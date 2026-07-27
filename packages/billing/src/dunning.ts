// Dunning schedule (spec §29). Deterministic 5-step ladder. The site is NEVER
// paused before the day-14 step — that invariant is the whole point of the
// schedule (a customer keeps their site through the entire recovery window).
import type { Db } from "@adw/db";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DunningStep {
  step: number;
  /** Days after the first failed charge this step fires. */
  offsetDays: number;
  channels: ("email" | "sms")[];
  /** True only for the terminal step, where the site is paused. */
  pausesSite: boolean;
  /** True for the "final notice" step. */
  final: boolean;
}

/**
 * The 5-step dunning schedule (spec §29):
 *  1. day 0   — email
 *  2. day +3  — email
 *  3. day +5  — email + sms
 *  4. day +7  — email (final notice)
 *  5. day +14 — email, site paused
 */
export function dunningSteps(): DunningStep[] {
  return [
    { step: 1, offsetDays: 0, channels: ["email"], pausesSite: false, final: false },
    { step: 2, offsetDays: 3, channels: ["email"], pausesSite: false, final: false },
    { step: 3, offsetDays: 5, channels: ["email", "sms"], pausesSite: false, final: false },
    { step: 4, offsetDays: 7, channels: ["email"], pausesSite: false, final: true },
    { step: 5, offsetDays: 14, channels: ["email"], pausesSite: true, final: false },
  ];
}

export interface DunningState {
  subscription_id: string;
  step: number;
  next_action_at: string | null;
  pause_at: string | null;
  status: string;
}

/**
 * Advance a subscription one step through the dunning schedule, creating the
 * dunning_state row on first call. Sets next_action_at to when the following
 * step is due. pause_at is set ONLY on reaching step 5 (day 14) — never before.
 * Returns the updated dunning_state.
 */
export async function advanceDunning(db: Db, subscriptionId: string, now: Date = new Date()): Promise<DunningState> {
  const steps = dunningSteps();
  const existing = await db.maybeOne<{ step: number }>(
    "SELECT step FROM dunning_state WHERE subscription_id = $1",
    [subscriptionId],
  );
  const current = existing?.step ?? 0;
  const newStep = Math.min(current + 1, steps.length);

  const thisDef = steps[newStep - 1]!;
  const nextDef = steps[newStep]; // undefined once we are at the last step
  const nextActionAt = nextDef
    ? new Date(now.getTime() + (nextDef.offsetDays - thisDef.offsetDays) * DAY_MS)
    : null;

  // Pause is only ever set on the terminal (day-14) step.
  const pauseAt = thisDef.pausesSite ? now : null;
  const status = thisDef.pausesSite ? "paused" : "past_due";

  if (!existing) {
    return db.one<DunningState>(
      `INSERT INTO dunning_state (subscription_id, step, next_action_at, pause_at, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING subscription_id, step, next_action_at, pause_at, status`,
      [subscriptionId, newStep, nextActionAt, pauseAt, status],
    );
  }
  return db.one<DunningState>(
    `UPDATE dunning_state
        SET step = $2, next_action_at = $3, pause_at = $4, status = $5
      WHERE subscription_id = $1
      RETURNING subscription_id, step, next_action_at, pause_at, status`,
    [subscriptionId, newStep, nextActionAt, pauseAt, status],
  );
}

/**
 * Resolve dunning after a successful payment (spec §29): mark the subscription
 * active and reset dunning state (step 0, no scheduled action, no pause).
 */
export async function resolveDunning(db: Db, subscriptionId: string): Promise<void> {
  await db.query("UPDATE subscriptions SET status = 'active' WHERE id = $1", [subscriptionId]);
  await db.query(
    `UPDATE dunning_state
        SET step = 0, next_action_at = NULL, pause_at = NULL, status = 'active'
      WHERE subscription_id = $1`,
    [subscriptionId],
  );
}
