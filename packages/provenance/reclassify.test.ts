// ⛔ Classification ran once, at ingest, and never again. So every GB/IE contact
// created while the classifier was a stub returning "unknown" was denied at the
// gate forever — improving the classifier improved nothing already held.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { reclassifySubscribers, type RegistryLookup } from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });

/** Says "corporate" for anything ending in Ltd, like the real suffix classifier. */
const suffixish: RegistryLookup = {
  async classify(name: string) {
    return /\bltd$/i.test(name.trim())
      ? { subscriberType: "corporate" as const, ref: "suffix:ltd" }
      : { subscriberType: "unknown" as const, ref: null };
  },
};

let batchId: string;
beforeAll(async () => {
  const batch = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
     VALUES ('test',$1,0,0,$1) RETURNING id`,
    [`licence:reclassify:${randomUUID()}`],
  );
  batchId = batch.id;
});

async function contact(
  name: string,
  countryCode: string,
  subscriberType: string | null,
): Promise<string> {
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (name, category, country_code, city, source_vendor, source_batch_id, external_ref, category_raw, region_code, segment)
     VALUES ($1,'plumber',$2,'Manchester','test',$3,$4,'plumber',$5,'smb') RETURNING id`,
    [name, countryCode, batchId, randomUUID(), countryCode === "US" ? "R1" : "R2"],
  );
  const email = `${randomUUID()}@example.test`;
  const row = await db.one<{ id: string }>(
    `INSERT INTO contacts (business_id, email, email_hash, verification, subscriber_type)
     VALUES ($1,$2,$3,'valid',$4) RETURNING id`,
    [biz.id, email, emailHash(email), subscriberType],
  );
  return row.id;
}

async function typeOf(id: string): Promise<{ subscriber_type: string | null; registry_ref: string | null }> {
  return db.one("SELECT subscriber_type, registry_ref FROM contacts WHERE id = $1", [id]);
}

describe("⛔ the classification is retroactive", () => {
  it("resolves a contact ingested while the classifier could not answer", async () => {
    const stuck = await contact(`Halloran ${randomUUID().slice(0, 8)} Ltd`, "GB", "unknown");
    const out = await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect(out.considered).toBeGreaterThan(0);
    const after = await typeOf(stuck);
    expect(after.subscriber_type, "still unknown — the gate will deny it forever").toBe("corporate");
    // ⛔ And the evidence travels with it. Without the reference the row is a
    // bare assertion, which is exactly what a compliance record must not be.
    expect(after.registry_ref).toBe("suffix:ltd");
  });

  it("covers rows where the column is NULL, not only the literal 'unknown'", async () => {
    // NULL and 'unknown' both deny. A pass that only matched the string would
    // leave the NULL half of the population untouched and report success.
    const nulled = await contact(`Beckwith ${randomUUID().slice(0, 8)} Ltd`, "GB", null);
    await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect((await typeOf(nulled)).subscriber_type).toBe("corporate");
  });

  it("⛔ never downgrades a contact that is already classified", async () => {
    // A pass that can erase a corporate classification takes mailable contacts
    // OUT of the pipeline every time it runs — the same silent shrink this
    // exists to undo, only worse because it would be self-inflicted.
    const known = await contact("No Suffix Here", "GB", "corporate");
    const trader = await contact("Also No Suffix", "GB", "sole_trader");
    await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect((await typeOf(known)).subscriber_type).toBe("corporate");
    expect((await typeOf(trader)).subscriber_type).toBe("sole_trader");
  });

  it("leaves a name carrying no evidence unresolved rather than guessing", async () => {
    const plain = await contact(`Ferris ${randomUUID().slice(0, 8)} Roofing`, "GB", "unknown");
    await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect((await typeOf(plain)).subscriber_type).toBe("unknown");
  });

  it("⛔ does not touch jurisdictions that have no such concept", async () => {
    // "Austin Roofing Ltd" in Texas is not a PECR corporate subscriber; there
    // is no such thing under CAN-SPAM. Writing one would be inventing a
    // classification for a jurisdiction that does not use it.
    const us = await contact(`Austin ${randomUUID().slice(0, 8)} Ltd`, "US", "unknown");
    await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect((await typeOf(us)).subscriber_type).toBe("unknown");
  });

  it("is idempotent — a second pass resolves nothing new", async () => {
    await contact(`Novak ${randomUUID().slice(0, 8)} Ltd`, "GB", "unknown");
    await reclassifySubscribers(db, suffixish, { limit: 2000 });
    const second = await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect(second.resolved).toBe(0);
  });

  it("⛔ reports a registry outage as an error, never as a negative result", async () => {
    // "We asked and the answer was no" and "we could not ask" are different
    // facts. Collapsing them means an outage looks like a population that
    // genuinely has no evidence, and nobody investigates.
    const id = await contact(`Kowalski ${randomUUID().slice(0, 8)} Ltd`, "GB", "unknown");
    const broken: RegistryLookup = {
      async classify() { throw new Error("registry unreachable"); },
    };
    const out = await reclassifySubscribers(db, broken, { limit: 2000 });
    expect(out.errors).toBeGreaterThan(0);
    expect(out.resolved).toBe(0);
    // …and the row is untouched, so the next pass retries it.
    expect((await typeOf(id)).subscriber_type).toBe("unknown");
  });

  it("accounts for every row it examined", async () => {
    await contact(`Whitfield ${randomUUID().slice(0, 8)} Ltd`, "GB", "unknown");
    await contact(`Delgado ${randomUUID().slice(0, 8)} Plumbing`, "GB", "unknown");
    const out = await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect(out.resolved + out.unresolved + out.errors).toBe(out.considered);
  });

  it("⛔ reports the backlog, so 'resolved 0' is readable", async () => {
    // 0 resolved over a backlog of 400 and 0 resolved over a backlog of 0 are
    // opposite states. A run that reports only the numerator is unreadable.
    await contact(`Ashworth ${randomUUID().slice(0, 8)} Roofing`, "GB", "unknown");
    const out = await reclassifySubscribers(db, suffixish, { limit: 2000 });
    expect(out.backlog).toBeGreaterThan(0);
    const manual = await db.one<{ n: string }>(
      `SELECT count(*) AS n FROM contacts c JOIN businesses b ON b.id = c.business_id
        WHERE b.country_code IN ('GB','IE')
          AND (c.subscriber_type IS NULL OR c.subscriber_type = 'unknown')`,
    );
    expect(out.backlog).toBe(Number(manual.n));
  });

  it("a zero limit buys nothing and claims nothing", async () => {
    const out = await reclassifySubscribers(db, suffixish, { limit: 0 });
    expect(out.considered).toBe(0);
    expect(out.resolved).toBe(0);
  });
});
