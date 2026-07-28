// The knowledge base is what the business has already published, and nothing
// else (spec §21.2). Every type in this file exists to keep that promise
// checkable: a fact that cannot name where it came from and when has no place
// to put that information, so it cannot be constructed.

/** The fact categories the extraction seam is allowed to emit. Closed on purpose:
 *  an extractor that invents a category is inventing a claim. */
export const FACT_TYPES = [
  "hours",
  "service",
  "price",
  "area",
  "credential",
  "contact",
  "payment",
  "staff",
  "policy",
] as const;
export type KbFactType = (typeof FACT_TYPES)[number];

/**
 * 'claimed_unverified' is the load-bearing one: a certification printed on their
 * own site that we could not check against a register. The agent may never
 * assert it (§21.2) — it is the most damaging false claim in this market.
 * 'stale' means the source page itself looks abandoned (§21.2, price/copyright).
 * 'inferred' only ever comes from reviews, never from a model's world knowledge.
 */
export type KbFactStatus = "verified" | "claimed_unverified" | "stale" | "inferred";

export interface KbFact {
  id: string;
  /** `${type}:${lang}:${slug}` — stable across re-crawls, and the join key that
   *  makes "site says 9–5, GBP says 8–6" surface as one conflict rather than
   *  two unrelated facts. Language lives here because kb_facts is frozen and has
   *  no language column; parseFactKey reads it back. */
  factKey: string;
  type: KbFactType;
  value: string;
  /** BCP-47 primary subtag. Multilingual sites are extracted per language. */
  lang: string;
  sourceUrl: string;
  retrievedAt: Date;
  confidence: number;
  status: KbFactStatus;
}

/** Flagged, never resolved. A model picking a side here is the exact failure
 *  §21.2 forbids — resolvedAt/resolvedValue are written by the owner, in
 *  onboarding, and by nothing else. */
export interface KbConflict {
  id: string;
  factIds: string[];
  description: string;
  resolvedAt?: Date;
  resolvedValue?: string;
}

export type KbGapReason = "missing" | "conflict" | "unverified" | "stale" | "inferred" | "template";

/** Something the pack cannot answer from published content. It becomes an
 *  onboarding question; it never becomes a generated answer. */
export interface KbGap {
  key: string;
  reason: KbGapReason;
  question: string;
}

export interface KnowledgeBase {
  id: string;
  businessId: string;
  customerId?: string;
  version: number;
  siteHash: string;
  gbpHash: string;
  /** Fewer than 5 pages or fewer than 400 words of surviving content, or no
   *  facts at all. Drives the vertical-template fallback and the extended
   *  onboarding questionnaire. */
  thin: boolean;
  facts: KbFact[];
  conflicts: KbConflict[];
  gaps: KbGap[];
  createdAt: Date;
}

export interface CrawledPage {
  url: string;
  text: string;
  retrievedAt: Date;
  /** Crawl depth from the site root. Depth > 2 is discarded before extraction. */
  depth: number;
  /** Declared <html lang>. Absent means we detect from the text. */
  lang?: string;
}

export interface GbpRecord {
  sourceUrl: string;
  retrievedAt: Date;
  /** Day key ('mon'…'sun') to a raw range such as '08:00-18:00'. */
  hours?: Record<string, string>;
  services?: string[];
  areaServed?: string[];
  phone?: string;
  lang?: string;
}

export interface ReviewSample {
  sourceUrl: string;
  retrievedAt: Date;
  reviews: { text: string; lang?: string }[];
}

/** An answer the owner gave us directly. Lowest source priority, but still
 *  carries provenance — the questionnaire URL and when they answered. */
export interface OnboardingAnswer {
  type: KbFactType;
  value: string;
  sourceUrl: string;
  retrievedAt: Date;
  lang?: string;
}

/** What an extractor hands back. Provenance is required here rather than
 *  patched in afterwards, so an extractor cannot produce a sourceless fact and
 *  have the pipeline invent one for it. */
export interface RawFact {
  type: KbFactType;
  value: string;
  sourceUrl: string;
  retrievedAt: Date;
  confidence: number;
  /** Override the derived key when the extractor knows the slot (e.g. a
   *  specific weekday) better than a slug of the value would. */
  factKey?: string;
  status?: KbFactStatus;
  lang?: string;
}

export type ExtractorFn = (
  pages: CrawledPage[],
  gbp: GbpRecord | undefined,
  reviews: ReviewSample | undefined,
) => Promise<RawFact[]>;

/** Cross-business duplicate check. A block of text that N other businesses have
 *  also published is their web builder's template, not their knowledge. */
export interface DuplicateIndex {
  /** Number of OTHER businesses known to have published this exact block. */
  count(blockHash: string): Promise<number>;
}

/** Register lookup for a claimed credential. Absent means nothing can be
 *  verified, which is the safe default: everything stays claimed_unverified. */
export type CredentialVerifier = (value: string, sourceUrl: string) => Promise<boolean>;

export interface ExtractDeps {
  extract: ExtractorFn;
  duplicates?: DuplicateIndex;
  verifyCredential?: CredentialVerifier;
  now?: () => Date;
}

export interface ExtractInput {
  businessId: string;
  /** Playbook vertical from the A3 manifest. Used only to source the template
   *  question set when there is nothing to extract. */
  vertical?: string;
  customerId?: string;
  pages: CrawledPage[];
  gbp?: GbpRecord;
  reviews?: ReviewSample;
  onboarding?: OnboardingAnswer[];
  /** Default language for the market, used when a page declares none and the
   *  text is too short to detect. */
  marketLang?: string;
  version?: number;
}
