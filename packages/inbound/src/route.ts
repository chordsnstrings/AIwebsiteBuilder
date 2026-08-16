// What happens to a received email, end to end.
//
// parse → classify → match → act. Every branch ends in a recorded outcome; the
// one thing that must never happen is a message arriving and nothing being
// written anywhere, which is the state this system was in until now: replies to
// cold mail landed in a mailbox nobody read, `messages.replied_at` was never
// written by anything, and `LeadWorkflow` waited on a `reply` signal that had no
// emitter in production. Every lead therefore received all three touches and was
// marked EXHAUSTED regardless of what the recipient wrote back.
//
// ⛔ The agent is not on this path's critical section. Suppression, the reply
// signal and the ledger write are deterministic; a model may afterwards draft a
// response, but "stop emailing me" is honoured whether or not a model is
// reachable, and an out-of-office never advances anything.

import type { Db } from "@adw/db";
import { emailHash } from "@adw/db";
import { classifyInbound, mayAdvanceLead, type InboundKind } from "./classify.ts";
import { parseEmail, type ParsedEmail } from "./parse.ts";
import { matchConversation, type MatchResult } from "./match.ts";

export interface InboundOutcome {
  kind: InboundKind;
  reason: string;
  match: MatchResult["via"];
  /** Written to `messages` when the thread was identified. */
  messageId?: string;
  suppressed: boolean;
  /** True when the LeadWorkflow was signalled — only ever for a human reply. */
  signalled: boolean;
  /** Set when a human needs to look; the message is stored either way. */
  exception?: string;
}

export interface InboundDeps {
  db: Db;
  replyTokenSecret: string;
  /** Deliver the `reply` signal. Absent in tests that only assert persistence. */
  signalWorkflow?: (workflowId: string, name: string, payload: unknown) => Promise<void>;
  /** Store the body out of line. Defaults to a content-addressed key only —
   *  bodies are never logged and never inlined into events. */
  storeBody?: (key: string, body: string) => Promise<void>;
  now?: () => Date;
}

/** Deterministic, so a redelivered notification cannot double-write. */
function inboundIdempotencyKey(email: ParsedEmail): string {
  const basis = email.messageId ?? `${email.from}|${email.subject}|${email.rawText.slice(0, 200)}`;
  return `inbound:${emailHash(basis).toString("hex").slice(0, 40)}`;
}

