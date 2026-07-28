// The cutover procedure (spec §42.2).
//
//   1. SNAPSHOT complete DNS      A · AAAA · CNAME · MX · TXT · SRV · NS
//   2. detect provider            via NS lookup
//   3. change TWO records only    apex A → anycast IP,  www CNAME → subdomain
//   4. Domain Connect one-click   where supported (~42% of targets)
//   5. poll for propagation       old site stays live throughout
//   6. verify, then DIFF against the snapshot
//   7. ⛔ ALARM on any delta to MX · SPF · DKIM · DMARC
//
// ⛔ We never delegate nameservers. Taking them means recreating every mail
// record perfectly, and one mistake kills their business email on delivery day.
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { changedMailKinds, diffDns, mailRecordsChanged } from "./mail.ts";
import {
  CutoverPlanError,
  NoSnapshotError,
  NotApprovedError,
  RECORD_TYPES,
  type CutoverPlan,
  type CutoverRecord,
  type DnsDiff,
  type DnsRecord,
  type DnsResolver,
  type DnsSnapshot,
  type RecordChange,
} from "./types.ts";

/** Exactly two records change. Never three, never a mail record. */
export const MAX_CHANGES = 2;

// ---------------------------------------------------------------------------
// 1. Snapshot
// ---------------------------------------------------------------------------

/**
 * Capture every record type. A snapshot missing a type cannot prove that type
 * was untouched, so a partial capture is treated as no capture at all — the
 * resolver failing on MX is precisely when we most need to stop.
 */
export async function snapshotDns(domain: string, resolver: DnsResolver): Promise<DnsSnapshot> {
  const records: DnsRecord[] = [];
  for (const type of RECORD_TYPES) {
    // A type with no records is a legitimate answer; a type that THREW is not,
    // and swallowing that would produce a snapshot that silently proves less
    // than it appears to.
    const found = await resolver.resolve(domain, type);
    records.push(...found);
  }
  const ns = records.filter((r) => r.type === "NS").map((r) => r.value);
  const provider = detectProvider(ns);
  return {
    domain,
    records,
    ...(provider === null ? {} : { provider }),
    takenAt: new Date(),
  };
}

export async function persistSnapshot(db: Db, customerId: string, snapshot: DnsSnapshot): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO dns_snapshots (customer_id, domain, records, provider, taken_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [customerId, snapshot.domain, JSON.stringify(snapshot.records), snapshot.provider ?? null, snapshot.takenAt],
  );
  return row.id;
}

export async function latestSnapshot(db: Db, customerId: string, domain: string): Promise<DnsSnapshot | null> {
  const row = await db.maybeOne<{ id: string; domain: string; records: DnsRecord[]; provider: string | null; taken_at: string }>(
    `SELECT id, domain, records, provider, taken_at FROM dns_snapshots
      WHERE customer_id = $1 AND domain = $2 ORDER BY taken_at DESC LIMIT 1`,
    [customerId, domain],
  );
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    records: row.records,
    ...(row.provider === null ? {} : { provider: row.provider }),
    takenAt: new Date(row.taken_at),
  };
}

// ---------------------------------------------------------------------------
// 2. Provider detection
// ---------------------------------------------------------------------------

const PROVIDERS: { id: string; match: RegExp; domainConnect: boolean }[] = [
  { id: "cloudflare", match: /\bcloudflare\.com$/i, domainConnect: false },
  { id: "godaddy", match: /\b(domaincontrol|godaddy)\.com$/i, domainConnect: true },
  { id: "namecheap", match: /\bregistrar-servers\.com$/i, domainConnect: true },
  { id: "route53", match: /\bawsdns-\d+\.(com|net|org|co\.uk)$/i, domainConnect: false },
  { id: "google_domains", match: /\bgoogledomains\.com$/i, domainConnect: true },
  { id: "ionos", match: /\b(ui-dns|ionos)\.(com|de|org|biz)$/i, domainConnect: true },
  { id: "wix", match: /\bwixdns\.net$/i, domainConnect: false },
  { id: "squarespace", match: /\bsquarespacedns\.com$/i, domainConnect: false },
];

