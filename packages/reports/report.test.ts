// Value-report tests (spec §58). The report is arithmetic over the ledger, so
// these tests seed rows and check the arithmetic — including the constraint that
// carries the most weight: a month where the numbers went down never carries an
// upsell.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { generateValueReport, suggestFor, EVENT_TYPES, WEB_FORM_CHANNEL } from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

/** The month under report and the month it is compared against. */
const MONTH = { year: 2026, month: 3 };
const PRIOR = { year: 2026, month: 2 };

/** A fixed instant inside a month — no clock reads anywhere in these tests. */
function at(m: { year: number; month: number }, day = 10): Date {
  return new Date(Date.UTC(m.year, m.month - 1, day, 12, 0, 0));
}

/** Keywords that cost the customer money if they reply. Must never appear in a down month. */
const UPSELL_KEYWORDS = ["BOOKING", "PAYMENTS"];

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

async function seedCustomer(): Promise<{ customerId: string; businessId: string }> {
  const batch = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
     VALUES ('demo','lic-1',1,0,'x') RETURNING id`,
  );
  const business = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('demo',$1,'Acme','US','R1','no_site') RETURNING id`,
    [batch.id],
  );
  const customer = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R1','Acme LLC',$2,'en-US','America/New_York','active') RETURNING id`,
    [business.id, `owner-${Math.random().toString(36).slice(2)}@acme.test`],
  );
  return { customerId: customer.id, businessId: business.id };
}

async function seedEvents(
  customerId: string,
  eventType: string,
  count: number,
  occurredAt: Date,
  payload: Record<string, unknown> = {},
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.query(
      `INSERT INTO events (event_type, occurred_at, subject_kind, subject_id, payload)
       VALUES ($1,$2,'customer',$3,$4)`,
      [eventType, occurredAt, customerId, JSON.stringify(payload)],
    );
  }
}

/** A website contact-form submission lands as an inbound message on the customer's conversation. */
async function seedFormSubmissions(customerId: string, count: number, sentAt: Date): Promise<void> {
  const convo = await db.one<{ id: string }>(
    `INSERT INTO conversations (customer_id, channel) VALUES ($1,'dashboard') RETURNING id`,
    [customerId],
  );
  for (let i = 0; i < count; i++) {
    await db.query(
      `INSERT INTO messages (conversation_id, direction, channel, body_r2_key, body_hash, idempotency_key, sent_at)
       VALUES ($1,'inbound',$2,$3,$4,$5,$6)`,
      [
        convo.id,
        WEB_FORM_CHANNEL,
        `r2/${customerId}/${sentAt.getTime()}/${i}`,
        `hash-${i}`,
        `idem-${customerId}-${sentAt.getTime()}-${i}`,
        sentAt,
      ],
    );
  }
}

async function seedBuild(businessId: string, customerId: string, createdAt: Date): Promise<void> {
  await db.query(
    `INSERT INTO builds (business_id, customer_id, mode, role_chain, first_pass, gate_results, cost_cents, artefact_r2_key, created_at)
     VALUES ($1,$2,'full','[]'::jsonb,true,'{}'::jsonb,0,'r2/build',$3)`,
    [businessId, customerId, createdAt],
  );
}

