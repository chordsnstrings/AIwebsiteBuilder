import { describe, expect, it } from "vitest";
import {
  blockHash,
  contentBlocks,
  deterministicExtract,
  extractKnowledgeBase,
  type CrawledPage,
  type ExtractDeps,
  type ExtractInput,
  type GbpRecord,
  type RawFact,
} from "./src/index.ts";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const RETRIEVED = new Date("2026-07-27T09:00:00.000Z");
const SITE = "https://acme.example";
const GBP_URL = "https://business.google.com/acme";
const REVIEWS_URL = "https://business.google.com/acme/reviews";

function filler(count: number): string {
  return Array.from({ length: count }, (_, i) => `filler${i}`).join(" ");
}

function page(url: string, text: string, over: Partial<CrawledPage> = {}): CrawledPage {
  return { url, text, retrievedAt: RETRIEVED, depth: 1, lang: "en", ...over };
}

const RICH_PAGE = [
  "Acme Plumbing",
  "",
  "Opening hours",
  "Mon-Fri: 9am-5pm",
  "Sat: 10am-2pm",
  "Sun: closed",
  "",
  "Services",
  "- Drain unblocking — £95",
  "- Boiler servicing — £120",
  "- Emergency callout",
  "",
  "We cover Leeds, Bradford and Wakefield",
  "",
  "Gas Safe registered no. 123456",
  "",
  "Our team",
  "Jane Doe — Practice Manager",
  "Bob Smith",
  "",
  "Contact",
  "info@acme.example",
  "Tel: +44 113 496 0000",
  "",
  "© 2026 Acme Plumbing",
].join("\n");

function input(over: Partial<ExtractInput> = {}): ExtractInput {
  return {
    businessId: "11111111-1111-1111-1111-111111111111",
    pages: [page(`${SITE}/`, RICH_PAGE)],
    marketLang: "en",
    ...over,
  };
}

function deps(over: Partial<ExtractDeps> = {}): ExtractDeps {
  return { extract: deterministicExtract, now: () => NOW, ...over };
}

/** An extractor that returns exactly what a test hands it. */
function fixedExtractor(facts: RawFact[]): ExtractDeps["extract"] {
  return async () => facts.map((f) => ({ ...f }));
}

describe("provenance per fact", () => {
  it("gives every extracted fact a sourceUrl and a retrievedAt", async () => {
    const kb = await extractKnowledgeBase(input(), deps());
    expect(kb.facts.length).toBeGreaterThan(0);
    for (const fact of kb.facts) {
      expect(fact.sourceUrl.length).toBeGreaterThan(0);
      expect(fact.retrievedAt.getTime()).toBe(RETRIEVED.getTime());
    }
  });

  it("drops a fact whose extractor supplied no sourceUrl", async () => {
    const kb = await extractKnowledgeBase(
      input(),
      deps({
        extract: fixedExtractor([
          { type: "service", value: "Sourceless service", sourceUrl: "", retrievedAt: RETRIEVED, confidence: 1 },
          { type: "service", value: "Sourced service", sourceUrl: `${SITE}/`, retrievedAt: RETRIEVED, confidence: 1 },
        ]),
      }),
    );
    expect(kb.facts.map((f) => f.value)).toEqual(["Sourced service"]);
  });

  it("drops a fact whose retrievedAt is missing or invalid", async () => {
    const kb = await extractKnowledgeBase(
      input(),
      deps({
        extract: fixedExtractor([
          { type: "service", value: "Undated", sourceUrl: `${SITE}/`, retrievedAt: new Date("nope"), confidence: 1 },
          { type: "service", value: "Dated", sourceUrl: `${SITE}/`, retrievedAt: RETRIEVED, confidence: 1 },
        ]),
      }),
    );
    expect(kb.facts.map((f) => f.value)).toEqual(["Dated"]);
  });

  it("only ever cites a URL we were given as a source", async () => {
    const gbp: GbpRecord = { sourceUrl: GBP_URL, retrievedAt: RETRIEVED, services: ["Power flushing"] };
    const kb = await extractKnowledgeBase(input({ gbp }), deps());
    const allowed = new Set([`${SITE}/`, GBP_URL]);
    for (const fact of kb.facts) expect(allowed.has(fact.sourceUrl)).toBe(true);
  });
});

