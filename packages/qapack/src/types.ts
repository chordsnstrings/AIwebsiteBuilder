// Shapes for the Q&A pack (§21.3, HANDOVER A4→A5). These mirror qa_packs and
// qa_pairs in migration 0009 field for field; where the pack carries more than
// the table has columns for, store.ts says exactly where it lands.

/**
 * The knowledge base comes from @adw/kb — the real type, not a mirror of it.
 *
 * These were briefly redeclared here so pack generation could be built before
 * that package landed, and the two drifted immediately: `gaps` was a string[]
 * on one side and a structured KbGap[] on the other, which typechecked in both
 * packages and failed only where they finally met. A comment promising two
 * shapes agree is not a mechanism; an import is.
 */
export type { KbConflict, KbFact, KbFactStatus, KnowledgeBase } from "@adw/kb";

/**
 * 'template_refusal' is the ONE source permitted to carry no sourceFactIds: it
 * asserts nothing, it states that the business does not publish this.
 * 'promoted_fallback' is an owner-approved answer to a live gap (§21.5) — never
 * auto-promoted, or the system learns its own hallucinations.
 */
export type QAPairSource = "generated" | "template_refusal" | "promoted_fallback";

export interface QAPair {
  id: string;
  question: string;
  answer: string;
  sourceFactIds: string[];
  embedding: Float32Array;
  confidence: number;
  source: QAPairSource;
  approvedAt?: Date | undefined;
  approvedBy?: string | undefined;
}

/** A pair that was built and then thrown away, with the rule that killed it. */
export interface ExcludedPair {
  question: string;
  ruleId: string;
  reason: string;
}

export interface TopicCoverage {
  answered: number;
  total: number;
}

export interface PackCoverage {
  byTopic: Record<string, TopicCoverage>;
  byVerticalTemplate: { answered: number; total: number; ratio: number };
  factsUsed: number;
  factsAvailable: number;
}

export interface QAPack {
  id: string;
  kbId: string;
  businessId: string;
  customerId?: string | undefined;
  version: number;
  vertical: string;
  // What the pack was built against. A pack whose playbook or embedding
  // provider has moved on is re-buildable rather than quietly incomparable.
  playbookVersion: string;
  embeddingProvider: string;
  pairs: QAPair[];
  coverage: PackCoverage;
  /** Template questions this business could not answer. */
  templateFallbacks: string[];
  /** Questions with no answer in the KB. These are NOT pairs (§21.3). */
  gaps: string[];
  excluded: ExcludedPair[];
  thin: boolean;
  /** Thin pack → the onboarding questionnaire gets longer, not the model bolder. */
  extendedOnboarding: boolean;
  approvedAt?: Date | undefined;
  approvedBy?: string | undefined;
  /**
   * On what authority the pack was approved.
   *
   * ⛔ `owner` is a person's signature and is the evidence that makes a stored
   * answer defensible on a paying customer's live site. `speculative` is a
   * policy decision this system made so a preview can answer the business
   * owner it was built for — narrower audience, unofficial-preview banner,
   * answers only from what that business itself published. Collapsing the two
   * into a bare timestamp is how a policy approval ends up serving a customer's
   * visitors, which is the failure §21.3 exists to prevent.
   */
  approvalKind?: "owner" | "speculative" | undefined;
  createdAt: Date;
}

/** An unapproved pack must never go live (§21.3). */
export function isApproved(pack: Pick<QAPack, "approvedAt">): boolean {
  return pack.approvedAt instanceof Date;
}
