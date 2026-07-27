// THE ONLY code path permitted to write merchant_accounts.tos_acceptance
// (spec §14.2.5 single-writer invariant). Enforced three ways:
//   1. the DB trigger adw_guard_tos_acceptance blocks any UPDATE unless the GUC
//      adw.tos_writer='webhook' is set, which only happens inside adw_accept_tos;
//   2. adw_accept_tos is the sole SECURITY DEFINER write path;
//   3. the eslint rule adw/tos-acceptance-single-writer permits writing the
//      tos_acceptance key ONLY in this exact file.
// tos_acceptance may be set ONLY from a genuine, signature-verified acceptance
// webhook event — never inferred, never backfilled, never set on ADW's say-so.
import { emit } from "@adw/telemetry";
import type { Db } from "@adw/db";
import type { PaymentRail } from "../rails/types.ts";

/** The acceptance evidence captured from the webhook. */
export interface TosAcceptance {
  /** ISO timestamp the merchant accepted terms. */
  date: string;
  /** IP the acceptance came from. */
  ip: string;
}

/**
 * Record ToS acceptance via the one blessed DB path (adw_accept_tos). This is the
 * ONLY function in the codebase that causes tos_acceptance to be written. Call it
 * exclusively from a verified acceptance webhook (see handleAcceptanceWebhook).
 *
 * @param accountId merchant_accounts.id (UUID)
 */
export async function acceptTos(db: Db, accountId: string, acceptance: TosAcceptance): Promise<void> {
  await db.query("SELECT adw_accept_tos($1, $2::jsonb)", [accountId, JSON.stringify(acceptance)]);
  await emit({
    eventType: "payments.tos.accepted",
    subject: { kind: "merchant_account", id: accountId },
    payload: { at: acceptance.date },
  });
}

export interface AcceptanceWebhookResult {
  accepted: boolean;
  /** Why the webhook was not applied (bad signature / wrong type / unknown account). */
  reason?: "bad_signature" | "not_acceptance_event" | "unknown_account" | "missing_fields";
}

/**
 * Normalize and verify an incoming webhook, and — only if it is a genuine,
 * signature-verified `tos.accepted` event — record acceptance. Any other event,
 * or a bad signature, is a no-op. This is the guarded entry point that upholds
 * "tos_acceptance is set only from a genuine acceptance webhook".
 */
export async function handleAcceptanceWebhook(
  db: Db,
  rail: PaymentRail,
  raw: unknown,
): Promise<AcceptanceWebhookResult> {
  const evt = rail.normalizeWebhook(raw);
  if (!evt.signatureValid) return { accepted: false, reason: "bad_signature" };
  if (evt.type !== "tos.accepted") return { accepted: false, reason: "not_acceptance_event" };
  if (!evt.accountId) return { accepted: false, reason: "unknown_account" };
  if (!evt.tosAcceptedAt || !evt.tosAcceptedIp) return { accepted: false, reason: "missing_fields" };

  // Map the rail-side external account id to our merchant_accounts.id.
  const row = await db.maybeOne<{ id: string }>(
    "SELECT id FROM merchant_accounts WHERE external_account_id = $1 AND rail_id = $2",
    [evt.accountId, rail.id],
  );
  if (!row) return { accepted: false, reason: "unknown_account" };

  await acceptTos(db, row.id, { date: evt.tosAcceptedAt, ip: evt.tosAcceptedIp });
  return { accepted: true };
}
