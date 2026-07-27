import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import {
  acceptTos,
  buildPrefill,
  conformanceCheck,
  createAccount,
  handleAcceptanceWebhook,
  MockSecondaryRail,
  MockStripeRail,
  monitorRisk,
  preScreen,
  runIntegrationTest,
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

/** Insert a business + customer, return the customer id and legal name. */
async function makeCustomer(legalName = "Acme Plumbing", country = "US"): Promise<{ customerId: string; legalName: string }> {
  const batch = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
     VALUES ('d','l',1,0,'x') RETURNING id`,
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,$2,$3,'R1','no_site') RETURNING id`,
    [batch.id, legalName, country],
  );
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'US',$2,$3,'en-US','America/New_York','active') RETURNING id`,
    [biz.id, legalName, `c${Math.random().toString(36).slice(2)}@example.com`],
  );
  return { customerId: cust.id, legalName };
}

function prefillFor(customerId: string, legalName: string, businessType: "company" | "individual" = "company") {
  return buildPrefill({
    id: customerId,
    legalName,
    url: "https://acme.example",
    mcc: "5045",
    countryCode: "US",
    businessType,
  });
}

describe("rail conformance (spec §14.1 invariants)", () => {
  it("passes for MockStripeRail and MockSecondaryRail", async () => {
    expect((await conformanceCheck(new MockStripeRail())).ok).toBe(true);
    expect((await conformanceCheck(new MockSecondaryRail())).ok).toBe(true);
  });

  it("rejects a destination-charge account", async () => {
    // A rail that opens a non-direct (destination) account violates invariant 1.
    class DestinationRail extends MockStripeRail {
      override async createMerchantAccount(prefill: Parameters<MockStripeRail["createMerchantAccount"]>[0]) {
        const created = await super.createMerchantAccount(prefill);
        return { ...created, chargeType: "destination" as unknown as "direct" };
      }
    }
    const result = await conformanceCheck(new DestinationRail());
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("INV1_charge_type_not_direct");
  });
});

describe("pre-screen (commercial filter)", () => {
  it("declines a prohibited category silently (no reason)", async () => {
    const r = await preScreen(db, {
      customerId: randomUUID(),
      category: "gambling",
      registryHit: true,
      countryCode: "US",
    });
    expect(r.offered).toBe(false);
    expect(r.businessType).toBeUndefined();
    // Silent: the result carries no reason field at all.
    expect(Object.prototype.hasOwnProperty.call(r, "reason")).toBe(false);
  });

  it("routes entity type by registryHit", async () => {
    const company = await preScreen(db, {
      customerId: randomUUID(),
      category: "trades",
      registryHit: true,
      countryCode: "US",
    });
    expect(company).toEqual({ offered: true, businessType: "company" });

    const individual = await preScreen(db, {
      customerId: randomUUID(),
      category: "trades",
      registryHit: false,
      countryCode: "US",
    });
    expect(individual).toEqual({ offered: true, businessType: "individual" });
  });

  it("does not offer to an unlicensed AE business", async () => {
    const r = await preScreen(db, {
      customerId: randomUUID(),
      category: "trades",
      registryHit: true,
      countryCode: "AE",
      licensed: false,
    });
    expect(r.offered).toBe(false);
  });
});

describe("onboarding", () => {
  it("createAccount inserts a merchant_accounts row with charge_type='direct'", async () => {
    const { customerId, legalName } = await makeCustomer();
    const rail = new MockStripeRail();
    const res = await createAccount(db, rail, customerId, prefillFor(customerId, legalName));

    const row = await db.one<{
      charge_type: string;
      requirement_collection: string;
      statement_descriptor: string;
      rail_id: string;
      business_type: string;
      tos_acceptance: unknown;
    }>(
      `SELECT charge_type, requirement_collection, statement_descriptor, rail_id, business_type, tos_acceptance
         FROM merchant_accounts WHERE id = $1`,
      [res.accountId],
    );
    expect(row.charge_type).toBe("direct");
    expect(row.requirement_collection).toBe("stripe");
    expect(row.statement_descriptor).toBe("Acme Plumbing");
    expect(row.rail_id).toBe("stripe");
    expect(row.business_type).toBe("company");
    expect(row.tos_acceptance).toBeNull();
  });

  it("tos_acceptance cannot be written directly, only via adw_accept_tos", async () => {
    const { customerId, legalName } = await makeCustomer();
    const res = await createAccount(db, new MockStripeRail(), customerId, prefillFor(customerId, legalName));

    // A raw UPDATE is blocked by the single-writer trigger.
    await expect(
      db.query("UPDATE merchant_accounts SET tos_acceptance = $2::jsonb WHERE id = $1", [
        res.accountId,
        JSON.stringify({ date: "2026-07-27T00:00:00Z", ip: "1.2.3.4" }),
      ]),
    ).rejects.toThrow(/webhook/);

    // The blessed path succeeds.
    await acceptTos(db, res.accountId, { date: "2026-07-27T00:00:00Z", ip: "1.2.3.4" });
    const row = await db.one<{ tos_acceptance: { ip: string } | null }>(
      "SELECT tos_acceptance FROM merchant_accounts WHERE id = $1",
      [res.accountId],
    );
    expect(row.tos_acceptance).not.toBeNull();
    expect(row.tos_acceptance?.ip).toBe("1.2.3.4");
  });

  it("acceptance webhook records tos only on a genuine, signed event", async () => {
    const { customerId, legalName } = await makeCustomer();
    const rail = new MockStripeRail();
    const res = await createAccount(db, rail, customerId, prefillFor(customerId, legalName));

    // A tampered (bad-signature) webhook is ignored.
    const tampered = { body: JSON.stringify({ type: "tos.accepted", accountId: res.externalAccountId }), signature: "nope" };
    expect((await handleAcceptanceWebhook(db, rail, tampered)).accepted).toBe(false);

    // A genuine signed acceptance event writes tos_acceptance.
    const signed = rail.dispatchWebhook({
      type: "tos.accepted",
      accountId: res.externalAccountId,
      tosAcceptedAt: "2026-07-27T12:00:00Z",
      tosAcceptedIp: "9.9.9.9",
    });
    expect((await handleAcceptanceWebhook(db, rail, signed)).accepted).toBe(true);
    const row = await db.one<{ tos_acceptance: { ip: string } | null }>(
      "SELECT tos_acceptance FROM merchant_accounts WHERE id = $1",
      [res.accountId],
    );
    expect(row.tos_acceptance?.ip).toBe("9.9.9.9");
  });
});

describe("integration test / build gate (spec §14.2.8)", () => {
  it("passes for a healthy mock account and sets integration_test_passed", async () => {
    const { customerId, legalName } = await makeCustomer();
    const rail = new MockStripeRail();
    const res = await createAccount(db, rail, customerId, prefillFor(customerId, legalName));
    rail.onboard(res.externalAccountId); // simulate charges/payouts enabled

    const result = await runIntegrationTest(db, rail, res.accountId);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);

    const row = await db.one<{ integration_test_passed: boolean }>(
      "SELECT integration_test_passed FROM merchant_accounts WHERE id = $1",
      [res.accountId],
    );
    expect(row.integration_test_passed).toBe(true);
  });

  it("fails and halts payments when the rail emits a non-direct charge", async () => {
    // The account row is direct (DB CHECK enforces it), but the rail returns a
    // destination charge at checkout — the gate must detect it.
    class DestinationCheckoutRail extends MockStripeRail {
      override async createCheckout(accountId: string, req: Parameters<MockStripeRail["createCheckout"]>[1]) {
        const co = await super.createCheckout(accountId, req);
        return { ...co, chargeType: "destination" as unknown as "direct" };
      }
    }
    const { customerId, legalName } = await makeCustomer();
    const rail = new DestinationCheckoutRail();
    const res = await createAccount(db, rail, customerId, prefillFor(customerId, legalName));
    rail.onboard(res.externalAccountId);

    const result = await runIntegrationTest(db, rail, res.accountId);
    expect(result.passed).toBe(false);
    expect(result.buildFailed).toBe(true);
    expect(result.paymentsHalted).toBe(true);
    expect(result.failures.map((f) => f.check)).toContain("charge_type_is_direct");
  });
});

describe("risk monitoring (spec §14.2.10)", () => {
  it("suspends and raises an exception when dispute rate > 0.75%", () => {
    const actions = monitorRisk({ disputeRate: 0.008, volumeMultiple: 1, refundRate: 0, balanceCents: 100 });
    const suspend = actions.find((a) => a.trigger === "dispute_rate");
    expect(suspend).toBeDefined();
    expect(suspend?.action).toBe("suspend");
    expect(suspend?.raiseException).toBe(true);
  });

  it("does not suspend at or below the dispute threshold", () => {
    const actions = monitorRisk({ disputeRate: 0.005, volumeMultiple: 1, refundRate: 0, balanceCents: 100 });
    expect(actions.find((a) => a.trigger === "dispute_rate")).toBeUndefined();
  });

  it("holds on a >4x volume spike, reviews on >20% refunds, suspends on negative balance", () => {
    const actions = monitorRisk({ disputeRate: 0, volumeMultiple: 4.5, refundRate: 0.25, balanceCents: -100 });
    const kinds = actions.map((a) => `${a.trigger}:${a.action}`);
    expect(kinds).toContain("volume_spike:hold");
    expect(kinds).toContain("refund_rate:review");
    expect(kinds).toContain("negative_balance:suspend");
  });
});
