// @adw/protocol — MF14, the protocol & incident playbooks.
//
// The catalogue's largest family (141 units, 34 safety-critical) and its
// declared centre of gravity: "escalation IS the product". It was also the
// cleanest zero in the coverage audit — no protocol runtime, no statutory
// clock, no escalation chain, no acknowledgement.
//
// The shape every unit shares, and the shape this package implements:
//
//     trigger  →  fixed response  →  interlocks  →  evidence capture  →  clock
//
// Two rules that are not negotiable and are asserted in the tests:
//   ⛔ Detection is deterministic. No model decides whether someone reported a
//      gas smell.
//   ⛔ The response is fixed. What the agent says was written by a human in a
//      reviewed file, not composed on the spot.
export {
  clearProtocolCache,
  interlockText,
  loadProtocols,
  protocolById,
  protocolsFor,
} from "./catalogue.ts";

export { detectProtocol, forbids, respond, type DetectOptions } from "./detect.ts";

export {
  acknowledgeIncident,
  openIncident,
  openIncidents,
  raiseManually,
  resolveIncident,
  type OpenedIncident,
  type OpenIncidentInput,
  type OpenIncidentRow,
} from "./incident.ts";

export {
  exhaustedIncidents,
  runEscalations,
  type EscalationResult,
  type Notification,
  type NotifyFn,
} from "./escalate.ts";

export {
  ProtocolCatalogueError,
  type Detection,
  type EscalationStep,
  type Protocol,
  type ProtocolCatalogue,
  type ProtocolMatch,
  type Severity,
} from "./types.ts";
