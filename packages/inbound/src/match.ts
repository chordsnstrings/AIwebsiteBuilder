// Finding which conversation a received message belongs to.
//
// Three strategies, tried in order of how much we trust them:
//
//   1. The plus-addressed Reply-To token we minted on the way out. Signed, so a
//      forged token cannot attach a message to someone else's conversation.
//   2. In-Reply-To / References against `messages.provider_message_id`.
//   3. The sender's address against a contact with exactly one open thread.
//
// ⛔ Strategy 3 refuses when it is ambiguous rather than guessing. Attaching a
// reply to the wrong conversation would show one business's words to another,
// which is worse in every direction than an unmatched message landing in the
// exception queue for a human.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "@adw/db";

export interface ReplyToken {
  conversationId: string;
  leadId?: string;
}

/**
 * Mint the local-part suffix for a plus-addressed Reply-To.
 *
 * The signature is what makes the token safe to accept: without it, anyone can
 * read a Reply-To off an email we sent, change the id, and post a reply into an
 * arbitrary conversation.
 */
export function mintReplyToken(token: ReplyToken, secret: string): string {
  const body = token.leadId === undefined ? token.conversationId : `${token.conversationId}.${token.leadId}`;
  const mac = createHmac("sha256", secret).update(body).digest("base64url").slice(0, 16);
  return `${body}.${mac}`;
}

export function verifyReplyToken(raw: string, secret: string): ReplyToken | null {
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  const mac = parts[parts.length - 1] ?? "";
  const body = parts.slice(0, -1).join(".");
  const expected = createHmac("sha256", secret).update(body).digest("base64url").slice(0, 16);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(mac, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [conversationId, leadId] = body.split(".");
  if (conversationId === undefined || conversationId.length === 0) return null;
  return leadId === undefined ? { conversationId } : { conversationId, leadId };
}

/** `reply+<token>@inbound.example` → the token. */
export function replyAddress(base: string, token: string): string {
  const [local, domain] = base.split("@");
  return `${local ?? "reply"}+${token}@${domain ?? "invalid"}`;
}

export function tokenFromAddress(address: string): string | null {
  const local = address.split("@")[0] ?? "";
  const plus = local.indexOf("+");
  if (plus < 0) return null;
  const token = local.slice(plus + 1);
  return token.length > 0 ? token : null;
}

export interface MatchResult {
  conversationId?: string;
  leadId?: string;
  contactId?: string;
  /** Which strategy matched, recorded so a run of strategy-3 matches is
   *  visible rather than silently accumulating. */
  via: "reply_token" | "message_id" | "sole_open_thread" | "unmatched";
  reason?: string;
}

export interface MatchDeps {
  db: Db;
  replyTokenSecret: string;
}

export async function matchConversation(
  email: { from: string; to: string[]; inReplyTo?: string | undefined; references: string[] },
  deps: MatchDeps,
): Promise<MatchResult> {
  // --- 1. The token we minted ------------------------------------------------
  for (const addr of email.to) {
    const raw = tokenFromAddress(addr);
    if (raw === null) continue;
    const token = verifyReplyToken(raw, deps.replyTokenSecret);
    if (token === null) {
      // A malformed or forged token is worth surfacing: it is either an attack
      // or a secret rotation that orphaned every in-flight thread.
      return { via: "unmatched", reason: `reply token on ${addr} failed verification` };
    }
    // `conversations` reaches a contact only through `leads` — there is no
    // contact_id on the conversation itself.
    const row = await deps.db.maybeOne<{ id: string; contact_id: string | null; lead_id: string | null }>(
      `SELECT c.id, l.id AS lead_id, l.contact_id
         FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.id = $1`,
      [token.conversationId],
    );
    if (row === null) return { via: "unmatched", reason: "reply token names a conversation that no longer exists" };
    return {
      conversationId: row.id,
      ...(row.lead_id === null ? {} : { leadId: row.lead_id }),
      ...(row.contact_id === null ? {} : { contactId: row.contact_id }),
      via: "reply_token",
    };
  }

  // --- 2. Threading headers --------------------------------------------------
  const candidates = [email.inReplyTo, ...email.references].filter((r): r is string => r !== undefined && r.length > 0);
  if (candidates.length > 0) {
    const row = await deps.db.maybeOne<{ conversation_id: string | null; contact_id: string | null; lead_id: string | null }>(
      `SELECT m.conversation_id, l.id AS lead_id, l.contact_id
         FROM messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE m.provider_message_id = ANY($1::text[])
        ORDER BY m.sent_at DESC NULLS LAST LIMIT 1`,
      [candidates.map((c) => c.replace(/^<|>$/g, ""))],
    );
    if (row?.conversation_id != null) {
      return {
        conversationId: row.conversation_id,
        ...(row.lead_id === null ? {} : { leadId: row.lead_id }),
        ...(row.contact_id === null ? {} : { contactId: row.contact_id }),
        via: "message_id",
      };
    }
  }

  // --- 3. The sender, if and only if it is unambiguous ------------------------
  const threads = await deps.db.query<{ id: string; contact_id: string; lead_id: string }>(
    `SELECT c.id, l.id AS lead_id, l.contact_id
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       JOIN contacts ct ON ct.id = l.contact_id
      WHERE ct.email = $1 AND c.closed_at IS NULL
      ORDER BY c.opened_at DESC LIMIT 2`,
    [email.from],
  );
  if (threads.rows.length === 1) {
    const only = threads.rows[0]!;
    return { conversationId: only.id, contactId: only.contact_id, leadId: only.lead_id, via: "sole_open_thread" };
  }
  if (threads.rows.length > 1) {
    // ⛔ Refuse. Showing one business's thread to another is worse than an
    // unmatched message a human has to place.
    return { via: "unmatched", reason: `${threads.rows.length}+ open threads for ${email.from}; refusing to guess` };
  }
  return { via: "unmatched", reason: `no conversation for ${email.from}` };
}
