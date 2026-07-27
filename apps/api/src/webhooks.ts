// Webhook effects.
//
// Signature verification and idempotency live in the route; this module is what
// the event actually *does*. Two of these paths are load-bearing for go-live:
//
//   • Complaints and hard bounces must reach the suppression ledger. A complaint
//     that is acknowledged with 200 OK and then dropped is worse than an error —
//     the sender looks compliant while continuing to mail someone who reported
//     it, and Gmail's bulk-sender rules put the account on the wrong side of a
//     0.3% threshold within days.
//   • The deliverability control loop scores assets from messages.bounced_at and
//     messages.complained_at. If nothing writes those columns the loop reads
//     zero forever and can never halt a burning domain. It fails silently, which
//     spec §65 lists as the highest-scoring FMEA class.
//
// Everything here is deterministic. No model is consulted about a bounce.
import { createHash } from "node:crypto";
import type { Db } from "@adw/db";
import { advanceDunning, resolveDunning } from "@adw/billing";
import { emit } from "@adw/telemetry";

export interface WebhookOutcome {
  /** False when the provider/event pair has no handler — recorded, not an error. */
  handled: boolean;
  /** Human-readable effects, returned to the caller and logged. */
  effects: string[];
}

const NOT_HANDLED: WebhookOutcome = { handled: false, effects: [] };

/**
 * Apply the domain effects of a verified webhook. Never throws for an unknown
 * shape: a provider that adds a field must not be able to 500 our endpoint into
 * a retry storm.
 */
export async function applyWebhookEffects(
  db: Db,
  provider: string,
  payload: unknown,
): Promise<WebhookOutcome> {
  if (typeof payload !== "object" || payload === null) return NOT_HANDLED;
  const body = unwrapSns(payload as Record<string, unknown>);

  if (isEmailFeedback(body)) return applyEmailFeedback(db, provider, body);
  if (typeof body["type"] === "string" && body["type"].includes(".")) {
    return applyBillingEvent(db, provider, body);
  }
  return NOT_HANDLED;
}

// --- Email feedback (SES/SNS shape, and the same fields sent bare) -----------

/**
 * SES delivers through SNS, which wraps the real notification as a JSON *string*
 * in `Message`. Providers that post the notification directly are handled by the
 * same code — unwrapping is a no-op when there is no envelope.
 */
function unwrapSns(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload["Type"] !== "Notification" || typeof payload["Message"] !== "string") return payload;
  try {
    const inner: unknown = JSON.parse(payload["Message"]);
    return typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : payload;
  } catch {
    return payload;
  }
}

function isEmailFeedback(body: Record<string, unknown>): boolean {
  return typeof body["notificationType"] === "string" || typeof body["eventType"] === "string";
}

interface Recipient {
  email: string;
}

