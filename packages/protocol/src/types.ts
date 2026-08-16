// What a protocol is, and what happens when one fires.
//
// The catalogue's MF14 family is 141 units and every one has the same shape:
//
//     trigger  →  fixed response  →  interlocks  →  evidence capture  →  clock
//
// The catalogue's own note on this family is "escalation IS the product", and
// the types below take that literally. A protocol is not a branch in a
// conversation; it is a thing that STOPS the conversation, records what was
// said, and starts a clock that a human has to answer.

/** 1 is safety-critical: someone can be hurt, or a statutory duty is running. */
export type Severity = 1 | 2 | 3;

export type Detection = "automatic" | "manual";

export interface Protocol {
  id: string;
  label: string;
  severity: Severity;
  safetyCritical: boolean;
  /** `['*']` for every vertical; `[]` for catalogued-but-not-active. */
  verticals: string[];
  detection: Detection;
  /** Source patterns, compiled once at load. Empty when detection is manual. */
  triggers: RegExp[];
  interlocks: string[];
  /** What the incident record must contain — the acceptance test from the catalogue. */
  capture: string;
  staysHuman?: string;
  escalation: EscalationStep[];
}

export interface EscalationStep {
  afterMinutes: number;
  notify: string;
}

export interface ProtocolCatalogue {
  version: string;
  interlocks: Record<string, string>;
  notifyRoles: Record<string, string>;
  protocols: Protocol[];
}

/**
 * A protocol firing on a turn.
 *
 * ⛔ `respond` is a FIXED string assembled from the catalogue, never composed by
 * a model. The whole point of this layer is that what the agent says when
 * someone reports a gas smell is decided in advance, by a human, in a reviewed
 * file — not generated on the spot by the component with the least context and
 * the most confidence.
 */
export interface ProtocolMatch {
  protocol: Protocol;
  /** The exact words that matched, for the record. */
  matchedOn: string;
  respond: string;
  interlocks: string[];
}

/** ⛔ An interlock named by a protocol but absent from the closed set. */
export class ProtocolCatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolCatalogueError";
  }
}