/** Map nameservers to a known provider, for guided instructions. */
export function detectProvider(nameservers: string[]): string | null {
  for (const ns of nameservers) {
    const host = ns.replace(/\.$/, "").toLowerCase();
    const hit = PROVIDERS.find((p) => p.match.test(host));
    if (hit) return hit.id;
  }
  return null;
}

/** ~42% of targets sit behind a provider supporting one-click Domain Connect. */
export function supportsDomainConnect(provider: string | null): boolean {
  return PROVIDERS.find((p) => p.id === provider)?.domainConnect ?? false;
}

// ---------------------------------------------------------------------------
// 3. Plan — exactly two records
// ---------------------------------------------------------------------------

export interface CutoverTarget {
  /** Our anycast IP, for the apex A record. */
  apexIp: string;
  /** The customer's subdomain, for the www CNAME. */
  subdomain: string;
}

/**
 * Build the plan. Throws rather than returning something a caller has to
 * validate — a plan that touches a mail record must not be constructible.
 *
 * Apex is an A record, never a CNAME: classic DNS cannot CNAME at the root, and
 * although Cloudflare, Namecheap and Route 53 support flattening, most of the
 * 47% on regional providers do not. A record on apex plus CNAME on www is the
 * universal path and is what the instructions always default to.
 */
export function planCutover(snapshot: DnsSnapshot, target: CutoverTarget): CutoverPlan {
  if (snapshot.id === undefined) {
    throw new NoSnapshotError("cutover plan requires a persisted snapshot — the diff has nothing to measure against");
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(target.apexIp)) {
    throw new CutoverPlanError(`apex must be an A record with an IPv4 address, got "${target.apexIp}"`);
  }

  const changes: RecordChange[] = [
    { op: "upsert", type: "A", name: "@", value: target.apexIp },
    { op: "upsert", type: "CNAME", name: "www", value: target.subdomain },
  ];

  assertPlanSafe(changes);

  const provider = snapshot.provider ?? null;
  const domainConnect = supportsDomainConnect(provider);
  return {
    domain: snapshot.domain,
    snapshotId: snapshot.id,
    changes,
    method: domainConnect ? "domain_connect" : "guided",
    provider: provider ?? "unknown",
    instructions: instructionsFor(provider, snapshot.domain, target),
  };
}

/**
 * The guard. Exported because the API and the workflow both re-assert it before
 * applying — a plan is data and could have been assembled anywhere.
 */
export function assertPlanSafe(changes: RecordChange[]): void {
  if (changes.length !== MAX_CHANGES) {
    throw new CutoverPlanError(`a cutover changes exactly ${MAX_CHANGES} records, got ${changes.length}`);
  }
  for (const c of changes) {
    if (c.type === "MX" || c.type === "TXT" || c.type === "SRV") {
      throw new CutoverPlanError(`a cutover must never touch ${c.type} — that is where mail lives`);
    }
    // ⛔ Nameserver delegation. 86% of these domains have live MX, and taking
    // the nameservers means recreating every mail record perfectly.
    if (c.type === "NS") {
      throw new CutoverPlanError("we never delegate a customer's nameservers");
    }
    if (c.type === "CNAME" && (c.name === "@" || c.name === "")) {
      throw new CutoverPlanError("apex cannot be a CNAME — most regional providers do not support flattening");
    }
  }
}

function instructionsFor(provider: string | null, domain: string, target: CutoverTarget): string[] {
  const generic = [
    `Sign in to your DNS provider for ${domain}.`,
    `Change the A record for @ (the root of your domain) to ${target.apexIp}.`,
    `Change the CNAME record for www to ${target.subdomain}.`,
    "Leave every other record exactly as it is — especially anything marked MX or TXT. That is your email.",
    "Save. Your existing site stays live until the change spreads, so nothing breaks while you wait.",
  ];
  if (provider === "godaddy") {
    return ["In GoDaddy, open My Products → DNS → Manage Zones.", ...generic.slice(1)];
  }
  if (provider === "cloudflare") {
    return ["In Cloudflare, open the domain → DNS → Records.", ...generic.slice(1)];
  }
  if (provider === "namecheap") {
    return ["In Namecheap, open Domain List → Manage → Advanced DNS.", ...generic.slice(1)];
  }
  return generic;
}

