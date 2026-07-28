// The gap list (§21.5) — what the agent was asked and could not answer.
//
// This is the most valuable table in the product and the easiest one to get
// subtly wrong. It is the business telling its owner what its customers
// actually want to know, in their words, ranked by how often they ask. It is
// also the ONLY route by which the pack grows, and it runs through the owner:
// a system that promotes its own drafts is a system learning its own
// hallucinations, and the second time round there is nothing left to check them
// against.
//
// So: the exact question is stored verbatim, the same question asked again
// increments a counter instead of adding a row, and `approved_at` is written by
// a human or not at all.

import type { Db } from "@adw/db";
import { narrowingTerms, stem } from "../retrieval/coverage.ts";

const STOPWORDS_FOR_NORM = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "can", "could", "did", "do", "does",
  "for", "from", "has", "have", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on",
  "or", "please", "that", "the", "there", "they", "this", "to", "us", "was", "we", "what",
  "whats", "when", "where", "which", "who", "will", "with", "would", "you", "your",
]);

/**
 * The dedupe key behind `agent_gaps_dedupe`.
 *
 * Built from the terms that NARROW the question, sorted, so "how much is a
 * callout?" and "what's your callout fee?" land on one row — they are one thing
 * the owner has to answer once, and showing them as two makes a short list look
 * like a long one.
 *
 * Questions that narrow to nothing ("how much do you charge?") fall back to
 * their stemmed content words, or every generic question in the product would
 * collapse into a single unreadable row.
 */
export function normaliseQuestion(question: string): string {
  const narrowing = narrowingTerms(question);
  if (narrowing.length > 0) return [...narrowing].sort().join(" ");
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0 && !STOPWORDS_FOR_NORM.has(w))
    .map(stem);
  return words.length > 0 ? [...new Set(words)].sort().join(" ") : question.trim().toLowerCase();
}

export interface GapInput {
  question: string;
  customerId?: string | undefined;
  businessId?: string | undefined;
}

export interface GapRecord {
  id: string;
  timesAsked: number;
  /** False when this call incremented an existing gap. */
  created: boolean;
}

/**
 * Record the question. Repeats increment; they never insert.
 *
 * The unique index is on `COALESCE(customer_id, business_id)`, an expression,
 * so `ON CONFLICT` cannot name it by column list — the expression is repeated
 * here verbatim instead. Getting that wrong is silent: the insert succeeds, the
 * counter stays at 1, and the owner's list fills with the same question.
 */
export async function recordGap(db: Db, input: GapInput): Promise<GapRecord> {
  if (input.customerId === undefined && input.businessId === undefined) {
    throw new Error("A gap must belong to a customer or a business — an unattributed gap is nobody's to answer");
  }
  const row = await db.one<{ id: string; times_asked: number; inserted: boolean }>(
    `INSERT INTO agent_gaps (customer_id, business_id, question, question_norm)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (COALESCE(customer_id, business_id), question_norm) DO UPDATE
       SET times_asked = agent_gaps.times_asked + 1,
           last_asked_at = now()
     RETURNING id, times_asked, (xmax = 0) AS inserted`,
    [input.customerId ?? null, input.businessId ?? null, input.question.trim(), normaliseQuestion(input.question)],
  );
  return { id: row.id, timesAsked: row.times_asked, created: row.inserted };
}

export interface OpenGap {
  id: string;
  question: string;
  timesAsked: number;
  firstAskedAt: Date;
  lastAskedAt: Date;
  draftedAnswer: string | null;
  status: string;
}

/** The owner's list, most-asked first. Nothing here is answered yet. */
export async function openGaps(db: Db, owner: { customerId?: string; businessId?: string }, limit = 50): Promise<OpenGap[]> {
  const res = await db.query<{
    id: string;
    question: string;
    times_asked: number;
    first_asked_at: Date;
    last_asked_at: Date;
    drafted_answer: string | null;
    status: string;
  }>(
    `SELECT id, question, times_asked, first_asked_at, last_asked_at, drafted_answer, status
       FROM agent_gaps
      WHERE COALESCE(customer_id, business_id) = $1 AND status IN ('open','drafted')
      ORDER BY times_asked DESC, last_asked_at DESC
      LIMIT $2`,
    [owner.customerId ?? owner.businessId ?? null, limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    question: r.question,
    timesAsked: r.times_asked,
    firstAskedAt: r.first_asked_at,
    lastAskedAt: r.last_asked_at,
    draftedAnswer: r.drafted_answer,
    status: r.status,
  }));
}
