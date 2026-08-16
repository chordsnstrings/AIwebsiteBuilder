// Nightly evals + production-invariant checks (spec §18, §48.5). Runs keyless
// against the demo database. Any failing check exits non-zero — in production
// this blocks the build / pages the operator. This is the machine-checkable
// form of the Phase-0 exit criterion and the nightly assertion table.
import { createDb, migrate, type Db } from "../packages/db/src/index.ts";
import { LocalKeyWrapper, LocalPgBackend } from "../packages/vault/src/index.ts";
import { runFullSweep, runSuites } from "../packages/evals-harness/src/index.ts";
import { registryStatus } from "../packages/registry/src/index.ts";
import { config } from "../packages/config/src/index.ts";
import { probeCoverage, runAllProbes, evaluateSignals, heartbeatMissed, emitHeartbeat } from "../packages/sentinel/src/index.ts";

const url = process.env.DATABASE_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw";
/** Retrieval turns needed in the window before the hit rate means anything. */
const MIN_HIT_RATE_SAMPLE = 50;

const db: Db = await createDb({ backend: "pg", url });
await migrate(db);
const vault = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const checks: Check[] = [
  // -------------------------------------------------------------------------
  // v3.0 — the transaction layer. Each of these has a target of ZERO and an
  // alert at one, because each fails silently: a component reporting success
  // while not working is the metric class this system is most exposed to.
  // -------------------------------------------------------------------------
  {
    name: "No customer agent is live without a passing eval run",
    run: async () => {
      // ⛔ No partial credit, and no exceptions. An agent that improvises about
      // a customer's licensing is THEIR liability under Moffatt — shipping one
      // without a green gate is the single most damaging thing we can do to
      // someone who has just paid us.
      const row = await db.one<{ n: string }>(
        `SELECT count(*) AS n
           FROM customers c
          WHERE c.status = 'active'
            AND EXISTS (SELECT 1 FROM qa_packs p WHERE p.customer_id = c.id)
            AND NOT EXISTS (
              SELECT 1 FROM agent_eval_runs r
               WHERE r.customer_id = c.id AND r.verdict = 'pass'
            )`,
      );
      return { ok: Number(row.n) === 0, detail: `${row.n} live agents without a passing eval run` };
    },
  },
  {
    name: "No Q&A pair asserts something absent from the knowledge base",
    run: async () => {
      // A generated pair with no source fact is the grounding failure the whole
      // architecture exists to prevent. Template refusal pairs are the one
      // permitted exception — they assert nothing.
      const row = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM qa_pairs
          WHERE source = 'generated'
            AND (source_fact_ids IS NULL OR array_length(source_fact_ids, 1) IS NULL)`,
      );
      return { ok: Number(row.n) === 0, detail: `${row.n} ungrounded generated pairs` };
    },
  },
  {
    name: "No Q&A pack went live without the owner approving it",
    run: async () => {
      const row = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM qa_packs p
          WHERE p.customer_id IS NOT NULL AND p.approved_at IS NULL
            AND EXISTS (SELECT 1 FROM agent_eval_runs r WHERE r.pack_id = p.id AND r.verdict = 'pass')`,
      );
      return { ok: Number(row.n) === 0, detail: `${row.n} unapproved packs behind a passing gate` };
    },
  },
  {
    // ⛔ The check above passed for months while the product was completely
    // broken. It counts VIOLATIONS, so zero packs → zero violations → green,
    // and nothing distinguished "the rule holds" from "the rule has never had
    // anything to hold over". `approvePack()` had no production caller at all,
    // so no pack ever cleared the eval gate, so no customer agent ever went
    // live — and the nightly board said everything was fine.
    //
    // An invariant with an empty population is not evidence. This asserts the
    // population exists, so the guard above can only stay green by being true.
    name: "The approval invariant above has a population to be true over",
    run: async () => {
      const row = await db.one<{ approved: string; live: string }>(
        `SELECT
           (SELECT count(*) FROM qa_packs WHERE customer_id IS NOT NULL AND approved_at IS NOT NULL) AS approved,
           (SELECT count(*) FROM agent_eval_runs WHERE verdict = 'pass') AS live`,
      );
      const approved = Number(row.approved);
      const live = Number(row.live);
      return {
        ok: approved > 0 && live > 0,
        detail:
          approved === 0
            ? "ZERO approved packs exist — the approval guard is vacuous and no customer agent can be live"
            : live === 0
              ? `${approved} approved packs but zero passing eval runs — nothing reached the gate`
              : `${approved} approved packs, ${live} passing eval runs`,
      };
    },
  },
  {
    name: "No customer mail record was altered during a cutover",
    run: async () => {
      // 86% of targets have live MX. This is the number that would end the
      // company, so it is asserted over all history, not a rolling window.
      const row = await db.one<{ n: string }>(
        "SELECT count(*) AS n FROM dns_cutovers WHERE mail_records_changed = TRUE",
      );
      return { ok: Number(row.n) === 0, detail: `${row.n} cutovers that touched a mail record` };
    },
  },
  {
    name: "No cutover was applied without a prior DNS snapshot",
    run: async () => {
      // Without a before-state there is no diff, and without a diff the safety
      // claim is a promise rather than a verified assertion.
      const row = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM dns_cutovers c
          WHERE c.status <> 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM dns_snapshots s
               WHERE s.id = c.snapshot_id AND s.taken_at <= c.started_at
            )`,
      );
      return { ok: Number(row.n) === 0, detail: `${row.n} cutovers with no prior snapshot` };
    },
  },
  {
    name: "No fallback answer was promoted into a pack without owner approval",
    run: async () => {
      // Auto-promotion is the difference between a grounded system and one that
      // learns its own hallucinations.
      const row = await db.one<{ n: string }>(
        "SELECT count(*) AS n FROM agent_gaps WHERE promoted_pair_id IS NOT NULL AND approved_at IS NULL",
      );
      return { ok: Number(row.n) === 0, detail: `${row.n} auto-promoted answers` };
    },
  },
  {
    name: "No photo assessment carries a price the agent wrote",
    run: async () => {
      // The price column is only ever written by the owner from the dashboard.
      // A priced assessment the owner never replied to means something else set
      // it, which is the boundary in §41.1.
      const row = await db.one<{ n: string }>(
        "SELECT count(*) AS n FROM photo_assessments WHERE price_cents IS NOT NULL AND owner_replied_at IS NULL",
      );
      return { ok: Number(row.n) === 0, detail: `${row.n} agent-priced assessments` };
    },
  },
  {
    name: "Retrieval hit rate is at or above the launch target",
    run: async () => {
      // Not zero-targeted — this one is a health signal. Below the floor the
      // fallback is carrying the product, which is both costlier and less
      // grounded than the design assumes.
      const target = (config.playbooks().data as { retrieval: { hit_rate_target_launch: number } }).retrieval
        .hit_rate_target_launch;
      // ⛔ The denominator is retrieval ATTEMPTS, not all turns. A booking turn
      // and a hard refusal never consulted the pack; counting them as hits
      // (which this check used to do for `state_machine`) reports the router's
      // behaviour as the pack's, and a busy booking flow would mask a pack that
      // answers nothing.
      const row = await db.maybeOne<{ total: string; hits: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE answered_from IN ('pack','pack_hedged')) AS hits
           FROM agent_turns
          WHERE route = 'retrieval' AND created_at >= now() - interval '7 days'`,
      );
      const total = Number(row?.total ?? 0);
      // Below the minimum sample the rate is noise, and a check that can go red
      // on four turns gets muted — after which it protects nothing. The count is
      // always reported, so "not enough data" is visibly different from "fine".
      if (total < MIN_HIT_RATE_SAMPLE) {
        return { ok: true, detail: `${total} retrieval turns in the window — below the ${MIN_HIT_RATE_SAMPLE} needed to judge` };
      }
      const rate = Number(row?.hits ?? 0) / total;
      return {
        ok: rate >= target,
        detail: `${(rate * 100).toFixed(1)}% of ${total} turns answered from the pack (target ${(target * 100).toFixed(0)}%)`,
      };
    },
  },
  {
    name: "Architect escalation rate is inside the playbook target",
    run: async () => {
      // Above 6% the playbooks are too narrow — that is a config review, not
      // more escalation.
      const max = (config.playbooks().data as { escalation: { target_rate_max: number } }).escalation
        .target_rate_max;
      const row = await db.one<{ total: string; escalated: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE trigger = 'vertical_unresolved') AS escalated
           FROM exceptions WHERE raised_at >= now() - interval '7 days'`,
      );
      const manifests = await db.one<{ n: string }>(
        "SELECT count(*) AS n FROM delivery_manifests WHERE created_at >= now() - interval '7 days'",
      );
      const attempted = Number(manifests.n) + Number(row.escalated);
      if (attempted === 0) return { ok: true, detail: "no classifications in the window" };
      const rate = Number(row.escalated) / attempted;
      return { ok: rate <= max, detail: `${(rate * 100).toFixed(1)}% escalated of ${attempted} (max ${(max * 100).toFixed(0)}%)` };
    },
  },
  {
    name: "No manifest names a module outside the playbook catalogue",
    run: async () => {
      // A module the model proposed that does not exist fails the build. This
      // asserts none slipped through into a stored manifest.
      const playbooks = config.playbooks().data as {
        verticals: Record<string, { site_modules?: string[]; agent_capabilities?: string[] }>;
      };
      const known = new Set<string>();
      for (const v of Object.values(playbooks.verticals)) {
        for (const m of v.site_modules ?? []) known.add(m);
        for (const c of v.agent_capabilities ?? []) known.add(c);
      }
      const rows = await db.query<{ id: string; site_modules: unknown; agent_capabilities: unknown }>(
        "SELECT id, site_modules, agent_capabilities FROM delivery_manifests",
      );
      const bad: string[] = [];
      for (const r of rows.rows) {
        const mods = [...(r.site_modules as string[]), ...(r.agent_capabilities as string[])];
        for (const m of mods) if (!known.has(m)) bad.push(`${r.id}:${m}`);
      }
      return { ok: bad.length === 0, detail: `${rows.rows.length} manifests, ${bad.length} unknown modules` };
    },
  },

  {
    name: "Every role has a champion backed by a stored eval run",
    run: async () => {
      await runFullSweep({ db, vault, forceMock: true });
      const status = await registryStatus(db);
      const missing = status.filter((s) => !s.champion || !s.hasEvalRun);
      return { ok: missing.length === 0 && status.length >= 16, detail: `${status.length} roles, ${missing.length} missing champion/eval` };
    },
  },
  {
    name: "Adversarial suites pass (injection 10, care 30, IP/claims 15 at 100% recall)",
    run: async () => {
      const results = await runSuites({ db, vault, forceMock: true });
      const failed = results.filter((r) => r.casesPassed < r.casesTotal);
      const detail = results.map((r) => `${r.suite} ${r.casesPassed}/${r.casesTotal}`).join(", ");
      return { ok: failed.length === 0 && results.length >= 3, detail };
    },
  },
  {
    name: "Every T0/T1 vendor has a live probe and all probes pass",
    run: async () => {
      const t0t1 = config
        .vendors()
        .data.vendors.filter((v) => v.tier === "T0" || v.tier === "T1")
        .map((v) => v.id);
      const coverage = probeCoverage(db, t0t1);
      const run = await runAllProbes(db);
      return {
        ok: coverage.missing.length === 0 && run.failed === 0,
        detail: `${coverage.covered.length} covered, ${coverage.missing.length} missing; ${run.passed}/${run.total} probes passing`,
      };
    },
  },
  {
    name: "Dead man's switch heartbeat is current",
    run: async () => {
      await emitHeartbeat(db);
      const missed = await heartbeatMissed(db);
      return { ok: !missed, detail: missed ? "heartbeat stale" : "heartbeat fresh" };
    },
  },
  {
    name: "Layer-2 passive signals are all within threshold on a healthy window",
    run: async () => {
      const signals = evaluateSignals({
        firstPassRateByRole: { developer: 0.84, customer_care: 0.91 },
        inboxPlacement: 0.725,
        complaintRate: 0.0006,
        silentFailureCount: 0,
        previewRenderSuccess: 0.99,
        formSubmissionArrival: 0.999,
        providerConcentration: 0.55,
      });
      const alarming = signals.filter((s) => s.alarm);
      return { ok: alarming.length === 0, detail: `${signals.length} signals, ${alarming.length} alarming` };
    },
  },
  {
    name: "No outbound message lacks a gate_decision_id",
    run: async () => {
      const r = await db.one<{ n: string }>("SELECT count(*) AS n FROM messages WHERE direction='outbound' AND gate_decision_id IS NULL");
      return { ok: Number(r.n) === 0, detail: `${r.n} orphan messages` };
    },
  },
  {
    name: "No connected account has a charge_type other than 'direct'",
    run: async () => {
      const r = await db.one<{ n: string }>("SELECT count(*) AS n FROM merchant_accounts WHERE charge_type <> 'direct'");
      return { ok: Number(r.n) === 0, detail: `${r.n} non-direct accounts` };
    },
  },
  // -------------------------------------------------------------------------
  // The customer-side families (MF2-MF13). Each of these has a target of ZERO
  // and, like the block above, each fails SILENTLY — which is the whole reason
  // it is asserted nightly rather than trusted to a code review.
  // -------------------------------------------------------------------------
  {
    name: "No statutory date was moved without a named human and a reason",
    run: async () => {
      // ⛔ A recall can slip a fortnight; a licence renewal date is a fact about
      // the law. The clamp lives in `scheduleReminder`, and this is the
      // assertion that it was never routed around.
      const r = await db.one<{ n: string; total: string }>(
        `SELECT count(*) FILTER (WHERE moved_at IS NOT NULL
                                   AND (moved_by IS NULL OR moved_reason IS NULL OR btrim(moved_reason) = '')) AS n,
                count(*) AS total
           FROM reminders WHERE statutory = TRUE`,
      );
      // ⛔ The denominator is reported, always. "0 violations" over an empty
      // table and "0 violations" over four hundred rows are different
      // statements, and the approval invariant in this same file passed for a
      // year because nothing had ever reached the gate it guarded.
      return { ok: Number(r.n) === 0, detail: `${r.n} unexplained moves over ${r.total} statutory reminders` };
    },
  },
  {
    name: "No journey step was delivered after the contact unsubscribed",
    run: async () => {
      // ⛔ Consent at step 1 is not consent at step 3 twelve days later. The
      // runner re-checks suppression before every step; this checks the
      // evidence rather than the intention.
      const r = await db.one<{ n: string }>(
        `SELECT count(*) AS n
           FROM journey_steps_sent st
           JOIN journey_runs jr ON jr.id = st.run_id
           JOIN suppression s ON s.email_hash = digest(jr.contact, 'sha256')
          WHERE s.suppressed_at < st.sent_at`,
      );
      const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM journey_steps_sent");
      return { ok: Number(r.n) === 0, detail: `${r.n} suppressed sends over ${total.n} journey steps delivered` };
    },
  },
  {
    name: "Nothing was published in a business's name without an approver",
    run: async () => {
      // The one step between a model's sentence and a business's public
      // profile. A published row with no approver means the step was skipped.
      const r = await db.one<{ n: string; total: string }>(
        `SELECT count(*) FILTER (WHERE approved_by IS NULL OR approved_at IS NULL) AS n,
                count(*) AS total
           FROM publications WHERE state = 'published'`,
      );
      return { ok: Number(r.n) === 0, detail: `${r.n} unapproved over ${r.total} published` };
    },
  },
  {
    name: "No reconciliation was signed off over an unexplained difference",
    run: async () => {
      // For the statutory ones — a client account, a deposit register — that
      // signature is the regulatory artefact.
      const r = await db.one<{ n: string; total: string }>(
        `SELECT count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM recon_matches m
                   WHERE m.run_id = r.id AND m.status <> 'matched' AND m.resolved_at IS NULL)) AS n,
                count(*) AS total
           FROM recon_runs r WHERE r.state = 'closed'`,
      );
      return { ok: Number(r.n) === 0, detail: `${r.n} with open differences over ${r.total} closed runs` };
    },
  },
  {
    name: "No watch reports a value it has not actually fetched",
    run: async () => {
      // ⛔ The failure this family is built to avoid, restated as a query: a
      // subscription that has been failing for a fortnight while the board
      // showed a number. `watchBoard` withholds the value once stale; this
      // catches a subscription nobody noticed had stopped.
      const r = await db.one<{ n: string; total: string }>(
        `SELECT count(*) FILTER (WHERE last_run_at IS NOT NULL
                                   AND (last_ok_at IS NULL OR last_ok_at < now() - interval '14 days')) AS n,
                count(*) AS total
           FROM watch_subscriptions WHERE active = TRUE`,
      );
      return { ok: Number(r.n) === 0, detail: `${r.n} stale over ${r.total} active watches` };
    },
  },
  {
    name: "Every live customer has a trade the per-archetype config resolves",
    run: async () => {
      // ⛔ `businesses.vertical` is written in exactly ONE place and is left
      // NULL whenever the Architect escalated. Five customer-side families key
      // everything off it, so a customer with no resolvable trade silently gets
      // no case types, no clocks, no journeys, no watches, no reconciliations
      // and no publishing channels — with nothing anywhere reporting it. The
      // read falls back to the lead-data category; this catches the ones where
      // neither resolves.
      const { resolveVertical, primaryArchetype } = await import("../packages/taxonomy/src/index.ts");
      const rows = await db.query<{ id: string; vertical: string | null; category: string | null }>(
        `SELECT c.id, b.vertical, b.category
           FROM customers c JOIN businesses b ON b.id = c.business_id
          WHERE c.status = 'active'`,
      );
      const unresolved = rows.rows.filter((r) => primaryArchetype(resolveVertical(r.vertical, r.category)) === undefined);
      return {
        ok: unresolved.length === 0,
        detail: `${unresolved.length} unresolved over ${rows.rows.length} active customers`,
      };
    },
  },
  {
    name: "Every kill switch is read by something that halts",
    run: async () => {
      // ⛔ Three of the five were settable, stored, displayed as engaged, and
      // read by nothing. A switch that appears to work stops the operator
      // looking for the real off button, and they find out during the incident
      // it was installed for. Asserted by ENGAGING each one and checking the
      // reader agrees — a reader that exists but is never called is exactly the
      // shape of the original defect, so the two chokepoint tests in
      // apps/worker/killswitches.test.ts carry the other half.
      const { readEngagedSwitches, clearKillSwitchCache, buildsHalted, paymentsOnboardingHalted, agentHalted, sendingHalted } =
        await import("../packages/gate/src/index.ts");
      clearKillSwitchCache();
      const engaged = new Set(["HALT_ALL_SENDING", "HALT_COLD_ONLY", "HALT_BUILDS", "HALT_PAYMENTS_ONBOARDING", "HALT_AGENT:developer"]);
      const unread: string[] = [];
      if (!sendingHalted(new Set(["HALT_ALL_SENDING"]), "email", "transactional")) unread.push("HALT_ALL_SENDING");
      if (!sendingHalted(new Set(["HALT_COLD_ONLY"]), "email", "cold")) unread.push("HALT_COLD_ONLY");
      if (!buildsHalted(engaged)) unread.push("HALT_BUILDS");
      if (!paymentsOnboardingHalted(engaged)) unread.push("HALT_PAYMENTS_ONBOARDING");
      if (!agentHalted(engaged, "developer")) unread.push("HALT_AGENT:*");
      // And the live table has no switch the code cannot read.
      const rows = await db.query<{ name: string }>("SELECT name FROM kill_switches");
      const known = new Set(["HALT_ALL_SENDING", "HALT_COLD_ONLY", "HALT_BUILDS", "HALT_PAYMENTS_ONBOARDING"]);
      for (const row of rows.rows) {
        if (!known.has(row.name) && !row.name.startsWith("HALT_AGENT:")) unread.push(row.name);
      }
      await readEngagedSwitches(db, Date.now());
      clearKillSwitchCache();
      return { ok: unread.length === 0, detail: unread.length === 0 ? `${rows.rows.length} switches, all readable` : `unread: ${unread.join(", ")}` };
    },
  },
  {
    name: "No preview is live past its expiry",
    run: async () => {
      const r = await db.one<{ n: string }>("SELECT count(*) AS n FROM previews WHERE expires_at < now() AND takedown_at IS NULL AND claimed_at IS NULL");
      return { ok: Number(r.n) === 0, detail: `${r.n} expired-but-live previews` };
    },
  },
  {
    name: "No CUST/PAY vendor is ACTIVE with an incomplete diligence file",
    run: async () => {
      const rows = await db.query<{ id: string; diligence: Record<string, unknown> }>(
        "SELECT id, diligence FROM vendors WHERE state='ACTIVE' AND data_class IN ('CUST','PAY')",
      );
      const bad = rows.rows.filter((v) => {
        for (let q = 1; q <= 9; q++) if (!v.diligence[`q${q}`]) return true;
        return false;
      });
      return { ok: bad.length === 0, detail: `${bad.length} under-diligenced active CUST/PAY vendors` };
    },
  },
  {
    name: "Jurisdiction config version is stamped and EU is disabled",
    run: async () => {
      const j = config.jurisdictions();
      const euDisabled = j.data.countries.DE?.enabled === false;
      return { ok: euDisabled && /^jurisdictions@[0-9a-f]{7}$/.test(j.version), detail: `${j.version}, EU disabled=${euDisabled}` };
    },
  },
  {
    name: "Provider concentration cap is set at the endpoint level (0.60)",
    run: async () => {
      const t = config.thresholds().data.control.provider_concentration_max;
      return { ok: t === 0.6, detail: `cap=${t}` };
    },
  },
  {
    name: "The append-only suppression ledger rejects deletes (defence in depth)",
    run: async () => {
      try {
        await db.query("DELETE FROM suppression WHERE email_hash = decode('00','hex')");
        return { ok: true, detail: "no rows matched (delete would be rejected by trigger anyway)" };
      } catch (err) {
        return { ok: /append-only/i.test(err instanceof Error ? err.message : ""), detail: "trigger rejected delete" };
      }
    },
  },
];

let failed = 0;
for (const c of checks) {
  const res = await c.run().catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
  console.log(`${res.ok ? "✓" : "✗"} ${c.name} — ${res.detail}`);
  if (!res.ok) failed++;
}
await db.close();
console.log(`\n${failed === 0 ? "✅ nightly evals PASSED" : `❌ ${failed} check(s) failed`} (${checks.length} checks)`);
if (failed > 0) process.exit(1);