describe("conflicts are flagged, never resolved", () => {
  const conflictInput = input({
    pages: [page(`${SITE}/`, ["Opening hours", "Mon: 9am-5pm"].join("\n"))],
    gbp: { sourceUrl: GBP_URL, retrievedAt: RETRIEVED, hours: { mon: "08:00-18:00" } },
  });

  it("keeps both values when the site and GBP disagree about hours", async () => {
    const kb = await extractKnowledgeBase(conflictInput, deps());
    const monday = kb.facts.filter((f) => f.factKey === "hours:en:mon");
    expect(monday.map((f) => f.value).sort()).toEqual(["08:00-18:00", "09:00-17:00"]);
  });

  it("records a KbConflict naming both facts", async () => {
    const kb = await extractKnowledgeBase(conflictInput, deps());
    expect(kb.conflicts).toHaveLength(1);
    const conflict = kb.conflicts[0];
    expect(conflict?.factIds).toHaveLength(2);
    expect(conflict?.description).toContain("hours:en:mon");
    // Nothing in this package may choose between them.
    expect(conflict?.resolvedAt).toBeUndefined();
    expect(conflict?.resolvedValue).toBeUndefined();
  });

  it("turns the conflict into an onboarding question", async () => {
    const kb = await extractKnowledgeBase(conflictInput, deps());
    const gap = kb.gaps.find((g) => g.reason === "conflict");
    expect(gap?.key).toBe("hours:en:mon");
    expect(gap?.question).toContain("09:00-17:00");
    expect(gap?.question).toContain("08:00-18:00");
  });

  it("collapses agreeing sources to one fact and no conflict", async () => {
    const kb = await extractKnowledgeBase(
      input({
        pages: [page(`${SITE}/`, ["Opening hours", "Mon: 9am-5pm"].join("\n"))],
        gbp: { sourceUrl: GBP_URL, retrievedAt: RETRIEVED, hours: { mon: "09:00-17:00" } },
      }),
      deps(),
    );
    expect(kb.conflicts).toHaveLength(0);
    const monday = kb.facts.filter((f) => f.factKey === "hours:en:mon");
    expect(monday).toHaveLength(1);
    // Their own site outranks the directory listing.
    expect(monday[0]?.sourceUrl).toBe(`${SITE}/`);
  });

  it("flags service areas that do not overlap", async () => {
    const kb = await extractKnowledgeBase(
      input({
        pages: [page(`${SITE}/`, "We cover Leeds, Bradford and Wakefield")],
        gbp: { sourceUrl: GBP_URL, retrievedAt: RETRIEVED, areaServed: ["Bristol", "Bath"] },
      }),
      deps(),
    );
    const conflict = kb.conflicts.find((c) => c.description.includes("service areas"));
    expect(conflict).toBeDefined();
    expect(conflict?.factIds).toHaveLength(5);
    expect(kb.facts.filter((f) => f.type === "area")).toHaveLength(5);
  });

  it("does not flag service areas that overlap", async () => {
    const kb = await extractKnowledgeBase(
      input({
        pages: [page(`${SITE}/`, "We cover Leeds, Bradford and Wakefield")],
        gbp: { sourceUrl: GBP_URL, retrievedAt: RETRIEVED, areaServed: ["Leeds"] },
      }),
      deps(),
    );
    expect(kb.conflicts).toHaveLength(0);
  });
});

describe("credential claims", () => {
  it("stores an unverifiable certification as claimed_unverified", async () => {
    const kb = await extractKnowledgeBase(input(), deps());
    const credential = kb.facts.find((f) => f.type === "credential");
    expect(credential?.value).toContain("Gas Safe");
    expect(credential?.status).toBe("claimed_unverified");
  });

  it("promotes a credential only when a register verifies it", async () => {
    const kb = await extractKnowledgeBase(input(), deps({ verifyCredential: async () => true }));
    expect(kb.facts.find((f) => f.type === "credential")?.status).toBe("verified");
  });

  it("leaves the claim unverified when the register says no", async () => {
    const kb = await extractKnowledgeBase(input(), deps({ verifyCredential: async () => false }));
    expect(kb.facts.find((f) => f.type === "credential")?.status).toBe("claimed_unverified");
  });

  it("asks the owner for the registration number", async () => {
    const kb = await extractKnowledgeBase(input(), deps());
    const gap = kb.gaps.find((g) => g.reason === "unverified");
    expect(gap?.question).toContain("registration number");
  });
});

