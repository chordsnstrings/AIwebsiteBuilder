// ⛔ The console's read model, through the HTTP surface the console actually
// calls. The defect these guard against is not a wrong number — it is a screen
// that renders confidently over data it never fetched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { clearKillSwitchCache, readEngagedSwitches, releaseKillSwitch } from "@adw/gate";
import type { SessionUser } from "@adw/auth";
import { createApp } from "./src/app.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let vault: SecretsBackend;

const OPERATOR: SessionUser = { id: "op", email: "ops@adw.example", role: "superadmin", customerId: null, totpEnabled: true };
const CUSTOMER: SessionUser = { id: "cu", email: "c@example.com", role: "customer", customerId: null, totpEnabled: false };

const appAs = (u: SessionUser | null) => createApp({ db, vault, forceMock: true, authOverride: u });

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
});
afterAll(async () => { await db?.close(); });

const OPS_ROUTES = ["/ops/now", "/ops/jobs", "/ops/customers", "/ops/spend", "/ops/models", "/ops/fleet"];

describe("every ops surface is superadmin-only", () => {
  for (const route of OPS_ROUTES) {
    it(`${route} refuses a customer and an anonymous caller`, async () => {
      expect((await appAs(CUSTOMER).request(route)).status).toBe(403);
      expect((await appAs(null).request(route)).status).toBe(403);
      expect((await appAs(OPERATOR).request(route)).status).toBe(200);
    });
  }
});

describe("⛔ the kill switch writes, and proves the gate saw it", () => {
  it("engages, is confirmed by the gate's own reader, and releases", async () => {
    // THE defect. The console rendered five switches, moved the toggle on local
    // state, and said "engaged by you" — while `toggleKillSwitch` had zero call
    // sites. An operator pulling HALT_ALL_SENDING during an incident watched it
    // turn red and the system went on sending. A control that reports success
    // without effect is worse than no control at all.
    const app = appAs(OPERATOR);
    await releaseKillSwitch(db, "HALT_ALL_SENDING", "test").catch(() => {});
    clearKillSwitchCache();

    const res = await app.request("/killswitch/HALT_ALL_SENDING", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engage: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engaged: boolean; confirmedByGate: boolean; engagedSwitches: string[]; propagationSeconds: number;
    };
    expect(body.engaged).toBe(true);
    // ⛔ Not "we wrote it" — "the gate's own reader returns it".
    expect(body.confirmedByGate).toBe(true);
    expect(body.engagedSwitches).toContain("HALT_ALL_SENDING");
    // Said out loud, because "engaged here" and "engaged in every process"
    // differ by the gate's cache TTL.
    expect(body.propagationSeconds).toBeGreaterThan(0);

    // And independently, outside the response: the gate really does deny on it.
    clearKillSwitchCache();
    expect((await readEngagedSwitches(db, Date.now())).has("HALT_ALL_SENDING")).toBe(true);

    const off = await app.request("/killswitch/HALT_ALL_SENDING", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engage: false }),
    });
    const offBody = (await off.json()) as { confirmedByGate: boolean; engagedSwitches: string[] };
    expect(offBody.confirmedByGate).toBe(true);
    expect(offBody.engagedSwitches).not.toContain("HALT_ALL_SENDING");
    clearKillSwitchCache();
    expect((await readEngagedSwitches(db, Date.now())).has("HALT_ALL_SENDING")).toBe(false);
  });

  it("lists the full roster, so a never-toggled switch is still on screen", async () => {
    // A switch with no row is not a switch that does not exist. Rendering only
    // the rows would hide the four an operator has never had to pull, which are
    // precisely the ones they will need to find in a hurry.
    const res = await appAs(OPERATOR).request("/killswitch");
    const body = (await res.json()) as { switches: unknown[]; known: string[]; asOf: string };
    expect(body.known).toContain("HALT_ALL_SENDING");
    expect(body.known).toContain("HALT_BUILDS");
    expect(body.known.length).toBeGreaterThanOrEqual(4);
    expect(Date.parse(body.asOf)).not.toBeNaN();
  });

  it("refuses a switch name it does not know", async () => {
    const res = await appAs(OPERATOR).request("/killswitch/HALT_EVERYTHING_FOREVER", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(400);
  });
});

describe("⛔ /ops/now degrades one board at a time", () => {
  it("returns each board tagged ok, never a bare payload", async () => {
    // All-or-nothing would mean one failing query renders an empty home screen,
    // which reads exactly like "nothing needs you". The single worst possible
    // confusion on this particular screen.
    const res = await appAs(OPERATOR).request("/ops/now");
    const body = (await res.json()) as Record<string, { ok: boolean; data?: unknown; error?: string }> & { asOf: string };
    for (const key of ["worklist", "jobs", "recentFailures", "spend"]) {
      const board = body[key]!;
      expect(board, `${key} missing`).toBeDefined();
      expect(board.ok, `${key} failed: ${board.error ?? ""}`).toBe(true);
      expect(board.data).toBeDefined();
    }
    expect(Date.parse(body.asOf)).not.toBeNaN();
  });

  it("the worklist carries its coverage, so empty is distinguishable from broken", async () => {
    const res = await appAs(OPERATOR).request("/ops/now");
    const body = (await res.json()) as { worklist: { ok: boolean; data: { coverage: { source: string; ok: boolean; considered: number }[] } } };
    expect(body.worklist.data.coverage).toHaveLength(6);
    for (const c of body.worklist.data.coverage) expect(c.ok).toBe(true);
  });
});

describe("the customer board", () => {
  it("reports the total population, not just the page it returned", async () => {
    const res = await appAs(OPERATOR).request("/ops/customers?limit=1");
    const body = (await res.json()) as { rows: unknown[]; totalCustomers: number; unresolvedVerticals: number };
    expect(body.rows.length).toBeLessThanOrEqual(1);
    expect(body.totalCustomers).toBeGreaterThanOrEqual(body.rows.length);
    expect(typeof body.unresolvedVerticals).toBe("number");
  });

  it("404s an unknown customer rather than rendering an empty one", async () => {
    const res = await appAs(OPERATOR).request("/ops/customers/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("the fleet board", () => {
  it("⛔ withholds a rate rather than dividing by an empty denominator", async () => {
    // 0.00% complaint rate over zero sends is not a healthy fleet, and printing
    // it as 0.00% is the exact lie this console exists to stop telling.
    const res = await appAs(OPERATOR).request("/ops/fleet");
    const body = (await res.json()) as {
      deliverability: { sent: number; bounceRate: number | null; complaintRate: number | null };
    };
    if (body.deliverability.sent === 0) {
      expect(body.deliverability.bounceRate).toBeNull();
      expect(body.deliverability.complaintRate).toBeNull();
    } else {
      expect(body.deliverability.bounceRate).toBeGreaterThanOrEqual(0);
    }
  });
});