function recipients(node: unknown, key: string): Recipient[] {
  if (typeof node !== "object" || node === null) return [];
  const list = (node as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  const out: Recipient[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const address = (entry as Record<string, unknown>)["emailAddress"];
    if (typeof address === "string" && address.includes("@")) out.push({ email: address });
  }
  return out;
}

function providerMessageId(body: Record<string, unknown>): string | null {
  const mail = body["mail"];
  if (typeof mail === "object" && mail !== null) {
    const id = (mail as Record<string, unknown>)["messageId"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  const flat = body["messageId"];
  return typeof flat === "string" && flat.length > 0 ? flat : null;
}

async function applyEmailFeedback(
  db: Db,
  provider: string,
  body: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const kind = String(body["notificationType"] ?? body["eventType"]).toLowerCase();
  const messageId = providerMessageId(body);
  const effects: string[] = [];

  if (kind === "bounce") {
    const bounce = body["bounce"];
    const permanent =
      typeof bounce === "object" &&
      bounce !== null &&
      String((bounce as Record<string, unknown>)["bounceType"] ?? "").toLowerCase() === "permanent";

    if (messageId) {
      await markMessage(db, messageId, "bounced_at");
      effects.push(`message.bounced:${messageId}`);
    }
    // Only a permanent failure suppresses. A transient bounce is a mailbox
    // being full, not a person who cannot be contacted — suppressing on it
    // would quietly destroy reachable leads and is irreversible by design.
    if (permanent) {
      for (const r of recipients(bounce, "bouncedRecipients")) {
        if (await suppress(db, r.email, "hard_bounce")) effects.push(`suppressed:hard_bounce`);
      }
    }
    await emit({
      eventType: "email.bounced",
      subject: { kind: "message", id: messageId ?? "unknown" },
      payload: { provider, permanent },
    });
    return { handled: true, effects };
  }

  if (kind === "complaint") {
    if (messageId) {
      await markMessage(db, messageId, "complained_at");
      effects.push(`message.complained:${messageId}`);
    }
    // A complaint always suppresses, on every channel, immediately. There is no
    // threshold and no review step.
    for (const r of recipients(body["complaint"], "complainedRecipients")) {
      if (await suppress(db, r.email, "complaint")) effects.push("suppressed:complaint");
    }
    await emit({
      eventType: "email.complained",
      subject: { kind: "message", id: messageId ?? "unknown" },
      payload: { provider },
    });
    return { handled: true, effects };
  }

  if (kind === "delivery") {
    if (messageId) {
      await markMessage(db, messageId, "delivered_at");
      effects.push(`message.delivered:${messageId}`);
    }
    return { handled: true, effects };
  }

  return NOT_HANDLED;
}

/** Set one timestamp column on the message the provider is talking about. */
async function markMessage(
  db: Db,
  providerMessageId: string,
  column: "bounced_at" | "complained_at" | "delivered_at",
): Promise<void> {
  // Column name is from a closed union above, never from the payload.
  await db.query(
    `UPDATE messages SET ${column} = now() WHERE provider_message_id = $1 AND ${column} IS NULL`,
    [providerMessageId],
  );
}

/**
 * Append to the suppression ledger. Hashed, never plaintext; append-only, so a
 * repeat complaint is a no-op rather than an error. Returns whether a new row
 * landed.
 */
async function suppress(db: Db, email: string, reason: string): Promise<boolean> {
  const hash = createHash("sha256").update(email.trim().toLowerCase()).digest();
  const res = await db.query(
    `INSERT INTO suppression (email_hash, reason, channel_scope)
     VALUES ($1, $2, 'all')
     ON CONFLICT DO NOTHING`,
    [hash, reason],
  );
  const inserted = (res.rowCount ?? 0) > 0;
  if (inserted) {
    await emit({
      eventType: "suppression.added",
      subject: { kind: "contact", id: hash.toString("hex").slice(0, 16) },
      payload: { reason },
    });
  }
  return inserted;
}

// --- Billing events ---------------------------------------------------------

function subscriptionRef(body: Record<string, unknown>): string | null {
  const data = body["data"];
  if (typeof data !== "object" || data === null) return null;
  const object = (data as Record<string, unknown>)["object"];
  if (typeof object !== "object" || object === null) return null;
  const o = object as Record<string, unknown>;
  for (const key of ["subscription", "id"]) {
    const value = o[key];
    if (typeof value === "string" && value.startsWith("sub_")) return value;
  }
  return null;
}

/** Map a processor subscription id to our own row. Unknown ids are ignored. */
async function localSubscriptionId(db: Db, stripeId: string): Promise<string | null> {
  const row = await db.maybeOne<{ id: string }>(
    "SELECT id FROM subscriptions WHERE stripe_subscription_id = $1",
    [stripeId],
  );
  return row?.id ?? null;
}

async function applyBillingEvent(
  db: Db,
  provider: string,
  body: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const type = String(body["type"]);
  const effects: string[] = [];

  // A dispute is never handled autonomously — it goes to a human with the
  // evidence pack, per spec §29. Severity 2: money is already moving.
  if (type === "charge.dispute.created") {
    await db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
       VALUES ('payment_dispute', 2, $1, 'none — disputes are never actioned automatically',
               'Assemble the dispute evidence pack and respond before the processor deadline')`,
      [JSON.stringify({ provider, type })],
    );
    return { handled: true, effects: ["exception:payment_dispute"] };
  }

  const ref = subscriptionRef(body);
  if (!ref) return NOT_HANDLED;
  const subscriptionId = await localSubscriptionId(db, ref);
  if (!subscriptionId) return { handled: true, effects: ["ignored:unknown_subscription"] };

  switch (type) {
    case "invoice.payment_failed":
      await advanceDunning(db, subscriptionId);
      effects.push(`dunning.advanced:${subscriptionId}`);
      break;
    case "invoice.paid":
    case "invoice.payment_succeeded":
      await resolveDunning(db, subscriptionId);
      effects.push(`dunning.resolved:${subscriptionId}`);
      break;
    case "customer.subscription.deleted":
      await db.query("UPDATE subscriptions SET status = 'canceled' WHERE id = $1", [subscriptionId]);
      effects.push(`subscription.canceled:${subscriptionId}`);
      break;
    default:
      return NOT_HANDLED;
  }

  await emit({
    eventType: "billing.webhook",
    subject: { kind: "subscription", id: subscriptionId },
    payload: { provider, type },
  });
  return { handled: true, effects };
}
