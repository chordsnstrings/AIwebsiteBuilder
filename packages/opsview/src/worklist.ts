// What needs a human, from every source that can need one.
//
// ⛔ Six independent tables can each hold something waiting on a person, and
// before this file every one of them was invisible: a Q&A pack nobody approved
// blocked a customer's whole agent, an asset generation nobody approved blocked
// a build, and an enterprise deal sat still for three weeks because a DPA
// reference was never recorded — none of which appeared on any screen. Work
// queued in six places is work in no place.
//
// ⛔ Each source is queried in its own try/catch and REPORTS ITS OWN COUNT. An
// empty worklist must be distinguishable from a worklist whose queries failed;
// otherwise the calmest possible screen is also the one a broken console shows.
// This is the denominator rule — "0 waiting out of 400 considered" is a
// different fact from "0 waiting because the query threw".

import type { Db } from "@adw/db";

export type WorkSource =
  | "exception"
  | "qa_pack"
  | "publication"
  | "asset"
  | "opportunity_gate"
  | "protocol_incident";

export interface WorkItem {
  /** Stable and source-prefixed, so two tables cannot collide on a uuid. */
  key: string;
  source: WorkSource;
  /** 1 is most severe, matching `exceptions.severity` and the protocol catalogue. */
  severity: number;
  title: string;
  detail: string;
  customerId: string | null;
  customerName: string | null;
  waitingSince: Date;
  ageHours: number;
  /** What is stopped while this waits. Empty when nothing is blocked. */
  blocking: string | null;
  /** Where in the console the operator acts on it. */
  href: string;
}

export interface SourceCoverage {
  source: WorkSource;
  /** Rows the query looked at. The denominator. */
  considered: number;
  /** Rows that came back needing a person. */
  waiting: number;
  ok: boolean;
  error?: string;
}

export interface Worklist {
  items: WorkItem[];
  /** ⛔ Always returned, even when every source is empty. */
  coverage: SourceCoverage[];
  /**
   * Items the cap dropped.
   *
   * ⛔ The list is capped so one runaway source cannot make the board unusable.
   * But a cap that truncates silently is worse than no board: the operator sees
   * a full screen, works to the bottom, and believes they have reached the end
   * of the queue when hundreds more are waiting behind it. That reads as "all
   * clear" while nothing is clear — the exact shape of failure this whole
   * package exists to make impossible. The number is always present; zero means
   * the list is genuinely complete.
   */
  truncated: number;
  asOf: Date;
}

function hours(from: Date, now: Date): number {
  return Math.max(0, (now.getTime() - from.getTime()) / 3_600_000);
}

/**
 * Age escalates severity, because the failure mode here is not a missed alarm —
 * it is a real item sitting under a pile of less important ones for a week.
 * Capped at one step so an old cosmetic item never outranks a fresh SEV1.
 */
function aged(base: number, ageHours: number, escalateAfterHours: number): number {
  return ageHours >= escalateAfterHours ? Math.max(1, base - 1) : base;
}

type Source = (db: Db, now: Date) => Promise<{ items: WorkItem[]; considered: number }>;

const exceptionsSource: Source = async (db, now) => {
  const rows = await db.query<{
    id: string; trigger: string; severity: number; system_action: string | null;
    recommendation: string | null; raised_at: Date; customer_id: string | null;
    acknowledged_at: Date | null; legal_name: string | null;
  }>(
    `SELECT e.id, e.trigger, e.severity, e.system_action, e.recommendation, e.raised_at,
            e.customer_id, e.acknowledged_at, c.legal_name
       FROM exceptions e
       LEFT JOIN customers c ON c.id = e.customer_id
      WHERE e.status = 'open'
      ORDER BY e.severity, e.raised_at`,
  );
  const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM exceptions");
  return {
    considered: Number(total.n),
    items: rows.rows.map((r) => ({
      key: `exception:${r.id}`,
      source: "exception" as const,
      severity: aged(r.severity, hours(r.raised_at, now), 24),
      title: r.trigger.replace(/_/g, " "),
      detail: r.recommendation ?? r.system_action ?? "no recommendation recorded",
      customerId: r.customer_id,
      customerName: r.legal_name,
      waitingSince: new Date(r.raised_at),
      ageHours: hours(r.raised_at, now),
      blocking: r.acknowledged_at === null ? "unacknowledged" : null,
      href: `#/now/exception/${r.id}`,
    })),
  };
};

