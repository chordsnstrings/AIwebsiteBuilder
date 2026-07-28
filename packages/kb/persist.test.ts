import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import {
  deterministicExtract,
  extractKnowledgeBase,
  loadKnowledgeBase,
  persistKnowledgeBase,
  type ExtractInput,
  type KnowledgeBase,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const NOW = new Date("2026-07-28T00:00:00.000Z");
const RETRIEVED = new Date("2026-07-27T09:00:00.000Z");

let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

async function makeBusiness(): Promise<string> {
  const batch = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
     VALUES ('demo','lic',1,0,$1) RETURNING id`,
    [randomUUID()],
  );
  const business = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('demo',$1,$2,'GB','R1','ok_site') RETURNING id`,
    [batch.id, `Acme ${randomUUID()}`],
  );
  return business.id;
}

async function makeManifest(businessId: string, vertical: string): Promise<void> {
  await db.query(
    `INSERT INTO delivery_manifests (business_id, vertical, confidence, playbook_version)
     VALUES ($1,$2,0.90,'playbooks@test')`,
    [businessId, vertical],
  );
}

const SITE = "https://acme.example";
const PAGE = [
  "Opening hours",
  "Mon: 9am-5pm",
  "",
  "Services",
  "- Drain unblocking — £95",
  "",
  "We cover Leeds",
  "",
  "Gas Safe registered no. 123456",
].join("\n");

async function buildKb(businessId: string, over: Partial<ExtractInput> = {}): Promise<KnowledgeBase> {
  return extractKnowledgeBase(
    {
      businessId,
      pages: [{ url: `${SITE}/`, text: PAGE, retrievedAt: RETRIEVED, depth: 1, lang: "en" }],
      gbp: { sourceUrl: "https://business.google.com/acme", retrievedAt: RETRIEVED, hours: { mon: "08:00-18:00" } },
      ...over,
    },
    { extract: deterministicExtract, now: () => NOW },
  );
}

