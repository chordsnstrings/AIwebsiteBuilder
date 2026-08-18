// ⛔ The ignition. Before this file the pipeline had no beginning:
// `fetchBatch()` was implemented and registered, `ingestRecord()` was
// implemented, `enrolLead()` was implemented and documented as "the only entry
// point into the lead workflow" — and NOTHING called any of them. The whole
// machine downstream was correct and was never handed a business to work on.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { remainingSendCapacity, sourceLeads, standingCampaign, type LeadSourceLike } from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });

const deps = {
  verifier: { async verify() { return "valid" as const; } },
  fetcher: { async fetch() { return { text: "We fix taps. Call us.", screenshot: Buffer.from("png") }; } },
  store: { async put() {} },
  registry: { async classify() { return { subscriberType: "corporate" as const, ref: "suffix:ltd" }; } },
};

let seq = 0;
function source(records: Partial<Record<string, unknown>>[]): LeadSourceLike {
  const run = ++seq;
  // ⛔ Stamped ONCE, when the source is constructed — not per fetch. A vendor
  // returns the same externalRef for the same business every time, and that is
  // exactly what the dedupe relies on; generating a new one per call would make
  // the idempotency test pass for the wrong reason.
  const stamp = `${Date.now()}-${run}`;
  return {
    vendorId: "lead_data_primary",
    async fetchBatch(_q: string, limit: number) {
      return {
        records: records.slice(0, limit).map((r, i) => ({
          externalRef: `test-${stamp}-${i}`,
          name: `Test Business ${run}-${i}`,
          category: "plumber",
          countryCode: "US",
          city: "Austin",
          phone: "+15125550100",
          websiteUrl: null,
          reviewCount: 12,
          rating: 4.5,
          email: `owner-${stamp}-${i}@example.test`,
          sourceUrl: "https://directory.example/listing",
          ...r,
        })) as never,
        licenceRef: `licence:test:${run}`,
        costCents: records.length * 3,
      };
    },
  };
}