describe("stale signals", () => {
  const stalePage = [
    "Services",
    "- Drain unblocking — £95",
    "",
    "© 2019 Acme Plumbing",
  ].join("\n");

  it("marks a price stale when the source page's copyright is 3+ years old", async () => {
    const kb = await extractKnowledgeBase(input({ pages: [page(`${SITE}/prices`, stalePage)] }), deps());
    const price = kb.facts.find((f) => f.type === "price");
    expect(price?.value).toContain("£95");
    expect(price?.status).toBe("stale");
  });

  it("leaves a price verified when the page is current", async () => {
    const current = stalePage.replace("2019", "2026");
    const kb = await extractKnowledgeBase(input({ pages: [page(`${SITE}/prices`, current)] }), deps());
    expect(kb.facts.find((f) => f.type === "price")?.status).toBe("verified");
  });

  it("asks the owner to confirm a stale price", async () => {
    const kb = await extractKnowledgeBase(input({ pages: [page(`${SITE}/prices`, stalePage)] }), deps());
    expect(kb.gaps.find((g) => g.reason === "stale")?.question).toContain("still current");
  });
});

describe("personal data", () => {
  it("keeps a staff member the business published with a job title", async () => {
    const kb = await extractKnowledgeBase(input(), deps());
    expect(kb.facts.filter((f) => f.type === "staff").map((f) => f.value)).toEqual(["Jane Doe — Practice Manager"]);
  });

  it("drops a name published without a business role", async () => {
    const kb = await extractKnowledgeBase(input(), deps());
    expect(kb.facts.some((f) => f.value.includes("Bob Smith"))).toBe(false);
  });

  it("stores a role mailbox but not an individual's address", async () => {
    const kb = await extractKnowledgeBase(
      input(),
      deps({
        extract: fixedExtractor([
          { type: "contact", value: "info@acme.example", sourceUrl: `${SITE}/`, retrievedAt: RETRIEVED, confidence: 1 },
          { type: "contact", value: "jane.doe@acme.example", sourceUrl: `${SITE}/`, retrievedAt: RETRIEVED, confidence: 1 },
        ]),
      }),
    );
    expect(kb.facts.map((f) => f.value)).toEqual(["info@acme.example"]);
  });

  it("refuses a fact carrying sensitive personal detail whatever its type", async () => {
    const kb = await extractKnowledgeBase(
      input(),
      deps({
        extract: fixedExtractor([
          { type: "policy", value: "Jane Doe date of birth 1980-01-01", sourceUrl: `${SITE}/`, retrievedAt: RETRIEVED, confidence: 1 },
        ]),
      }),
    );
    expect(kb.facts).toHaveLength(0);
  });
});

describe("boilerplate", () => {
  const shared = `Welcome to our website we are a family run business serving customers across the region ${filler(20)}`;
  const own = `Acme Plumbing has unblocked drains in Leeds since nineteen ninety two and every engineer ${filler(20)}`;

  it("discards a page other businesses also publish and flags the KB thin", async () => {
    const sharedHashes = new Set(contentBlocks(shared).map(blockHash));
    const kb = await extractKnowledgeBase(
      input({
        pages: [page(`${SITE}/`, shared), page(`${SITE}/about`, `${own}\n\nWe cover Leeds`)],
      }),
      deps({ duplicates: { count: async (hash) => (sharedHashes.has(hash) ? 4 : 0) } }),
    );
    expect(kb.thin).toBe(true);
    for (const fact of kb.facts) expect(fact.sourceUrl).toBe(`${SITE}/about`);
  });

  it("keeps a page nobody else publishes", async () => {
    const kb = await extractKnowledgeBase(
      input({ pages: [page(`${SITE}/`, `${own}\n\nWe cover Leeds`)] }),
      deps({ duplicates: { count: async () => 0 } }),
    );
    expect(kb.facts.some((f) => f.type === "area")).toBe(true);
  });
});

