// Mail-record detection — the single most important function in this package.
//
// Getting it wrong is the whole risk. Checking only MX is catastrophically too
// narrow: SPF, DKIM and DMARC all live inside TXT records, and destroying an SPF
// record silently sends a customer's outbound mail to spam for weeks without
// anything appearing to be broken. Treating every TXT change as a mail change is
// too broad in the other direction — domain-verification TXT records for search
// consoles and SaaS tools churn constantly and are not mail.
//
// So: a TXT record is a mail record if it *is* one, judged by its content and
// its label, not by its type.
import { MAIL_RECORD_TYPES, type DnsDiff, type DnsDiffEntry, type DnsRecord, type RecordType } from "./types.ts";

/** SPF lives at the apex as a TXT beginning `v=spf1`. */
const SPF = /^\s*"?v=spf1\b/i;
/** DMARC lives at `_dmarc.<domain>` as a TXT beginning `v=DMARC1`. */
const DMARC = /^\s*"?v=DMARC1\b/i;
/** DKIM lives at `<selector>._domainkey.<domain>` and carries `v=DKIM1` or a `p=` key. */
const DKIM_NAME = /(^|\.)_domainkey(\.|$)/i;
const DKIM_VALUE = /^\s*"?(v=DKIM1\b|k=rsa\b|p=[A-Za-z0-9+/])/i;

/**
 * Whether one record participates in mail delivery or mail authentication.
 *
 * `_dmarc` and `_domainkey` are matched on the LABEL as well as the value,
 * because an emptied DKIM record has no recognisable value left — and an emptied
 * DKIM record is exactly the failure we are trying to catch.
 */
export function isMailRecord(record: Pick<DnsRecord, "type" | "name" | "value">): boolean {
  if (record.type === "MX") return true;
  if (record.type !== "TXT") return false;
  const name = record.name.toLowerCase();
  if (name === "_dmarc" || name.startsWith("_dmarc.")) return true;
  if (DKIM_NAME.test(name)) return true;
  return SPF.test(record.value) || DMARC.test(record.value) || DKIM_VALUE.test(record.value);
}

/** The classification, for reporting which protection was disturbed. */
export function mailRecordKind(record: Pick<DnsRecord, "type" | "name" | "value">): string | null {
  if (record.type === "MX") return "MX";
  if (record.type !== "TXT") return null;
  const name = record.name.toLowerCase();
  if (name === "_dmarc" || name.startsWith("_dmarc.") || DMARC.test(record.value)) return "DMARC";
  if (DKIM_NAME.test(name) || DKIM_VALUE.test(record.value)) return "DKIM";
  if (SPF.test(record.value)) return "SPF";
  return null;
}

const key = (r: Pick<DnsRecord, "type" | "name">): string => `${r.type}:${r.name.toLowerCase()}`;

function displayValue(r: DnsRecord): string {
  return (r.type === "MX" && r.priority !== undefined ? `${r.priority} ${r.value}` : r.value).trim();
}

/**
 * Group into (type, name) → the SET of values at that name.
 *
 * Values stay separate rather than being concatenated. A domain apex routinely
 * carries several TXT records at once — SPF alongside a search-console
 * verification alongside a SaaS token — and joining them into one string makes
 * each individually unclassifiable. That would hide SPF destruction in every
 * realistic zone, which is the exact failure this module exists to catch.
 *
 * Sorted, because record order is not semantically meaningful in DNS and a
 * resolver may return them in any sequence.
 */
function index(records: DnsRecord[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const r of records) {
    const k = key(r);
    grouped.set(k, [...(grouped.get(k) ?? []), displayValue(r)]);
  }
  for (const [k, values] of grouped) grouped.set(k, [...values].sort());
  return grouped;
}

/** Structured diff between two record sets. */
export function diffDns(before: DnsRecord[], after: DnsRecord[]): DnsDiff {
  const a = index(before);
  const b = index(after);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const entries: DnsDiffEntry[] = keys.map((k) => {
    const [type, name] = k.split(":") as [RecordType, string];
    const beforeValues = a.get(k) ?? [];
    const afterValues = b.get(k) ?? [];
    const joined = (v: string[]): string | null => (v.length === 0 ? null : v.join(" | "));
    return {
      type,
      name,
      before: joined(beforeValues),
      after: joined(afterValues),
      changed: joined(beforeValues) !== joined(afterValues),
      beforeValues,
      afterValues,
    };
  });
  return { entries, changedCount: entries.filter((e) => e.changed).length };
}

/** Only the values under this entry that are themselves mail records. */
function mailValues(entry: DnsDiffEntry, side: "beforeValues" | "afterValues"): string[] {
  return entry[side].filter((value) => isMailRecord({ type: entry.type, name: entry.name, value }));
}

/**
 * Did the cutover touch anything that carries mail?
 *
 * Compares the mail-bearing values on each side rather than the whole record
 * set, so adding an unrelated verification TXT beside an untouched SPF record
 * does not fire — and removing SPF from beside that verification TXT does.
 *
 * Target zero, alert at one. Asserted nightly over all history rather than a
 * rolling window, because a mail record broken last month is still broken.
 */
export function mailRecordsChanged(diff: DnsDiff): boolean {
  return diff.entries.some((e) => {
    if (!MAIL_RECORD_TYPES.includes(e.type)) return false;
    const before = mailValues(e, "beforeValues");
    const after = mailValues(e, "afterValues");
    return before.join(" | ") !== after.join(" | ");
  });
}

/** Which protections were disturbed, for the alert body and the dashboard. */
export function changedMailKinds(diff: DnsDiff): string[] {
  const kinds = new Set<string>();
  for (const e of diff.entries) {
    if (!MAIL_RECORD_TYPES.includes(e.type)) continue;
    const before = mailValues(e, "beforeValues");
    const after = mailValues(e, "afterValues");
    if (before.join(" | ") === after.join(" | ")) continue;
    // Classify from whichever side still has the value — a deleted record has
    // nothing left on the `after` side to read.
    for (const value of [...before, ...after]) {
      const kind = mailRecordKind({ type: e.type, name: e.name, value });
      if (kind) kinds.add(kind);
    }
    // A wholly deleted DKIM/DMARC record classifies from its label alone.
    if (before.length > 0 && after.length === 0) {
      const kind = mailRecordKind({ type: e.type, name: e.name, value: "" });
      if (kind) kinds.add(kind);
    }
  }
  return [...kinds].sort();
}
