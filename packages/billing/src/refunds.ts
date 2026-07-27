// Refund keyword handler + dispute evidence (spec §36, §37). CRITICAL: the
// REFUND path is a RULE, not an agent. No language model, no gateway call, no
// judgement — a customer who emails "REFUND" within the 30-day guarantee window
// gets their build fee back deterministically (spec §36: "no agent is in this
// path. It is a rule."). This module imports only @adw/db, @adw/config and
// @adw/telemetry — never @adw/gateway or @adw/agents.
import type { Db } from "@adw/db";
import { config } from "@adw/config";
import { emit } from "@adw/telemetry";

const GUARANTEE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// "starts with or equals REFUND" as a whole word (so REFUNDABLE does not match).
const REFUND_RE = /^refund\b/i;

export interface InboundKeyword {
  customerId: string;
  emailBody: string;
  receivedAt: Date;
}

export interface RefundOutcome {
  refunded: boolean;
  refundId?: string;
}

/**
 * Handle an inbound customer email for the REFUND keyword (spec §36). If the
 * body (trimmed, case-insensitive) is / starts with "REFUND" and the customer is
 * within 30 days of won_at, auto-approve a guarantee refund of the paid build fee
 * and mark the customer 'refunded'. Purely deterministic — no agent is invoked.
 */
export async function handleInboundKeyword(db: Db, input: InboundKeyword): Promise<RefundOutcome> {
  if (!REFUND_RE.test(input.emailBody.trim())) {
    return { refunded: false };
  }

  const customer = await db.maybeOne<{ region_code: string; won_at: string; status: string }>(
    "SELECT region_code, won_at, status FROM customers WHERE id = $1",
    [input.customerId],
  );
  if (!customer) return { refunded: false };

  // Outside the 30-day guarantee window ⇒ no automatic refund.
  const wonAt = new Date(customer.won_at).getTime();
  if (input.receivedAt.getTime() - wonAt > GUARANTEE_WINDOW_MS) {
    return { refunded: false };
  }

  const region = config.pricing().data[customer.region_code];
  if (!region) {
    // No pricing for this region — cannot compute the fee deterministically.
    return { refunded: false };
  }

  const refund = await db.one<{ id: string }>(
    `INSERT INTO refunds (customer_id, amount_cents, currency, reason, requested_via, auto_approved)
     VALUES ($1, $2, 'USD', 'guarantee', 'email_keyword', true)
     RETURNING id`,
    [input.customerId, region.build_fee_cents],
  );
  await db.query("UPDATE customers SET status = 'refunded' WHERE id = $1", [input.customerId]);

  await emit({
    eventType: "billing.refund.auto_approved",
    subject: { kind: "customer", id: input.customerId },
    payload: { refundId: refund.id, amountCents: region.build_fee_cents, via: "email_keyword" },
  });

  return { refunded: true, refundId: refund.id };
}

export interface DisputePack {
  signupRecord: { customerId: string; legalName: string; wonAt: string; contactEmail: string };
  deliveredUrl: string | null;
  deliveryEmail: string;
  termsVersion: string;
}

/**
 * Assemble a chargeback/dispute evidence pack from data already held (spec §37).
 * Read-only — produces a draft object, submits nothing.
 */
export async function assembleDisputePack(db: Db, customerId: string): Promise<DisputePack> {
  const customer = await db.one<{ legal_name: string; contact_email: string; won_at: string }>(
    "SELECT legal_name, contact_email, won_at FROM customers WHERE id = $1",
    [customerId],
  );
  const build = await db.maybeOne<{ deployed_url: string | null }>(
    `SELECT deployed_url FROM builds
      WHERE customer_id = $1 AND deployed_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [customerId],
  );

  return {
    signupRecord: {
      customerId,
      legalName: customer.legal_name,
      wonAt: String(customer.won_at),
      contactEmail: customer.contact_email,
    },
    deliveredUrl: build?.deployed_url ?? null,
    deliveryEmail: customer.contact_email,
    termsVersion: config.legalText().version,
  };
}
