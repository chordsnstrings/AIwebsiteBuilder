import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  approvePack,
  cosine,
  EMBEDDING_DIMS,
  embedText,
  generateQAPack,
  isApproved,
  loadQAPack,
  loadVerticalTemplate,
  packId,
  persistQAPack,
  type EmbeddingProvider,
  type KbFact,
  type KnowledgeBase,
  type QAPack,
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

const ROOFING = loadVerticalTemplate("roofing");
const RETRIEVED = new Date("2026-03-01T00:00:00Z");

function fact(over: Partial<KbFact> & Pick<KbFact, "factKey" | "value">): KbFact {
  return {
    id: randomUUID(),
    type: over.factKey,
    sourceUrl: "https://acme-roofing.example/services",
    retrievedAt: RETRIEVED,
    confidence: 1,
    status: "verified",
    ...over,
  };
}

function kb(facts: KbFact[], over: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    id: randomUUID(),
    businessId: randomUUID(),
    version: 1,
    thin: false,
    facts,
    conflicts: [],
    gaps: [],
    ...over,
  };
}

// A KB rich enough to hit the 150–250 target: services and areas are what a
// roofer actually publishes at volume.
const SERVICE_HEADS = ["roof", "gutter", "chimney", "skylight", "fascia", "soffit", "flashing", "ridge", "valley", "dormer"];
const SERVICE_TAILS = ["repair", "replacement", "cleaning", "inspection", "sealing", "painting"];
const AREAS = [
  "Deira", "Jumeirah", "Al Barsha", "Mirdif", "Karama", "Satwa", "Marina", "Bur Dubai",
  "Al Quoz", "Sharjah", "Ajman", "Nad Al Sheba", "Umm Suqeim", "Al Warqa", "Silicon Oasis",
  "Motor City", "Arabian Ranches", "Discovery Gardens", "Springs", "Meadows",
];

function richFacts(): KbFact[] {
  const facts: KbFact[] = [];
  for (const head of SERVICE_HEADS) {
    for (const tail of SERVICE_TAILS) facts.push(fact({ factKey: "service", value: `${head} ${tail}` }));
  }
  for (const area of AREAS) facts.push(fact({ factKey: "service_area", value: area }));
  for (const method of ["Visa", "Mastercard", "bank transfer", "cash on completion"]) {
    facts.push(fact({ factKey: "payment_method", value: method }));
  }
  for (const brand of ["Marley", "Redland", "Velux", "IKO"]) {
    facts.push(fact({ factKey: "brand", value: brand }));
  }
  facts.push(fact({ factKey: "hours", value: "Sunday to Thursday, 8am to 6pm" }));
  facts.push(fact({ factKey: "contact_phone", value: "+971 4 555 0100" }));
  facts.push(fact({ factKey: "warranty", value: "10-year workmanship guarantee on new roofs" }));
  return facts;
}

async function makeBusiness(): Promise<string> {
  const batch = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
     VALUES ('d','l',1,0,$1) RETURNING id`,
    [randomUUID()],
  );
  const business = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,'Acme Roofing','AE','R1','no_site','roofing') RETURNING id`,
    [batch.id],
  );
  return business.id;
}

