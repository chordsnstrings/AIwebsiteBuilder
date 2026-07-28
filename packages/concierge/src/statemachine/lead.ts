// The lead capture machine (§39.2). The route everything else degrades into.
//
// Booking unavailable, photo triage not offered for this vertical, a question
// nobody published an answer to, a ceiling coming down at 11pm — all of them
// end here, because a visitor who leaves a way to be reached is worth something
// and a visitor who is refused is worth nothing. That is the whole reason the
// capabilities the manifest withheld degrade rather than refuse.
//
// It asks for two things and stops. Every extra field is a drop-off, and the
// business needs a name and a number, not a form.

import type { Db } from "@adw/db";
import type { Urgency } from "../types.ts";
import { extractContact } from "./booking.ts";

export type LeadStage = "need_detail" | "need_contact" | "captured";

export interface LeadState {
  stage: LeadStage;
  need?: string | undefined;
  contact?: string | undefined;
  name?: string | undefined;
  urgency: Urgency;
  reference?: string | undefined;
}

export const initialLeadState = (urgency: Urgency = "normal"): LeadState => ({ stage: "need_detail", urgency });

// The prefix is matched case-insensitively; the NAME itself is not. A name
// has to look like a name — "I'm not sure" must not capture "not".
const NAME =
  /(?:\b[Ii]'?[Mm]\b|\b[Mm]y name(?:'?s| is)?|\b[Tt]his is|\b[Ii]t'?s)[\s,]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/;

export function extractName(text: string): string | undefined {
  const m = NAME.exec(text);
  return m?.[1];
}

export interface LeadTransition {
  state: LeadState;
  reply: string;
  /** Set on the transition into `captured`. The caller commits it. */
  commit?: { need: string; contact: string; name?: string | undefined; urgency: Urgency } | undefined;
}

const ASK_CONTACT: Record<Urgency, string> = {
  emergency: "That sounds urgent — what's the best number to reach you on right now? I'll flag it straight away.",
  urgent: "Understood. What's the best number or email to get back to you on?",
  normal: "Happy to pass that on. What's the best number or email to reach you on?",
};

export function leadNext(state: LeadState, text: string): LeadTransition {
  const contact = extractContact(text);
  const name = extractName(text) ?? state.name;

  if (state.stage === "captured") {
    return { state, reply: "Already passed on — someone will be in touch. Anything else in the meantime?" };
  }

  // The need is whatever they said first. Not parsed, not summarised, not
  // rewritten: the owner reads it, and the owner reading the customer's own
  // words is more useful than the owner reading our paraphrase of them.
  const need = state.need ?? (state.stage === "need_detail" ? text.trim() : undefined);

  if (contact === undefined) {
    return {
      state: { ...state, stage: "need_contact", ...(need === undefined ? {} : { need }), ...(name === undefined ? {} : { name }) },
      reply: ASK_CONTACT[state.urgency],
    };
  }

  const finalNeed = need ?? "(no detail given)";
  return {
    state: { ...state, stage: "captured", need: finalNeed, contact, ...(name === undefined ? {} : { name }) },
    reply:
      state.urgency === "emergency"
        ? "Got it — I've flagged this as urgent and the business has been alerted."
        : "Thanks — that's with the business now and someone will come back to you.",
    commit: { need: finalNeed, contact, ...(name === undefined ? {} : { name }), urgency: state.urgency },
  };
}

export interface EnquiryCommit {
  sessionId: string;
  customerId?: string | undefined;
  businessId?: string | undefined;
  need: string;
  contact: string;
  name?: string | undefined;
  urgency: Urgency;
}

export interface EnquiryRecord {
  id: string;
  created: boolean;
}

/**
 * One open enquiry per session. `enquiries` has no natural unique key — an
 * urgency or a contact can legitimately be corrected mid-conversation — so the
 * session is the idempotency scope, and a second commit updates the row rather
 * than adding a duplicate to the owner's queue. Two identical leads in that
 * queue is the owner phoning the same person twice.
 */
export async function commitEnquiry(db: Db, input: EnquiryCommit): Promise<EnquiryRecord> {
  return db.tx(async (tx) => {
    const existing = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM enquiries WHERE session_id = $1 AND status = 'open' ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [input.sessionId],
    );
    if (existing !== null) {
      await tx.query(`UPDATE enquiries SET name = $2, need = $3, contact = $4, urgency = $5 WHERE id = $1`, [
        existing.id,
        input.name ?? null,
        input.need,
        input.contact,
        input.urgency,
      ]);
      return { id: existing.id, created: false };
    }
    const row = await tx.one<{ id: string }>(
      `INSERT INTO enquiries (customer_id, business_id, session_id, name, need, contact, urgency)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        input.customerId ?? null,
        input.businessId ?? null,
        input.sessionId,
        input.name ?? null,
        input.need,
        input.contact,
        input.urgency,
      ],
    );
    return { id: row.id, created: true };
  });
}
