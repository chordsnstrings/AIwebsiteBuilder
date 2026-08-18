// Money in flight.
//
// ⛔ Not MRR. The console's home surface used to open on monthly recurring
// revenue and a customer count, which is a board-meeting figure: true or false,
// there is nothing an operator does about it at 3am. What an operator needs is
// the money this system is about to spend on its own initiative, and how close
// that is to the ceilings that stop it.
//
// ⛔ Every figure here carries the window it was measured over and the number of
// rows behind it. A spend figure with no denominator cannot be distinguished
// from a spend figure whose query matched nothing.

import type { Db } from "@adw/db";

export interface Figure {
  /** Integer cents. Money is never a float in this codebase. */
  cents: number;
  /** Rows the sum ran over. Zero rows and zero spend are different facts. */
  rows: number;
  /** ⛔ Null when there is no ceiling configured, never 0 — 0 would read as "no budget left". */
  capCents: number | null;
  window: string;
  source: string;
}

export interface SpendBoard {
  /** Model spend through the gateway. The largest autonomous outflow. */
  gatewayToday: Figure;
  gatewayMonth: Figure;
  /** Image and video generation. Billable on approval, which is why it is separate. */
  assetsMonth: Figure;
  /** Per-customer asset caps and how much of each is consumed. */
  assetBudgets: { customerId: string; legalName: string; capCents: number; spentCents: number }[];
  /** Subscription revenue, kept small and at the bottom. It is context, not an alarm. */
  activeSubscriptions: { count: number; monthlyCents: number };
  asOf: Date;
}

/** From config: the daily gateway ceiling in the build spec. */
export const GATEWAY_DAILY_CAP_CENTS = 250_000;

export async function spendBoard(db: Db, now: Date): Promise<SpendBoard> {
  const today = await db.one<{ cents: string; rows: string }>(
    `SELECT COALESCE(sum(cost_cents),0) AS cents, count(*) AS rows
       FROM events WHERE event_type = 'gateway.completed' AND occurred_at >= date_trunc('day', $1::timestamptz)`,
    [now],
  );
  const month = await db.one<{ cents: string; rows: string }>(
    `SELECT COALESCE(sum(cost_cents),0) AS cents, count(*) AS rows
       FROM events WHERE event_type = 'gateway.completed' AND occurred_at >= date_trunc('month', $1::timestamptz)`,
    [now],
  );
  // ⛔ Counts `approved` and `generating` as well as `ready`: an approved
  // generation is money already committed, and a board that only counts
  // completed work under-reports exactly when a batch is in flight.
  const assets = await db.one<{ cents: string; rows: string }>(
    `SELECT COALESCE(sum(COALESCE(actual_cost_cents, estimated_cost_cents)),0) AS cents, count(*) AS rows
       FROM generated_assets
      WHERE state IN ('approved','generating','ready')
        AND requested_at >= date_trunc('month', $1::timestamptz)`,
    [now],
  );
  const budgets = await db.query<{
    customer_id: string; legal_name: string; monthly_cap_cents: number; spent: string;
  }>(
    `SELECT b.customer_id, c.legal_name, b.monthly_cap_cents,
            COALESCE((SELECT sum(COALESCE(a.actual_cost_cents, a.estimated_cost_cents))
                        FROM generated_assets a
                       WHERE a.customer_id = b.customer_id
                         AND a.state IN ('approved','generating','ready')
                         AND a.requested_at >= date_trunc('month', $1::timestamptz)), 0) AS spent
       FROM asset_budgets b
       LEFT JOIN customers c ON c.id = b.customer_id
      ORDER BY spent DESC`,
    [now],
  );
  const subs = await db.one<{ n: string; cents: string }>(
    `SELECT count(*) AS n, COALESCE(sum(CASE WHEN billing_interval = 'year' THEN amount_cents / 12 ELSE amount_cents END),0) AS cents
       FROM subscriptions WHERE status = 'active'`,
  );

  return {
    gatewayToday: {
      cents: Number(today.cents),
      rows: Number(today.rows),
      capCents: GATEWAY_DAILY_CAP_CENTS,
      window: "since midnight UTC",
      source: "events where event_type = 'gateway.completed'",
    },
    gatewayMonth: {
      cents: Number(month.cents),
      rows: Number(month.rows),
      capCents: null,
      window: "month to date",
      source: "events where event_type = 'gateway.completed'",
    },
    assetsMonth: {
      cents: Number(assets.cents),
      rows: Number(assets.rows),
      capCents: null,
      window: "month to date",
      source: "generated_assets in approved, generating or ready",
    },
    assetBudgets: budgets.rows.map((r) => ({
      customerId: r.customer_id,
      legalName: r.legal_name ?? "(unknown customer)",
      capCents: r.monthly_cap_cents,
      spentCents: Number(r.spent),
    })),
    activeSubscriptions: { count: Number(subs.n), monthlyCents: Number(subs.cents) },
    asOf: now,
  };
}

export interface RoleCost {
  role: string;
  model: string;
  calls: number;
  costCents: number;
  /** Cost per call, in cents, to one decimal. The comparable number across roles. */
  perCallCents: number;
}

/** Model spend by role and model — the Models surface. */
export async function costByRole(db: Db, since: Date): Promise<RoleCost[]> {
  const rows = await db.query<{ role: string | null; model: string | null; calls: string; cost_cents: string }>(
    `SELECT actor_id AS role, model, count(*) AS calls, COALESCE(sum(cost_cents),0) AS cost_cents
       FROM events WHERE event_type = 'gateway.completed' AND occurred_at >= $1
       GROUP BY actor_id, model ORDER BY cost_cents DESC LIMIT 100`,
    [since],
  );
  return rows.rows.map((r) => {
    const calls = Number(r.calls);
    const cost = Number(r.cost_cents);
    return {
      role: r.role ?? "(unattributed)",
      model: r.model ?? "(unrecorded)",
      calls,
      costCents: cost,
      perCallCents: calls === 0 ? 0 : Math.round((cost / calls) * 10) / 10,
    };
  });
}