const qaPackSource: Source = async (db, now) => {
  // ⛔ An unapproved pack is not cosmetic: the customer's agent will not answer
  // from an unapproved knowledge base, so the product they are paying for is
  // silently switched off until somebody clicks.
  const rows = await db.query<{
    id: string; customer_id: string | null; created_at: Date; pair_count: number;
    thin: boolean; legal_name: string | null;
  }>(
    `SELECT p.id, p.customer_id, p.created_at, p.pair_count, p.thin, c.legal_name
       FROM qa_packs p
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.approved_at IS NULL
      ORDER BY p.created_at`,
  );
  const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM qa_packs");
  return {
    considered: Number(total.n),
    items: rows.rows.map((r) => ({
      key: `qa_pack:${r.id}`,
      source: "qa_pack" as const,
      severity: aged(r.thin ? 2 : 3, hours(r.created_at, now), 48),
      title: `Q&A pack awaiting owner approval`,
      detail: `${r.pair_count} pairs${r.thin ? " · flagged thin" : ""}`,
      customerId: r.customer_id,
      customerName: r.legal_name,
      waitingSince: new Date(r.created_at),
      ageHours: hours(r.created_at, now),
      blocking: "the customer's agent cannot answer until this is approved",
      href: `#/customers/${r.customer_id ?? ""}`,
    })),
  };
};

const publicationSource: Source = async (db, now) => {
  const rows = await db.query<{
    id: string; customer_id: string; channel: string; topic: string | null;
    drafted_at: Date; legal_name: string | null;
  }>(
    `SELECT p.id, p.customer_id, p.channel, p.topic, p.drafted_at, c.legal_name
       FROM publications p
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.state = 'drafted'
      ORDER BY p.drafted_at`,
  );
  const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM publications");
  return {
    considered: Number(total.n),
    items: rows.rows.map((r) => ({
      key: `publication:${r.id}`,
      source: "publication" as const,
      severity: aged(3, hours(r.drafted_at, now), 72),
      title: `${r.channel} post awaiting approval`,
      detail: r.topic ?? "(no topic)",
      customerId: r.customer_id,
      customerName: r.legal_name,
      waitingSince: new Date(r.drafted_at),
      ageHours: hours(r.drafted_at, now),
      blocking: "nothing is published in the customer's name until approved",
      href: `#/customers/${r.customer_id}`,
    })),
  };
};

const assetSource: Source = async (db, now) => {
  // ⛔ These cost real money on generation, which is why they wait for a person.
  // The amount is shown on the item: approving without seeing the figure is how
  // a budget goes in one afternoon.
  const rows = await db.query<{
    id: string; customer_id: string; kind: string; slot: string;
    estimated_cost_cents: number; requested_at: Date; legal_name: string | null;
  }>(
    `SELECT a.id, a.customer_id, a.kind, a.slot, a.estimated_cost_cents, a.requested_at, c.legal_name
       FROM generated_assets a
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.state = 'requested'
      ORDER BY a.requested_at`,
  );
  const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM generated_assets");
  return {
    considered: Number(total.n),
    items: rows.rows.map((r) => ({
      key: `asset:${r.id}`,
      source: "asset" as const,
      severity: 3,
      title: `${r.kind} for ${r.slot} awaiting spend approval`,
      detail: `estimated ${(r.estimated_cost_cents / 100).toFixed(2)} — billable on approval`,
      customerId: r.customer_id,
      customerName: r.legal_name,
      waitingSince: new Date(r.requested_at),
      ageHours: hours(r.requested_at, now),
      blocking: null,
      href: `#/customers/${r.customer_id}`,
    })),
  };
};

