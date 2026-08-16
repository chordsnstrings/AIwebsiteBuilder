// Shapes for the customer's agent (§39). These mirror agent_sessions,
// agent_turns and agent_gaps in migration 0009 — the turn record is the
// evidence trail, so nothing here may be richer than what gets stored.

import type { QAPack, QAPair } from "@adw/qapack";

/** Where the turn went. Mirrors agent_turns.route. */
export type Route = "retrieval" | "booking" | "lead_capture" | "fallback" | "escalate" | "photo" | "protocol";

/** What produced the words. Mirrors agent_turns.answered_from. */
export type AnsweredFrom = "pack" | "pack_hedged" | "fallback" | "refusal" | "state_machine" | "protocol";

export type Urgency = "emergency" | "urgent" | "normal";

export interface RetrievalThresholds {
  verbatimMin: number;
  hedgedMin: number;
  rrfK: number;
  vectorWeight: number;
  bm25Weight: number;
}

/** A pack prepared for scanning. Built once, queried per turn. */
export interface PackIndex {
  packId: string;
  vertical: string;
  embeddingProvider: string;
  pairs: QAPair[];
  /** Lower-cased question + answer, per pair, for BM25 and coverage. */
  texts: string[];
  bm25: Bm25Index;
}

export interface Bm25Index {
  /** term → inverse document frequency */
  idf: Map<string, number>;
  /** per-document term frequencies */
  tf: Map<string, number>[];
  lengths: number[];
  avgLength: number;
}

export interface ScoredPair {
  pair: QAPair;
  /** Cosine of the query against the pair's stored embedding — 0..1. */
  cosine: number;
  /** BM25 score. Unbounded, comparable only within one query. */
  bm25: number;
  /** Reciprocal-rank fusion of the two rankings. Ordering only. */
  rrf: number;
  /** Question terms that narrow it and are absent from the pair. */
  missingTerms: string[];
}

export type RetrievalOutcome =
  | { hit: true; mode: "verbatim" | "hedged"; pair: QAPair; score: number; ranked: ScoredPair[] }
  | {
      hit: false;
      /** Why nothing was returned. `coverage` means a pair scored well enough
       *  but was about something else — the near-miss that matters most. */
      reason: "empty_pack" | "below_threshold" | "coverage";
      best?: ScoredPair;
      ranked: ScoredPair[];
    };

/** The identity of the conversation. Everything a turn is stored against. */
export interface ConciergeSession {
  id: string;
  customerId?: string | undefined;
  businessId?: string | undefined;
  previewId?: string | undefined;
  channel: "web" | "whatsapp" | "mcp" | "voice";
  turnIndex: number;
}

export interface ConciergeContext {
  session: ConciergeSession;
  vertical: string;
  /** The approved pack. An unapproved pack must never serve a visitor. */
  index: PackIndex;
  /** Facts the fallback may read. Text only — the fallback never sees ids it
   *  could cite without the retrieval layer having selected them. */
  kbSlice: string[];
  /** Booking is advertised only where the vertical allows it AND a calendar is
   *  connected. Absent capability is the reason a booking turn is refused. */
  capabilities: string[];
  calendarConnected: boolean;
}

export interface TurnResult {
  answer: string;
  route: Route;
  answeredFrom: AnsweredFrom;
  pairId?: string | undefined;
  retrievalScore?: number | undefined;
  urgency: Urgency;
  refused: boolean;
  escalate: boolean;
  /** True when the exact question was written to agent_gaps. */
  gapLogged: boolean;
  injectionSuspected: boolean;
  /** Model calls this turn. A plain business question must cost zero. */
  modelCalls: number;
  costCents: number;
  latencyMs: number;
  /** Present on a state-machine turn once the machine has everything it needs.
   *  `incident` is a protocol firing — the reference is the incident id, and it
   *  is the only effect that means the conversation has been stopped. */
  effect?: { kind: "enquiry" | "booking" | "incident"; reference: string } | undefined;
  /** Set when a protocol fired. Names it so the transcript and the owner's
   *  queue agree about what happened. */
  protocolId?: string | undefined;
}

/** An unapproved pack must never reach a visitor (§21.3). */
export class UnapprovedPackError extends Error {}

export function assertPackApproved(pack: Pick<QAPack, "id" | "approvedAt">): void {
  if (!(pack.approvedAt instanceof Date)) {
    throw new UnapprovedPackError(
      `Q&A pack ${pack.id} has not been approved by the owner. The agent answers only from an ` +
        "approved pack — approval is the evidence that makes a stored answer defensible.",
    );
  }
}
