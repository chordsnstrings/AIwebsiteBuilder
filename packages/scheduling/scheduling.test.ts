// MF10 — capacity and scheduling.
//
// `bookingNext` was written, unit-tested and reachable from POST /agent/turn,
// and it never offered anyone a slot, because `availableSlots` had no
// production supplier and `customer_calendars` had zero writers.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  addResource, availableSlots, blockTime, cancelBooking, claimSlot,
  connectCalendar, joinWaitlist, revokeCalendar, setWeeklyHours,
} from "./src/index.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let customerId: string;
// A Wednesday.
const MON = new Date("2026-09-07T00:00:00Z");
const win = { from: MON, to: new Date("2026-09-14T00:00:00Z") };
const noon = new Date("2026-09-06T12:00:00Z");

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,'Sched Co','GB','R2','no_site') RETURNING id`, [batch.id]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Sched Co','s@example.com','en-GB','Europe/London','active') RETURNING id`, [biz.id]);
  customerId = cust.id;
});
afterAll(async () => { await db?.close(); });

describe("⛔ a business with nothing configured offers nothing", () => {
  it("returns no slots rather than inventing them", async () => {
    // The pre-existing failure mode was the reverse: a booking machine that
    // could not be told when the business was open, so it asked for a contact
    // and promised a call back that nobody scheduled.
    expect(await availableSlots(db, customerId, win, { now: noon })).toEqual([]);
  });
});

describe("availability", () => {
  it("generates slots from weekly rules", async () => {
    await addResource(db, { customerId, name: "Chair 1", kind: "practitioner" });
    await setWeeklyHours(db, customerId, [
      { weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60, slotMinutes: 60 },
    ]);
    const slots = await availableSlots(db, customerId, win, { now: noon, limit: 10 });
    expect(slots.length).toBe(3);
    expect(slots[0]!.start).toBe("2026-09-07T09:00:00.000Z");
  });

  it("⛔ honours a lead time — nobody can book a slot starting in nine minutes", async () => {
    const justBefore = new Date("2026-09-07T08:30:00.000Z");
    const slots = await availableSlots(db, customerId, win, { now: justBefore, leadTimeMinutes: 120, limit: 10 });
    expect(slots.every((s) => new Date(s.start).getTime() >= justBefore.getTime() + 120 * 60_000)).toBe(true);
  });

  it("subtracts a blocked window", async () => {
    await blockTime(db, {
      customerId, startsAt: new Date("2026-09-07T09:00:00Z"), endsAt: new Date("2026-09-07T10:00:00Z"), reason: "dentist",
    });
    const slots = await availableSlots(db, customerId, win, { now: noon, limit: 10 });
    expect(slots.map((s) => s.start)).not.toContain("2026-09-07T09:00:00.000Z");
    expect(slots.map((s) => s.start)).toContain("2026-09-07T10:00:00.000Z");
  });
});

describe("⛔ capacity is counted, not assumed", () => {
  it("re-checks inside the transaction and refuses a taken slot", async () => {
    // Between the agent offering three o'clock and the visitor typing "yes"
    // there is a human pause of any length. A system that trusts its own
    // earlier answer double-books at exactly the busiest times.
    const resourceId = await addResource(db, { customerId, name: "Solo Room", kind: "room", capacity: 1 });
    const start = new Date("2026-09-08T09:00:00Z");
    const end = new Date("2026-09-08T10:00:00Z");
    const first = await claimSlot(db, { customerId, resourceId, start, end, contact: "a@x.com", idempotencyKey: `k1-${Date.now()}` });
    expect(first.booked).toBe(true);
    const second = await claimSlot(db, { customerId, resourceId, start, end, contact: "b@x.com", idempotencyKey: `k2-${Date.now()}` });
    expect(second.booked).toBe(false);
    expect(second.reason).toBe("slot_taken");
  });

  it("lets a class take its full capacity and no more", async () => {
    const resourceId = await addResource(db, { customerId, name: "Yoga Studio", kind: "room", capacity: 3 });
    const start = new Date("2026-09-09T18:00:00Z");
    const end = new Date("2026-09-09T19:00:00Z");
    for (let i = 0; i < 3; i++) {
      const r = await claimSlot(db, { customerId, resourceId, start, end, contact: `p${i}@x.com`, idempotencyKey: `y${i}-${Date.now()}` });
      expect(r.booked, `place ${i}`).toBe(true);
    }
    const fourth = await claimSlot(db, { customerId, resourceId, start, end, contact: "d@x.com", idempotencyKey: `y4-${Date.now()}` });
    expect(fourth.booked).toBe(false);
  });

  it("a replayed claim returns the same booking, not a second one", async () => {
    const resourceId = await addResource(db, { customerId, name: "Replay Room", kind: "room" });
    const key = `replay-${Date.now()}`;
    const args = { customerId, resourceId, start: new Date("2026-09-10T09:00:00Z"), end: new Date("2026-09-10T10:00:00Z"), contact: "r@x.com", idempotencyKey: key };
    const a = await claimSlot(db, args);
    const b = await claimSlot(db, args);
    expect(b.booked).toBe(true);
    expect(b.bookingId).toBe(a.bookingId);
  });
});

describe("waitlist", () => {
  it("⛔ surfaces whoever was waiting, and does NOT auto-book them", async () => {
    // Moving somebody into a slot they asked about last week without asking is
    // how a business gets a no-show and a complaint from the same person.
    const resourceId = await addResource(db, { customerId, name: "WL Room", kind: "room" });
    const start = new Date("2026-09-11T09:00:00Z");
    const end = new Date("2026-09-11T10:00:00Z");
    const booked = await claimSlot(db, { customerId, resourceId, start, end, contact: "held@x.com", idempotencyKey: `wl-${Date.now()}` });
    await joinWaitlist(db, {
      customerId, contact: "waiting@x.com",
      earliestAt: new Date("2026-09-11T08:00:00Z"), latestAt: new Date("2026-09-11T18:00:00Z"), resourceId,
    });
    const out = await cancelBooking(db, booked.bookingId!);
    expect(out.cancelled).toBe(true);
    expect(out.waiting.map((w) => w.contact)).toContain("waiting@x.com");
    // Nothing was booked on their behalf.
    const theirs = await db.query("SELECT 1 FROM bookings WHERE contact = 'waiting@x.com'");
    expect(theirs.rows.length).toBe(0);
  });
});

describe("calendars", () => {
  it("⛔ can actually be connected — the table had zero writers", async () => {
    const id = await connectCalendar(db, { customerId, provider: "google", externalRef: "cal-123" });
    expect(id).toBeTruthy();
    const row = await db.one<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM customer_calendars WHERE customer_id = $1 AND provider = 'google'", [customerId]);
    expect(row.revoked_at).toBeNull();
    expect(await revokeCalendar(db, customerId, "google")).toBe(true);
    expect(await revokeCalendar(db, customerId, "google"), "revoking twice is a no-op").toBe(false);
  });
});