describe("persistKnowledgeBase / loadKnowledgeBase", () => {
  it("writes the KB, its facts and its conflicts", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    const result = await persistKnowledgeBase(db, kb);

    expect(result.kbId).toBe(kb.id);
    expect(result.factsWritten).toBe(kb.facts.length);
    expect(result.factsRejected).toBe(0);
    expect(result.conflictsWritten).toBe(1);

    const counts = await db.one<{ facts: string; conflicts: string }>(
      `SELECT (SELECT count(*) FROM kb_facts WHERE kb_id = $1) AS facts,
              (SELECT count(*) FROM kb_conflicts WHERE kb_id = $1) AS conflicts`,
      [kb.id],
    );
    expect(Number(counts.facts)).toBe(kb.facts.length);
    expect(Number(counts.conflicts)).toBe(1);
  });

  it("round-trips every fact with its provenance intact", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    await persistKnowledgeBase(db, kb);

    const loaded = await loadKnowledgeBase(db, kb.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.businessId).toBe(businessId);
    expect(loaded?.siteHash).toBe(kb.siteHash);
    expect(loaded?.gbpHash).toBe(kb.gbpHash);
    expect(loaded?.facts.map((f) => f.id).sort()).toEqual(kb.facts.map((f) => f.id).sort());
    for (const fact of loaded?.facts ?? []) {
      const original = kb.facts.find((f) => f.id === fact.id);
      expect(fact.sourceUrl).toBe(original?.sourceUrl);
      expect(fact.retrievedAt.getTime()).toBe(original?.retrievedAt.getTime());
      expect(fact.status).toBe(original?.status);
      expect(fact.confidence).toBeCloseTo(original?.confidence ?? -1, 3);
      expect(fact.lang).toBe(original?.lang);
    }
  });

  it("never writes a fact missing half its provenance", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    const sourceless = { ...(kb.facts[0] as (typeof kb.facts)[number]), id: randomUUID(), sourceUrl: "" };
    const undated = { ...(kb.facts[0] as (typeof kb.facts)[number]), id: randomUUID(), retrievedAt: new Date("nope") };

    const result = await persistKnowledgeBase(db, { ...kb, facts: [...kb.facts, sourceless, undated] });
    expect(result.factsRejected).toBe(2);

    const rows = await db.query<{ id: string }>(
      `SELECT id FROM kb_facts WHERE id = ANY($1::uuid[])`,
      [[sourceless.id, undated.id]],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("is idempotent — re-persisting the same KB writes no new rows", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    await persistKnowledgeBase(db, kb);
    await persistKnowledgeBase(db, kb);

    const counts = await db.one<{ kbs: string; facts: string; conflicts: string }>(
      `SELECT (SELECT count(*) FROM knowledge_bases WHERE id = $1) AS kbs,
              (SELECT count(*) FROM kb_facts WHERE kb_id = $1) AS facts,
              (SELECT count(*) FROM kb_conflicts WHERE kb_id = $1) AS conflicts`,
      [kb.id],
    );
    expect(Number(counts.kbs)).toBe(1);
    expect(Number(counts.facts)).toBe(kb.facts.length);
    expect(Number(counts.conflicts)).toBe(1);
  });

  it("stores the conflict unresolved, pointing at both facts", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    await persistKnowledgeBase(db, kb);

    const row = await db.one<{ fact_ids: string[]; resolved_at: Date | null; resolved_value: string | null }>(
      `SELECT fact_ids, resolved_at, resolved_value FROM kb_conflicts WHERE kb_id = $1`,
      [kb.id],
    );
    expect(row.fact_ids).toHaveLength(2);
    expect(row.resolved_at).toBeNull();
    expect(row.resolved_value).toBeNull();
    const values = await db.query<{ value: string }>(
      `SELECT value FROM kb_facts WHERE id = ANY($1::uuid[]) ORDER BY value`,
      [row.fact_ids],
    );
    expect(values.rows.map((r) => r.value)).toEqual(["08:00-18:00", "09:00-17:00"]);
  });

  it("preserves claimed_unverified through the round trip", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    await persistKnowledgeBase(db, kb);
    const loaded = await loadKnowledgeBase(db, kb.id);
    const credential = loaded?.facts.find((f) => f.type === "credential");
    expect(credential?.status).toBe("claimed_unverified");
    expect(loaded?.gaps.some((g) => g.reason === "unverified")).toBe(true);
  });

  it("recomputes the gap list from stored facts rather than storing it", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    await persistKnowledgeBase(db, kb);
    const loaded = await loadKnowledgeBase(db, kb.id);
    expect(loaded?.gaps.filter((g) => g.reason === "conflict")).toHaveLength(1);
    expect(loaded?.gaps.map((g) => `${g.reason}:${g.key}`)).toEqual(kb.gaps.map((g) => `${g.reason}:${g.key}`));
  });

  it("takes the vertical for template gaps from the business's manifest", async () => {
    const businessId = await makeBusiness();
    await makeManifest(businessId, "roofing");
    // No GBP record either — nothing published anywhere is the case the
    // template fallback exists for.
    const kb = await extractKnowledgeBase(
      {
        businessId,
        vertical: "roofing",
        pages: [{ url: `${SITE}/`, text: "Welcome to Acme, a family business.", retrievedAt: RETRIEVED, depth: 1, lang: "en" }],
      },
      { extract: deterministicExtract, now: () => NOW },
    );
    expect(kb.facts).toHaveLength(0);
    await persistKnowledgeBase(db, kb);

    const loaded = await loadKnowledgeBase(db, kb.id);
    expect(loaded?.thin).toBe(true);
    expect(loaded?.gaps.map((g) => g.key).sort()).toEqual(["area", "contact", "hours", "service"]);
    expect(loaded?.gaps.every((g) => g.reason === "template")).toBe(true);
  });

  it("round-trips the thin flag", async () => {
    const businessId = await makeBusiness();
    const kb = await buildKb(businessId);
    expect(kb.thin).toBe(true);
    await persistKnowledgeBase(db, kb);
    expect((await loadKnowledgeBase(db, kb.id))?.thin).toBe(true);
  });

  it("returns null for a KB that was never written", async () => {
    expect(await loadKnowledgeBase(db, randomUUID())).toBeNull();
  });

  it("keeps versions side by side so an agent can bind to one", async () => {
    const businessId = await makeBusiness();
    const v1 = await buildKb(businessId);
    const v2 = await buildKb(businessId, {
      pages: [{ url: `${SITE}/`, text: `${PAGE}\nWe cover Bradford`, retrievedAt: RETRIEVED, depth: 1, lang: "en" }],
      version: 2,
    });
    expect(v2.id).not.toBe(v1.id);
    await persistKnowledgeBase(db, v1);
    await persistKnowledgeBase(db, v2);

    const rows = await db.query<{ version: number }>(
      `SELECT version FROM knowledge_bases WHERE business_id = $1 ORDER BY version`,
      [businessId],
    );
    expect(rows.rows.map((r) => Number(r.version))).toEqual([1, 2]);
  });
});