export async function routeInbound(raw: string, deps: InboundDeps): Promise<InboundOutcome> {
  const now = deps.now ?? (() => new Date());
  const email = parseEmail(raw);
  const classification = classifyInbound(email);
  const match = await matchConversation(email, { db: deps.db, replyTokenSecret: deps.replyTokenSecret });

  const outcome: InboundOutcome = {
    kind: classification.kind,
    reason: classification.reason,
    match: match.via,
    suppressed: false,
    signalled: false,
  };

  // --- Suppression first ----------------------------------------------------
  //
  // ⛔ Before matching is even consulted. Someone who replies "take me off your
  // list" from an address we cannot thread is still someone who asked to be
  // taken off, and making that depend on our ability to find their conversation
  // would be indefensible.
  if (classification.kind === "unsubscribe" || classification.kind === "complaint") {
    if (email.from.includes("@")) {
      await deps.db.query(
        `INSERT INTO suppression (email_hash, reason, channel_scope)
         VALUES ($1, $2, 'all') ON CONFLICT DO NOTHING`,
        [emailHash(email.from), classification.kind === "complaint" ? "complaint" : "reply_stop_request"],
      );
      outcome.suppressed = true;
    }
  }

  // A hard bounce that arrived as mail rather than as a webhook. Same effect —
  // the two paths must not disagree about whether an address is deliverable.
  if (classification.kind === "bounce") {
    const failed = extractFailedRecipient(email);
    if (failed !== null) {
      await deps.db.query(
        `INSERT INTO suppression (email_hash, reason, channel_scope)
         VALUES ($1, 'hard_bounce', 'all') ON CONFLICT DO NOTHING`,
        [emailHash(failed)],
      );
      outcome.suppressed = true;
    } else {
      outcome.exception = "bounce message with no extractable recipient";
    }
  }

  // --- Persist the message --------------------------------------------------
  if (match.conversationId !== undefined) {
    const key = inboundIdempotencyKey(email);
    if (deps.storeBody !== undefined) await deps.storeBody(key, email.rawText);
    const inserted = await deps.db.maybeOne<{ id: string }>(
      `INSERT INTO messages (conversation_id, direction, channel, subject, body_r2_key, body_hash, idempotency_key, sent_at)
       VALUES ($1, 'inbound', 'email', $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        match.conversationId,
        email.subject.slice(0, 500),
        key,
        emailHash(email.rawText).toString("hex"),
        key,
        now(),
      ],
    );
    if (inserted !== null) outcome.messageId = inserted.id;

    // ⛔ `replied_at` marks the OUTBOUND message that drew the reply, and only
    // for a human one. An out-of-office setting replied_at would make the
    // deliverability dashboard report engagement that did not happen.
    if (mayAdvanceLead(classification.kind)) {
      const thread = [email.inReplyTo, ...email.references]
        .filter((r): r is string => r !== undefined)
        .map((r) => r.replace(/^<|>$/g, ""));
      await deps.db.query(
        `UPDATE messages SET replied_at = $1
          WHERE conversation_id = $2 AND direction = 'outbound' AND replied_at IS NULL
            AND ($3::text[] = '{}' OR provider_message_id = ANY($3::text[]))`,
        [now(), match.conversationId, thread],
      );
    }
  } else {
    outcome.exception = match.reason ?? "no conversation matched";
  }

  // --- Advance the lead -----------------------------------------------------
  //
  // ⛔ Only a human reply. This is the guard that stops a vacation responder
  // being logged as engagement — auto-replies outnumber real replies on most
  // cold lists, so without it the reply rate in the dashboard is a fiction and
  // the sequence stops for people who never read the message.
  if (mayAdvanceLead(classification.kind) && match.leadId !== undefined && deps.signalWorkflow !== undefined) {
    const lead = await deps.db.maybeOne<{ workflow_id: string }>("SELECT workflow_id FROM leads WHERE id = $1", [
      match.leadId,
    ]);
    if (lead !== null) {
      // Intent is deliberately NOT scored here. The workflow's threshold reads
      // it, and a deterministic keyword guess would be a second, worse copy of
      // the router that already exists. The responder agent supplies it.
      await deps.signalWorkflow(lead.workflow_id, "reply", { intent: 0, pending: true });
      outcome.signalled = true;
    }
  }

  await deps.db.query(
    `INSERT INTO events (event_type, actor_kind, actor_id, payload)
     VALUES ('email.received', 'system', 'inbound', $1)`,
    [
      JSON.stringify({
        kind: outcome.kind,
        reason: outcome.reason,
        match: outcome.match,
        suppressed: outcome.suppressed,
        signalled: outcome.signalled,
        // ⛔ Never the body. Message bodies are not logged, at any level.
        subjectLength: email.subject.length,
      }),
    ],
  );

  if (outcome.exception !== undefined) {
    await deps.db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
       VALUES ('inbound_unrouted', 3, $1, 'message classified and stored, not attached to a thread',
               'Attach it by hand, or widen the matcher if this is a recurring pattern')`,
      [JSON.stringify({ from: email.from, kind: outcome.kind, reason: outcome.exception })],
    );
  }

  return outcome;
}

/**
 * Pull the failed address out of a DSN.
 *
 * Best-effort by design: `Final-Recipient` is the standard field, `X-Failed-Recipients`
 * is what several large providers actually send, and a bounce we cannot attribute
 * is surfaced rather than guessed at — suppressing the wrong address would
 * silently remove a real prospect.
 */
export function extractFailedRecipient(email: ParsedEmail): string | null {
  const failedHeader = email.headers["x-failed-recipients"];
  if (failedHeader !== undefined && failedHeader.includes("@")) return failedHeader.trim().toLowerCase();
  const final = /^Final-Recipient:\s*rfc822;\s*(\S+@\S+)/im.exec(email.rawText);
  if (final?.[1] !== undefined) return final[1].toLowerCase().replace(/[<>;,]/g, "");
  const original = /^Original-Recipient:\s*rfc822;\s*(\S+@\S+)/im.exec(email.rawText);
  if (original?.[1] !== undefined) return original[1].toLowerCase().replace(/[<>;,]/g, "");
  return null;
}