describe("value report — every figure comes from a query", () => {
  it("reports a seeded customer's month with numbers, not estimates", async () => {
    const { customerId, businessId } = await seedCustomer();

    // Prior month: the smaller baseline every delta is measured against.
    await seedEvents(customerId, EVENT_TYPES.visit, 20, at(PRIOR), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.call, 3, at(PRIOR));
    await seedEvents(customerId, EVENT_TYPES.booking, 1, at(PRIOR));
    await seedEvents(customerId, EVENT_TYPES.payment, 1, at(PRIOR), { amount_cents: "6000" });
    await seedFormSubmissions(customerId, 1, at(PRIOR));

    // Reported month.
    await seedEvents(customerId, EVENT_TYPES.visit, 18, at(MONTH), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.visit, 9, at(MONTH), { source: "ai_assistants" });
    await seedEvents(customerId, EVENT_TYPES.visit, 7, at(MONTH), { source: "referral" });
    await seedEvents(customerId, EVENT_TYPES.visit, 6, at(MONTH), {}); // no source => direct
    await seedEvents(customerId, EVENT_TYPES.call, 6, at(MONTH));
    await seedEvents(customerId, EVENT_TYPES.booking, 2, at(MONTH));
    await seedEvents(customerId, EVENT_TYPES.payment, 2, at(MONTH), { amount_cents: "6000" });
    await seedFormSubmissions(customerId, 3, at(MONTH));
    await seedEvents(customerId, EVENT_TYPES.searchQuery, 4, at(MONTH), { query: "emergency plumber" });
    await seedEvents(customerId, EVENT_TYPES.searchQuery, 2, at(MONTH), { query: "boiler service" });
    await seedEvents(customerId, EVENT_TYPES.aiProbe, 2, at(MONTH), { appears: "true" });
    await seedEvents(customerId, EVENT_TYPES.aiProbe, 2, at(MONTH), { appears: "false" });
    await seedBuild(businessId, customerId, at(MONTH));

    const report = await generateValueReport(db, customerId, MONTH);

    expect(report.customerId).toBe(customerId);
    expect(report.period).toEqual({
      year: 2026,
      month: 3,
      startsAt: "2026-03-01T00:00:00.000Z",
      endsAt: "2026-04-01T00:00:00.000Z",
    });

    // Every headline figure is a finite number.
    for (const key of ["visits", "calls", "formSubmissions", "bookings", "paymentsProcessedCents"] as const) {
      expect(typeof report[key], key).toBe("number");
      expect(Number.isFinite(report[key]), key).toBe(true);
    }

    expect(report.visits).toBe(40);
    expect(report.calls).toBe(6);
    expect(report.formSubmissions).toBe(3);
    expect(report.bookings).toBe(2);
    expect(report.paymentsProcessedCents).toBe(12000);

    // Deltas are this month minus last month, and every one is a number.
    expect(report.previous).toEqual({
      visits: 20,
      calls: 3,
      formSubmissions: 1,
      bookings: 1,
      paymentsProcessedCents: 6000,
    });
    expect(report.momDelta).toEqual({
      visits: 20,
      calls: 3,
      formSubmissions: 2,
      bookings: 1,
      paymentsProcessedCents: 6000,
    });
    for (const v of Object.values(report.momDelta)) expect(typeof v).toBe("number");

    // The four traffic buckets account for every visit.
    expect(report.sources).toEqual({ direct: 6, search: 18, aiAssistants: 9, referral: 7 });
    const bucketed = Object.values(report.sources).reduce((a, b) => a + b, 0);
    expect(bucketed).toBe(report.visits);

    // Ordered by frequency, ties broken on the text.
    expect(report.topQueries).toEqual(["emergency plumber", "boiler service"]);
    expect(report.aiVisibility).toEqual({ appearsIn: 2, tracked: 4 });
  });

  it("returns zeros — not nulls or guesses — for a customer with no activity", async () => {
    const { customerId } = await seedCustomer();
    const report = await generateValueReport(db, customerId, MONTH);

    expect(report.visits).toBe(0);
    expect(report.calls).toBe(0);
    expect(report.formSubmissions).toBe(0);
    expect(report.bookings).toBe(0);
    expect(report.paymentsProcessedCents).toBe(0);
    expect(report.momDelta).toEqual({
      visits: 0,
      calls: 0,
      formSubmissions: 0,
      bookings: 0,
      paymentsProcessedCents: 0,
    });
    expect(report.sources).toEqual({ direct: 0, search: 0, aiAssistants: 0, referral: 0 });
    expect(report.topQueries).toEqual([]);
    expect(report.aiVisibility).toEqual({ appearsIn: 0, tracked: 0 });
    // Nothing happened, so there is nothing to suggest. No manufactured pitch.
    expect(report.suggestion).toBeNull();
  });
});