describe("⛔ sourcing drives a record all the way into the pipeline", () => {
  it("creates the business, the contact, the provenance, the lead AND the workflow intent", async () => {
    // Each of those steps existed. The chain between them did not.
    const out = await sourceLeads(db, source([{}]), deps, {
      query: "plumbers in Austin", maxRecords: 1, ignoreCapacity: true,
    });
    expect(out.fetched).toBe(1);
    expect(out.ingested, `nothing ingested: ${JSON.stringify(out.skipped)}`).toBe(1);
    expect(out.businessesCreated).toBe(1);
    expect(out.batchId).not.toBeNull();
    // The licence reference and the cost travel with the batch — provenance of
    // purchase, not reconstructed later.
    expect(out.licenceRef).toContain("licence:");
    expect(out.costCents).toBeGreaterThan(0);

    const biz = await db.one<{ id: string; source_batch_id: string; vertical: string | null }>(
      "SELECT id, source_batch_id, vertical FROM businesses WHERE source_batch_id = $1",
      [out.batchId],
    );
    expect(biz.source_batch_id).toBe(out.batchId);
    // ⛔ Resolved at the one place a business is created. Null here is the
    // defect that silently switches off every customer-side family later.
    expect(biz.vertical).toBe("plumber");

    const contact = await db.one<{ id: string }>("SELECT id FROM contacts WHERE business_id = $1", [biz.id]);
    const prov = await db.maybeOne("SELECT 1 AS x FROM provenance WHERE contact_id = $1", [contact.id]);
    expect(prov, "no provenance — the contact cannot lawfully be mailed").not.toBeNull();

    // ⛔ THE LINK THAT WAS MISSING. enrolLead had zero call sites.
    const lead = await db.maybeOne<{ id: string; state: string }>(
      "SELECT id, state FROM leads WHERE contact_id = $1", [contact.id],
    );
    expect(lead, "ingested but never enrolled — the pipeline would never see it").not.toBeNull();

    const intent = await db.maybeOne(
      "SELECT 1 AS x FROM workflow_intents WHERE workflow_type = 'lead' AND payload->>'leadId' = $1",
      [lead!.id],
    );
    expect(intent, "enrolled but no workflow intent — nothing would ever start it").not.toBeNull();
  });

  it("⛔ never invents a contact address", async () => {
    // Deriving info@<name>.com from a record with no email would be
    // manufacturing a recipient, which is the one thing the whole provenance
    // chain exists to make impossible.
    const out = await sourceLeads(db, source([{ email: null }]), deps, {
      query: "q", maxRecords: 1, ignoreCapacity: true,
    });
    expect(out.ingested).toBe(0);
    expect(out.skipped["no_email"]).toBe(1);
    expect(out.businessesCreated, "a business was created for a record nobody can contact").toBe(0);
  });

  it("⛔ refuses to source into a market we do not operate in", async () => {
    // The gate would deny these later anyway — but by then the data is bought
    // and a person's details are being held for a market we cannot mail.
    const out = await sourceLeads(db, source([{ countryCode: "DE" }]), deps, {
      query: "q", maxRecords: 1, ignoreCapacity: true,
    });
    expect(out.ingested).toBe(0);
    expect(out.skipped["market_disabled:DE"]).toBe(1);
  });

  it("⛔ never puts an enterprise account into the SMB motion", async () => {
    const out = await sourceLeads(db, source([{ category: "hospitals_and_health_systems" }]), deps, {
      query: "q", maxRecords: 1, ignoreCapacity: true,
    });
    expect(out.ingested).toBe(0);
    expect(out.skipped["enterprise_segment"]).toBe(1);
  });

  it("⛔ buys nothing when the fleet cannot send", async () => {
    // Licensed data costs money per record and its provenance starts ageing
    // immediately. Sourcing faster than the fleet can send builds a backlog
    // that expires before it is contacted — money spent to manufacture a
    // compliance problem.
    const never = {
      vendorId: "lead_data_primary",
      async fetchBatch() {
        throw new Error("the vendor must not be called when there is no capacity");
      },
    } as unknown as LeadSourceLike;
    const out = await sourceLeads(db, never, deps, { query: "q", maxRecords: 0 });
    expect(out.fetched).toBe(0);
    expect(out.costCents).toBe(0);
    expect(out.halted).toContain("capacity");
  });

  it("everything fetched is accounted for", async () => {
    // A sourcing run that silently drops records is indistinguishable from a
    // vendor that returned fewer.
    const out = await sourceLeads(
      db,
      source([{}, { email: null }, { countryCode: "DE" }, {}]),
      deps,
      { query: "q", maxRecords: 4, ignoreCapacity: true },
    );
    const skips = Object.values(out.skipped).reduce((n, v) => n + v, 0);
    expect(out.ingested + skips).toBe(out.fetched);
  });

  it("re-sourcing the same records does not create a second business or a second lead", async () => {
    const src = source([{}]);
    const first = await sourceLeads(db, src, deps, { query: "q", maxRecords: 1, ignoreCapacity: true });
    expect(first.businessesCreated).toBe(1);
    // The same vendor identifiers again.
    const second = await sourceLeads(db, src, deps, { query: "q", maxRecords: 1, ignoreCapacity: true });
    expect(second.businessesCreated, "the same externalRef created a second business").toBe(0);
    expect(second.skipped["business_already_held"]).toBe(1);
  });
});

describe("⛔ the standing campaign is one campaign", () => {
  it("resolves to the same row every time", async () => {
    // A fresh campaign per run would silently void two invariants: leads is
    // unique on (contact_id, campaign_id), and the gate's frequency cap counts
    // touches WITHIN a campaign. A new campaign every hour means the 4-in-30-days
    // cap never binds.
    const a = await standingCampaign(db, "R1", "US");
    const b = await standingCampaign(db, "R1", "US");
    const c = await standingCampaign(db, "R1", "CA");
    expect(a).toBe(b);
    expect(a).toBe(c);
    const markets = await db.one<{ enabled_markets: string[] }>(
      "SELECT enabled_markets FROM campaigns WHERE id = $1", [a],
    );
    expect(markets.enabled_markets).toContain("US");
    expect(markets.enabled_markets).toContain("CA");
  });

  it("the name is unique in the schema, not merely by convention", async () => {
    const name = `standing:R1:web_presence`;
    await expect(
      db.query(
        "INSERT INTO campaigns (name, region_code, enabled_markets, message_class) VALUES ($1,'R1',ARRAY['US'],'web_presence')",
        [name],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("send capacity", () => {
  it("is read from the fleet, not from a constant", async () => {
    const capacity = await remainingSendCapacity(db);
    expect(typeof capacity).toBe("number");
    expect(capacity).toBeGreaterThanOrEqual(0);
    const manual = await db.one<{ n: string }>(
      `SELECT COALESCE(sum(GREATEST(daily_cap - sends_today, 0)), 0) AS n
         FROM sending_assets WHERE retired_at IS NULL AND health IN ('healthy','warming')`,
    );
    expect(capacity).toBe(Number(manual.n));
  });
});