// ---------------------------------------------------------------------------
// 4-5. Apply
// ---------------------------------------------------------------------------

export interface ApplyDeps {
  db: Db;
  customerId: string;
}

/**
 * Record that the plan was applied. The customer (or Domain Connect) makes the
 * change at their provider; we never hold their nameservers, so this writes the
 * intent and the verification step is what confirms reality.
 *
 * Two preconditions, both enforced here rather than by the caller:
 *   • a snapshot exists and predates the change, or the diff proves nothing
 *   • the customer explicitly approved
 */
export async function applyCutover(plan: CutoverPlan, deps: ApplyDeps, approvedAt: Date | null): Promise<CutoverRecord> {
  assertPlanSafe(plan.changes);
  if (approvedAt === null) {
    throw new NotApprovedError("a cutover requires the customer's explicit approval");
  }

  const snapshot = await deps.db.maybeOne<{ id: string }>(
    "SELECT id FROM dns_snapshots WHERE id = $1 AND customer_id = $2 AND domain = $3",
    [plan.snapshotId, deps.customerId, plan.domain],
  );
  if (!snapshot) {
    throw new NoSnapshotError(`no snapshot ${plan.snapshotId} for ${plan.domain} — refusing to change anything`);
  }

  const row = await deps.db.one<{ id: string }>(
    `INSERT INTO dns_cutovers (customer_id, domain, snapshot_id, applied, status, customer_approved_at)
     VALUES ($1,$2,$3,$4,'applied',$5) RETURNING id`,
    [deps.customerId, plan.domain, plan.snapshotId, JSON.stringify(plan.changes), approvedAt],
  );

  await emit({
    eventType: "dns.cutover.applied",
    subject: { kind: "customer", id: deps.customerId },
    payload: { domain: plan.domain, method: plan.method, provider: plan.provider },
  });

  return {
    id: row.id,
    customerId: deps.customerId,
    domain: plan.domain,
    snapshotId: plan.snapshotId,
    status: "applied",
    mailRecordsChanged: false,
  };
}

// ---------------------------------------------------------------------------
// 6-7. Verify and alarm
// ---------------------------------------------------------------------------

export interface VerifyOutcome {
  status: "verified" | "reverted";
  diff: DnsDiff;
  mailRecordsChanged: boolean;
  /** Which protections were disturbed — SPF, DKIM, DMARC, MX. */
  mailKinds: string[];
  /** Present only on a revert: the changes that restore the snapshot. */
  revertPlan?: RecordChange[];
}

/**
 * Re-resolve after propagation and diff against the snapshot.
 *
 * ⛔ On ANY mail-record delta this reverts, raises SEV1 and returns the revert
 * plan — even when the two records we changed are exactly right. A third party
 * editing MX during our propagation window is still our incident, because we
 * are the change the customer will remember.
 */
