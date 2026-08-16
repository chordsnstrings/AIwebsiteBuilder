// @adw/concierge — the customer's agent.
//
// This is the thing the $399 setup fee buys and the subscription keeps running.
// Not a chatbot on a website: a business a machine can read and transact with,
// at a market baseline where 9.6% publish Service schema and 11.6% are both
// machine-readable and bookable.
//
// The architecture is one sentence. ⛔ A stored answer is RETURNED, never
// composed — and everything else in this package exists to keep that true under
// paraphrase, under ambiguity, under prompt injection, and under the pressure
// of a visitor who really wants a price.
//
// A turn goes: hard refusals → deterministic route → (retrieval | booking |
// lead capture | photo | escalation) → fallback only if retrieval missed, and
// the fallback's output is guarded by the same coverage rule that gated
// retrieval. Every step writes to agent_turns, because under Moffatt v. Air
// Canada the liability for what an agent says sits with the business operating
// it, and "it came from a pair you approved" is the defence.

import type { Db } from "@adw/db";
import { detectProtocol, openIncident } from "@adw/protocol";
import { assertPackApproved, type ConciergeContext, type ConciergeSession, type Route, type TurnResult } from "./types.ts";
import type { QAPack } from "@adw/qapack";
import { buildPackIndex, retrieve, thresholds } from "./retrieval/index.ts";
import { REFUSAL_TEXT, refusalPolicy, type RefusalPolicy } from "./refusals.ts";
import { resolveRoute, type ModelRouter, type RouterOptions } from "./router/index.ts";
import { runFallback, type FallbackModel } from "./fallback/index.ts";
import {
  bookingConfirmation,
  bookingNext,
  commitBooking,
  extractContact,
  initialBookingState,
  type BookingState,
  type Slot,
} from "./statemachine/booking.ts";
import { commitEnquiry, initialLeadState, leadNext, type LeadState } from "./statemachine/lead.ts";
import { loadMachineState, recordTurn, replayTurn, saveMachineState } from "./session.ts";

export * from "./types.ts";
export {
  BM25_B,
  BM25_K1,
  bm25Score,
  buildBm25,
  buildPackIndex,
  indexFromRows,
  missingTerms,
  narrowingTerms,
  retrieve,
  stem,
  stemSet,
  thresholds,
} from "./retrieval/index.ts";
export {
  isQuestionShaped,
  REFUSAL_TEXT,
  refusalPolicy,
  refusalRules,
  type AnswerGuardContext,
  type RefusalPolicy,
  type RefusalRule,
} from "./refusals.ts";
export { resolveRoute, routeTurn, type ModelRouter, type RouterDecision, type RouterOptions } from "./router/index.ts";
export {
  normaliseQuestion,
  openGaps,
  recordGap,
  runFallback,
  type FallbackModel,
  type FallbackResult,
  type GapRecord,
  type OpenGap,
} from "./fallback/index.ts";
export {
  bookingConfirmation,
  bookingIdempotencyKey,
  bookingNext,
  commitBooking,
  extractContact,
  initialBookingState,
  pickSlot,
  type BookingRecord,
  type BookingState,
  type Slot,
} from "./statemachine/booking.ts";
export {
  commitEnquiry,
  extractName,
  initialLeadState,
  leadNext,
  type EnquiryRecord,
  type LeadState,
} from "./statemachine/lead.ts";
export {
  hitRate,
  loadMachineState,
  loadSession,
  openSession,
  recordTurn,
  replayTurn,
  saveMachineState,
  type TurnRecord,
} from "./session.ts";

/**
 * A hedged answer is still the stored answer, word for word. The hedge is a
 * wrapper around it and never a rewrite: the moment we let a model soften a
 * pair's wording, "returned, not composed" stops being true.
 */
export const HEDGE_PREFIX = "I think this is what you're after — from what the business has published:";
export const HEDGE_SUFFIX = "If that's not quite it, tell me and I'll get someone to confirm.";

