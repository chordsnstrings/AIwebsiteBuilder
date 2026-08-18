// One row per customer, fourteen mechanism families across it.
//
// ⛔ This screen did not exist, and its absence was the largest hole in the
// product. Fourteen families were built, each with its own tables and its own
// worker job, and there was nowhere in any interface to answer the first
// question anybody asks: "how is this customer doing?" You could read fourteen
// tables by hand. That is not an answer, that is a query.
//
// ⛔ `not_applicable` is a first-class state and comes from CONFIG, not from an
// empty table. A plumber has no dental recall clock and a solicitor has no gas
// safety certificate; painting those cells "unconfigured" would fill every row
// with fourteen false alarms and teach the operator to ignore the whole board.
// The distinction between "this vertical does not do that" and "this vertical
// does that and it is not set up" is the entire value of the screen.

import type { Db } from "@adw/db";
import { caseTypesFor } from "@adw/cases";
import { clocksFor, journeysFor } from "@adw/journeys";
import { watchesFor } from "@adw/watch";
import { reconTypesFor } from "@adw/reconcile";
import { assetKindsFor } from "@adw/assets";
import { channelsFor } from "@adw/publish";
import { resolveVertical } from "@adw/taxonomy";

export const FAMILIES = [
  { id: "knowledge", label: "Knowledge", mf: "MF1" },
  { id: "cases", label: "Cases", mf: "MF2" },
  { id: "queue", label: "Owner queue", mf: "MF3" },
  { id: "clocks", label: "Clocks", mf: "MF4" },
  { id: "journeys", label: "Journeys", mf: "MF5" },
  { id: "documents", label: "Documents", mf: "MF6" },
  { id: "watches", label: "Watchers", mf: "MF7" },
  { id: "reconcile", label: "Reconcile", mf: "MF8" },
  { id: "assessments", label: "Assessments", mf: "MF9" },
  { id: "scheduling", label: "Scheduling", mf: "MF10" },
  { id: "calls", label: "Calls", mf: "MF11" },
  { id: "publishing", label: "Publishing", mf: "MF12" },
  { id: "assets", label: "Assets", mf: "MF13" },
  { id: "protocols", label: "Protocols", mf: "MF14" },
] as const;

export type FamilyId = (typeof FAMILIES)[number]["id"];

/**
 * ⛔ Five states, and only one of them is green. `unknown` exists because the
 * customer's vertical can be NULL — a real defect this codebase already found
 * once — and a customer whose vertical was never resolved must not render as a
 * quiet row of "not applicable". It is the loudest row on the board.
 */
export type FamilyState = "unknown" | "not_applicable" | "unconfigured" | "ok" | "attention" | "stale";

export interface FamilyCell {
  family: FamilyId;
  state: FamilyState;
  /** Live objects in this family for this customer. */
  count: number;
  /** Of those, how many are waiting on a person. */
  waiting: number;
  /**
   * How many of this family the vertical's CONFIG defines — 6 clocks for a
   * dentist, 4 for a plumber.
   *
   * ⛔ This is the denominator for the cell, and measuring it changed what this
   * screen is. At family granularity every known trade uses all fourteen
   * families, so a board that only said "applicable / not applicable" would be
   * fourteen identical green ticks on every row and would carry no information
   * at all. The differences between verticals live one level down, in how many
   * clocks and watches and channels each defines, so that is what the cell
   * shows. Null for the families that are not vertical-selected.
   */
  configured: number | null;
  /** Short evidence, shown on the cell. Never a bare number with no unit. */
  note: string;
}

export interface CustomerRow {
  id: string;
  legalName: string;
  domain: string | null;
  status: string;
  /** Null is a defect, not a blank. Rendered as such. */
  vertical: string | null;
  regionCode: string;
  wonAt: Date | null;
  cells: Record<FamilyId, FamilyCell>;
  /** Cells in `attention`. The sort key for the board. */
  attentionCount: number;
}

export interface CustomerBoard {
  rows: CustomerRow[];
  /** ⛔ The denominator: how many customers exist, not how many are shown. */
  totalCustomers: number;
  /** Customers whose vertical is NULL — the silent-failure population. */
  unresolvedVerticals: number;
  asOf: Date;
}