describe("value report — exactly one suggested action", () => {
  it("carries a single one-word reply keyword drawn from the customer's own data", async () => {
    const { customerId } = await seedCustomer();
    // Growth month with no booking widget: the rule offers to add one.
    await seedEvents(customerId, EVENT_TYPES.visit, 5, at(PRIOR), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.visit, 30, at(MONTH), { source: "search" });

    const report = await generateValueReport(db, customerId, MONTH);
    expect(report.suggestion).not.toBeNull();
    const s = report.suggestion!;

    expect(typeof s.text).toBe("string");
    expect(s.text.length).toBeGreaterThan(0);
    // One word, upper case, no spaces — it is typed as an SMS/email reply.
    expect(s.replyKeyword).toMatch(/^[A-Z]+$/);
    expect(s.replyKeyword.split(/\s+/)).toHaveLength(1);
    // The text tells the customer the keyword, and cites their own figure.
    expect(s.text).toContain(s.replyKeyword);
    expect(s.text).toContain("30");
    expect(s.replyKeyword).toBe("BOOKING");
    // A genuinely good month may carry an upsell — which is what makes the
    // down-month rule below meaningful.
    expect(s.upsell).toBe(true);
  });

  it("suggests the free AI-visibility fix ahead of anything billable", async () => {
    const { customerId } = await seedCustomer();
    await seedEvents(customerId, EVENT_TYPES.visit, 5, at(PRIOR), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.visit, 25, at(MONTH), { source: "ai_assistants" });
    await seedEvents(customerId, EVENT_TYPES.aiProbe, 1, at(MONTH), { appears: "true" });
    await seedEvents(customerId, EVENT_TYPES.aiProbe, 3, at(MONTH), { appears: "false" });

    const report = await generateValueReport(db, customerId, MONTH);
    expect(report.suggestion?.replyKeyword).toBe("VISIBILITY");
    expect(report.suggestion?.upsell).toBe(false);
    expect(report.suggestion?.text).toContain("1 of the 4");
  });
});

describe("value report — no upsell in a down month (spec §58)", () => {
  it("offers a free review instead of selling when metrics fall", async () => {
    const { customerId } = await seedCustomer();
    // A strong prior month, a weak reported month.
    await seedEvents(customerId, EVENT_TYPES.visit, 30, at(PRIOR), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.call, 8, at(PRIOR));
    await seedEvents(customerId, EVENT_TYPES.visit, 10, at(MONTH), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.call, 2, at(MONTH));

    const report = await generateValueReport(db, customerId, MONTH);
    expect(report.momDelta.visits).toBe(-20);
    expect(report.momDelta.calls).toBe(-6);

    // The suggestion is either absent or explicitly not an upsell — never a pitch.
    const s = report.suggestion;
    expect(s === null || s.upsell === false).toBe(true);
    expect(s?.upsell).toBe(false);
    expect(s?.replyKeyword).toBe("REVIEW");
    expect(UPSELL_KEYWORDS).not.toContain(s?.replyKeyword);
    // It names the figure that actually moved.
    expect(s?.text).toContain("30");
    expect(s?.text).toContain("10");
    expect(s?.text).toContain("no charge");
  });

  it("suppresses the upsell even when only one metric is down and the rest grew", async () => {
    const { customerId } = await seedCustomer();
    // Visits and calls up, bookings down by one. Still a down month.
    await seedEvents(customerId, EVENT_TYPES.visit, 10, at(PRIOR), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.booking, 3, at(PRIOR));
    await seedEvents(customerId, EVENT_TYPES.visit, 40, at(MONTH), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.call, 5, at(MONTH));
    await seedEvents(customerId, EVENT_TYPES.booking, 1, at(MONTH));

    const report = await generateValueReport(db, customerId, MONTH);
    expect(report.momDelta.visits).toBe(30);
    expect(report.momDelta.bookings).toBe(-2);
    expect(report.suggestion?.upsell).toBe(false);
    expect(UPSELL_KEYWORDS).not.toContain(report.suggestion?.replyKeyword);
  });

  it("never returns an upsell for any down-month shape (rule-level check)", () => {
    const base = { visits: 10, calls: 4, formSubmissions: 2, bookings: 0, paymentsProcessedCents: 0 };
    const metrics = ["visits", "calls", "formSubmissions", "bookings", "paymentsProcessedCents"] as const;
    for (const down of metrics) {
      const previous = { ...base, [down]: base[down] + 5 };
      const delta = {
        visits: base.visits - previous.visits,
        calls: base.calls - previous.calls,
        formSubmissions: base.formSubmissions - previous.formSubmissions,
        bookings: base.bookings - previous.bookings,
        paymentsProcessedCents: base.paymentsProcessedCents - previous.paymentsProcessedCents,
      };
      const s = suggestFor({
        current: base,
        previous,
        delta,
        // Conditions that would otherwise trigger the billable suggestions.
        sources: { direct: 10, search: 0, aiAssistants: 0, referral: 0 },
        topQueries: ["emergency plumber"],
        aiVisibility: { appearsIn: 0, tracked: 3 },
        buildsThisMonth: 0,
      });
      expect(s === null || s.upsell === false, `down on ${down}`).toBe(true);
    }
  });
});

