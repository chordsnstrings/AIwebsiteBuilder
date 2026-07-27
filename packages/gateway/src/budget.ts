// Budget enforcement (spec §14). Budgets are denominated in cost per passing
// output where meaningful. Per-role daily caps are enforced in the gateway
// before the call; a breach halts the role and raises an exception — it does
// NOT escalate to a costlier model.
import type { Db } from "@adw/db";
import type { RoleId } from "@adw/registry";

const DAILY_TOTAL_USD = 2500;

export async function roleSpendTodayUsd(db: Db, role: RoleId): Promise<number> {
  const row = await db.one<{ s: string | null }>(
    `SELECT COALESCE(SUM(cost_cents),0) AS s FROM events
     WHERE actor_id = $1 AND event_type = 'gateway.completed' AND occurred_at >= date_trunc('day', now())`,
    [role],
  );
  return Number(row.s ?? 0) / 100;
}

export async function totalSpendTodayUsd(db: Db): Promise<number> {
  const row = await db.one<{ s: string | null }>(
    `SELECT COALESCE(SUM(cost_cents),0) AS s FROM events
     WHERE event_type = 'gateway.completed' AND occurred_at >= date_trunc('day', now())`,
  );
  return Number(row.s ?? 0) / 100;
}

export async function checkDailyTotal(db: Db): Promise<{ ok: boolean; spent: number }> {
  const spent = await totalSpendTodayUsd(db);
  return { ok: spent < DAILY_TOTAL_USD, spent };
}

export class BudgetExceededError extends Error {
  constructor(public readonly role: RoleId, public readonly spent: number) {
    super(`Budget exceeded for role ${role} (spent $${spent.toFixed(2)})`);
    this.name = "BudgetExceededError";
  }
}