/**
 * How many of each family this vertical's config defines.
 *
 * `null` means the family is not vertical-selected (every customer has a
 * knowledge base and can be telephoned). `0` means config defines none, and the
 * family genuinely does not apply — which is what an unresolvable vertical
 * produces, since `resolveVertical` returns "" rather than guessing.
 */
export function configuredCounts(vertical: string | null): Record<FamilyId, number | null> {
  const v = vertical === null ? "" : resolveVertical(vertical, null);
  return {
    knowledge: null,
    cases: caseTypesFor(v).length,
    queue: null,
    clocks: clocksFor(v).length,
    journeys: journeysFor(v).length,
    documents: null,
    watches: watchesFor(v).length,
    reconcile: reconTypesFor(v).length,
    assessments: null,
    scheduling: null,
    calls: null,
    publishing: channelsFor(v).length,
    assets: assetKindsFor(v).length,
    protocols: null,
  };
}

/** Which families this vertical uses at all, from config. */
export function applicableFamilies(vertical: string | null): Set<FamilyId> {
  const applicable = new Set<FamilyId>();
  if (vertical === null) return applicable;
  const counts = configuredCounts(vertical);
  for (const f of FAMILIES) {
    const n = counts[f.id];
    // Not vertical-selected (null) is applicable to everyone; a configured
    // count of zero is genuinely not applicable.
    if (n === null || n > 0) applicable.add(f.id);
  }
  return applicable;
}

interface Tally {
  customer_id: string;
  live: string | number;
  waiting: string | number;
  last_at: Date | null;
}