describe("value report — deterministic", () => {
  it("produces byte-identical output on two runs over the same data", async () => {
    const { customerId, businessId } = await seedCustomer();
    await seedEvents(customerId, EVENT_TYPES.visit, 4, at(PRIOR), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.visit, 11, at(MONTH), { source: "search" });
    await seedEvents(customerId, EVENT_TYPES.visit, 3, at(MONTH), { source: "referral" });
    await seedEvents(customerId, EVENT_TYPES.call, 2, at(MONTH));
    await seedEvents(customerId, EVENT_TYPES.booking, 1, at(MONTH));
    await seedEvents(customerId, EVENT_TYPES.payment, 1, at(MONTH), { amount_cents: "4500" });
    await seedFormSubmissions(customerId, 2, at(MONTH));
    // Equal counts force the tie-break, which must be stable across runs.
    await seedEvents(customerId, EVENT_TYPES.searchQuery, 2, at(MONTH), { query: "zebra service" });
    await seedEvents(customerId, EVENT_TYPES.searchQuery, 2, at(MONTH), { query: "apple service" });
    await seedEvents(customerId, EVENT_TYPES.aiProbe, 3, at(MONTH), { appears: "true" });
    await seedBuild(businessId, customerId, at(MONTH));

    const first = await generateValueReport(db, customerId, MONTH);
    const second = await generateValueReport(db, customerId, MONTH);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.topQueries).toEqual(["apple service", "zebra service"]);
  });

  it("ignores rows outside the reported month", async () => {
    const { customerId } = await seedCustomer();
    // One second before the month starts and one second after it ends.
    await seedEvents(customerId, EVENT_TYPES.visit, 5, new Date(Date.UTC(2026, 1, 28, 23, 59, 59)));
    await seedEvents(customerId, EVENT_TYPES.visit, 7, new Date(Date.UTC(2026, 3, 1, 0, 0, 0)));
    await seedEvents(customerId, EVENT_TYPES.visit, 2, at(MONTH));

    const report = await generateValueReport(db, customerId, MONTH);
    expect(report.visits).toBe(2);
    // The February rows are the prior-month baseline, not this month's.
    expect(report.previous.visits).toBe(5);
  });

  it("counts only this customer's rows", async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    await seedEvents(a.customerId, EVENT_TYPES.visit, 3, at(MONTH));
    await seedEvents(b.customerId, EVENT_TYPES.visit, 9, at(MONTH));

    expect((await generateValueReport(db, a.customerId, MONTH)).visits).toBe(3);
    expect((await generateValueReport(db, b.customerId, MONTH)).visits).toBe(9);
  });

  it("rolls the comparison month back across a year boundary", async () => {
    const { customerId } = await seedCustomer();
    await seedEvents(customerId, EVENT_TYPES.visit, 6, new Date(Date.UTC(2025, 11, 15, 12)));
    await seedEvents(customerId, EVENT_TYPES.visit, 8, new Date(Date.UTC(2026, 0, 15, 12)));

    const report = await generateValueReport(db, customerId, { year: 2026, month: 1 });
    expect(report.visits).toBe(8);
    expect(report.previous.visits).toBe(6);
    expect(report.momDelta.visits).toBe(2);
  });
});