export const ESCALATION_TEXT =
  "That's something the business will want to hear directly rather than from me. " +
  "I've flagged it and passed on this conversation — someone will be in touch.";

export interface ConciergeDeps {
  db: Db;
  /** Absent means the fallback always refuses. That is a valid configuration
   *  and the one an eval run uses. */
  model?: FallbackModel | undefined;
  /** Only consulted for text the deterministic router could not place. */
  modelRouter?: ModelRouter | undefined;
  /** The owner's real calendar. Absent means no slots to offer. */
  availableSlots?: ((ctx: ConciergeContext) => Promise<Slot[]>) | undefined;
  now?: (() => Date) | undefined;
}

export interface TurnOptions {
  hasAttachment?: boolean;
  /** Supplied by the caller so a retried request reuses its index rather than
   *  appending a second turn with the same words. */
  turnIndex?: number;
  /** Internal. Used once, when a question about a transaction found nothing in
   *  the pack and hands over to the machine. Not part of the public contract —
   *  a caller that could name a route could route around the refusal policy. */
  forceRoute?: Route;
}

/**
 * Build a runtime context from an approved pack.
 *
 * ⛔ Approval is checked here rather than at the call site because this is the
 * one function that turns a pack into something a visitor can talk to. An
 * unapproved pack is a draft, and a draft answering the public on a business's
 * behalf is the failure mode the owner sign-off exists to prevent.
 */
export function contextFromPack(
  pack: QAPack,
  session: ConciergeSession,
  opts: { kbSlice?: string[]; capabilities?: string[]; calendarConnected?: boolean; vertical?: string } = {},
): ConciergeContext {
  assertPackApproved(pack);
  return {
    session,
    vertical: opts.vertical ?? pack.vertical,
    index: buildPackIndex(pack),
    kbSlice: opts.kbSlice ?? [],
    capabilities: opts.capabilities ?? [],
    calendarConnected: opts.calendarConnected ?? false,
  };
}

interface Persisted {
  booking?: BookingState;
  lead?: LeadState;
}

/** A machine that has asked a question and is waiting for the answer. */
function midFlow(persisted: Persisted): "booking" | "lead_capture" | null {
  const booking = persisted.booking;
  if (booking !== undefined && booking.stage !== "confirmed" && booking.stage !== "cancelled") return "booking";
  const lead = persisted.lead;
  if (lead !== undefined && lead.stage !== "captured") return "lead_capture";
  return null;
}

/**
 * A machine mid-flow gets first refusal on the next message.
 *
 * "0509876543" and "2" carry no intent a router can classify — they are answers
 * to a question the machine just asked, and routing them to retrieval strands
 * the conversation one step from a booking. But a genuine question mid-booking
 * ("what are your hours?") must still be answered, so the hand-back is narrow:
 * only text the deterministic pass could not place, or text that supplies a
 * contact. Distress and complaints never reach here — they route away first.
 */
function continueMachine(route: Route, ambiguous: boolean, text: string, persisted: Persisted): Route {
  if (route !== "retrieval") return route;
  const waiting = midFlow(persisted);
  if (waiting === null) return route;
  if (ambiguous || extractContact(text) !== undefined) return waiting;
  return route;
}

function routerOptions(ctx: ConciergeContext, opts: TurnOptions): RouterOptions {
  return {
    capabilities: ctx.capabilities,
    calendarConnected: ctx.calendarConnected,
    ...(opts.hasAttachment === undefined ? {} : { hasAttachment: opts.hasAttachment }),
  };
}

/**
 * Handle one visitor message end to end.
 *
 * `modelCalls` is returned rather than logged so the property that matters can
 * be asserted: a plain business question answered from the pack costs ZERO
 * model calls. Not "usually", not "after warm-up" — the retrieval path never
 * touches a model, and a test says so.
 */
