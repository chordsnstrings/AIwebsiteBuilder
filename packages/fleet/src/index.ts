// @adw/fleet — cold email sending fleet + deliverability control loop
// (spec §22, §40). Deterministic asset lifecycle: provision → warm-up → rotate,
// with a health control loop that throttles/halts assets on trailing-7-day
// deliverability signals and enforces structural fleet invariants.
export { warmupCap } from "./warmup.ts";
export {
  evaluateAssetHealth,
  type Health,
  type DeliverabilityBand,
  type DeliverabilityThresholds,
  type AssetMetrics,
} from "./health.ts";
export {
  provisionMailbox,
  assertDnsReady,
  type Provider,
  type DomainClass,
  type ProvisionOpts,
  type ProvisionedAsset,
  type DnsAssertions,
  type DnsReadiness,
} from "./provisioning.ts";
export { checkFleetInvariants } from "./invariants.ts";
export { pickAsset, type RotationAsset } from "./rotation.ts";
