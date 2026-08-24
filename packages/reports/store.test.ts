// ⛔ `@adw/reports` had ZERO consumers. Generated, tested, exported, and
// imported by nothing anywhere in the repository — no job produced a report, no
// table held one, no route served one, no screen showed one. The one artefact
// that answers "what did I get for my money", which is the question that
// decides whether a subscription renews, and it had never existed for a single
// customer.
//
// These tests are about the sweep that fixed that, and specifically the ways it
// could go wrong quietly: twelve copies of January, a month that has not
// finished, a customer silently dropped from a pass.
//
// ⛔ Every assertion is scoped to a customer this file created, or is an
// accounting identity. The shared test database carries thousands of customers
// left by other suites, and a global count over it is the same "ask a capped
// list and believe the answer" mistake that has already produced three real
// bugs in this repo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import { latestReport, reportsFor, storeValueReport, sweepValueReports } from "./src/index.ts";
import { generateValueReport } from "./src/value-report.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

async function seedCustomer(status = "active"): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical, phone_e164, city)
     VALUES ('d',$1,'Report Plumbing','GB','R1','no_site','plumber','+447700900000','Leeds') RETURNING id`,
    [batch.id],
  );
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R1','Report Plumbing',$2,'en-GB','Europe/London',$3) RETURNING id`,
    [biz.id, `report_${randomUUID()}@example.com`, status],
  );
  return cust.id;
}

/**
 * Run the sweep for one customer only, by generating and storing exactly what
 * the sweep would. Keeps the assertions about behaviour rather than about how
 * many rows other suites happen to have left lying around.
 */
async function sweepOne(customerId: string, month: { year: number; month: number }): Promise<boolean> {
  const report = await generateValueReport(db, customerId, month);
  return (await storeValueReport(db, report, month)).stored;
}

describe("the monthly sweep", () => {
  it("⛔ reports the last CLOSED month, never the one still running", async () => {
    // A figure that changes after the customer reads it is not a figure. §58's
    // premise is that every number is checkable, and a month in progress is not.
    expect((await sweepValueReports(db, new Date("2026-08-24T09:00:00Z"), { limit: 1 })).month)
      .toEqual({ year: 2026, month: 7 });
    // And across a year boundary.
    expect((await sweepValueReports(db, new Date("2026-01-15T09:00:00Z"), { limit: 1 })).month)
      .toEqual({ year: 2025, month: 12 });
  });

  it("stores one report per customer per month, however often the job runs", async () => {
    const customerId = await seedCustomer();
    const month = { year: 2026, month: 7 };

    expect(await sweepOne(customerId, month)).toBe(true);
    const stored = await latestReport(db, customerId);
    expect(stored?.month).toEqual(month);
    expect(stored?.report.customerId).toBe(customerId);

    // ⛔ The job is HOURLY. Re-inserting on every pass would hand this customer
    // several hundred copies of July before August ended.
    expect(await sweepOne(customerId, month)).toBe(false);
    expect(await sweepOne(customerId, month)).toBe(false);
    expect(await reportsFor(db, customerId)).toHaveLength(1);
  });

  it("⛔ accounts for every customer it considered", async () => {
    // The denominator is the point. "0 generated" over 0 eligible customers is
    // a quiet Tuesday; over 200 it is an outage, and a bare count cannot tell
    // them apart. The identity below is what makes the number readable: nobody
    // considered may be silently dropped.
    await seedCustomer();
    const out = await sweepValueReports(db, new Date("2026-06-10T09:00:00Z"), { limit: 25 });
    expect(out.generated + out.skipped + out.errors).toBe(out.considered);
    expect(out.considered).toBeGreaterThan(0);
  });

  it("⛔ does not restate a month the customer has already read", async () => {
    const customerId = await seedCustomer();
    const month = { year: 2025, month: 3 };
    const report = await generateValueReport(db, customerId, month);
    expect((await storeValueReport(db, report, month)).stored).toBe(true);

    // A second store of the same month is refused rather than overwriting: the
    // customer may already have read those figures.
    const restated = { ...report, visits: report.visits + 9999 };
    expect((await storeValueReport(db, restated, month)).stored).toBe(false);
    const back = await reportsFor(db, customerId);
    expect(back.find((r) => r.month.month === 3)?.report.visits).toBe(report.visits);
  });

  it("leaves a churned customer out — we do not report on an account that left", async () => {
    const churned = await seedCustomer("churned");
    const eligible = await db.maybeOne(
      "SELECT 1 AS x FROM customers WHERE id = $1 AND status = 'active'", [churned],
    );
    expect(eligible).toBeNull();
    await sweepValueReports(db, new Date("2026-05-04T09:00:00Z"), { limit: 25 });
    expect(await reportsFor(db, churned)).toHaveLength(0);
  });
});
