// Sessions and the turn record.
//
// Every turn is written — inbound text, route, retrieval score, which pair
// answered, what the visitor was told. That record is not analytics. Under
// Moffatt v. Air Canada the business operating an agent owns what it says, and
// the thing that makes their position defensible is being able to show that the
// answer came from a stored, owner-approved pair rather than from a model
// improvising on their behalf. `pair_id` and `retrieval_score` ARE that proof.
//
// It is also the only honest measurement of the hit rate. A retrieval layer
// that reports its own success is measuring its intentions.

import type { Db } from "@adw/db";
import type { AnsweredFrom, ConciergeSession, Route, TurnResult } from "./types.ts";

export interface OpenSessionInput {
  customerId?: string | undefined;
  businessId?: string | undefined;
  previewId?: string | undefined;
  channel?: ConciergeSession["channel"];
  visitorRef?: string | undefined;
}

export async function openSession(db: Db, input: OpenSessionInput): Promise<ConciergeSession> {
  if (input.customerId === undefined && input.previewId === undefined) {
    // Mirrors the table CHECK. Raised here so the caller gets a sentence rather
    // than a constraint name.
    throw new Error("A session belongs to a customer or to a preview — an unattached transcript has no owner");
  }
  const row = await db.one<{ id: string }>(
    `INSERT INTO agent_sessions (customer_id, business_id, preview_id, channel, visitor_ref)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      input.customerId ?? null,
      input.businessId ?? null,
      input.previewId ?? null,
      input.channel ?? "web",
      input.visitorRef ?? null,
    ],
  );
  return {
    id: row.id,
    ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
    ...(input.businessId === undefined ? {} : { businessId: input.businessId }),
    ...(input.previewId === undefined ? {} : { previewId: input.previewId }),
    channel: input.channel ?? "web",
    turnIndex: 0,
  };
}

export async function loadSession(db: Db, id: string): Promise<ConciergeSession | null> {
  const row = await db.maybeOne<{
    id: string;
    customer_id: string | null;
    business_id: string | null;
    preview_id: string | null;
    channel: string;
  }>(`SELECT id, customer_id, business_id, preview_id, channel FROM agent_sessions WHERE id = $1`, [id]);
  if (row === null) return null;
  const next = await db.one<{ next: number }>(
    `SELECT COALESCE(MAX(turn_index) + 1, 0) AS next FROM agent_turns WHERE session_id = $1`,
    [id],
  );
  return {
    id: row.id,
    ...(row.customer_id === null ? {} : { customerId: row.customer_id }),
    ...(row.business_id === null ? {} : { businessId: row.business_id }),
    ...(row.preview_id === null ? {} : { previewId: row.preview_id }),
    channel: (row.channel as ConciergeSession["channel"]) ?? "web",
    turnIndex: Number(next.next),
  };
}

export interface TurnRecord {
  sessionId: string;
  turnIndex: number;
  inbound: string;
  intent?: string | undefined;
  route: Route;
  retrievalScore?: number | undefined;
  pairId?: string | undefined;
  answeredFrom: AnsweredFrom;
  answer: string;
  latencyMs: number;
  costCents: number;
}

/**
 * Write the turn. `(session_id, turn_index)` is unique, so a retried request
 * with the same index updates rather than duplicating — a transcript that grows
 * an extra turn on every retry is evidence of nothing.
 */
export async function recordTurn(db: Db, turn: TurnRecord): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO agent_turns
       (session_id, turn_index, inbound, intent, route, retrieval_score, pair_id,
        answered_from, answer, latency_ms, cost_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (session_id, turn_index) DO UPDATE SET
       inbound = EXCLUDED.inbound,
       intent = EXCLUDED.intent,
       route = EXCLUDED.route,
       retrieval_score = EXCLUDED.retrieval_score,
       pair_id = EXCLUDED.pair_id,
       answered_from = EXCLUDED.answered_from,
       answer = EXCLUDED.answer,
       latency_ms = EXCLUDED.latency_ms,
       cost_cents = EXCLUDED.cost_cents
     RETURNING id`,
    [
      turn.sessionId,
      turn.turnIndex,
      turn.inbound,
      turn.intent ?? null,
      turn.route,
      turn.retrievalScore ?? null,
      turn.pairId ?? null,
      turn.answeredFrom,
      turn.answer,
      turn.latencyMs,
      turn.costCents,
    ],
  );
  return row.id;
}

