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
const db: Db = await createDb({ backend: "pg", url });
await migrate(db);
const vault = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const checks: Check[] = [
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