/** One aggregate per family across ALL customers — fourteen queries, not fourteen per row. */
const TALLIES: { family: FamilyId; sql: string; staleDays: number | null }[] = [
  {
    family: "knowledge",
    staleDays: null,
    sql: `SELECT customer_id, count(*) AS live, count(*) FILTER (WHERE approved_at IS NULL) AS waiting,
                 max(created_at) AS last_at FROM qa_packs WHERE customer_id IS NOT NULL GROUP BY customer_id`,
  },
  {
    family: "cases",
    staleDays: 30,
    // "Waiting" is the case that has blown its own stage deadline, which is the
    // only owner-independent definition available — stage names are per-vertical
    // config, so no single stage string means "with the owner" across verticals.
    sql: `SELECT customer_id, count(*) FILTER (WHERE closed_at IS NULL) AS live,
                 count(*) FILTER (WHERE closed_at IS NULL AND stage_due_at < now()) AS waiting,
                 max(created_at) AS last_at FROM cases GROUP BY customer_id`,
  },
  {
    family: "queue",
    staleDays: null,
    sql: `SELECT customer_id, count(*) FILTER (WHERE status = 'open') AS live,
                 count(*) FILTER (WHERE status = 'open' AND acknowledged_at IS NULL) AS waiting,
                 max(raised_at) AS last_at FROM exceptions WHERE customer_id IS NOT NULL GROUP BY customer_id`,
  },
  {
    family: "clocks",
    staleDays: 90,
    sql: `SELECT customer_id, count(*) FILTER (WHERE fired_at IS NULL AND cancelled_at IS NULL) AS live,
                 count(*) FILTER (WHERE fired_at IS NULL AND cancelled_at IS NULL AND due_at < now()) AS waiting,
                 max(created_at) AS last_at FROM reminders GROUP BY customer_id`,
  },
  {
    family: "journeys",
    staleDays: 60,
    sql: `SELECT customer_id, count(*) FILTER (WHERE state = 'running') AS live, 0 AS waiting,
                 max(created_at) AS last_at FROM journey_runs GROUP BY customer_id`,
  },
  {
    family: "documents",
    staleDays: null,
    sql: `SELECT customer_id, count(*) FILTER (WHERE completed_at IS NULL) AS live,
                 count(*) FILTER (WHERE completed_at IS NULL) AS waiting,
                 max(created_at) AS last_at FROM document_requests GROUP BY customer_id`,
  },
  {
    family: "watches",
    staleDays: 14,
    sql: `SELECT customer_id, count(*) FILTER (WHERE active) AS live,
                 count(*) FILTER (WHERE active AND consecutive_failures >= 2) AS waiting,
                 max(last_ok_at) AS last_at FROM watch_subscriptions GROUP BY customer_id`,
  },
  {
    family: "reconcile",
    staleDays: 45,
    // ⛔ Only a run with unresolved differences is waiting on a person. An open
    // run that simply has not been closed yet is ordinary work in progress, and
    // counting it as waiting would light the column up for every customer.
    sql: `SELECT r.customer_id, count(*) FILTER (WHERE r.closed_at IS NULL) AS live,
                 count(*) FILTER (WHERE r.closed_at IS NULL AND d.unresolved > 0) AS waiting,
                 max(r.opened_at) AS last_at
            FROM recon_runs r
            LEFT JOIN LATERAL (
              SELECT count(*) AS unresolved FROM recon_matches m
               WHERE m.run_id = r.id AND m.resolved_at IS NULL AND m.status <> 'matched'
            ) d ON true
           GROUP BY r.customer_id`,
  },
  {
    family: "assessments",
    staleDays: null,
    // An urgent assessment the owner has not replied to is the one that matters;
    // the rest are a log.
    sql: `SELECT customer_id, count(*) AS live,
                 count(*) FILTER (WHERE urgent AND owner_replied_at IS NULL) AS waiting,
                 max(created_at) AS last_at FROM photo_assessments GROUP BY customer_id`,
  },
  {
    family: "scheduling",
    staleDays: 30,
    sql: `SELECT customer_id, count(*) FILTER (WHERE status <> 'cancelled' AND slot_start > now()) AS live,
                 0 AS waiting, max(created_at) AS last_at FROM bookings GROUP BY customer_id`,
  },
  {
    family: "calls",
    staleDays: 30,
    // ⛔ A missed call nobody followed up is money on the floor, and it is the
    // reason the voice family exists. It counts as waiting.
    sql: `SELECT customer_id, count(*) AS live,
                 count(*) FILTER (WHERE outcome <> 'answered' AND followed_up = false) AS waiting,
                 max(started_at) AS last_at FROM calls GROUP BY customer_id`,
  },
  {
    family: "publishing",
    staleDays: 30,
    sql: `SELECT customer_id, count(*) FILTER (WHERE state IN ('drafted','approved')) AS live,
                 count(*) FILTER (WHERE state = 'drafted') AS waiting,
                 max(published_at) AS last_at FROM publications GROUP BY customer_id`,
  },
  {
    family: "assets",
    staleDays: null,
    sql: `SELECT customer_id, count(*) FILTER (WHERE state IN ('requested','approved','generating')) AS live,
                 count(*) FILTER (WHERE state = 'requested') AS waiting,
                 max(requested_at) AS last_at FROM generated_assets GROUP BY customer_id`,
  },
  {
    family: "protocols",
    staleDays: null,
    sql: `SELECT customer_id, count(*) FILTER (WHERE resolved_at IS NULL) AS live,
                 count(*) FILTER (WHERE acknowledged_at IS NULL AND resolved_at IS NULL) AS waiting,
                 max(created_at) AS last_at FROM protocol_incidents WHERE customer_id IS NOT NULL GROUP BY customer_id`,
  },
];

function cellFor(
  family: FamilyId,
  configured: number | null,
  verticalKnown: boolean,
  tally: Tally | undefined,
  staleDays: number | null,
  now: Date,
): FamilyCell {
  if (!verticalKnown) {
    return { family, state: "unknown", count: 0, waiting: 0, configured: null, note: "vertical unresolved" };
  }
  if (configured === 0) {
    return {
      family, state: "not_applicable", count: 0, waiting: 0, configured: 0,
      note: "none defined for this vertical",
    };
  }
  const live = tally === undefined ? 0 : Number(tally.live);
  const waiting = tally === undefined ? 0 : Number(tally.waiting);
  const lastAt = tally?.last_at ?? null;
  const defined = configured === null ? "" : ` of ${configured} defined`;

  if (waiting > 0) {
    return { family, state: "attention", count: live, waiting, configured, note: `${waiting} waiting` };
  }
  if (tally === undefined || (live === 0 && lastAt === null)) {
    // ⛔ Configured for this vertical, and nothing has ever happened. That is
    // not health, it is a family that was never switched on for this customer.
    return { family, state: "unconfigured", count: 0, waiting: 0, configured, note: `never used${defined}` };
  }
  if (staleDays !== null && lastAt !== null) {
    const days = (now.getTime() - new Date(lastAt).getTime()) / 86_400_000;
    if (days > staleDays) {
      return { family, state: "stale", count: live, waiting: 0, configured, note: `nothing for ${Math.floor(days)}d` };
    }
  }
  return {
    family, state: "ok", count: live, waiting: 0, configured,
    note: live === 0 ? `idle${defined}` : `${live} live${defined}`,
  };
}