/** A persisted KB row so qa_packs.kb_id / business_id resolve. */
async function makeKbRow(businessId: string, version = 1): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO knowledge_bases (business_id, version) VALUES ($1,$2) RETURNING id`,
    [businessId, version],
  );
  return row.id;
}

async function persistedPack(facts: KbFact[], over: Partial<KnowledgeBase> = {}): Promise<QAPack> {
  const businessId = await makeBusiness();
  const kbId = await makeKbRow(businessId, over.version ?? 1);
  const pack = await generateQAPack(kb(facts, { id: kbId, businessId, ...over }), ROOFING);
  await persistQAPack(db, pack);
  return pack;
}

describe("vertical template", () => {
  it("composes roughly sixty questions from the playbook blocks", () => {
    expect(ROOFING.questions.length).toBeGreaterThanOrEqual(55);
    expect(ROOFING.questions.length).toBeLessThanOrEqual(70);
    expect(ROOFING.questions.map((q) => q.id)).toContain("v_roof_leak");
    // roofing sets photo_triage: true, so the photo block is in.
    expect(ROOFING.questions.map((q) => q.id)).toContain("photo_price");
    expect(ROOFING.playbookVersion).toMatch(/^playbooks@/);
  });

  it("inherits the universal refusals as well as the vertical's own", () => {
    const ids = ROOFING.refusals.map((r) => r.id);
    expect(ids).toContain("unverified_credential");
    expect(ids).toContain("trade_certification");
  });

  it("refuses to build a template for a prohibited vertical", () => {
    expect(() => loadVerticalTemplate("hair_salon")).toThrow(/Fresha and Booksy own booking/);
  });

  it("refuses to build a template for a vertical that is not in the playbooks", () => {
    expect(() => loadVerticalTemplate("submarine_repair")).toThrow(/not in the playbooks/);
  });
});

describe("generateQAPack grounding", () => {
  it("gives every generated answer at least one source fact", async () => {
    const pack = await generateQAPack(kb(richFacts()), ROOFING);
    const generated = pack.pairs.filter((p) => p.source === "generated");
    expect(generated.length).toBeGreaterThan(100);
    for (const pair of generated) expect(pair.sourceFactIds.length).toBeGreaterThanOrEqual(1);
  });

  it("leaves an unanswerable question out of the pack as an answer and on the gap list", async () => {
    const pack = await generateQAPack(kb([fact({ factKey: "service", value: "flat roof repair" })]), ROOFING);
    const hours = pack.pairs.find((p) => p.question === "What are your opening hours?");
    expect(hours?.source).toBe("template_refusal");
    expect(hours?.sourceFactIds).toEqual([]);
    expect(pack.gaps).toContain("What are your opening hours?");
    expect(pack.templateFallbacks).toContain("What are your opening hours?");
  });

  it("carries the knowledge base's own gaps through to the pack", async () => {
    const pack = await generateQAPack(
      kb([fact({ factKey: "service", value: "flat roof repair" })], {
        // The KB's gaps are structured; the pack records the QUESTION, because
        // that is what the owner is asked and what the dashboard shows them.
        gaps: [{ key: "listed_buildings", reason: "no_source", question: "Do you work on listed buildings?" }],
      }),
      ROOFING,
    );
    expect(pack.gaps).toContain("Do you work on listed buildings?");
  });

  it("makes template_refusal the only source permitted to have no facts", async () => {
    const pack = await generateQAPack(kb(richFacts()), ROOFING);
    for (const pair of pack.pairs) {
      if (pair.sourceFactIds.length === 0) expect(pair.source).toBe("template_refusal");
    }
  });

  it("never sources an answer from a claimed-but-unverified credential", async () => {
    const claimed = fact({ factKey: "certification", value: "Gas Safe registered", status: "claimed_unverified" });
    const pack = await generateQAPack(kb([claimed, fact({ factKey: "service", value: "flat roof repair" })]), ROOFING);
    const cited = pack.pairs.flatMap((p) => p.sourceFactIds);
    expect(cited).not.toContain(claimed.id);
    const credentials = pack.pairs.find((p) => p.question === "Are you qualified and registered?");
    expect(credentials?.source).toBe("template_refusal");
    expect(pack.excluded.some((e) => e.ruleId === "claimed_unverified")).toBe(true);
  });

  it("discards an answer that would assert a prohibited trade claim and logs the rule", async () => {
    // Inferred, not verified: the phrase is in the KB but nothing published it,
    // so the pair is thrown away rather than hedged.
    const pack = await generateQAPack(
      kb([fact({ factKey: "process", value: "Asbestos is stripped on every job", status: "inferred" })]),
      ROOFING,
    );
    expect(pack.excluded.some((e) => e.ruleId === "trade_certification")).toBe(true);
    expect(pack.pairs.some((p) => p.answer.toLowerCase().includes("asbestos"))).toBe(false);
  });

  it("applies the universal refusals before the vertical's own", async () => {
    const pack = await generateQAPack(
      kb([fact({ factKey: "process", value: "All work is Gas Safe certified", status: "inferred" })]),
      ROOFING,
    );
    // "certified" is a universal refusal; "gas safe" is roofing's. Either kills
    // the pair — what matters is that the claim never reaches the pack.
    expect(pack.excluded.some((e) => e.ruleId === "unverified_credential")).toBe(true);
    expect(pack.pairs.some((p) => p.answer.toLowerCase().includes("gas safe"))).toBe(false);
  });

  it("allows a published price through the pricing refusal, because provenance is the test", async () => {
    const pack = await generateQAPack(
      kb([fact({ factKey: "price", value: "Flat roof repair from AED 450" })]),
      ROOFING,
    );
    const pricing = pack.pairs.find((p) => p.question === "How much do you charge?");
    expect(pricing?.source).toBe("generated");
    expect(pricing?.answer).toContain("AED 450");
  });

  it("hedges a stale fact with the date it was published and discounts its confidence", async () => {
    const pack = await generateQAPack(
      kb([fact({ factKey: "hours", value: "Mon-Fri 9am to 5pm", status: "stale" })]),
      ROOFING,
    );
    const hours = pack.pairs.find((p) => p.question === "What are your opening hours?");
    expect(hours?.answer).toContain("2026-03-01");
    expect(hours?.confidence).toBeLessThan(1);
  });

  it("never writes a pair whose question the business cannot answer at all", async () => {
    const pack = await generateQAPack(kb([]), ROOFING);
    expect(pack.pairs.every((p) => p.source === "template_refusal")).toBe(true);
    expect(pack.templateFallbacks).toHaveLength(ROOFING.questions.length);
  });
});

describe("generateQAPack shape", () => {
  it("deduplicates two pairs answering the same question, keeping the higher confidence", async () => {
    const weak = fact({ factKey: "service", value: "Gutter cleaning.", confidence: 0.5 });
    const strong = fact({ factKey: "service", value: "gutter cleaning", confidence: 0.95 });
    const pack = await generateQAPack(kb([weak, strong]), ROOFING);
    const matches = pack.pairs.filter((p) => p.question.toLowerCase() === "do you offer gutter cleaning?");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.sourceFactIds).toEqual([strong.id]);
    expect(pack.excluded.some((e) => e.ruleId === "duplicate")).toBe(true);
  });

  it("keeps distinct published services as distinct pairs", async () => {
    const pack = await generateQAPack(kb(richFacts()), ROOFING);
    expect(pack.excluded.filter((e) => e.ruleId === "duplicate")).toHaveLength(0);
    const questions = new Set(pack.pairs.map((p) => p.question));
    expect(questions.size).toBe(pack.pairs.length);
  });

  it("lands a rich knowledge base in the 150–250 pair target", async () => {
    const pack = await generateQAPack(kb(richFacts()), ROOFING);
    expect(pack.pairs.length).toBeGreaterThanOrEqual(150);
    expect(pack.pairs.length).toBeLessThanOrEqual(250);
    expect(pack.thin).toBe(false);
    expect(pack.extendedOnboarding).toBe(false);
  });

  it("flags a pack under forty grounded pairs as thin and sends onboarding back for more", async () => {
    const pack = await generateQAPack(kb([fact({ factKey: "service", value: "flat roof repair" })]), ROOFING);
    expect(pack.pairs.filter((p) => p.source === "generated").length).toBeLessThan(ROOFING.minPackPairs);
    expect(pack.thin).toBe(true);
    expect(pack.extendedOnboarding).toBe(true);
    // The fallback IS the vertical template: every question still has an answer.
    expect(pack.pairs.length).toBeGreaterThanOrEqual(ROOFING.questions.length - 1);
  });

  it("inherits thin from a thin knowledge base even when the pack is large", async () => {
    const pack = await generateQAPack(kb(richFacts(), { thin: true }), ROOFING);
    expect(pack.thin).toBe(true);
  });

  it("reports coverage by topic and against the vertical template", async () => {
    const pack = await generateQAPack(kb(richFacts()), ROOFING);
    const totals = Object.values(pack.coverage.byTopic).reduce((sum, t) => sum + t.total, 0);
    expect(totals).toBe(ROOFING.questions.length);
    expect(pack.coverage.byVerticalTemplate.total).toBe(ROOFING.questions.length);
    expect(pack.coverage.byVerticalTemplate.answered).toBeGreaterThan(0);
    expect(pack.coverage.byVerticalTemplate.ratio).toBeGreaterThan(0);
    expect(pack.coverage.factsUsed).toBeGreaterThan(0);
    expect(pack.coverage.factsAvailable).toBe(richFacts().length);
  });

  it("derives the pack id from the business and KB version, not from a clock", async () => {
    const base = kb(richFacts());
    const first = await generateQAPack(base, ROOFING, { now: () => new Date("2026-01-01T00:00:00Z") });
    const second = await generateQAPack(base, ROOFING, { now: () => new Date("2027-06-06T12:00:00Z") });
    expect(first.id).toBe(packId(base.id, base.version));
    expect(second.id).toBe(first.id);
    expect(first.pairs.map((p) => p.id)).toEqual(second.pairs.map((p) => p.id));
  });

  it("gives a new KB version a new pack id", async () => {
    const facts = richFacts();
    const businessId = randomUUID();
    const v1 = await generateQAPack(kb(facts, { businessId, version: 1 }), ROOFING);
    const v2 = await generateQAPack(kb(facts, { businessId, version: 2 }), ROOFING);
    expect(v2.id).not.toBe(v1.id);
  });

  it("stamps the playbook version and embedding provider it was built with", async () => {
    const provider: EmbeddingProvider = {
      id: "test-provider-v0",
      dims: EMBEDDING_DIMS,
      embed: (texts) => Promise.resolve(texts.map(embedText)),
    };
    const pack = await generateQAPack(kb(richFacts()), ROOFING, { embeddings: provider });
    expect(pack.embeddingProvider).toBe("test-provider-v0");
    expect(pack.playbookVersion).toBe(ROOFING.playbookVersion);
  });

  it("embeds every pair at the declared width", async () => {
    const pack = await generateQAPack(kb(richFacts()), ROOFING);
    for (const pair of pack.pairs) expect(pair.embedding.length).toBe(EMBEDDING_DIMS);
  });

  it("embeds pairs so a differently-worded visitor question still finds one", async () => {
    const pack = await generateQAPack(kb(richFacts()), ROOFING);
    const visitor = embedText("Do you work in Deira?");
    const best = pack.pairs.reduce(
      (top, pair) => Math.max(top, cosine(visitor, pair.embedding)),
      0,
    );
    expect(best).toBeGreaterThan(0.7);
  });
});

describe("persistence", () => {
  it("round-trips a pack and its embeddings through the database", async () => {
    const pack = await persistedPack(richFacts());
    const loaded = await loadQAPack(db, pack.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.pairs).toHaveLength(pack.pairs.length);
    expect(loaded?.vertical).toBe("roofing");
    expect(loaded?.templateFallbacks).toEqual(pack.templateFallbacks);
    expect(loaded?.gaps).toEqual(pack.gaps);

    const original = pack.pairs.find((p) => p.source === "generated");
    const restored = loaded?.pairs.find((p) => p.id === original?.id);
    expect(restored?.answer).toBe(original?.answer);
    expect(restored?.sourceFactIds).toEqual(original?.sourceFactIds);
    expect(restored?.confidence).toBe(original?.confidence);
    expect(Array.from(restored?.embedding ?? [])).toEqual(Array.from(original?.embedding ?? []));
  });

  it("is idempotent: persisting the same pack twice writes one pack and one row per pair", async () => {
    const pack = await persistedPack(richFacts());
    await persistQAPack(db, pack);
    const packs = await db.one<{ n: string }>(`SELECT count(*) AS n FROM qa_packs WHERE id = $1`, [pack.id]);
    const pairs = await db.one<{ n: string }>(`SELECT count(*) AS n FROM qa_pairs WHERE pack_id = $1`, [pack.id]);
    expect(Number(packs.n)).toBe(1);
    expect(Number(pairs.n)).toBe(pack.pairs.length);
  });

  it("refuses to persist a generated pair with no source fact, without asking the database", async () => {
    const pack = await persistedPack([fact({ factKey: "service", value: "flat roof repair" })]);
    const forged: QAPack = {
      ...pack,
      pairs: [{
        id: randomUUID(),
        question: "Are you Gas Safe registered?",
        answer: "Yes, all our engineers are Gas Safe registered.",
        sourceFactIds: [],
        embedding: embedText("Are you Gas Safe registered?"),
        confidence: 1,
        source: "generated",
      }],
    };
    await expect(persistQAPack(db, forged)).rejects.toThrow(/no source fact/);
  });

  it("returns null for a pack id that does not exist", async () => {
    expect(await loadQAPack(db, randomUUID())).toBeNull();
  });

  it("stores the thin flag and pair count on the pack row", async () => {
    const pack = await persistedPack([fact({ factKey: "service", value: "flat roof repair" })]);
    const row = await db.one<{ thin: boolean; pair_count: number }>(
      `SELECT thin, pair_count FROM qa_packs WHERE id = $1`,
      [pack.id],
    );
    expect(row.thin).toBe(true);
    expect(row.pair_count).toBe(pack.pairs.length);
  });
});

describe("approval", () => {
  it("identifies an unapproved pack", async () => {
    const pack = await persistedPack(richFacts());
    const loaded = await loadQAPack(db, pack.id);
    expect(loaded?.approvedAt).toBeUndefined();
    expect(isApproved(loaded ?? pack)).toBe(false);
  });

  it("stamps approval on the pack and every pair", async () => {
    const pack = await persistedPack(richFacts());
    const approval = await approvePack(db, pack.id, "owner@acme-roofing.example");
    expect(approval.pairsApproved).toBe(pack.pairs.length);

    const loaded = await loadQAPack(db, pack.id);
    expect(isApproved(loaded ?? pack)).toBe(true);
    expect(loaded?.approvedBy).toBe("owner@acme-roofing.example");
    expect(loaded?.pairs.every((p) => p.approvedAt instanceof Date)).toBe(true);
  });

  it("keeps the first approval when called again — approval is evidence, not a setting", async () => {
    const pack = await persistedPack(richFacts());
    const first = await approvePack(db, pack.id, "owner@acme-roofing.example", new Date("2026-05-01T09:00:00Z"));
    const second = await approvePack(db, pack.id, "someone-else@acme-roofing.example");
    expect(second.approvedBy).toBe("owner@acme-roofing.example");
    expect(second.approvedAt.toISOString()).toBe(first.approvedAt.toISOString());
    expect(second.pairsApproved).toBe(0);
  });

  it("throws rather than silently approving a pack that is not there", async () => {
    await expect(approvePack(db, randomUUID(), "owner@acme-roofing.example")).rejects.toThrow(/No such Q&A pack/);
  });
});
