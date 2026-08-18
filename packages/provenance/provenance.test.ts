import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { randomUUID } from "node:crypto";
import { enrolLead, ingestRecord, type ProvenanceDeps, type IngestRecord } from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

function mockDeps(over: Partial<ProvenanceDeps> = {}): ProvenanceDeps {
  return {
    db,
    verifier: { async verify() { return "valid"; } },
    fetcher: { async fetch() { return { text: "We fix taps. Call us.", screenshot: Buffer.from("png") }; } },
    store: { async put() {} },
    registry: { async classify() { return { subscriberType: "corporate" as const, ref: "suffix:ltd" }; } },
    ...over,
  };
}

async function makeBusiness(country = "US"): Promise<string> {
  const batch = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','l',1,0,'x') RETURNING id`,
  );
  const b = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment) VALUES ('d',$1,'Acme',$2,'R1','no_site') RETURNING id`,
    [batch.id, country],
  );
  return b.id;
}

function rec(businessId: string, over: Partial<IngestRecord> = {}): IngestRecord {
  return {
    businessId,
    email: `p${Math.random().toString(36).slice(2)}@example.com`,
    sourceUrl: "https://acme.example",
    // ⛔ A trade, not a family. The old default was "trades", which is the
    // vocabulary `RELATES_ROLE_CATEGORIES` was written against and which the
    // sourcing path never produces — so every fixture here agreed with a check
    // that disagreed with production.
    category: "plumber",
    countryCode: "US",
    businessName: "Acme",
    ...over,
  };
}

describe("provenance pipeline", () => {
  it("accepts a clean record and writes a provenance row", async () => {
    const biz = await makeBusiness();
    const out = await ingestRecord(rec(biz), mockDeps());
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") {
      const p = await db.one<{ n: string }>("SELECT count(*) AS n FROM provenance WHERE contact_id = $1", [out.contactId]);
      expect(Number(p.n)).toBe(1);
    }
  });

  it("drops an invalid email", async () => {
    const biz = await makeBusiness();
    const out = await ingestRecord(rec(biz), mockDeps({ verifier: { async verify() { return "invalid"; } } }));
    expect(out.status).toBe("rejected");
  });

  it("marks provenance_failed (US opt-out only) when the page can't be fetched", async () => {
    const biz = await makeBusiness();
    const out = await ingestRecord(rec(biz), mockDeps({ fetcher: { async fetch() { return null; } } }));
    expect(out.status).toBe("provenance_failed");
    if (out.status === "provenance_failed") expect(out.eligible).toBe("opt_out_only");
  });

  it("detects a no-CEM statement (do not email) → no_cem_statement FALSE", async () => {
    const biz = await makeBusiness("CA");
    const out = await ingestRecord(
      rec(biz, { countryCode: "CA" }),
      mockDeps({ fetcher: { async fetch() { return { text: "Please do not email us for marketing.", screenshot: Buffer.from("x") }; } } }),
    );
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") {
      const p = await db.one<{ no_cem_statement: boolean; legal_basis: string }>(
        "SELECT no_cem_statement, legal_basis FROM provenance WHERE contact_id = $1",
        [out.contactId],
      );
      expect(p.no_cem_statement).toBe(false);
      expect(p.legal_basis).toBe("casl_10_9");
    }
  });

  it("classifies subscriber type via registry for UK", async () => {
    const biz = await makeBusiness("GB");
    const out = await ingestRecord(rec(biz, { countryCode: "GB" }), mockDeps());
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") {
      const c = await db.one<{ subscriber_type: string }>("SELECT subscriber_type FROM contacts WHERE id = $1", [out.contactId]);
      expect(c.subscriber_type).toBe("corporate");
    }
  });
});

// ---------------------------------------------------------------------------
// enrolLead is the only entry point into the lead workflow. Before it existed,
// ingestion produced perfect contacts and provenance and then stopped.
// ---------------------------------------------------------------------------
describe("enrolLead", () => {
  async function makeContact(): Promise<{ contactId: string; businessId: string; email: string }> {
    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
    );
    const biz = await db.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
       VALUES ('d',$1,'Enrol Co','US','R1','no_site') RETURNING id`,
      [batch.id],
    );
    const email = `enrol_${randomUUID()}@example.com`;
    const contact = await db.one<{ id: string }>(
      "INSERT INTO contacts (business_id, email, email_hash, verification) VALUES ($1,$2,$3,'valid') RETURNING id",
      [biz.id, email, emailHash(email)],
    );
    return { contactId: contact.id, businessId: biz.id, email };
  }

  async function makeCampaign(): Promise<string> {
    const row = await db.one<{ id: string }>(
      "INSERT INTO campaigns (name, region_code, enabled_markets) VALUES ($1,'R1',$2) RETURNING id",
      [`enrol-${randomUUID()}`, ["US"]],
    );
    return row.id;
  }

  it("creates the lead and queues the workflow start", async () => {
    const c = await makeContact();
    const campaignId = await makeCampaign();
    const out = await enrolLead(db, { ...c, campaignId });
    expect(out.leadId).not.toBeNull();

    const intent = await db.one<{ kind: string; workflow_type: string }>(
      "SELECT kind, workflow_type FROM workflow_intents WHERE execution_id = $1",
      [`lead:${out.leadId}`],
    );
    expect(intent).toMatchObject({ kind: "start", workflow_type: "lead" });
  });

  it("refuses to enrol a suppressed contact", async () => {
    const c = await makeContact();
    await db.query("INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'unsubscribe','all')", [
      emailHash(c.email),
    ]);
    const out = await enrolLead(db, { ...c, campaignId: await makeCampaign() });
    expect(out).toEqual({ leadId: null, reason: "suppressed" });
  });

  it("refuses a second active lead for the same contact", async () => {
    const c = await makeContact();
    await enrolLead(db, { ...c, campaignId: await makeCampaign() });
    const second = await enrolLead(db, { ...c, campaignId: await makeCampaign() });
    expect(second).toEqual({ leadId: null, reason: "already_active" });
  });
});

describe("⛔ role relevance decides three markets", () => {
  // CASL, the Australian Spam Act and New Zealand's UEM rules all rest the
  // implied-consent defence on the address having been published in a business
  // capacity, and `rule_5_provenance_role` denies without it. The check used to
  // compare vertical-FAMILY names ("trades", "retail") against a TRADE name
  // ("plumber", "landscaper") — two vocabularies, so it answered false for
  // every record ever ingested and CA, AU and NZ were permanently unmailable.
  const cases: [string, boolean][] = [
    ["plumber", true],
    ["electrician", true],
    ["dentist", true],
    // Spellings the source actually emits, resolved through the taxonomy's aliases.
    ["roofer", true],
    ["landscaper", true],
    ["hair_salon", true],
    // ⛔ An enterprise account is not a local SMB publishing a business contact.
    ["hospitals_and_health_systems", false],
    // ⛔ Unknown is not permission.
    ["nonsense_category", false],
    ["", false],
    // ⛔ And the family name itself, which is what the old list matched on.
    ["trades", false],
  ];

  for (const [category, expected] of cases) {
    it(`${category === "" ? "(empty)" : category} → ${expected}`, async () => {
      const biz = await makeBusiness("CA");
      const out = await ingestRecord(rec(biz, { category }), mockDeps());
      expect(out.status).toBe("accepted");
      const row = await db.one<{ relates_to_role: boolean }>(
        "SELECT relates_to_role FROM provenance WHERE contact_id = $1",
        [(out as { contactId: string }).contactId],
      );
      expect(row.relates_to_role).toBe(expected);
    });
  }
});
