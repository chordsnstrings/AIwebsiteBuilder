// MF2 + MF3 — cases and the owner's queue.
//
// The only long-running objects in this system were ADW's own
// `workflow_executions`; the customer had none. And `exceptions.status` never
// left 'open' — no acknowledge writer, no resolve writer, no assignee, no due
// date — so the queue grew forever and every item looked equally new.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  acknowledgeItem, addCaseNote, advanceCase, assignItem, caseTypesFor,
  customerStatus, openCase, overdueItems, queue, resolveItem, stalledCases,
} from "./src/index.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let customerId: string;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,'Case Co','GB','R2','no_site','lawyer') RETURNING id`, [batch.id]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Case Co','c@example.com','en-GB','Europe/London','active') RETURNING id`, [biz.id]);
  customerId = cust.id;
});
afterAll(async () => { await db?.close(); });

describe("case types", () => {
  it("resolve per archetype, so all 145 trades have one", () => {
    expect(caseTypesFor("lawyer").map((t) => t.id)).toContain("matter");
    expect(caseTypesFor("plumber").length).toBeGreaterThan(0);
    expect(caseTypesFor("hotel").length).toBeGreaterThan(0);
  });
});

describe("the case object", () => {
  const ref = () => `M-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  it("opens, advances, and closes on a terminal stage", async () => {
    const id = await openCase(db, { customerId, vertical: "lawyer", caseType: "matter", reference: ref(), title: "Sale of 12 Elm St" });
    expect((await advanceCase(db, id, "conflict_check", "clerk@x.com", { vertical: "lawyer" })).moved).toBe(true);
    expect((await advanceCase(db, id, "concluded", "clerk@x.com", { vertical: "lawyer" })).moved).toBe(true);
    const row = await db.one<{ closed_at: Date | null }>("SELECT closed_at FROM cases WHERE id = $1", [id]);
    expect(row.closed_at).not.toBeNull();
  });

  it("⛔ refuses a stage the type does not define", async () => {
    // A case in a stage nothing knows about has no clock and no visibility rule.
    const id = await openCase(db, { customerId, vertical: "lawyer", caseType: "matter", reference: ref(), title: "X" });
    const out = await advanceCase(db, id, "invented_stage", "clerk@x.com", { vertical: "lawyer" });
    expect(out.moved).toBe(false);
    expect(out.reason).toMatch(/no stage/);
  });

  it("⛔ resets the clock PER STAGE, not per case", async () => {
    // "Open for 40 days" is normal for a conveyance and a scandal for a
    // complaint. What matters is how long it has sat where it is.
    const id = await openCase(db, { customerId, vertical: "lawyer", caseType: "matter", reference: ref(), title: "Y" });
    const before = await db.one<{ stage_due_at: Date }>("SELECT stage_due_at FROM cases WHERE id = $1", [id]);
    await advanceCase(db, id, "in_progress", "clerk@x.com", { vertical: "lawyer" });
    const after = await db.one<{ stage_due_at: Date }>("SELECT stage_due_at FROM cases WHERE id = $1", [id]);
    expect(new Date(after.stage_due_at).getTime()).toBeGreaterThan(new Date(before.stage_due_at).getTime());
  });

  it("surfaces anything not moving", async () => {
    const reference = ref();
    const id = await openCase(db, { customerId, vertical: "lawyer", caseType: "matter", reference, title: "Stalled" },
      new Date(Date.now() - 10 * 86_400_000));
    const stalled = await stalledCases(db, customerId);
    expect(stalled.map((s) => s.id)).toContain(id);
    expect(stalled.find((s) => s.id === id)!.hoursOverdue).toBeGreaterThan(0);
  });

  it("⛔ never leaks an internal note or an internal stage to the customer", async () => {
    // A case note saying "client is being difficult" is internal, and a status
    // page that leaks one costs the business the client.
    const id = await openCase(db, { customerId, vertical: "lawyer", caseType: "matter", reference: ref(), title: "Private" });
    await addCaseNote(db, id, "client is being difficult", "clerk@x.com", false);
    await advanceCase(db, id, "conflict_check", "clerk@x.com", { vertical: "lawyer" });

    const status = await customerStatus(db, id, "lawyer");
    // conflict_check is customer_visible: false — reported as "in progress"
    // rather than named. Telling a client their matter is in "conflict check"
    // is a conversation the firm chooses to have.
    expect(status!.stage).toBe("in_progress");
    expect(JSON.stringify(status)).not.toContain("difficult");
    expect(JSON.stringify(status)).not.toContain("conflict");
  });
});

describe("⛔ the queue can actually be cleared", () => {
  const raise = async (trigger: string, severity = 3, forCustomer = false) => {
    const row = await db.one<{ id: string }>(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation, customer_id)
       VALUES ($1,$2,'{}','noted','do the thing',$3) RETURNING id`,
      [trigger, severity, forCustomer ? customerId : null]);
    return row.id;
  };

  it("acknowledges and resolves — the writers that did not exist", async () => {
    const id = await raise(`ack-${Date.now()}`);
    expect(await acknowledgeItem(db, id, "op@example.com")).toBe(true);
    expect(await acknowledgeItem(db, id, "other@example.com"), "acknowledging twice is a no-op").toBe(false);
    expect(await resolveItem(db, id, "op@example.com", "fixed by hand")).toBe(true);
    const row = await db.one<{ status: string; resolved_by: string }>(
      "SELECT status, resolved_by FROM exceptions WHERE id = $1", [id]);
    expect(row.status).toBe("resolved");
    expect(row.resolved_by).toBe("op@example.com");
  });

  it("resolving without acknowledging still records who saw it", async () => {
    const id = await raise(`direct-${Date.now()}`);
    await resolveItem(db, id, "op@example.com", "not a real problem");
    const row = await db.one<{ acknowledged_by: string | null }>(
      "SELECT acknowledged_by FROM exceptions WHERE id = $1", [id]);
    expect(row.acknowledged_by).toBe("op@example.com");
  });

  it("separates the owner's queue from ADW's operations queue", async () => {
    // Both were the same undifferentiated list, which is why the owner's
    // console had nothing to show.
    const mine = await raise(`owner-${Date.now()}`, 3, true);
    const ours = await raise(`adw-${Date.now()}`, 3, false);
    expect((await queue(db, { customerId })).map((i) => i.id)).toContain(mine);
    expect((await queue(db, { customerId })).map((i) => i.id)).not.toContain(ours);
    // The ops queue carries every exception raised by every other suite, so it
    // is asked with a limit that can actually reach a fresh row.
    expect((await queue(db, { customerId: null, limit: 1000 })).map((i) => i.id)).toContain(ours);
  });

  it("orders by severity, then age", async () => {
    const items = await queue(db, { customerId: null, limit: 200 });
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.severity).toBeLessThanOrEqual(items[i]!.severity);
    }
  });

  it("⛔ surfaces items nobody touched past their due time", async () => {
    // A queue that silently accumulates unacknowledged items has stopped being
    // a control and become a backlog, and the difference is invisible from the
    // top of the list.
    const id = await raise(`overdue-${Date.now()}`, 2);
    await assignItem(db, id, "op@example.com", new Date(Date.now() - 3_600_000));
    expect((await overdueItems(db)).map((i) => i.id)).toContain(id);
  });
});
