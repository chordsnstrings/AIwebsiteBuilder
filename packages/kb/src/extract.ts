// Knowledge-base assembly (spec §21.2, workflow handover A3→A4).
//
// The extractor seam decides WHAT text says. This file decides what is allowed
// to become a fact, and it does so without a model: provenance enforcement,
// personal-data policy, staleness, credential status, conflict flagging and the
// thin/fallback decision are all deterministic. That split is the point — swap
// the extractor and none of the guarantees below move.
import { config } from "@adw/config";
import {
  type CrawledPage,
  type ExtractDeps,
  type ExtractInput,
  type GbpRecord,
  type KbConflict,
  type KbFact,
  type KbFactStatus,
  type KbGap,
  type KnowledgeBase,
  type RawFact,
  FACT_TYPES,
  type KbFactType,
} from "./types.ts";
import { isBusinessRoleFact } from "./personal.ts";
import {
  blockHash,
  contentBlocks,
  copyrightYear,
  detectLanguage,
  deterministicUuid,
  normalizeValue,
  sha256Hex,
  slugify,
  words,
} from "./text.ts";

/** Their site is crawled to depth 2 and no further (§21.2). */
export const MAX_CRAWL_DEPTH = 2;
/** Thin thresholds — below either one the pack falls back to the vertical
 *  template and onboarding gets extended. */
export const THIN_MIN_PAGES = 5;
export const THIN_MIN_WORDS = 400;
/** A price on a page whose own copyright is this many years behind is not a
 *  price we let the agent quote unconfirmed. */
export const STALE_YEARS = 3;
/** Blocks published by at least this many OTHER businesses are a builder's
 *  template, not this business's knowledge. */
export const BOILERPLATE_MIN_OTHERS = 2;
/** A page this much of which is other people's text is discarded whole. */
export const BOILERPLATE_PAGE_RATIO = 0.6;

const FACT_TYPE_SET = new Set<string>(FACT_TYPES);

type SourceLabel = "site" | "gbp" | "reviews" | "onboarding" | "unknown";
const SOURCE_ORDER: SourceLabel[] = ["site", "gbp", "reviews", "onboarding", "unknown"];
const SOURCE_TEXT: Record<SourceLabel, string> = {
  site: "their site",
  gbp: "their Google Business Profile",
  reviews: "their reviews",
  onboarding: "onboarding",
  unknown: "an unattributed source",
};

const TYPE_QUESTIONS: Record<KbFactType, string> = {
  hours: "What are your opening hours, for each day of the week?",
  service: "Which services should the agent be able to describe?",
  price: "Which of your prices, exactly, may the agent quote?",
  area: "Which areas do you cover?",
  credential: "Which certifications may we state, and what is the registration number for each?",
  contact: "Which phone number and email address should the agent give out?",
  payment: "Which payment methods do you accept?",
  staff: "Who should the agent name, and with what job title?",
  policy: "What are your cancellation and guarantee policies?",
};

/** Playbook site modules that imply a fact type customers will ask about. */
const MODULE_FACT_TYPES: Record<string, KbFactType> = {
  services: "service",
  service_area: "area",
  pricing: "price",
  credentials: "credential",
  contact: "contact",
  emergency: "hours",
  booking: "hours",
};

interface PlaybookVertical {
  site_modules?: string[];
  pricing?: string;
}

function verticalPlaybook(vertical: string | undefined): PlaybookVertical | undefined {
  if (vertical === undefined) return undefined;
  const { data } = config.playbooks() as { data: { verticals?: Record<string, PlaybookVertical> } };
  return data.verticals?.[vertical];
}

/** Fact types this vertical's customers will ask about. Drives both the gap
 *  list and the zero-fact template fallback. */
function expectedTypes(vertical: string | undefined): KbFactType[] {
  const playbook = verticalPlaybook(vertical);
  const out = new Set<KbFactType>(["hours", "service", "area", "contact"]);
  for (const mod of playbook?.site_modules ?? []) {
    const type = MODULE_FACT_TYPES[mod];
    if (type !== undefined) out.add(type);
  }
  // A vertical that never publishes prices is not missing one.
  if (playbook?.pricing === "never_published") out.delete("price");
  else if (playbook !== undefined) out.add("price");
  return [...out].sort();
}

