// The router (§39.1). Classifies; never answers.
//
// ⛔ It is CODE. A plain business question — which is the overwhelming majority
// of turns — must reach retrieval without a single model call, for two reasons
// that both matter. Cost: the agent runs on a $399 setup fee plus a
// subscription, and a model call to decide "this is a question" is spent
// against every turn forever. Determinism: routing decides whether a turn can
// reach the booking machine or the fallback model at all, and a route that
// varies between identical inputs cannot be reviewed.
//
// The model router exists for genuinely ambiguous text only, and is opt-in.
// Ambiguity resolves to retrieval when it is absent, which is the safe default:
// retrieval either finds a stored answer or logs a gap.

import type { Route, Urgency } from "../types.ts";

/** Distress. Not the word "emergency" in a question — an actual situation. */
const DISTRESS =
  /\b(flood|flooded|flooding|burst|gas leak|smell(s|ing)? of gas|sparking|no heating|no hot water|no power|no water|water everywhere|collapsed|electrocut\w*)\b|\b(water|sewage)\b[^.?!]{0,20}\b(pouring|gushing|coming|running|leaking)\b[^.?!]{0,20}\b(through|into|in|down|from)\b|\bceiling\b[^.?!]{0,20}\b(coming down|collapsing|falling)\b/i;

/** Anger and legal escalation. Never handled by an agent (§32). */
const COMPLAINT =
  /\b(complain|complaint|complaining|terrible|appalling|awful|disgusted|disgusting|unacceptable|refund|solicitor|ombudsman|trading standards|small claims|sue|suing|legal action)\b/i;

const BOOKING = /\b(book|booking|appointment|schedule|slot|reschedule|reserve|fit me in|come out)\b/i;
const QUOTE = /\b(quote|quotation|estimate|call me|call me back|callback|ring me|get in touch|contact me)\b/i;
const PHOTO = /\b(photo|photos|picture|pictures|image|images|attached|attachment|send you a pic|pic)\b/i;

const URGENT = /\b(urgent|urgently|asap|today|right now|straight away|immediately|as soon as)\b/i;

/**
 * The difference between asking ABOUT a thing and being IN it.
 *
 * "Can you deal with a burst pipe?" and "my pipe has burst" contain the same
 * word and are not remotely the same message. The first is a visitor checking
 * whether this business does the work — and the pack has a published answer
 * for it. Treating it as an emergency skips that answer, alerts the owner for
 * nothing, and teaches them to ignore the alerts.
 *
 * The signal is a situation marker: someone describing their own circumstances
 * says "my", "there's", "I've got". Someone asking about a service does not.
 */
const SITUATION =
  /\b(my|our|i have|i've|i got|we have|we've|there'?s|there is|it'?s|the house|the kitchen|the bathroom|the boiler|upstairs|downstairs|right now|currently)\b/i;

/**
 * Injection markers. Scanned on the way in AND on the way out (§13.5). A turn
 * flagged here never reaches the fallback model — the structural response to
 * "ignore your instructions" is to remove the component that has instructions
 * to ignore, not to instruct it harder.
 */
const INJECTION =
  /(ignore (all |any |the )?(previous|prior|above|earlier)? ?(instructions|prompts?|rules))|(\bsystem prompt\b)|(\bdisregard (your|all|the) )|(\byou are now\b)|(\bact as\b.{0,20}\b(admin|developer|root)\b)|(<\|.*?\|>)|(\[\[.*?system.*?\]\])/i;

export interface RouterOptions {
  /** From the delivery manifest. A capability the manifest did not grant is not
   *  reachable from a conversation, whatever the visitor asks for. */
  capabilities: string[];
  calendarConnected: boolean;
  hasAttachment?: boolean;
}

export interface RouterDecision {
  route: Route;
  urgency: Urgency;
  injectionSuspected: boolean;
  escalate: boolean;
  /** True when the deterministic pass could not tell. */
  ambiguous: boolean;
  /** Where the turn goes if retrieval finds nothing. Set for questions ABOUT a
   *  transaction ("how do I book?"), which the pack usually answers better than
   *  a state machine can — but which still need the machine when it does not. */
  deferredRoute?: Route | undefined;
  /** Human-readable, stored on the turn so a route can be explained later. */
  reason: string;
}

const looksLikeQuestion = (text: string): boolean =>
  text.includes("?") ||
  /^\s*(what|when|where|who|why|how|which|do|does|did|can|could|are|is|was|will|would|should|shall|may|might|am|have|has)\b/i.test(
    text,
  );

/** A question that asks how something works, rather than asking for it to be
 *  done. "How do I book?" is answerable from the pack; "book me in" is not. */
const looksInformational = (text: string): boolean =>
  /^\s*(how|what|where|when|which|why|do you|does|did you|is there|are there|can you)\b/i.test(text);

function inDistress(text: string): boolean {
  if (!DISTRESS.test(text)) return false;
  // A question about the service, with nothing of the visitor's own situation
  // in it, is a question. Everything else is treated as real.
  if (looksLikeQuestion(text) && !SITUATION.test(text)) return false;
  return true;
}

