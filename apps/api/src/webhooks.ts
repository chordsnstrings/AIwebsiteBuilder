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
import { applyEmailFeedback, extractSesInbound } from "@adw/inbound";
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
export interface WebhookEffectDeps {
  /** Present once the inbound rail is configured. Absent means a Received
   *  notification is refused loudly rather than acknowledged and dropped. */
  routeInbound?: (raw: string) => Promise<{ kind: string; suppressed: boolean; signalled: boolean }>;
  /** Fetch a message SES wrote to S3 instead of inlining. */
  fetchS3?: (bucket: string, key: string) => Promise<string>;
}

export async function applyWebhookEffects(
  db: Db,
  provider: string,
  payload: unknown,
  deps: WebhookEffectDeps = {},
): Promise<WebhookOutcome> {
  if (typeof payload !== "object" || payload === null) return NOT_HANDLED;
  const body = unwrapSns(payload as Record<string, unknown>);

  // ⛔ Received comes FIRST. It is also a `notificationType`, so leaving it to
  // `isEmailFeedback` would route every inbound reply into the bounce handler,
  // which would find no bounce object and return NOT_HANDLED — the message
  // acknowledged, the reply lost, and a 200 in the log saying it went fine.
  if (body["notificationType"] === "Received") return applyInboundMail(db, body, deps);

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

/**
 * A received email, arriving through the same SNS topic as the feedback events.
 *
 * ⛔ An unconfigured inbound rail returns `handled: false` with a reason rather
 * than a silent acknowledgement. A 200 on a reply nobody read is exactly the
 * shape of the bug this whole path exists to remove.
 */
async function applyInboundMail(
  db: Db,
  body: Record<string, unknown>,
  deps: WebhookEffectDeps,
): Promise<WebhookOutcome> {
  const extracted = extractSesInbound(body as Parameters<typeof extractSesInbound>[0]);
  if (extracted.kind === "not_inbound") return NOT_HANDLED;
  if (extracted.kind === "rejected") {
    await db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
       VALUES ('inbound_rejected', 2, $1, 'message not processed', 'Inspect the receipt rule and the notification shape')`,
      [JSON.stringify({ reason: extracted.reason })],
    );
    return { handled: true, effects: [`inbound_rejected:${extracted.reason}`] };
  }
  if (deps.routeInbound === undefined) {
    await db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
       VALUES ('inbound_rail_unconfigured', 1, $1, 'received mail was NOT processed',
               'Wire routeInbound into the webhook handler; replies are being dropped')`,
      [JSON.stringify({ kind: extracted.kind })],
    );
    return { handled: false, effects: ["inbound_rail_unconfigured"] };
  }

  let raw: string;
  if (extracted.kind === "mime") {
    raw = extracted.raw;
  } else {
    if (deps.fetchS3 === undefined) {
      await db.query(
        `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
         VALUES ('inbound_s3_unreadable', 1, $1, 'received mail was NOT processed',
                 'The receipt rule writes to S3 but no fetcher is configured')`,
        [JSON.stringify({ bucket: extracted.bucket, key: extracted.key })],
      );
      return { handled: false, effects: ["inbound_s3_unreadable"] };
    }
    raw = await deps.fetchS3(extracted.bucket, extracted.key);
  }

  const outcome = await deps.routeInbound(raw);
  const effects = [`inbound:${outcome.kind}`];
  if (outcome.suppressed) effects.push("suppressed");
  if (outcome.signalled) effects.push("lead_signalled");
  return { handled: true, effects };
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
