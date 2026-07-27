// Billing tests (spec §29, §36, §37). Note the import list below: this file
// deliberately does NOT import @adw/gateway or @adw/agents — the REFUND path is
// a rule, not an agent, and a static scan of the source enforces that too.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { config } from "@adw/config";
import { setSinkForTesting } from "@adw/telemetry";
import {
  advanceDunning,
  createSubscription,
  dunningSteps,
  handleInboundKeyword,
  requestCancellation,
  resolveDunning,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const DAY_MS = 24 * 60 * 60 * 1000;
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  setSinkForTesting({ emit: async () => {} });
});
afterAll(async () => {
  setSinkForTesting(null);
  await db?.close();
});

async function seedCustomer(
  opts: { region?: string; wonAt?: Date; status?: string } = {},
): Promise<string> {
  const region = opts.region ?? "R1";
  const batch = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
     VALUES ('demo','lic-1',1,0,'x') RETURNING id`,
  );
  const business = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('demo',$1,'Acme','US',$2,'no_site') RETURNING id`,
    [batch.id, region],
  );
  const customer = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status, won_at)
     VALUES ($1,$2,'Acme LLC',$3,'en-US','America/New_York',$4,$5) RETURNING id`,
    [
      business.id,
      region,
      `owner-${Math.random().toString(36).slice(2)}@acme.test`,
      opts.status ?? "active",
      opts.wonAt ?? new Date(),
    ],
  );
  return customer.id;
}

async function seedSubscription(customerId: string, region = "R1"): Promise<string> {
  const sub = await db.one<{ id: string }>(
    `INSERT INTO subscriptions
       (customer_id, plan_code, billing_interval, amount_cents, currency, status, current_period_end)
     VALUES ($1,'standard','month',6500,'USD','past_due', now() + interval '30 days')
     RETURNING id`,
    [customerId],
  );
  return sub.id;
}

describe("§36 REFUND keyword handler (rule, not agent)", () => {
  it("REFUND within 30 days ⇒ refund created, customer refunded, ZERO agent invocations", async () => {
    const wonAt = new Date(Date.now() - 5 * DAY_MS);
    const customerId = await seedCustomer({ region: "R1", wonAt, status: "active" });

    const res = await handleInboundKeyword(db, {
      customerId,
      emailBody: "REFUND",
      receivedAt: new Date(),
    });
    expect(res.refunded).toBe(true);
    expect(res.refundId).toBeDefined();

    const refund = await db.one<{ amount_cents: number; reason: string; requested_via: string; auto_approved: boolean }>(
      "SELECT amount_cents, reason, requested_via, auto_approved FROM refunds WHERE id = $1",
      [res.refundId],
    );
    expect(refund.amount_cents).toBe(config.pricing().data.R1!.build_fee_cents);
    expect(refund.reason).toBe("guarantee");
    expect(refund.requested_via).toBe("email_keyword");
    expect(refund.auto_approved).toBe(true);

    const customer = await db.one<{ status: string }>("SELECT status FROM customers WHERE id = $1", [customerId]);
    expect(customer.status).toBe("refunded");
  });

  it("case-insensitive and tolerates trailing text", async () => {
    const customerId = await seedCustomer({ region: "R2", wonAt: new Date(Date.now() - DAY_MS), status: "active" });
    const res = await handleInboundKeyword(db, {
      customerId,
      emailBody: "  refund please, this isn't working  ",
      receivedAt: new Date(),
    });
    expect(res.refunded).toBe(true);
  });

  it("REFUND after 30 days ⇒ no refund", async () => {
    const wonAt = new Date(Date.now() - 45 * DAY_MS);
    const customerId = await seedCustomer({ region: "R1", wonAt, status: "active" });
    const res = await handleInboundKeyword(db, {
      customerId,
      emailBody: "REFUND",
      receivedAt: new Date(),
    });
    expect(res.refunded).toBe(false);
    const count = await db.one<{ n: string }>("SELECT count(*) AS n FROM refunds WHERE customer_id = $1", [customerId]);
    expect(Number(count.n)).toBe(0);
  });

  it("non-REFUND body ⇒ no refund", async () => {
    const customerId = await seedCustomer({ region: "R1", wonAt: new Date(), status: "active" });
    const res = await handleInboundKeyword(db, {
      customerId,
      emailBody: "when will my site be ready?",
      receivedAt: new Date(),
    });
    expect(res.refunded).toBe(false);
  });

  it("the billing source imports no agent/model dependency (spec §36)", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const content = readFileSync(join(srcDir, f), "utf8");
      // Match real import specifiers only, not prose in comments.
      expect(content).not.toMatch(/from\s+["']@adw\/(gateway|agents)["']/);
    }
  });
});

describe("§29 dunning schedule", () => {
  it("has the 5-step schedule with correct offsets and channels", () => {
    const steps = dunningSteps();
    expect(steps.map((s) => s.offsetDays)).toEqual([0, 3, 5, 7, 14]);
    expect(steps[2]!.channels).toEqual(["email", "sms"]);
    expect(steps[3]!.final).toBe(true);
    expect(steps[4]!.pausesSite).toBe(true);
  });

  it("never sets pause before the day-14 step", async () => {
    const customerId = await seedCustomer();
    const subId = await seedSubscription(customerId);

    // Steps 1..4 — pause_at must stay null.
    for (let i = 1; i <= 4; i++) {
      const state = await advanceDunning(db, subId);
      expect(state.step).toBe(i);
      expect(state.pause_at).toBeNull();
    }
    // Step 5 — now the site pauses.
    const paused = await advanceDunning(db, subId);
    expect(paused.step).toBe(5);
    expect(paused.pause_at).not.toBeNull();
  });

  it("resolveDunning restores the subscription and clears state", async () => {
    const customerId = await seedCustomer();
    const subId = await seedSubscription(customerId);
    await advanceDunning(db, subId);
    await advanceDunning(db, subId);
    await resolveDunning(db, subId);

    const state = await db.one<{ step: number; pause_at: string | null; status: string }>(
      "SELECT step, pause_at, status FROM dunning_state WHERE subscription_id = $1",
      [subId],
    );
    expect(state.step).toBe(0);
    expect(state.pause_at).toBeNull();
    expect(state.status).toBe("active");
    const sub = await db.one<{ status: string }>("SELECT status FROM subscriptions WHERE id = $1", [subId]);
    expect(sub.status).toBe("active");
  });
});

describe("§29 cancellation (two-click, no gauntlet)", () => {
  it("sets cancel_at_period_end and returns the period end", async () => {
    const customerId = await seedCustomer();
    const subId = await seedSubscription(customerId);
    const periodEnd = await requestCancellation(db, subId);
    expect(periodEnd).toBeInstanceOf(Date);

    const sub = await db.one<{ cancel_at_period_end: boolean }>(
      "SELECT cancel_at_period_end FROM subscriptions WHERE id = $1",
      [subId],
    );
    expect(sub.cancel_at_period_end).toBe(true);
  });
});

describe("§29 subscription creation uses region pricing", () => {
  it("prices a monthly subscription from the region's mrr_cents", async () => {
    const customerId = await seedCustomer({ region: "R3" });
    const sub = await createSubscription(db, { customerId, region: "R3", interval: "month" });
    expect(sub.amount_cents).toBe(config.pricing().data.R3!.mrr_cents);
    expect(sub.currency).toBe("USD");
    expect(sub.status).toBe("active");
  });

  it("R1 monthly differs from R3 monthly (region-specific)", async () => {
    const customerId = await seedCustomer({ region: "R1" });
    const sub = await createSubscription(db, { customerId, region: "R1", interval: "month" });
    expect(sub.amount_cents).toBe(config.pricing().data.R1!.mrr_cents);
    expect(config.pricing().data.R1!.mrr_cents).not.toBe(config.pricing().data.R3!.mrr_cents);
  });
});
