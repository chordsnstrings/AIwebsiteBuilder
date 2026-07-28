// The booking machine (§39.2). Deterministic state, idempotent effect.
//
// Two properties, and neither is negotiable.
//
// It is a MACHINE. Booking is the one thing the agent does that changes the
// world outside the conversation — a slot comes off the owner's calendar and
// someone plans their day around it. A model deciding, per turn, whether it has
// enough to book is a system that double-books under paraphrase. So the state
// is an enum, the transitions are a function, and the model is not consulted.
//
// It is IDEMPOTENT. A visitor who double-taps, a retried workflow step and a
// replayed webhook must all produce one booking. The key is derived from the
// session, the slot and the contact rather than generated, so the second attempt
// computes the same key and collides with the first by construction — there is
// no window in which two rows can exist.

import { createHash } from "node:crypto";
import type { Db } from "@adw/db";

export type BookingStage = "need_slot" | "need_contact" | "held" | "confirmed" | "cancelled";

export interface Slot {
  start: string;
  end: string;
}

export interface BookingState {
  stage: BookingStage;
  slot?: Slot | undefined;
  contact?: string | undefined;
  reference?: string | undefined;
}

export const initialBookingState = (): BookingState => ({ stage: "need_slot" });

/** Phone or email. Anything else is not a way to reach someone. */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;

export function extractContact(text: string): string | undefined {
  const email = EMAIL.exec(text);
  if (email) return email[0];
  const phone = PHONE.exec(text);
  if (phone) return phone[0].replace(/[\s().-]/g, "");
  return undefined;
}

/**
 * Which offered slot the visitor picked. Accepts the ordinal we printed and
 * nothing else — parsing "Tuesday afternoon" into a timestamp is a guess, and a
 * guess here books the wrong day.
 */
export function pickSlot(text: string, offered: readonly Slot[]): Slot | undefined {
  const ordinal = /(?:^|\b)(?:option\s*)?([1-9])(?:\b|$)/.exec(text.trim());
  if (ordinal) {
    const at = Number(ordinal[1]) - 1;
    const slot = offered[at];
    if (slot !== undefined) return slot;
  }
  // An exact ISO timestamp, which is what the MCP surface and the widget send.
  const iso = /\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/.exec(text);
  if (iso) return offered.find((s) => s.start === iso[0]);
  return undefined;
}

export interface BookingTurn {
  text: string;
  offered: readonly Slot[];
}

export interface BookingTransition {
  state: BookingState;
  reply: string;
  /** Set on the transition into `held`. The caller commits it. */
  commit?: { slot: Slot; contact: string } | undefined;
}

const listSlots = (offered: readonly Slot[]): string =>
  offered
    .slice(0, 3)
    .map((s, i) => `${i + 1}. ${new Date(s.start).toUTCString().replace(/:00 GMT$/, " GMT")}`)
    .join("\n");

/**
 * One transition. Pure — same state and same input give the same next state on
 * any machine, in any process, which is what makes a replayed turn safe.
 */
export function bookingNext(state: BookingState, turn: BookingTurn): BookingTransition {
  if (state.stage === "confirmed" || state.stage === "cancelled") {
    return { state, reply: "That's already booked in. If you need to change it, just say so and I'll pass it on." };
  }

  if (/\b(cancel|forget it|never mind|not now)\b/i.test(turn.text)) {
    return { state: { ...state, stage: "cancelled" }, reply: "No problem — I've left it. Anything else I can help with?" };
  }

  if (state.stage === "need_slot") {
    if (turn.offered.length === 0) {
      return {
        state,
        reply: "I don't have any slots to offer right now. If you leave a number, someone will call you back to arrange it.",
      };
    }
    const slot = pickSlot(turn.text, turn.offered);
    if (slot === undefined) {
      return { state, reply: `Here's what's free — reply with the number that suits:\n${listSlots(turn.offered)}` };
    }
    const contact = extractContact(turn.text);
    if (contact === undefined) {
      return { state: { ...state, stage: "need_contact", slot }, reply: "Got it. What's the best number or email to confirm on?" };
    }
    return { state: { ...state, stage: "held", slot, contact }, reply: "", commit: { slot, contact } };
  }

  // need_contact
  const contact = extractContact(turn.text);
  if (contact === undefined) {
    return { state, reply: "I just need a phone number or email address to confirm the booking against." };
  }
  const slot = state.slot;
  if (slot === undefined) {
    // Cannot happen through bookingNext, but a state loaded from storage is
    // data and data can be wrong. Restart rather than book against undefined.
    return { state: { stage: "need_slot" }, reply: "Let me start that again — which slot works for you?" };
  }
  return { state: { ...state, stage: "held", slot, contact }, reply: "", commit: { slot, contact } };
}

export interface BookingCommit {
  sessionId: string;
  customerId: string;
  slot: Slot;
  contact: string;
}

export interface BookingRecord {
  id: string;
  slotStart: Date;
  slotEnd: Date;
  status: string;
  /** False when this call collided with a booking that already existed. */
  created: boolean;
}

/**
 * Derived, not generated. Two attempts to book the same slot for the same
 * contact in the same session produce the same key and therefore the same row.
 */
export function bookingIdempotencyKey(input: Pick<BookingCommit, "sessionId" | "slot" | "contact">): string {
  return createHash("sha256")
    .update(`${input.sessionId}|${input.slot.start}|${input.slot.end}|${input.contact.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 48);
}

export async function commitBooking(db: Db, input: BookingCommit): Promise<BookingRecord> {
  const key = bookingIdempotencyKey(input);
  const inserted = await db.query<{ id: string; slot_start: Date; slot_end: Date; status: string }>(
    `INSERT INTO bookings (customer_id, session_id, slot_start, slot_end, contact, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, slot_start, slot_end, status`,
    [input.customerId, input.sessionId, input.slot.start, input.slot.end, input.contact, key],
  );
  const row = inserted.rows[0];
  if (row !== undefined) {
    return { id: row.id, slotStart: row.slot_start, slotEnd: row.slot_end, status: row.status, created: true };
  }
  const existing = await db.one<{ id: string; slot_start: Date; slot_end: Date; status: string }>(
    `SELECT id, slot_start, slot_end, status FROM bookings WHERE idempotency_key = $1`,
    [key],
  );
  return {
    id: existing.id,
    slotStart: existing.slot_start,
    slotEnd: existing.slot_end,
    status: existing.status,
    created: false,
  };
}

/** What the visitor is told once the slot is held. */
export function bookingConfirmation(slot: Slot): string {
  return (
    `Booked — ${new Date(slot.start).toUTCString().replace(/:00 GMT$/, " GMT")}. ` +
    "You'll get a confirmation, and if anything changes the business will be in touch directly."
  );
}