export async function customerBoard(db: Db, now: Date, limit = 200): Promise<CustomerBoard> {
  const customers = await db.query<{
    id: string; legal_name: string; domain: string | null; status: string;
    vertical: string | null; region_code: string; won_at: Date | null;
  }>(
    `SELECT id, legal_name, domain, status, vertical, region_code, won_at
       FROM customers ORDER BY won_at DESC NULLS LAST, legal_name LIMIT $1`,
    [limit],
  );
  const totals = await db.one<{ n: string; unresolved: string }>(
    "SELECT count(*) AS n, count(*) FILTER (WHERE vertical IS NULL) AS unresolved FROM customers",
  );

  // Fourteen aggregates, each keyed by customer. A per-row query would be 14×N.
  const byFamily = new Map<FamilyId, Map<string, Tally>>();
  for (const { family, sql } of TALLIES) {
    const map = new Map<string, Tally>();
    try {
      const rows = await db.query<Tally>(sql);
      for (const r of rows.rows) map.set(r.customer_id, r);
    } catch {
      // A family whose table is missing degrades to "no data for that column"
      // rather than blanking the whole board.
    }
    byFamily.set(family, map);
  }

  const rows: CustomerRow[] = customers.rows.map((c) => {
    const configured = configuredCounts(c.vertical);
    const cells = {} as Record<FamilyId, FamilyCell>;
    let attention = 0;
    for (const { family, staleDays } of TALLIES) {
      const cell = cellFor(
        family,
        configured[family],
        c.vertical !== null,
        byFamily.get(family)?.get(c.id),
        staleDays,
        now,
      );
      cells[family] = cell;
      if (cell.state === "attention" || cell.state === "unknown") attention++;
    }
    return {
      id: c.id,
      legalName: c.legal_name,
      domain: c.domain,
      status: c.status,
      vertical: c.vertical,
      regionCode: c.region_code,
      wonAt: c.won_at === null ? null : new Date(c.won_at),
      cells,
      attentionCount: attention,
    };
  });

  rows.sort((a, b) => b.attentionCount - a.attentionCount || a.legalName.localeCompare(b.legalName));
  return {
    rows,
    totalCustomers: Number(totals.n),
    unresolvedVerticals: Number(totals.unresolved),
    asOf: now,
  };
}

export interface CustomerDetail {
  customer: CustomerRow;
  /**
   * What this customer's vertical DEFINES, by name — the four clocks a plumber
   * has, the ten watches a dentist has.
   *
   * ⛔ Shown beside what the customer actually has running, because the useful
   * question is never "are there reminders" but "which of the four that should
   * exist are missing". Config on one side, database on the other, in the same
   * view: that comparison is not available anywhere else in the product.
   */
  defines: { family: FamilyId; items: string[] }[];
  asOf: Date;
}

export async function customerDetail(db: Db, customerId: string, now: Date): Promise<CustomerDetail | null> {
  // Reuses the board so a cell can never mean one thing on the list and another
  // on the detail page.
  const board = await customerBoard(db, now, 1000);
  const row = board.rows.find((r) => r.id === customerId);
  if (row === undefined) return null;

  const v = row.vertical === null ? "" : resolveVertical(row.vertical, null);
  const defines: { family: FamilyId; items: string[] }[] = [
    { family: "cases", items: caseTypesFor(v).map((t) => t.label) },
    // Statutory clocks are marked, because a missed statutory date is a
    // different kind of problem from a missed courtesy reminder.
    { family: "clocks", items: clocksFor(v).map((k) => (k.statutory ? `${k.label} (statutory)` : k.label)) },
    { family: "journeys", items: journeysFor(v).map((j) => j.id) },
    { family: "watches", items: watchesFor(v).map((w) => w.id) },
    { family: "reconcile", items: reconTypesFor(v).map((r) => r.id) },
    { family: "publishing", items: channelsFor(v).map((ch) => ch.id) },
    { family: "assets", items: assetKindsFor(v).map((a) => a.id) },
  ];
  return { customer: row, defines, asOf: now };
}