const opportunityGateSource: Source = async (db, now) => {
  // Evidence-blocked enterprise deals. The blocking key list is computed by the
  // acquisition package; here we surface only that the deal has not moved,
  // because a stalled deal is the operator-visible symptom.
  const rows = await db.query<{
    id: string; vertical: string; stage: string; updated_at: Date;
    owner_email: string | null; name: string | null;
  }>(
    `SELECT o.id, o.vertical, o.stage, o.updated_at, o.owner_email, b.name
       FROM opportunities o
       LEFT JOIN businesses b ON b.id = o.business_id
      WHERE o.closed_at IS NULL
        AND o.updated_at < now() - interval '7 days'
      ORDER BY o.updated_at`,
  );
  const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM opportunities WHERE closed_at IS NULL");
  return {
    considered: Number(total.n),
    items: rows.rows.map((r) => ({
      key: `opportunity:${r.id}`,
      source: "opportunity_gate" as const,
      severity: aged(4, hours(r.updated_at, now), 24 * 21),
      title: `${r.name ?? "opportunity"} has not moved`,
      detail: `stage ${r.stage.replace(/_/g, " ")} · ${Math.floor(hours(r.updated_at, now) / 24)} days`,
      customerId: null,
      customerName: r.name,
      waitingSince: new Date(r.updated_at),
      ageHours: hours(r.updated_at, now),
      blocking: r.owner_email === null ? "no owner assigned" : null,
      href: `#/acquisition/${r.id}`,
    })),
  };
};

const protocolIncidentSource: Source = async (db, now) => {
  // ⛔ Ranked above everything else by construction. These are the safety
  // protocols; a severity-1 incident sitting unacknowledged is the single worst
  // state this system can be in.
  const rows = await db.query<{
    id: string; protocol_id: string; severity: number; created_at: Date;
    customer_id: string | null; channel: string | null; legal_name: string | null;
  }>(
    `SELECT i.id, i.protocol_id, i.severity, i.created_at, i.customer_id, i.channel, c.legal_name
       FROM protocol_incidents i
       LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.acknowledged_at IS NULL AND i.resolved_at IS NULL
      ORDER BY i.severity, i.created_at`,
  );
  const total = await db.one<{ n: string }>("SELECT count(*) AS n FROM protocol_incidents");
  return {
    considered: Number(total.n),
    items: rows.rows.map((r) => ({
      key: `protocol_incident:${r.id}`,
      source: "protocol_incident" as const,
      severity: aged(r.severity, hours(r.created_at, now), 1),
      title: `${r.protocol_id.replace(/_/g, " ")} triggered`,
      detail: `${r.channel ?? "unknown channel"} · unacknowledged`,
      customerId: r.customer_id,
      customerName: r.legal_name,
      waitingSince: new Date(r.created_at),
      ageHours: hours(r.created_at, now),
      blocking: "unacknowledged safety protocol",
      href: `#/now/incident/${r.id}`,
    })),
  };
};

const SOURCES: { source: WorkSource; run: Source }[] = [
  { source: "protocol_incident", run: protocolIncidentSource },
  { source: "exception", run: exceptionsSource },
  { source: "qa_pack", run: qaPackSource },
  { source: "publication", run: publicationSource },
  { source: "asset", run: assetSource },
  { source: "opportunity_gate", run: opportunityGateSource },
];

/**
 * The merged worklist.
 *
 * ⛔ One source throwing degrades that source and nothing else. The alternative
 * — one query failing and the whole board rendering empty — is the exact shape
 * of "reports success while doing nothing" that this codebase keeps finding.
 */
export async function worklist(db: Db, now: Date, limit = 200): Promise<Worklist> {
  const coverage: SourceCoverage[] = [];
  const items: WorkItem[] = [];

  for (const { source, run } of SOURCES) {
    try {
      const out = await run(db, now);
      items.push(...out.items);
      coverage.push({ source, considered: out.considered, waiting: out.items.length, ok: true });
    } catch (err) {
      coverage.push({
        source,
        considered: 0,
        waiting: 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  items.sort((a, b) => a.severity - b.severity || a.waitingSince.getTime() - b.waitingSince.getTime());
  return {
    items: items.slice(0, limit),
    coverage,
    truncated: Math.max(0, items.length - limit),
    asOf: now,
  };
}
