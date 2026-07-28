import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import {
  aggregate,
  assertChannelIndependence,
  assertPermitted,
  emitHeartbeat,
  heartbeatMissed,
  isPermitted,
  makeProbe,
  routeAlert,
  runProbe,
  type AlertChannel,
  type AlertRouterConfig,
  type VendorHealthSurface,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

// A mock vendor surface with a simulateOutage() switch.
function surface(id: string): VendorHealthSurface & { outage: boolean } {
  const s = {
    vendorId: id,
    outage: false,
    async roundTrip() {
      if (s.outage) throw new Error("simulated outage");
      return { ok: true, latencyMs: 12 };
    },
  };
  return s;
}

describe("Sentinel probes", () => {
  it("a probe passes in demo mode and fails on simulateOutage()", async () => {
    const s = surface("stripe");
    const probe = makeProbe(s, "payment_intent", 60_000);
    const ok = await runProbe(db, probe);
    expect(ok.passed).toBe(true);
    s.outage = true;
    const bad = await runProbe(db, probe);
    expect(bad.passed).toBe(false);
    // Both results persisted.
    const rows = await db.one<{ n: string }>("SELECT count(*) AS n FROM probe_results WHERE vendor_id='stripe'");
    expect(Number(rows.n)).toBeGreaterThanOrEqual(2);
  });
});

describe("remediation allowlist (spec §71.5)", () => {
  it("permits risk-reducing actions and forbids risk-increasing ones", () => {
    expect(isPermitted("failover_role_to_fallback")).toBe(true);
    expect(isPermitted("rollback_deploy")).toBe(true);
    expect(isPermitted("switch_payment_processors")).toBe(false);
    expect(isPermitted("resume_halted")).toBe(false);
    expect(() => assertPermitted("change_config")).toThrow(/reduce risk/);
  });
});

describe("alert routing", () => {
  it("SEV1 bypasses the CEO and fires push then phone", async () => {
    const calls: string[] = [];
    const ch = (kind: "push" | "phone" | "email", vendorId: string): AlertChannel => ({
      kind,
      vendorId,
      async send() {
        calls.push(kind);
      },
    });
    const cfg: AlertRouterConfig = { push: ch("push", "pushover"), phone: ch("phone", "pagerduty"), email: ch("email", "postmark") };
    await routeAlert(cfg, { vendorId: "stripe", failureClass: "key_rotated", severity: 1 });
    expect(calls).toEqual(["push", "phone"]);
  });

  it("enforces channel independence (never Twilio phone, never SES email)", () => {
    const ch = (kind: "push" | "phone" | "email", vendorId: string): AlertChannel => ({ kind, vendorId, async send() {} });
    expect(() =>
      assertChannelIndependence({ push: ch("push", "pushover"), phone: ch("phone", "twilio"), email: ch("email", "postmark") }, new Set()),
    ).toThrow(/Twilio/);
    expect(() =>
      assertChannelIndependence({ push: ch("push", "pushover"), phone: ch("phone", "pagerduty"), email: ch("email", "aws_ses") }, new Set()),
    ).toThrow(/SES/);
    // A channel that routes through a monitored vendor is rejected.
    expect(() =>
      assertChannelIndependence({ push: ch("push", "cloudflare"), phone: ch("phone", "pagerduty"), email: ch("email", "postmark") }, new Set(["cloudflare"])),
    ).toThrow(/monitored/);
  });

  it("aggregates 200 failures of one vendor into one alert with a count", () => {
    const incidents = Array.from({ length: 200 }, () => ({ vendorId: "google_workspace", failureClass: "pool_suspended", severity: 2 as const }));
    const agg = aggregate(incidents);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.count).toBe(200);
  });

  it("collapses >10 distinct vendor failures into a single multi_vendor_event", () => {
    const incidents = Array.from({ length: 12 }, (_, i) => ({ vendorId: `v${i}`, failureClass: "down", severity: 2 as const }));
    const agg = aggregate(incidents);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.failureClass).toBe("multi_vendor_event");
  });
});

describe("dead man's switch", () => {
  it("detects a missed heartbeat (alerted by absence)", async () => {
    // Scoped to its own source. The shared test database carries beats from
    // every other suite, so asserting against the global latest beat would
    // pass or fail depending on what else ran — which is not a test.
    const source = `sentinel-test-${randomUUID()}`;
    const t0 = new Date("2026-07-27T12:00:00Z");
    await emitHeartbeat(db, t0, source);
    expect(await heartbeatMissed(db, new Date(t0.getTime() + 60_000), 3 * 60_000, source)).toBe(false);
    expect(await heartbeatMissed(db, new Date(t0.getTime() + 4 * 60_000), 3 * 60_000, source)).toBe(true);
  });

  it("reports a miss when a source has never beaten at all", async () => {
    expect(await heartbeatMissed(db, new Date(), 3 * 60_000, `never-${randomUUID()}`)).toBe(true);
  });
});
