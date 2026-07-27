import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { ingestRecord, type ProvenanceDeps, type IngestRecord } from "./src/index.ts";

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
    registry: { async classify() { return "corporate"; } },
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
    category: "trades",
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
