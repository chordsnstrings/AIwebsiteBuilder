// Subscription creation + cancellation (spec §29). Pricing comes from the
// PR-gated pricing config, never from a prompt. Cancellation is two-click with
// no retention gauntlet — there is deliberately no interstitial-offer parameter.
import type { Db } from "@adw/db";
import { config } from "@adw/config";

const DAY_MS = 24 * 60 * 60 * 1000;

export type BillingInterval = "month" | "year";

export interface CreateSubscriptionInput {
  customerId: string;
  region: string; // R1..R4
  interval: BillingInterval;
}

export interface CreatedSubscription {
  id: string;
  amount_cents: number;
  currency: string;
  billing_interval: string;
  status: string;
  current_period_end: string;
}

/**
 * Create an active subscription for a customer, pricing it from pricing.yaml.
 * amount_cents derives from the region's mrr_cents; annual applies the region's
 * annual discount. current_period_end is now + 30d (month) or 365d (year).
 */
export async function createSubscription(
  db: Db,
  input: CreateSubscriptionInput,
  now: Date = new Date(),
): Promise<CreatedSubscription> {
  const region = config.pricing().data[input.region];
  if (!region) throw new Error(`no pricing for region ${input.region}`);

  // Some regions (e.g. R4) restrict which billing intervals are allowed.
  const allowed = region.billing_interval_allowed;
  if (allowed && !allowed.includes(input.interval)) {
    throw new Error(`interval ${input.interval} not allowed for region ${input.region}`);
  }

  const isYear = input.interval === "year";
  const amount = isYear
    ? Math.round(region.mrr_cents * 12 * (1 - (region.annual_discount_pct ?? 0)))
    : region.mrr_cents;
  const periodDays = isYear ? 365 : 30;
  const periodEnd = new Date(now.getTime() + periodDays * DAY_MS);
  const planCode = `${input.region.toLowerCase()}_${input.interval}`;

  return db.one<CreatedSubscription>(
    `INSERT INTO subscriptions
       (customer_id, plan_code, billing_interval, amount_cents, currency, status, current_period_end)
     VALUES ($1, $2, $3, $4, 'USD', 'active', $5)
     RETURNING id, amount_cents, currency, billing_interval, status, current_period_end`,
    [input.customerId, planCode, input.interval, amount, periodEnd],
  );
}

/**
 * Request cancellation (spec §29): two-click, no retention gauntlet. Sets
 * cancel_at_period_end and returns the period end the customer keeps access
 * until. There is deliberately no offer/interstitial parameter.
 */
export async function requestCancellation(db: Db, subscriptionId: string): Promise<Date> {
  const row = await db.one<{ current_period_end: string }>(
    `UPDATE subscriptions SET cancel_at_period_end = true
      WHERE id = $1
      RETURNING current_period_end`,
    [subscriptionId],
  );
  return new Date(row.current_period_end);
}
