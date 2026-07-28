// DNS cutover types (spec §42, agent-workflow HANDOVER B8→B9).
//
// Ranked #1 of the five handovers that would end the company. 86% of target
// businesses have live MX records, and breaking a customer's business email on
// the day we deliver is irreversible in perception even when technically
// reverted within minutes.

/** Everything a snapshot must capture. A partial snapshot proves nothing. */
export const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "NS"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * Record types that carry mail. MX is obvious; the dangerous part is TXT,
 * because SPF, DKIM and DMARC all live inside TXT records. Checking only MX
 * misses three of the four ways to break someone's email.
 */
export const MAIL_RECORD_TYPES: readonly RecordType[] = ["MX", "TXT"] as const;

export interface DnsRecord {
  type: RecordType;
  /** "@" for apex, otherwise the label ("www", "_dmarc"). */
  name: string;
  value: string;
  ttl?: number;
  /** MX only. */
  priority?: number;
}

export interface DnsSnapshot {
  id?: string;
  domain: string;
  records: DnsRecord[];
  provider?: string;
  takenAt: Date;
}

/** A single record change. A plan is exactly two of these — never more. */
export interface RecordChange {
  op: "upsert";
  type: RecordType;
  name: string;
  value: string;
}

export interface CutoverPlan {
  domain: string;
  snapshotId: string;
  changes: RecordChange[];
  /** How the customer will apply it — one-click where their provider supports it. */
  method: "domain_connect" | "guided";
  provider: string;
  instructions: string[];
}

export interface DnsDiffEntry {
  type: RecordType;
  name: string;
  /** Joined for display. Use the arrays below for any classification. */
  before: string | null;
  after: string | null;
  changed: boolean;
  /**
   * The individual values at this name, sorted. Kept separate because a domain
   * apex routinely carries several TXT records at once, and each has to be
   * classifiable on its own — SPF beside a verification token is the norm, not
   * an edge case.
   */
  beforeValues: string[];
  afterValues: string[];
}

export interface DnsDiff {
  entries: DnsDiffEntry[];
  changedCount: number;
}

export type CutoverStatus = "pending" | "applied" | "verified" | "reverted" | "halted";

export interface CutoverRecord {
  id: string;
  customerId: string;
  domain: string;
  snapshotId: string;
  status: CutoverStatus;
  mailRecordsChanged: boolean;
}

/** Errors are typed because each one has a distinct operator response. */
export class CutoverPlanError extends Error {}
export class NoSnapshotError extends Error {}
export class NotApprovedError extends Error {}

/** Injected so tests are hermetic and a real resolver is one implementation. */
export interface DnsResolver {
  resolve(domain: string, type: RecordType): Promise<DnsRecord[]>;
}