describe("languages", () => {
  it("tags facts with the language of the page they came from", async () => {
    const french = [
      "Horaires",
      "09:00 - 17:00",
      "",
      "Nos services",
      "- Débouchage de canalisation",
    ].join("\n");
    const kb = await extractKnowledgeBase(
      input({ pages: [page(`${SITE}/`, RICH_PAGE), page(`${SITE}/fr`, french, { lang: "fr" })] }),
      deps(),
    );
    const langs = new Set(kb.facts.map((f) => f.lang));
    expect(langs).toEqual(new Set(["en", "fr"]));
    const fr = kb.facts.filter((f) => f.lang === "fr");
    expect(fr.some((f) => f.factKey === "service:fr:debouchage-de-canalisation")).toBe(true);
    expect(fr.every((f) => f.sourceUrl === `${SITE}/fr`)).toBe(true);
  });

  it("does not merge the same service stated in two languages into one fact", async () => {
    const kb = await extractKnowledgeBase(
      input({
        pages: [
          page(`${SITE}/`, "Services\n- Drain unblocking"),
          page(`${SITE}/fr`, "Nos services\n- Débouchage", { lang: "fr" }),
        ],
      }),
      deps(),
    );
    expect(kb.facts.filter((f) => f.type === "service")).toHaveLength(2);
    expect(kb.conflicts).toHaveLength(0);
  });
});

describe("reviews", () => {
  const reviewInput = (texts: string[]) =>
    input({
      pages: [page(`${SITE}/`, "Services\n- Drain unblocking")],
      reviews: { sourceUrl: REVIEWS_URL, retrievedAt: RETRIEVED, reviews: texts.map((text) => ({ text })) },
    });

  it("extracts a service reviewers mention but the site does not, as inferred", async () => {
    const kb = await extractKnowledgeBase(
      reviewInput(["Brilliant job, they cleaned my gutters.", "Turned up on time and cleaned my gutters."]),
      deps(),
    );
    const inferred = kb.facts.find((f) => f.status === "inferred");
    expect(inferred?.value).toContain("gutters");
    expect(inferred?.sourceUrl).toBe(REVIEWS_URL);
    expect(inferred?.confidence).toBeLessThan(0.5);
  });

  it("turns an inferred service into an onboarding question rather than a claim", async () => {
    const kb = await extractKnowledgeBase(
      reviewInput(["Brilliant job, they cleaned my gutters.", "Turned up on time and cleaned my gutters."]),
      deps(),
    );
    expect(kb.gaps.find((g) => g.reason === "inferred")?.question).toContain("gutters");
  });

  it("ignores a service only one reviewer ever mentioned", async () => {
    const kb = await extractKnowledgeBase(reviewInput(["They cleaned my gutters."]), deps());
    expect(kb.facts.some((f) => f.status === "inferred")).toBe(false);
  });
});

describe("thin content and the template fallback", () => {
  const bland = "Welcome to Acme. A family business with a long history of happy customers in the area.";

  it("falls back to the vertical template questions when nothing was extracted", async () => {
    const kb = await extractKnowledgeBase(input({ pages: [page(`${SITE}/`, bland)], vertical: "roofing" }), deps());
    expect(kb.facts).toHaveLength(0);
    expect(kb.thin).toBe(true);
    expect(kb.gaps.length).toBeGreaterThan(0);
    expect(kb.gaps.every((g) => g.reason === "template")).toBe(true);
    // Roofing never publishes prices, so a missing price is not a gap.
    expect(kb.gaps.some((g) => g.key === "price")).toBe(false);
    expect(kb.gaps.map((g) => g.key).sort()).toEqual(["area", "contact", "hours", "service"]);
  });

  it("flags thin below five pages", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => page(`${SITE}/p${i}`, `${RICH_PAGE}\n${filler(200)}`));
    const kb = await extractKnowledgeBase(input({ pages }), deps());
    expect(kb.thin).toBe(true);
  });

  it("flags thin below four hundred words", async () => {
    const pages = Array.from({ length: 6 }, (_, i) => page(`${SITE}/p${i}`, i === 0 ? RICH_PAGE : "Short page."));
    const kb = await extractKnowledgeBase(input({ pages }), deps());
    expect(kb.thin).toBe(true);
  });

  it("does not flag thin with five substantial pages", async () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      page(`${SITE}/p${i}`, i === 0 ? `${RICH_PAGE}\n\n${filler(120)}` : filler(120)),
    );
    const kb = await extractKnowledgeBase(input({ pages }), deps());
    expect(kb.thin).toBe(false);
  });
});

