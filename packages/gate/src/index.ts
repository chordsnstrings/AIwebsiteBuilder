export { gate, type GateDeps } from "./gate.ts";
export {
  KILL_SWITCHES,
  readEngagedSwitches,
  clearKillSwitchCache,
  sendingHalted,
  engageKillSwitch,
  releaseKillSwitch,
  type KillSwitchName,
} from "./killswitch.ts";
export { gatedSend, type EmailTransport, type SendInput, type SendResult } from "./send/index.ts";
export type {
  GateDecision,
  OutboundMessage,
  Obligation,
  DenyReason,
  MessageClass,
  ChannelKind,
  DomainClass,
  SubscriberType,
} from "@adw/compliance";
