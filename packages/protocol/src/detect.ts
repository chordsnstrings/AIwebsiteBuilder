// Recognising that something has gone wrong, and saying the one thing that
// was decided in advance.
//
// ⛔ No model runs here, ever. The argument is not cost — it is that "the
// classifier is right 99% of the time" is a statement about the 1% of gas
// smells it misses, and there is no threshold at which that becomes an
// acceptable component. Patterns are auditable, testable, and identical every
// time; a human can read config/protocols.yaml and know exactly what will fire.
//
// The second rule is that the RESPONSE is fixed too. What the agent says when
// someone reports chest pain is decided by a human in a reviewed file, not
// composed on the spot by the component with the least context and the most
// fluency. `respond()` assembles it from the catalogue and nothing else.

import { protocolsFor } from "./catalogue.ts";
import type { Protocol, ProtocolMatch } from "./types.ts";

export interface DetectOptions {
  vertical: string;
  /** Where the text came from, for the record. */
  channel?: string;
}

/**
 * The highest-severity protocol this text triggers, or null.
 *
 * ⛔ Severity order, not first-match order. A message can trip several — "I fell
 * on your steps and my phone is missing" is both an injury and an alleged theft
 * — and the more serious one has to win regardless of how the catalogue is
 * ordered in the file.
 */
export function detectProtocol(text: string, opts: DetectOptions): ProtocolMatch | null {
  const candidates = protocolsFor(opts.vertical).filter((p) => p.detection === "automatic");
  let best: { protocol: Protocol; matchedOn: string } | null = null;

  for (const protocol of candidates) {
    for (const re of protocol.triggers) {
      const m = re.exec(text);
      if (m === null) continue;
      if (best === null || protocol.severity < best.protocol.severity) {
        best = { protocol, matchedOn: m[0] };
      }
      break;
    }
  }
  if (best === null) return null;
  return {
    protocol: best.protocol,
    matchedOn: best.matchedOn,
    respond: respond(best.protocol),
    interlocks: best.protocol.interlocks,
  };
}

/**
 * What the agent says. Assembled from the catalogue, deterministic, and
 * deliberately short.
 *
 * ⛔ It never repeats the visitor's words back. A safeguarding disclosure echoed
 * into a chat transcript on a shared family computer is a second harm, and a
 * "just to confirm, you said..." is the most natural thing in the world for a
 * chat agent to write.
 *
 * ⛔ It never says what will happen next in detail, and never names who was
 * told — several of these protocols route to a designated lead precisely
 * because the person disclosing must not be able to work out who now knows.
 */
export function respond(protocol: Protocol): string {
  if (protocol.severity === 1) {
    return [
      "I've stopped this conversation and passed it straight to a person — that",
      "happens automatically and it has already gone.",
      "",
      "If anyone is in immediate danger, contact the emergency services now.",
      "I'm not able to advise on this myself.",
    ].join("\n");
  }
  return [
    "Thank you for telling me. I've recorded this and passed it to the team,",
    "who will be in touch.",
    "",
    "I'm not able to deal with this one myself.",
  ].join("\n");
}

/**
 * Does a protocol forbid something the agent was about to do?
 *
 * Used by the concierge to assert its own behaviour rather than to decide it —
 * by the time this is asked the protocol has already stopped the turn, and this
 * is the belt to that braces.
 */
export function forbids(match: ProtocolMatch, action: "book" | "quote" | "ask" | "advise" | "contact"): boolean {
  const map: Record<typeof action, string[]> = {
    book: ["no_booking"],
    quote: ["no_pricing"],
    ask: ["no_further_questions"],
    advise: ["no_advice", "no_triage"],
    contact: ["no_further_agent_contact"],
  };
  return match.interlocks.some((i) => map[action].includes(i));
}
