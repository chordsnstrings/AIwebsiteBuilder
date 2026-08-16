// MF11 — telephony.
//
// The smallest family in the catalogue, and almost all of its value is in one
// unit: a missed call at a trade business is a customer who has already decided
// to buy and is now dialling the next number on the list.
//
// The assertions are about what this DOES NOT do. There is no SMS transport in
// this system, and a missed-call text-back that reported success while sending
// nothing would be the exact failure this codebase keeps finding.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { markReturned, missedCalls, normaliseNumber, phoneHash, recordCall } from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
const uniq = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

async function makeCustomer(): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,$2,'GB','R2','no_site','plumber') RETURNING id`, [batch.id, `Voice ${uniq()}`]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Voice Co',$2,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, `v${uniq()}@example.com`]);
  return cust.id;
}

const call = (customerId: string, over: Record<string, unknown> = {}) => ({
  customerId,
  provider: "sim",
  providerCallId: `c-${uniq()}`,
  outcome: "missed" as const,
  callerNumber: "+44 20 7946 0000",
  startedAt: new Date(),
  ...over,
});

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });

describe("recording a call", () => {
  it("turns a missed call into an enquiry the owner can see", async () => {
    const customerId = await makeCustomer();
    const out = await recordCall(db, call(customerId));
    expect(out.created).toBe(true);
    expect(out.enquiryId).not.toBeNull();
    const [missed] = await missedCalls(db, customerId);
    expect(missed!.callerNumber).toBe("+442079460000");
  });

  it("does not raise an enquiry for a call somebody answered", async () => {
    const customerId = await makeCustomer();
    const out = await recordCall(db, call(customerId, { outcome: "answered", durationSeconds: 180 }));
    expect(out.enquiryId).toBeNull();
    expect((await missedCalls(db, customerId)).length).toBe(0);
  });

  it("⛔ a redelivered webhook is the same call, not a second one", async () => {
    // A second enquiry for one missed call is the owner ringing the same person
    // twice, which reads to that person as a business that does not know what
    // it is doing.
    const customerId = await makeCustomer();
    const event = call(customerId);
    const first = await recordCall(db, event);
    const second = await recordCall(db, event);
    expect(second.created).toBe(false);
    expect(second.callId).toBe(first.callId);
    expect((await missedCalls(db, customerId)).length).toBe(1);
  });

  it("carries a voicemail transcript into the enquiry", async () => {
    const customerId = await makeCustomer();
    const out = await recordCall(db, call(customerId, {
      outcome: "voicemail", transcript: "Hi, my boiler is leaking, please call back.",
    }));
    const row = await db.one<{ need: string }>("SELECT need FROM enquiries WHERE id = $1", [out.enquiryId]);
    expect(row.need).toMatch(/boiler is leaking/);
  });

  it("⛔ does not infer urgency from the fact that somebody rang", async () => {
    // A missed call at 3am is not automatically an emergency, and an enquiry
    // queue where everything is urgent has no ordering.
    const customerId = await makeCustomer();
    const out = await recordCall(db, call(customerId, {
      startedAt: new Date("2026-05-01T03:00:00Z"), transcript: "EMERGENCY! Water everywhere!!",
    }));
    const row = await db.one<{ urgency: string }>("SELECT urgency FROM enquiries WHERE id = $1", [out.enquiryId]);
    expect(row.urgency).toBe("normal");
  });

  it("normalises and hashes the caller's number", () => {
    expect(normaliseNumber("+44 (20) 7946-0000")).toBe("+442079460000");
    expect(phoneHash("+44 20 7946 0000").equals(phoneHash("+442079460000"))).toBe(true);
  });
});

describe("⛔ the text-back asks the gate and stops", () => {
  it("records a real denial rather than reporting a send", async () => {
    // There is no SMS transport in this system. A text-back that reported
    // success while sending nothing is the exact failure this codebase keeps
    // finding; a recorded denial is a true statement about today and a working
    // system the day a legal basis and a transport exist.
    const customerId = await makeCustomer();
    const out = await recordCall(db, call(customerId), { attemptFollowUp: true });
    expect(out.followUp).not.toBeNull();
    expect(out.followUp!.allowed).toBe(false);
    expect(out.followUp!.decisionId).toBeTruthy();
    // ⛔ Pinned to the reason, not merely to "denied". Asserting only that it
    // was refused would keep passing if the refusal moved to CONTENT_UNSAFE or
    // MARKET_NOT_ENABLED, and this family's whole claim is that the missing
    // piece is an SMS legal basis rather than anything about the message.
    expect(out.followUp!.reason).toBe("NO_LEGAL_BASIS");

    const row = await db.one<{ gate_decision_id: string | null; gate_reason: string | null; followed_up: boolean }>(
      "SELECT gate_decision_id, gate_reason, followed_up FROM calls WHERE id = $1", [out.callId]);
    expect(row.gate_decision_id).toBeTruthy();
    expect(row.gate_reason).toBeTruthy();
    // ⛔ `followed_up` stays FALSE. The owner's list must still show this call
    // as needing a call back, because nothing was actually said to anyone.
    expect(row.followed_up).toBe(false);
  });

  it("tells the owner WHY nothing was sent", async () => {
    // An automation that quietly does nothing is worse than one that says what
    // it will not do.
    const customerId = await makeCustomer();
    await recordCall(db, call(customerId), { attemptFollowUp: true });
    const [missed] = await missedCalls(db, customerId);
    expect(missed!.gateReason).toBeTruthy();
  });

  it("⛔ a suppressed caller is denied on the suppression rule", async () => {
    // The gate reads emailHash unconditionally; passing a zero buffer here
    // would have made every caller look unsuppressed regardless of what they
    // had asked for.
    const customerId = await makeCustomer();
    const number = `+4479${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    await db.query("INSERT INTO suppression (email_hash, phone_hash, reason) VALUES ($1,$1,'unsubscribe')",
      [phoneHash(number)]);
    const out = await recordCall(db, call(customerId, { callerNumber: number }), { attemptFollowUp: true });
    expect(out.followUp!.reason).toBe("SUPPRESSED");
  });

  it("does not attempt a text-back unless asked to", async () => {
    const customerId = await makeCustomer();
    const out = await recordCall(db, call(customerId));
    expect(out.followUp).toBeNull();
  });
});

describe("closing the loop", () => {
  it("marks a call returned and closes the enquiry with it", async () => {
    const customerId = await makeCustomer();
    const out = await recordCall(db, call(customerId));
    expect(await markReturned(db, out.callId)).toBe(true);
    const row = await db.one<{ status: string }>("SELECT status FROM enquiries WHERE id = $1", [out.enquiryId]);
    expect(row.status).toBe("contacted");
    expect((await missedCalls(db, customerId)).length).toBe(0);
  });
});