describe("source discipline", () => {
  it("ignores pages crawled deeper than depth 2", async () => {
    const kb = await extractKnowledgeBase(
      input({
        pages: [
          page(`${SITE}/`, "Services\n- Drain unblocking"),
          page(`${SITE}/deep`, "Services\n- Loft conversions", { depth: 3 }),
        ],
      }),
      deps(),
    );
    expect(kb.facts.some((f) => f.value.includes("Loft"))).toBe(false);
  });

  it("accepts onboarding answers as facts with their own provenance", async () => {
    const kb = await extractKnowledgeBase(
      input({
        onboarding: [
          {
            type: "payment",
            value: "Cash and card",
            sourceUrl: "https://onboarding.adw.example/q/payment",
            retrievedAt: RETRIEVED,
          },
        ],
      }),
      deps(),
    );
    const payment = kb.facts.find((f) => f.type === "payment");
    expect(payment?.value).toBe("Cash and card");
    expect(payment?.sourceUrl).toBe("https://onboarding.adw.example/q/payment");
  });

  it("rejects a fact type outside the closed set", async () => {
    const kb = await extractKnowledgeBase(
      input(),
      deps({
        extract: fixedExtractor([
          { type: "industry_norm" as never, value: "Most plumbers charge £80/hr", sourceUrl: `${SITE}/`, retrievedAt: RETRIEVED, confidence: 1 },
        ]),
      }),
    );
    expect(kb.facts).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("produces the same KB id and fact ids for an unchanged crawl", async () => {
    const a = await extractKnowledgeBase(input(), deps());
    const b = await extractKnowledgeBase(input(), deps({ now: () => new Date("2026-09-01T00:00:00.000Z") }));
    expect(b.id).toBe(a.id);
    expect(b.facts.map((f) => f.id)).toEqual(a.facts.map((f) => f.id));
  });

  it("produces a different KB id when the site content changes", async () => {
    const a = await extractKnowledgeBase(input(), deps());
    const b = await extractKnowledgeBase(
      input({ pages: [page(`${SITE}/`, `${RICH_PAGE}\nWe now also fit water softeners.`)] }),
      deps(),
    );
    expect(b.id).not.toBe(a.id);
  });

  it("produces a different KB id when the GBP record changes", async () => {
    const base = { sourceUrl: GBP_URL, retrievedAt: RETRIEVED } as const;
    const a = await extractKnowledgeBase(input({ gbp: { ...base, hours: { mon: "09:00-17:00" } } }), deps());
    const b = await extractKnowledgeBase(input({ gbp: { ...base, hours: { mon: "08:00-18:00" } } }), deps());
    expect(b.id).not.toBe(a.id);
  });
});

describe("the deterministic extractor", () => {
  it("reads hours, services, prices, areas, credentials and contacts from page text", async () => {
    const facts = await deterministicExtract([page(`${SITE}/`, RICH_PAGE)], undefined, undefined);
    const byType = new Map<string, string[]>();
    for (const f of facts) byType.set(f.type, [...(byType.get(f.type) ?? []), f.value]);
    expect(byType.get("hours")).toEqual(expect.arrayContaining(["09:00-17:00", "10:00-14:00", "closed"]));
    expect(byType.get("service")).toEqual(expect.arrayContaining(["Drain unblocking", "Emergency callout"]));
    expect(byType.get("price")?.some((v) => v.includes("£120"))).toBe(true);
    expect(byType.get("area")).toEqual(expect.arrayContaining(["Leeds", "Bradford", "Wakefield"]));
    expect(byType.get("credential")?.[0]).toContain("Gas Safe");
    expect(byType.get("contact")).toEqual(expect.arrayContaining(["info@acme.example"]));
  });

  it("expands a weekday range into one fact per day", async () => {
    const facts = await deterministicExtract([page(`${SITE}/`, "Opening hours\nMon-Fri: 9am-5pm")], undefined, undefined);
    expect(facts.filter((f) => f.type === "hours").map((f) => f.factKey)).toEqual([
      "hours:en:mon", "hours:en:tue", "hours:en:wed", "hours:en:thu", "hours:en:fri",
    ]);
  });

  it("reads a bare labelled range on a page with no English weekday names", async () => {
    const facts = await deterministicExtract(
      [page(`${SITE}/fr`, "Horaires\n09:00 - 17:00", { lang: "fr" })],
      undefined,
      undefined,
    );
    expect(facts.find((f) => f.type === "hours")).toMatchObject({ factKey: "hours:fr:general", value: "09:00-17:00" });
  });

  it("needs no model, no key and no network", async () => {
    const facts = await deterministicExtract([page(`${SITE}/`, RICH_PAGE)], undefined, undefined);
    expect(facts.length).toBeGreaterThan(5);
  });
});