export async function handleTurn(
  deps: ConciergeDeps,
  ctx: ConciergeContext,
  text: string,
  opts: TurnOptions = {},
): Promise<TurnResult> {
  const started = Date.now();
  const policy: RefusalPolicy = refusalPolicy(ctx.vertical);
  const owner = {
    ...(ctx.session.customerId === undefined ? {} : { customerId: ctx.session.customerId }),
    ...(ctx.session.businessId === undefined ? {} : { businessId: ctx.session.businessId }),
  };
  const turnIndex = opts.turnIndex ?? ctx.session.turnIndex;

  const finish = async (partial: Omit<TurnResult, "latencyMs">): Promise<TurnResult> => {
    const result: TurnResult = { ...partial, latencyMs: Date.now() - started };
    await recordTurn(deps.db, {
      sessionId: ctx.session.id,
      turnIndex,
      inbound: text,
      intent: result.route,
      route: result.route,
      ...(result.retrievalScore === undefined ? {} : { retrievalScore: result.retrievalScore }),
      ...(result.pairId === undefined ? {} : { pairId: result.pairId }),
      answeredFrom: result.answeredFrom,
      answer: result.answer,
      latencyMs: result.latencyMs,
      costCents: result.costCents,
    });
    return result;
  };

  // ---------------------------------------------------------------------
  // 1. Hard refusals, before anything else looks at the text.
  //
  // ⛔ No gap is logged here. The gap list is questions the business COULD
  // answer and has not; "are you cheaper than X" and "should I sue" are not
  // homework for the owner, and putting them on the list would bury the
  // questions that are.
  // ---------------------------------------------------------------------
  // ⛔ Replay first. The same turn index with the same words is a retry, a
  // double tap or a redelivered webhook — never a second question. Re-running
  // the turn would ask the machines to make their decisions twice, and the
  // second run of a lead-capture turn is a second lead in the owner's queue.
  const replayed =
    opts.forceRoute === undefined ? await replayTurn(deps.db, ctx.session, turnIndex, text) : null;
  if (replayed !== null) return replayed;

  // ---------------------------------------------------------------------
  // 0. Protocols (MF14). BEFORE the refusal policy, before routing, before
  //    retrieval — before anything that could answer.
  // ---------------------------------------------------------------------
  //
  // ⛔ The order here is the safety property. The router already recognised
  // trade emergencies like "gas leak" and routed them to LEAD CAPTURE — it
  // asked for a phone number and offered to book someone in. That is the right
  // handling for a burst pipe and the wrong handling for a gas smell, and the
  // difference is not something a routing table expresses.
  //
  // A protocol match does not produce an answer with a warning attached. It
  // STOPS the turn: no retrieval, no booking, no model, no follow-up sequence.
  // The interlocks the catalogue attaches to it are recorded on the incident,
  // and the words the visitor sees were written by a human in a reviewed file.
  const incidentMatch = detectProtocol(text, { vertical: ctx.vertical, channel: ctx.session.channel });
  if (incidentMatch !== null) {
    const opened = await openIncident(deps.db, {
      match: incidentMatch,
      // ⛔ Verbatim. Several of these protocols say "capture verbatim" because
      // a paraphrase of a disclosure is not evidence of the disclosure.
      triggerText: text,
      customerId: ctx.session.customerId,
      businessId: ctx.session.businessId,
      sessionId: ctx.session.id,
      channel: ctx.session.channel,
      detectedBy: "automatic",
    });
    return finish({
      answer: incidentMatch.respond,
      route: "protocol",
      answeredFrom: "protocol",
      // Severity 1 is an emergency whatever the language sounded like.
      urgency: incidentMatch.protocol.severity === 1 ? "emergency" : "urgent",
      refused: false,
      escalate: true,
      // ⛔ Not a gap. A gap is a question the pack could not answer and that the
      // owner might add; this is not a question, and offering to "add an
      // answer" for a safeguarding disclosure would be grotesque.
      gapLogged: false,
      injectionSuspected: false,
      modelCalls: 0,
      costCents: 0,
      protocolId: incidentMatch.protocol.id,
      effect: { kind: "incident", reference: opened.incidentId },
    });
  }

  const hard = policy.check(text, { vertical: ctx.vertical });
  if (hard !== null) {
    return finish({
      answer: REFUSAL_TEXT,
      route: "fallback",
      answeredFrom: "refusal",
      urgency: "normal",
      refused: true,
      escalate: false,
      gapLogged: false,
      injectionSuspected: false,
      modelCalls: 0,
      costCents: 0,
    });
  }

  const persisted = (await loadMachineState(deps.db, ctx.session.id)) as Persisted;
  const decision = await resolveRoute(text, routerOptions(ctx, opts), {
    ...(deps.modelRouter === undefined ? {} : { modelRouter: deps.modelRouter }),
    turnIndex,
  });
  const route =
    opts.forceRoute ?? continueMachine(decision.route, decision.ambiguous, text, persisted);

  const base = {
    urgency: decision.urgency,
    injectionSuspected: decision.injectionSuspected,
  };

  // ---------------------------------------------------------------------
  // 2. Escalation. Never handled by a model — a complaint answered by an
  //    agent is a complaint about the agent.
  // ---------------------------------------------------------------------
  if (route === "escalate") {
    return finish({
      ...base,
      answer: ESCALATION_TEXT,
      route: "escalate",
      answeredFrom: "state_machine",
      refused: false,
      escalate: true,
      gapLogged: false,
      modelCalls: decision.modelCalls,
      costCents: 0,
    });
  }

  // ---------------------------------------------------------------------
  // 3. Booking.
  // ---------------------------------------------------------------------
  if (route === "booking") {
    const offered = (await deps.availableSlots?.(ctx)) ?? [];
    const state = persisted.booking ?? initialBookingState();
    const step = bookingNext(state, { text, offered });
    let answer = step.reply;
    let effect: TurnResult["effect"];

    if (step.commit !== undefined && ctx.session.customerId !== undefined) {
      const booking = await commitBooking(deps.db, {
        sessionId: ctx.session.id,
        customerId: ctx.session.customerId,
        slot: step.commit.slot,
        contact: step.commit.contact,
      });
      // Idempotent by construction: a replayed turn recomputes the same key,
      // collides, and gets the row that already existed. The visitor is told
      // the same thing either way — a second "booked!" for one booking reads
      // as a double booking.
      answer = bookingConfirmation(step.commit.slot);
      effect = { kind: "booking", reference: booking.id };
      step.state.reference = booking.id;
      step.state.stage = "confirmed";
    }

    await saveMachineState(deps.db, ctx.session.id, { ...persisted, booking: step.state });
    return finish({
      ...base,
      answer,
      route: "booking",
      answeredFrom: "state_machine",
      refused: false,
      escalate: false,
      gapLogged: false,
      modelCalls: decision.modelCalls,
      costCents: 0,
      ...(effect === undefined ? {} : { effect }),
    });
  }

  // ---------------------------------------------------------------------
  // 4. Lead capture — and the destination every withheld capability
  //    degrades into.
  // ---------------------------------------------------------------------
  if (route === "lead_capture" || route === "photo") {
    const state = persisted.lead ?? initialLeadState(decision.urgency);
    // Urgency can only rise within a conversation. Someone who says "actually
    // it's flooding now" has changed the priority; a later calm message must
    // not quietly lower it back.
    const ranked = { emergency: 3, urgent: 2, normal: 1 } as const;
    if (ranked[decision.urgency] > ranked[state.urgency]) state.urgency = decision.urgency;

    if (route === "photo") {
      // Triage itself is @adw/agents/photo_triage, driven by the API once the
      // image is stored. The conversation only acknowledges it, and it never
      // prices — the assessment schema has no field for one.
      await saveMachineState(deps.db, ctx.session.id, { ...persisted, lead: state });
      return finish({
        ...base,
        answer: "Send the photo over and I'll pass it to the team — they'll come back to you on what's involved.",
        route: "photo",
        answeredFrom: "state_machine",
        refused: false,
        escalate: false,
        gapLogged: false,
        modelCalls: decision.modelCalls,
        costCents: 0,
      });
    }

    const step = leadNext(state, text);
    let effect: TurnResult["effect"];
    if (step.commit !== undefined) {
      const enquiry = await commitEnquiry(deps.db, {
        sessionId: ctx.session.id,
        ...owner,
        need: step.commit.need,
        contact: step.commit.contact,
        ...(step.commit.name === undefined ? {} : { name: step.commit.name }),
        urgency: step.commit.urgency,
      });
      effect = { kind: "enquiry", reference: enquiry.id };
      step.state.reference = enquiry.id;
    }
    await saveMachineState(deps.db, ctx.session.id, { ...persisted, lead: step.state });
    return finish({
      ...base,
      answer: step.reply,
      route: "lead_capture",
      answeredFrom: "state_machine",
      refused: false,
      escalate: decision.escalate,
      gapLogged: false,
      modelCalls: decision.modelCalls,
      costCents: 0,
      ...(effect === undefined ? {} : { effect }),
    });
  }

  // ---------------------------------------------------------------------
  // 5. Retrieval — the path most turns take, and the one with no model in it.
  // ---------------------------------------------------------------------
  const outcome = retrieve(ctx.index, text, thresholds());
  if (outcome.hit) {
    const stored = outcome.pair.answer;
    // A stored pair is the business's own published position, so the
    // groundable rules have nothing left to protect against. The hard ones
    // still apply: an approved pair promising arrival "within the hour" is a
    // guarantee we do not make on anyone's behalf, however it got there.
    const blocked = policy.guardAnswer(stored, { grounded: true });
    if (blocked === null) {
      const answer =
        outcome.mode === "verbatim" ? stored : `${HEDGE_PREFIX}\n\n${stored}\n\n${HEDGE_SUFFIX}`;
      return finish({
        ...base,
        answer,
        route: "retrieval",
        answeredFrom: outcome.mode === "verbatim" ? "pack" : "pack_hedged",
        pairId: outcome.pair.id,
        retrievalScore: outcome.score,
        refused: false,
        escalate: false,
        gapLogged: false,
        modelCalls: decision.modelCalls,
        costCents: 0,
      });
    }
  }

  // A miss on a question ABOUT a transaction — "how do I book?" with nothing in
  // the pack to answer it. The machine is the right destination now: the
  // visitor wants the thing, and the pack could not explain it.
  if (!outcome.hit && decision.deferredRoute !== undefined) {
    return handleTurn(deps, ctx, text, { ...opts, turnIndex, forceRoute: decision.deferredRoute });
  }

  // A miss. The fallback gets one attempt under guard; either way the exact
  // question lands in the gap list, which is the only way the pack ever grows.
  const fallback = await runFallback(
    { db: deps.db, policy, ...(deps.model === undefined ? {} : { model: deps.model }) },
    { question: text, kbSlice: ctx.kbSlice, injectionSuspected: decision.injectionSuspected, owner },
  );

  // ⛔ `route` stays "retrieval". The turn WAS a retrieval attempt; it missed.
  // Recording the miss as route "fallback" would take it out of the hit-rate
  // denominator, and a hit rate computed only over hits reads 100% forever —
  // the product's central metric quietly measuring nothing. Where the words
  // came from is `answered_from`, which is a different question.
  return finish({
    ...base,
    answer: fallback.answer,
    route: "retrieval",
    answeredFrom: fallback.refused ? "refusal" : "fallback",
    ...(outcome.hit ? {} : outcome.best === undefined ? {} : { retrievalScore: outcome.best.cosine }),
    refused: fallback.refused,
    escalate: false,
    gapLogged: fallback.gapLogged,
    modelCalls: decision.modelCalls + fallback.modelCalls,
    costCents: fallback.costCents,
  });
}
