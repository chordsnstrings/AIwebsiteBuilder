import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { config } from "@adw/config";
import {
  activateVendor,
  assertProvisioningPermitted,
  diligenceComplete,
  earliestWave1Send,
  provisioningPermitted,
  runWatches,
  seedVendors,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  await seedVendors(db);
});
afterAll(async () => {
  await db?.close();
});

const cloudflare = () => config.vendors().data.vendors.find((v) => v.id === "cloudflare")!;

describe("vendor orchestrator", () => {
  it("seeds the vendor registry from config", async () => {
    const n = await db.one<{ n: string }>("SELECT count(*) AS n FROM vendors");
    expect(Number(n.n)).toBeGreaterThanOrEqual(20);
  });

  it("permits scoped provisioning inside an existing account but never account creation", () => {
    const cf = cloudflare();
    expect(provisioningPermitted(cf, "dns_records")).toBe(true);
    expect(provisioningPermitted(cf, "create_account")).toBe(false);
    expect(() => assertProvisioningPermitted(cf, "create_account")).toThrow(/never on any allowlist/);
    expect(() => assertProvisioningPermitted(cf, "delete_production_data")).toThrow();
  });

  it("does not activate a vendor without a passing Sentinel probe", async () => {
    const r = await activateVendor(db, "cloudflare", false);
    expect(r.activated).toBe(false);
    const v = await db.one<{ state: string }>("SELECT state FROM vendors WHERE id='cloudflare'");
    expect(v.state).toBe("VERIFYING");
  });

  it("activates a PUB vendor with a passing probe", async () => {
    const r = await activateVendor(db, "cloudflare", true);
    expect(r.activated).toBe(true);
    const v = await db.one<{ state: string; probe_status: string }>("SELECT state, probe_status FROM vendors WHERE id='cloudflare'");
    expect(v.state).toBe("ACTIVE");
    expect(v.probe_status).toBe("passing");
  });

  it("blocks a CUST/PAY vendor from ACTIVE with an incomplete diligence file", async () => {
    // anthropic is CUST class. Reset its diligence to empty for this assertion
    // (the shared test DB may carry completed diligence from a prior run).
    await db.query("UPDATE vendors SET diligence='{}', state='IDENTIFIED' WHERE id='anthropic'");
    const r = await activateVendor(db, "anthropic", true);
    expect(r.activated).toBe(false);
    expect(r.reason).toMatch(/diligence/);
  });

  it("activates a CUST vendor once diligence is complete", async () => {
    const complete: Record<string, string> = {};
    for (let q = 1; q <= 9; q++) complete[`q${q}`] = "answered";
    expect(diligenceComplete(complete)).toBe(true);
    await db.query("UPDATE vendors SET diligence=$1 WHERE id='anthropic'", [JSON.stringify(complete)]);
    const r = await activateVendor(db, "anthropic", true);
    expect(r.activated).toBe(true);
  });

  it("watches contract renewals inside the notice period", async () => {
    const soon = new Date(Date.now() + 20 * 24 * 3600 * 1000);
    await db.query("UPDATE vendors SET renewal_at=$1, notice_period_days=30, balance_days=5 WHERE id='lead_data_primary'", [soon]);
    const findings = await runWatches(db);
    const renewal = findings.find((f) => f.vendorId === "lead_data_primary" && f.kind === "contract_renewal");
    const balance = findings.find((f) => f.vendorId === "lead_data_primary" && f.kind === "credit_balance");
    expect(renewal?.urgency).toBe("escalation");
    expect(balance?.urgency).toBe("escalation");
  });

  it("computes the earliest Wave-1 send date gated by the longest pole", () => {
    const start = new Date("2026-08-01T00:00:00Z");
    const { date, gatedBy } = earliestWave1Send(start);
    expect(date.getTime()).toBeGreaterThan(start.getTime());
    // Registrar approval, counsel, and mailbox warm-up are all 21 days.
    expect(["registrar_reseller_approval", "counsel_review", "mailbox_warmup"]).toContain(gatedBy);
  });
});