export async function verifyCutover(
  cutoverId: string,
  deps: ApplyDeps,
  resolver: DnsResolver,
): Promise<VerifyOutcome> {
  const cutover = await deps.db.one<{ domain: string; snapshot_id: string }>(
    "SELECT domain, snapshot_id FROM dns_cutovers WHERE id = $1",
    [cutoverId],
  );
  const snapshotRow = await deps.db.one<{ records: DnsRecord[] }>(
    "SELECT records FROM dns_snapshots WHERE id = $1",
    [cutover.snapshot_id],
  );

  const after = await snapshotDns(cutover.domain, resolver);
  const diff = diffDns(snapshotRow.records, after.records);
  const broke = mailRecordsChanged(diff);
  const mailKinds = changedMailKinds(diff);

  const status: VerifyOutcome["status"] = broke ? "reverted" : "verified";
  await deps.db.query(
    `UPDATE dns_cutovers SET diff = $2, mail_records_changed = $3, status = $4, completed_at = now()
      WHERE id = $1`,
    [cutoverId, JSON.stringify(diff), broke, status],
  );

  if (broke) {
    await deps.db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
       VALUES ('dns_mail_records_changed', 1, $1,
               'cutover marked reverted; revert plan generated',
               'Restore the snapshot records immediately and confirm mail flow with the customer before anything else')`,
      [JSON.stringify({ cutoverId, domain: cutover.domain, mailKinds })],
    );
    await emit({
      eventType: "dns.mail_records_changed",
      subject: { kind: "customer", id: deps.customerId },
      payload: { domain: cutover.domain, mailKinds },
    });
    return { status, diff, mailRecordsChanged: true, mailKinds, revertPlan: revertPlanFor(snapshotRow.records, diff) };
  }

  await emit({
    eventType: "dns.cutover.verified",
    subject: { kind: "customer", id: deps.customerId },
    payload: { domain: cutover.domain, changed: diff.changedCount },
  });
  return { status, diff, mailRecordsChanged: false, mailKinds };
}

/** Restore everything the diff says moved, back to the snapshot's values. */
function revertPlanFor(before: DnsRecord[], diff: DnsDiff): RecordChange[] {
  const changes: RecordChange[] = [];
  for (const entry of diff.entries) {
    if (!entry.changed || entry.before === null) continue;
    const original = before.filter(
      (r) => r.type === entry.type && r.name.toLowerCase() === entry.name.toLowerCase(),
    );
    for (const r of original) changes.push({ op: "upsert", type: r.type, name: r.name, value: r.value });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Edge cases that are outcomes, not failures (spec §42.5)
// ---------------------------------------------------------------------------

export type CutoverHold =
  | { kind: "no_registrar_access"; touches: number; parkAfterDays: number }
  | { kind: "third_party_controls_dns"; offerTransfer: true }
  | { kind: "domain_expiring"; expiresAt: Date }
  | { kind: "propagation_slow"; elapsedHours: number }
  | { kind: "declined" };

export interface HoldDecision {
  /** True when the flow stops permanently rather than retrying. */
  halt: boolean;
  /** The subdomain remains a complete product in every one of these cases. */
  subdomainRemainsLive: true;
  message: string;
}

/**
 * How each hold is handled. Every one of these leaves the customer with a
 * working product on the subdomain — the cutover is deliberately off the
 * critical path, which is what makes declining it a legitimate choice rather
 * than a failed onboarding.
 */
export function handleHold(hold: CutoverHold): HoldDecision {
  switch (hold.kind) {
    case "no_registrar_access":
      return {
        halt: hold.touches >= 4,
        subdomainRemainsLive: true,
        message:
          hold.touches >= 4
            ? "Parked after four attempts over ten days. Their site stays on the subdomain."
            : "Sent provider-specific instructions and scheduled a follow-up.",
      };
    case "third_party_controls_dns":
      return {
        halt: false,
        subdomainRemainsLive: true,
        message: "Offered the domain transfer path. The subdomain is fully functional meanwhile.",
      };
    case "domain_expiring":
      // ⛔ Never renew on their behalf without written authority — that is
      // spending their money on an asset we do not own.
      return {
        halt: true,
        subdomainRemainsLive: true,
        message: `Halted: the domain expires ${hold.expiresAt.toISOString().slice(0, 10)}. Alert the customer; do not renew for them.`,
      };
    case "propagation_slow":
      return {
        halt: false,
        subdomainRemainsLive: true,
        message: `Propagation at ${hold.elapsedHours}h. Parked and notified — this is not a failure.`,
      };
    case "declined":
      // ⛔ Fine. Do not pressure.
      return { halt: true, subdomainRemainsLive: true, message: "Customer declined. The subdomain is the product." };
  }
}
