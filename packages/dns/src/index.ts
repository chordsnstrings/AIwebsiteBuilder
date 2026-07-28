// @adw/dns — snapshot → two records → diff → alarm (spec §42).
//
// Ranked #1 of the five handovers that would end the company. 86% of target
// businesses have live MX records; breaking a customer's business email on
// delivery day is irreversible in perception even when technically reverted.
//
// The safety property is not "we are careful". It is that a plan touching a
// mail record cannot be constructed, a cutover without a prior snapshot cannot
// be applied, and any mail-record delta found afterwards reverts and pages —
// even when the two records we changed were exactly right.
export {
  MAIL_RECORD_TYPES,
  RECORD_TYPES,
  CutoverPlanError,
  NoSnapshotError,
  NotApprovedError,
  type CutoverPlan,
  type CutoverRecord,
  type CutoverStatus,
  type DnsDiff,
  type DnsDiffEntry,
  type DnsRecord,
  type DnsResolver,
  type DnsSnapshot,
  type RecordChange,
  type RecordType,
} from "./types.ts";

export { changedMailKinds, diffDns, isMailRecord, mailRecordKind, mailRecordsChanged } from "./mail.ts";

export {
  MAX_CHANGES,
  applyCutover,
  assertPlanSafe,
  detectProvider,
  handleHold,
  latestSnapshot,
  persistSnapshot,
  planCutover,
  snapshotDns,
  supportsDomainConnect,
  verifyCutover,
  type ApplyDeps,
  type CutoverHold,
  type CutoverTarget,
  type HoldDecision,
  type VerifyOutcome,
} from "./cutover.ts";

export { DohResolver, StaticResolver, type DohOptions } from "./resolver.ts";
