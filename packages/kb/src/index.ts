/**
 * @adw/kb — knowledge-base extraction with provenance per fact (spec §21.2,
 * workflow handover A3→A4).
 *
 * What a business has published, and nothing else. Every fact names its source
 * URL and when we retrieved it; conflicting sources are flagged for the owner
 * rather than reconciled by a model; an unverifiable certification is stored as
 * a claim, never as a fact. What cannot be extracted becomes a gap, and a gap
 * becomes an onboarding question — never a plausible answer.
 */
export type {
  CrawledPage,
  CredentialVerifier,
  DuplicateIndex,
  ExtractDeps,
  ExtractInput,
  ExtractorFn,
  GbpRecord,
  KbConflict,
  KbFact,
  KbFactStatus,
  KbFactType,
  KbGap,
  KbGapReason,
  KnowledgeBase,
  OnboardingAnswer,
  RawFact,
  ReviewSample,
} from "./types.ts";
export { FACT_TYPES, mayPublish } from "./types.ts";

export {
  extractKnowledgeBase,
  computeGaps,
  BOILERPLATE_MIN_OTHERS,
  BOILERPLATE_PAGE_RATIO,
  MAX_CRAWL_DEPTH,
  STALE_YEARS,
  THIN_MIN_PAGES,
  THIN_MIN_WORDS,
} from "./extract.ts";

/** Keyless default extractor — regex and heuristics only. */
export { deterministicExtract } from "./deterministic.ts";

export { isBusinessRoleFact, STAFF_ROLE_RE } from "./personal.ts";

export { persistKnowledgeBase, loadKnowledgeBase, type PersistResult } from "./persist.ts";

/** contentBlocks + blockHash are how a caller populates a DuplicateIndex: hash
 *  every block of every crawled page, count how many businesses share each. */
export {
  blockHash,
  contentBlocks,
  copyrightYear,
  detectLanguage,
  deterministicUuid,
  normalizeTimeRange,
  slugify,
} from "./text.ts";