function urgencyOf(text: string): Urgency {
  if (inDistress(text)) return "emergency";
  if (URGENT.test(text)) return "urgent";
  return "normal";
}

/**
 * The deterministic pass. Pure, synchronous, zero model calls.
 *
 * Order is the policy. Distress outranks everything — someone with water coming
 * through a ceiling is not there to browse the pack. A capability the manifest
 * withheld degrades to lead capture rather than a refusal: an unbookable
 * visitor who leaves a phone number is a lead, and a refused one is nothing.
 */
export function routeTurn(text: string, opts: RouterOptions): RouterDecision {
  const caps = new Set(opts.capabilities);
  const injectionSuspected = INJECTION.test(text);
  const urgency = urgencyOf(text);

  if (inDistress(text)) {
    return {
      route: "lead_capture",
      urgency: "emergency",
      injectionSuspected,
      escalate: true,
      ambiguous: false,
      reason: "distress signal — capture contact and alert the owner",
    };
  }

  if (COMPLAINT.test(text)) {
    return {
      route: "escalate",
      urgency,
      injectionSuspected,
      escalate: true,
      ambiguous: false,
      reason: "complaint or legal language — never handled by the agent",
    };
  }

  if (opts.hasAttachment === true || PHOTO.test(text)) {
    return caps.has("photo_triage")
      ? { route: "photo", urgency, injectionSuspected, escalate: false, ambiguous: false, reason: "photo" }
      : {
          route: "lead_capture",
          urgency,
          injectionSuspected,
          escalate: false,
          ambiguous: false,
          reason: "photo mentioned, but this vertical has no photo triage",
        };
  }

  if (BOOKING.test(text)) {
    const transactional: Route =
      caps.has("book") && opts.calendarConnected ? "booking" : "lead_capture";
    const reason =
      transactional === "booking"
        ? "booking"
        : caps.has("book")
          ? "booking asked for, no calendar connected"
          : "this vertical does not book online";

    // ⛔ "How do I book an appointment?" is a question, and the business
    // published an answer to it. Sending it to the machine would offer slots to
    // someone who asked how the process works — and would score as a retrieval
    // miss for a pair that exists.
    if (looksInformational(text)) {
      return {
        route: "retrieval",
        urgency,
        injectionSuspected,
        escalate: false,
        ambiguous: false,
        deferredRoute: transactional,
        reason: "question about booking — the pack answers this better than the machine",
      };
    }
    return { route: transactional, urgency, injectionSuspected, escalate: false, ambiguous: false, reason };
  }

  if (QUOTE.test(text)) {
    return { route: "lead_capture", urgency, injectionSuspected, escalate: false, ambiguous: false, reason: "quote or callback" };
  }

  if (looksLikeQuestion(text)) {
    return { route: "retrieval", urgency, injectionSuspected, escalate: false, ambiguous: false, reason: "question" };
  }

  // Not a question, not an intent we recognise. Retrieval is still the right
  // destination — it either finds a stored answer or logs a gap, and both are
  // better outcomes than guessing at what was meant.
  return {
    route: "retrieval",
    urgency,
    injectionSuspected,
    escalate: false,
    ambiguous: true,
    reason: "no deterministic signal — trying retrieval",
  };
}

export interface ModelRouter {
  classify(text: string, turnIndex: number): Promise<{ intent: string; urgency: Urgency; injectionSuspected: boolean }>;
}

/**
 * Deterministic first; the model only ever sees text the code could not place,
 * and only when a router was supplied. `modelCalls` is returned rather than
 * inferred so the "zero calls for a plain question" property is a test
 * assertion instead of a claim in a comment.
 */
export async function resolveRoute(
  text: string,
  opts: RouterOptions,
  deps: { modelRouter?: ModelRouter | undefined; turnIndex?: number } = {},
): Promise<RouterDecision & { modelCalls: number }> {
  const decision = routeTurn(text, opts);
  if (!decision.ambiguous || deps.modelRouter === undefined) return { ...decision, modelCalls: 0 };
  // ⛔ Suspected injection never reaches a model. The router's own output would
  // become the payload's first foothold.
  if (decision.injectionSuspected) return { ...decision, modelCalls: 0 };

  const out = await deps.modelRouter.classify(text, deps.turnIndex ?? 0);
  const caps = new Set(opts.capabilities);
  const mapped: Route =
    out.intent === "book" && caps.has("book") && opts.calendarConnected ? "booking"
    : out.intent === "book" || out.intent === "quote" ? "lead_capture"
    : out.intent === "photo" && caps.has("photo_triage") ? "photo"
    : out.intent === "complaint" ? "escalate"
    : "retrieval";
  return {
    ...decision,
    route: mapped,
    urgency: out.urgency,
    injectionSuspected: decision.injectionSuspected || out.injectionSuspected,
    escalate: mapped === "escalate",
    reason: `model router classified as ${out.intent}`,
    modelCalls: 1,
  };
}