/**
 * Has this exact turn already been handled?
 *
 * A turn index is the caller's idempotency key. The same index carrying the
 * same words is a retry, a double-tapped send button or a redelivered webhook —
 * never a second question. Re-running it would put the state machines through
 * their decisions twice, and the second run of a lead-capture turn is a second
 * lead in the owner's queue.
 *
 * The effect is re-derived from the durable row rather than cached on the turn,
 * because the booking or enquiry IS the effect; anything else would be a second
 * copy of it that could disagree.
 */
export async function replayTurn(
  db: Db,
  session: ConciergeSession,
  turnIndex: number,
  inbound: string,
): Promise<TurnResult | null> {
  const row = await db.maybeOne<{
    inbound: string;
    route: string;
    answered_from: string;
    answer: string | null;
    pair_id: string | null;
    retrieval_score: string | null;
    latency_ms: number | null;
    cost_cents: string | null;
  }>(
    `SELECT inbound, route, answered_from, answer, pair_id, retrieval_score, latency_ms, cost_cents
       FROM agent_turns WHERE session_id = $1 AND turn_index = $2`,
    [session.id, turnIndex],
  );
  // Different words at the same index is a caller bug, not a replay. Falling
  // through re-runs the turn and overwrites the record, which is the honest
  // outcome — silently returning the OLD answer to a NEW question would be
  // worse than either.
  if (row === null || row.inbound !== inbound) return null;

  const route = row.route as Route;
  let effect: TurnResult["effect"];
  if (route === "booking") {
    const booking = await db.maybeOne<{ id: string }>(
      `SELECT id FROM bookings WHERE session_id = $1 ORDER BY created_at LIMIT 1`,
      [session.id],
    );
    if (booking !== null) effect = { kind: "booking", reference: booking.id };
  } else if (route === "lead_capture") {
    const enquiry = await db.maybeOne<{ id: string }>(
      `SELECT id FROM enquiries WHERE session_id = $1 ORDER BY created_at LIMIT 1`,
      [session.id],
    );
    if (enquiry !== null) effect = { kind: "enquiry", reference: enquiry.id };
  }

  return {
    answer: row.answer ?? "",
    route,
    answeredFrom: row.answered_from as AnsweredFrom,
    ...(row.pair_id === null ? {} : { pairId: row.pair_id }),
    ...(row.retrieval_score === null ? {} : { retrievalScore: Number(row.retrieval_score) }),
    urgency: "normal",
    refused: row.answered_from === "refusal",
    escalate: route === "escalate",
    // The gap was recorded the first time. Reporting it again would double-count
    // a question that was only asked once.
    gapLogged: false,
    injectionSuspected: false,
    modelCalls: 0,
    costCents: Number(row.cost_cents ?? 0),
    latencyMs: row.latency_ms ?? 0,
    ...(effect === undefined ? {} : { effect }),
  };
}

// ---------------------------------------------------------------------------
// Machine state (migration 0010)
// ---------------------------------------------------------------------------

export interface MachineState {
  booking?: unknown;
  lead?: unknown;
}

export async function loadMachineState(db: Db, sessionId: string): Promise<MachineState> {
  const row = await db.maybeOne<{ machine_state: MachineState | null }>(
    `SELECT machine_state FROM agent_sessions WHERE id = $1`,
    [sessionId],
  );
  return row?.machine_state ?? {};
}

export async function saveMachineState(db: Db, sessionId: string, state: MachineState): Promise<void> {
  await db.query(`UPDATE agent_sessions SET machine_state = $2::jsonb WHERE id = $1`, [
    sessionId,
    JSON.stringify(state),
  ]);
}

/**
 * Turn-level hit rate for a customer. The number the product is judged on
 * (0.80 at launch, 0.93 by month three) and therefore the one worth being
 * pedantic about.
 *
 * The denominator is every turn that ATTEMPTED retrieval, misses included.
 * Counting only the turns that produced an answer would report 100% forever.
 * Hard refusals and state-machine turns are excluded because they never
 * consulted the pack — putting them in either direction measures the router,
 * not the pack.
 */
export async function hitRate(db: Db, customerId: string, sinceDays = 30): Promise<{ turns: number; answered: number; rate: number }> {
  const row = await db.one<{ turns: string; answered: string }>(
    `SELECT COUNT(*) AS turns,
            COUNT(*) FILTER (WHERE answered_from IN ('pack','pack_hedged')) AS answered
       FROM agent_turns t
       JOIN agent_sessions s ON s.id = t.session_id
      WHERE s.customer_id = $1
        AND t.route = 'retrieval'
        AND t.created_at > now() - ($2 || ' days')::interval`,
    [customerId, String(sinceDays)],
  );
  const turns = Number(row.turns);
  const answered = Number(row.answered);
  return { turns, answered, rate: turns === 0 ? 0 : answered / turns };
}
