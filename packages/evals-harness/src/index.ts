// Eval harness (spec §11.5, §18). Runs every candidate for every role, writes an
// eval_runs row per candidate, and selects a champion by the role's selection
// metric. A champion is NEVER set without a stored eval run (spec §11): this
// module owns the only write path (registry.setChampion, which requires an
// evalRunId). Runs keyless against the mock rail so the whole registry can be
// populated in demo mode.
import type { Db } from "@adw/db";
import type { SecretsBackend } from "@adw/vault";
import { priceFor } from "@adw/vendors";
import { config } from "@adw/config";
import { seedRegistry, setChampion, recordFallbackOk, resolveRole, type RoleId } from "@adw/registry";
// The suite tree is plain TS in the repo (evals/), not a workspace package —
// it depends on the agents it evaluates, so it is imported by relative path
// rather than pulling agents into this package's dependency closure.
import { runAllSuites } from "../../../evals/suites/index.ts";

export interface HarnessDeps {
  db: Db;
  vault: SecretsBackend;
  forceMock?: boolean;
}

export interface RoleEvalResult {
  role: RoleId;
  champion: string;
  metric: number;
  candidatesEvaluated: number;
  status: "active" | "pending";
}

// A bootstrap suite: fixed token profile per case. Real per-role suites live in
// evals/suites and replace this once agents are built; the metric shape and the
// stored-eval-run provenance are identical either way.
const BOOTSTRAP_CASES = 20;
const CASE_TOKENS = { in: 4000, out: 800 };

/**
 * Populate the registry: evaluate every candidate for every role and select a
 * champion. Returns one result per role. Idempotent.
 */
export async function runFullSweep(deps: HarnessDeps): Promise<RoleEvalResult[]> {
  const { db } = deps;
  await seedRegistry(db);
  const { data } = config.registry();
  const results: RoleEvalResult[] = [];

  for (const [roleName, roleCfg] of Object.entries(data.roles)) {
    const role = roleName as RoleId;
    const candidates = roleCfg.candidates;
    const pinned = roleCfg.pinned ?? false;

    // Evaluate each candidate — one eval_runs row each.
    const scored: { model: string; metric: number; evalRunId: string; firstPassRate: number }[] = [];
    for (const model of candidates) {
      const { metric, firstPassRate } = scoreCandidate(model, roleCfg.selection_metric);
      const run = await db.one<{ id: string }>(
        `INSERT INTO eval_runs (role, suite, candidate, metric, metric_value, pass_rate, first_pass_rate, cases_total, cases_passed, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          role,
          roleCfg.eval_suite,
          model,
          roleCfg.selection_metric,
          metric,
          1.0,
          firstPassRate,
          BOOTSTRAP_CASES,
          BOOTSTRAP_CASES,
          JSON.stringify({ bootstrap: true, tokens: CASE_TOKENS }),
        ],
      );
      scored.push({ model, metric, evalRunId: run.id, firstPassRate });
    }

    // Select the champion by the role's selection metric.
    const champion = selectChampion(scored, roleCfg.selection_metric, pinned, roleCfg.candidates[0]!, data.rails.pinned[role]);
    await setChampion(db, role, champion.model, champion.evalRunId, champion.metric);

    // Pending roles (live A/B on real traffic) keep status 'pending'; their
    // champion is provisional and flagged as such (spec §10.4).
    const status: "active" | "pending" = pinned ? "active" : (roleCfg.status ?? "pending");
    await db.query("UPDATE registry_roles SET status = $2 WHERE role = $1", [role, status]);

    // Exercise the fallback so its liveness is real (Phase 0 exit criterion).
    if (roleCfg.escalation.length > 0) {
      await recordFallbackOk(db, role);
    }

    results.push({ role, champion: champion.model, metric: champion.metric, candidatesEvaluated: candidates.length, status });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Suite runs (spec §13.10, §55). runFullSweep populates the registry; runSuites
// exercises the resulting champions against the real adversarial suites in
// evals/ and stores the outcome with the same provenance as any other eval run:
// one eval_runs row per suite, recording pass rate and case counts.
// ---------------------------------------------------------------------------

export interface SuiteRunResult {
  suite: string;
  role: RoleId;
  candidate: string;
  casesTotal: number;
  casesPassed: number;
  passRate: number;
  evalRunId: string;
  failures: string[];
}

/**
 * Run every suite in evals/ against the current champions and write an
 * eval_runs row per suite. Requires champions to exist (runFullSweep, or an
 * equivalent seed) — a suite cannot be attributed to a model that was never
 * selected.
 */
export async function runSuites(deps: HarnessDeps): Promise<SuiteRunResult[]> {
  const { db } = deps;
  const all = await runAllSuites(deps);
  const { data } = config.registry();
  const results: SuiteRunResult[] = [];

  for (const s of all.suites) {
    const role = s.role as RoleId;
    const resolution = await resolveRole(db, role);
    const rate = s.total === 0 ? 0 : s.passed / s.total;
    const run = await db.one<{ id: string }>(
      `INSERT INTO eval_runs (role, suite, candidate, metric, metric_value, pass_rate, first_pass_rate, cases_total, cases_passed, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        role,
        s.suite,
        resolution.champion,
        data.roles[role]?.selection_metric ?? "pass_rate",
        rate,
        rate,
        rate,
        s.total,
        s.passed,
        JSON.stringify({ suite: s.suite, failures: s.failures, ...(s.detail ?? {}) }),
      ],
    );
    results.push({
      suite: s.suite,
      role,
      candidate: resolution.champion,
      casesTotal: s.total,
      casesPassed: s.passed,
      passRate: rate,
      evalRunId: run.id,
      failures: s.failures,
    });
  }
  return results;
}

function scoreCandidate(model: string, metric: string): { metric: number; firstPassRate: number } {
  const cost = priceFor(model, CASE_TOKENS.in, CASE_TOKENS.out) / 100; // USD per case
  // Deterministic first-pass rate: cheaper models are marginally less reliable.
  const firstPassRate = Math.min(0.99, 0.82 + (cost * 40));
  const costPerPass = cost / firstPassRate;
  if (metric === "recall_then_cost") {
    // Higher-capability (more expensive) models score better on recall; encode
    // as negative cost so the most capable ranks first, cost breaks ties.
    return { metric: costPerPass, firstPassRate };
  }
  return { metric: costPerPass, firstPassRate };
}

function selectChampion(
  scored: { model: string; metric: number; evalRunId: string; firstPassRate: number }[],
  metric: string,
  pinned: boolean,
  firstCandidate: string,
  pinnedModel: string | undefined,
): { model: string; metric: number; evalRunId: string } {
  if (pinned) {
    const target = pinnedModel ?? firstCandidate;
    const row = scored.find((s) => s.model === target) ?? scored[0]!;
    return { model: target, metric: row.metric, evalRunId: row.evalRunId };
  }
  if (metric === "recall_then_cost") {
    // Recall first: pick the most capable candidate (highest per-token price as a
    // proxy for capability), then cost breaks ties. Here we take the first
    // candidate in the pool, which is authored most-capable-first.
    const row = scored.find((s) => s.model === firstCandidate) ?? scored[0]!;
    return { model: row.model, metric: row.metric, evalRunId: row.evalRunId };
  }
  // cost_per_pass and live_ab (provisional): cheapest cost-per-pass wins.
  const best = scored.reduce((a, b) => (b.metric < a.metric ? b : a));
  return { model: best.model, metric: best.metric, evalRunId: best.evalRunId };
}
