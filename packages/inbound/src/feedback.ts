// What a delivery notification DOES.
//
// Lives in this package rather than in the API app because two processes need
// it: the route, when a real notification arrives, and the worker, when it
// drains the simulator's feedback stream in demo mode.
//
// ⛔ Both must run the SAME code. An inline copy in the worker is exactly the
// bug this project already hit once — a drifted duplicate of the eval gate that
// checked less than the original and reported success. So the effects live here
// and both callers delegate.
//
// The two load-bearing paths:
//
//   • Complaints and hard bounces reach the suppression ledger. A complaint
//     acknowledged with 200 OK and dropped is worse than an error: the sender
//     looks compliant while continuing to mail someone who reported them, and
//     Gmail's bulk-sender rules put the account on the wrong side of a 0.3%
//     threshold within days.
//   • The deliverability loop scores assets from messages.bounced_at and
//     messages.complained_at. Nothing writing those columns means the loop reads
//     zero forever and can never halt a burning domain.
import { createHash } from "node:crypto";
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";

export interface WebhookOutcome {
  handled: boolean;
  effects: string[];
}

const NOT_HANDLED: WebhookOutcome = { handled: false, effects: [] };

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

export function providerMessageId(body: Record<string, unknown>): string | null {
  const mail = body["mail"];
  if (typeof mail === "object" && mail !== null) {
    const id = (mail as Record<string, unknown>)["messageId"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  const flat = body["messageId"];
  return typeof flat === "string" && flat.length > 0 ? flat : null;
}

export async function applyEmailFeedback(
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