function sourceLabelOf(url: string, index: SourceIndex): SourceLabel {
  if (index.site.has(url)) return "site";
  if (index.gbp === url) return "gbp";
  if (index.reviews === url) return "reviews";
  if (index.onboarding.has(url)) return "onboarding";
  return "unknown";
}

interface SourceIndex {
  site: Set<string>;
  gbp: string | undefined;
  reviews: string | undefined;
  onboarding: Set<string>;
  /** Pages whose own copyright line is STALE_YEARS or more behind. */
  stalePages: Set<string>;
  langByUrl: Map<string, string>;
}

/** Field-by-field so a change to any GBP value the KB actually reads produces a
 *  new KB id, and a change to anything else does not. */
function gbpFingerprint(gbp: GbpRecord): string {
  return sha256Hex(
    gbp.sourceUrl,
    ...Object.entries(gbp.hours ?? {}).map(([day, value]) => `h:${day}=${value}`).sort(),
    ...(gbp.services ?? []).map((s) => `s:${s}`).sort(),
    ...(gbp.areaServed ?? []).map((a) => `a:${a}`).sort(),
    `p:${gbp.phone ?? ""}`,
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function discardBoilerplate(
  pages: CrawledPage[],
  deps: ExtractDeps,
): Promise<{ kept: CrawledPage[]; discarded: CrawledPage[] }> {
  const index = deps.duplicates;
  if (index === undefined) return { kept: pages, discarded: [] };

  const kept: CrawledPage[] = [];
  const discarded: CrawledPage[] = [];
  for (const page of pages) {
    const blocks = contentBlocks(page.text);
    let total = 0;
    let duplicated = 0;
    for (const block of blocks) {
      const weight = words(block).length;
      total += weight;
      if ((await index.count(blockHash(block))) >= BOILERPLATE_MIN_OTHERS) duplicated += weight;
    }
    if (total > 0 && duplicated / total >= BOILERPLATE_PAGE_RATIO) discarded.push(page);
    else kept.push(page);
  }
  return { kept, discarded };
}

function statusFor(
  raw: RawFact,
  index: SourceIndex,
  credentialVerified: boolean,
): KbFactStatus {
  const declared = raw.status ?? "verified";
  if (raw.type === "credential" && declared !== "inferred") {
    // The single most damaging false claim in this market. Nothing but a
    // register lookup may promote it to 'verified'.
    return credentialVerified ? "verified" : "claimed_unverified";
  }
  // A price quoted off a page the business itself stopped maintaining.
  if (raw.type === "price" && index.stalePages.has(raw.sourceUrl) && declared === "verified") {
    return "stale";
  }
  return declared;
}

function normalizeFact(raw: RawFact, kbId: string, index: SourceIndex, status: KbFactStatus): KbFact | null {
  if (!FACT_TYPE_SET.has(raw.type)) return null;
  const value = raw.value.replace(/\s+/g, " ").trim();
  if (value.length === 0) return null;
  // The rule the whole architecture rests on: no source URL and no retrieval
  // time means no fact. There is no branch that supplies a default for either.
  if (typeof raw.sourceUrl !== "string" || raw.sourceUrl.trim().length === 0) return null;
  if (!isValidDate(raw.retrievedAt)) return null;

  const lang = raw.lang ?? index.langByUrl.get(raw.sourceUrl) ?? "en";
  const factKey = raw.factKey ?? `${raw.type}:${lang}:${slugify(value)}`;
  const confidence = Math.min(1, Math.max(0, Number.isFinite(raw.confidence) ? raw.confidence : 0));
  return {
    id: deterministicUuid(kbId, factKey, normalizeValue(value), raw.sourceUrl),
    factKey,
    type: raw.type,
    value,
    lang,
    sourceUrl: raw.sourceUrl,
    retrievedAt: raw.retrievedAt,
    confidence,
    status,
  };
}

function priorityOf(fact: KbFact, index: SourceIndex): number {
  return SOURCE_ORDER.indexOf(sourceLabelOf(fact.sourceUrl, index));
}

/**
 * One row per distinct claim. Two sources stating the SAME thing collapse to
 * the higher-priority one; two sources stating DIFFERENT things both survive
 * and become a conflict. Nothing here picks a winner between them.
 */
function reconcile(
  facts: KbFact[],
  kbId: string,
  index: SourceIndex,
): { facts: KbFact[]; conflicts: KbConflict[] } {
  const groups = new Map<string, Map<string, KbFact>>();
  for (const fact of facts) {
    const byValue = groups.get(fact.factKey) ?? new Map<string, KbFact>();
    const norm = normalizeValue(fact.value);
    const existing = byValue.get(norm);
    if (existing === undefined || priorityOf(fact, index) < priorityOf(existing, index)) {
      byValue.set(norm, fact);
    }
    groups.set(fact.factKey, byValue);
  }

  const out: KbFact[] = [];
  const conflicts: KbConflict[] = [];
  for (const [factKey, byValue] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const variants = [...byValue.values()].sort((a, b) => priorityOf(a, index) - priorityOf(b, index) || a.id.localeCompare(b.id));
    out.push(...variants);
    if (variants.length < 2) continue;
    const described = variants
      .map((f) => `${SOURCE_TEXT[sourceLabelOf(f.sourceUrl, index)]} says “${f.value}”`)
      .join("; ");
    conflicts.push(makeConflict(kbId, variants.map((f) => f.id), `Conflicting ${factKey}: ${described}`));
  }

  conflicts.push(...areaConflicts(out, kbId, index));
  return { facts: out.sort((a, b) => a.factKey.localeCompare(b.factKey) || a.id.localeCompare(b.id)), conflicts };
}

/** Two sources listing areas with nothing in common is a contradiction even
 *  though no single fact key collides — "we cover Leeds" vs "we cover Bristol". */
function areaConflicts(facts: KbFact[], kbId: string, index: SourceIndex): KbConflict[] {
  const bySource = new Map<SourceLabel, KbFact[]>();
  for (const fact of facts) {
    if (fact.type !== "area") continue;
    const label = sourceLabelOf(fact.sourceUrl, index);
    bySource.set(label, [...(bySource.get(label) ?? []), fact]);
  }
  const entries = [...bySource].filter(([, list]) => list.length > 0).sort((a, b) => a[0].localeCompare(b[0]));
  const out: KbConflict[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [labelA, listA] = entries[i] as [SourceLabel, KbFact[]];
      const [labelB, listB] = entries[j] as [SourceLabel, KbFact[]];
      const slugsA = new Set(listA.map((f) => slugify(f.value)));
      const overlap = listB.some((f) => slugsA.has(slugify(f.value)));
      if (overlap) continue;
      out.push(
        makeConflict(
          kbId,
          [...listA, ...listB].map((f) => f.id),
          `Conflicting service areas: ${SOURCE_TEXT[labelA]} lists ${listA.map((f) => f.value).join(", ")}; ` +
            `${SOURCE_TEXT[labelB]} lists ${listB.map((f) => f.value).join(", ")}`,
        ),
      );
    }
  }
  return out;
}

function makeConflict(kbId: string, factIds: string[], description: string): KbConflict {
  const ids = [...factIds].sort();
  return { id: deterministicUuid(kbId, "conflict", ...ids), factIds: ids, description };
}

/**
 * Everything the pack cannot answer from published content. Derived purely from
 * the stored facts and conflicts so that a loaded KB produces the same list as
 * a freshly extracted one — the gap list is not separately persisted.
 */
export function computeGaps(
  facts: KbFact[],
  conflicts: KbConflict[],
  vertical: string | undefined,
): KbGap[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const gaps: KbGap[] = [];

  for (const conflict of conflicts) {
    if (conflict.resolvedAt !== undefined) continue;
    const involved = conflict.factIds.map((id) => byId.get(id)).filter((f): f is KbFact => f !== undefined);
    const key = involved[0]?.factKey ?? conflict.id;
    const values = [...new Set(involved.map((f) => f.value))];
    gaps.push({
      key,
      reason: "conflict",
      question:
        values.length > 1
          ? `Your sources disagree about ${key}. Which is correct: ${values.map((v) => `“${v}”`).join(" or ")}?`
          : `Your sources disagree about ${key}. Which is correct?`,
    });
  }

  for (const fact of facts) {
    if (fact.status === "claimed_unverified") {
      gaps.push({
        key: fact.factKey,
        reason: "unverified",
        question: `Your site claims “${fact.value}”. What is the registration number, so we can verify it? Until then the agent will not mention it.`,
      });
    } else if (fact.status === "stale") {
      gaps.push({
        key: fact.factKey,
        reason: "stale",
        question: `“${fact.value}” comes from a page that has not been updated in years. Is it still current?`,
      });
    } else if (fact.status === "inferred") {
      gaps.push({
        key: fact.factKey,
        reason: "inferred",
        question: `Your reviews mention “${fact.value}” but your site does not. Do you offer it?`,
      });
    }
  }

  const present = new Set(facts.map((f) => f.type));
  const expected = expectedTypes(vertical);
  // Nothing published at all: the vertical template supplies the QUESTIONS, and
  // only the questions. It never supplies answers — a templated answer has no
  // source URL and would be exactly the fabrication this design prevents.
  const templateFallback = facts.length === 0;
  for (const type of expected) {
    if (present.has(type)) continue;
    gaps.push({ key: type, reason: templateFallback ? "template" : "missing", question: TYPE_QUESTIONS[type] });
  }

  return gaps.sort((a, b) => a.reason.localeCompare(b.reason) || a.key.localeCompare(b.key) || a.question.localeCompare(b.question));
}

/**
 * Build a knowledge base from what this business has published. Sources, in
 * priority order: their site (depth 2), their Google Business Profile, their
 * reviews, their onboarding answers. Nothing else — no competitor's site, no
 * industry norm, no inference from the model's own knowledge.
 */
export async function extractKnowledgeBase(input: ExtractInput, deps: ExtractDeps): Promise<KnowledgeBase> {
  const now = deps.now?.() ?? new Date();
  const inDepth = input.pages.filter((p) => p.depth <= MAX_CRAWL_DEPTH);
  const { kept, discarded } = await discardBoilerplate(inDepth, deps);

  const langByUrl = new Map<string, string>();
  const stalePages = new Set<string>();
  for (const page of kept) {
    langByUrl.set(page.url, page.lang ?? detectLanguage(page.text) ?? input.marketLang ?? "en");
    const year = copyrightYear(page.text);
    if (year !== undefined && now.getUTCFullYear() - year >= STALE_YEARS) stalePages.add(page.url);
  }
  if (input.gbp !== undefined) langByUrl.set(input.gbp.sourceUrl, input.gbp.lang ?? input.marketLang ?? "en");

  const index: SourceIndex = {
    site: new Set(kept.map((p) => p.url)),
    gbp: input.gbp?.sourceUrl,
    reviews: input.reviews?.sourceUrl,
    onboarding: new Set((input.onboarding ?? []).map((a) => a.sourceUrl)),
    stalePages,
    langByUrl,
  };

  const siteHash = sha256Hex(...kept.map((p) => `${p.url}#${sha256Hex(normalizeValue(p.text))}`).sort());
  const gbpHash = input.gbp === undefined ? "none" : gbpFingerprint(input.gbp);
  const kbId = deterministicUuid(input.businessId, "kb", siteHash, gbpHash);

  const raw = await deps.extract(kept, input.gbp, input.reviews);
  for (const answer of input.onboarding ?? []) {
    raw.push({
      type: answer.type,
      value: answer.value,
      sourceUrl: answer.sourceUrl,
      retrievedAt: answer.retrievedAt,
      confidence: 1,
      ...(answer.lang === undefined ? {} : { lang: answer.lang }),
    });
  }

  const normalized: KbFact[] = [];
  for (const item of raw) {
    if (!isBusinessRoleFact(item)) continue;
    const verified =
      item.type === "credential" && deps.verifyCredential !== undefined
        ? await deps.verifyCredential(item.value, item.sourceUrl)
        : false;
    const fact = normalizeFact(item, kbId, index, statusFor(item, index, verified));
    if (fact !== null) normalized.push(fact);
  }

  const { facts, conflicts } = reconcile(normalized, kbId, index);
  const wordCount = kept.reduce((n, p) => n + words(p.text).length, 0);
  const thin =
    facts.length === 0 ||
    kept.length < THIN_MIN_PAGES ||
    wordCount < THIN_MIN_WORDS ||
    // Their site turned out to be someone else's template; whatever is left is
    // not a description of this business.
    discarded.length > 0;

  return {
    id: kbId,
    businessId: input.businessId,
    ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
    version: input.version ?? 1,
    siteHash,
    gbpHash,
    thin,
    facts,
    conflicts,
    gaps: computeGaps(facts, conflicts, input.vertical),
    createdAt: now,
  };
}
