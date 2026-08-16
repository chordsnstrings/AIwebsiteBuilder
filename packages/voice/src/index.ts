// @adw/voice — telephony (MF11, 3 units).
//
// The smallest family in the catalogue, and almost all of its value is in one
// unit: a missed call at a trade business is a customer who has already decided
// to buy and is now dialling the next number on the list.
//
// ⛔ Nothing here places a call or sends a text. The spec keeps SMS and voice
// behind the consent bridge and the bridge does not exist. What this does is
// turn an unanswered call into an enquiry the owner can see — and, where a
// reply is warranted, ASK THE GATE, which denies for want of a legal basis and
// records why.
//
// That denial is the point rather than an embarrassment. A denial recorded is a
// system that starts working the day consent arrives. A send that skipped the
// gate is a regulatory problem that starts the same day.

import { createHash } from "node:crypto";
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { gate } from "@adw/gate";
import type { OutboundMessage } from "@adw/compliance";

export type CallOutcome = "missed" | "answered" | "voicemail";

export interface CallEvent {
  customerId: string;
  provider: string;
  providerCallId: string;
  outcome: CallOutcome;
  direction?: "inbound" | "outbound";
  callerNumber: string;
  startedAt: Date;
  durationSeconds?: number | undefined;
  transcript?: string | undefined;
  recordingRef?: string | undefined;
  countryCode?: string | undefined;
}

export interface RecordedCall {
  callId: string;
  created: boolean;
  enquiryId: string | null;
  /** Null when no follow-up was attempted; otherwise what the gate said. */
  followUp: { allowed: boolean; decisionId: string; reason?: string } | null;
}

/** E.164-ish: digits only, so +44 20 7946 0000 and +442079460000 hash alike. */
export function normaliseNumber(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  return digits.length === 0 ? "" : `+${digits}`;
}

export function phoneHash(raw: string): Buffer {
  return createHash("sha256").update(normaliseNumber(raw)).digest();
}

/**
 * Record a call and, for a missed one, capture the enquiry.
 *
 * ⛔ Idempotent on (provider, providerCallId). Telephony webhooks are redelivered
 * routinely, and a second enquiry for one missed call is the owner ringing the
 * same person twice — which reads to that person as a business that does not
 * know what it is doing.
 */
export async function recordCall(
  db: Db,
  event: CallEvent,
  opts: { attemptFollowUp?: boolean } = {},
): Promise<RecordedCall> {
  const hash = phoneHash(event.callerNumber);
  const number = normaliseNumber(event.callerNumber);

  const existing = await db.maybeOne<{ id: string; enquiry_id: string | null }>(
    "SELECT id, enquiry_id FROM calls WHERE provider = $1 AND provider_call_id = $2",
    [event.provider, event.providerCallId],
  );
  if (existing !== null) {
    return { callId: existing.id, created: false, enquiryId: existing.enquiry_id, followUp: null };
  }

  const { callId, enquiryId } = await db.tx(async (tx) => {
    let enquiry: string | null = null;
    if (event.outcome !== "answered") {
      // ⛔ `urgency: normal`, never inferred from the fact that they rang. A
      // missed call at 3am is not automatically an emergency, and an enquiry
      // queue where everything is urgent has no ordering.
      const row = await tx.one<{ id: string }>(
        `INSERT INTO enquiries (customer_id, need, contact, urgency, status)
         VALUES ($1,$2,$3,'normal','open') RETURNING id`,
        [
          event.customerId,
          event.transcript === undefined || event.transcript.trim() === ""
            ? "Missed call — no message left"
            : `Voicemail: ${event.transcript.trim()}`,
          number,
        ],
      );
      enquiry = row.id;
    }
    const call = await tx.one<{ id: string }>(
      `INSERT INTO calls (customer_id, outcome, direction, caller_hash, caller_number, started_at,
                          duration_seconds, transcript, recording_ref, enquiry_id, provider, provider_call_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        event.customerId, event.outcome, event.direction ?? "inbound", hash, number, event.startedAt,
        event.durationSeconds ?? null, event.transcript ?? null, event.recordingRef ?? null,
        enquiry, event.provider, event.providerCallId,
      ],
    );
    return { callId: call.id, enquiryId: enquiry };
  });

  await emit({
    eventType: "call.recorded",
    subject: { kind: "call", id: callId },
    payload: { outcome: event.outcome, enquiryRaised: enquiryId !== null },
  });

  let followUp: RecordedCall["followUp"] = null;
  if (opts.attemptFollowUp === true && event.outcome !== "answered") {
    followUp = await attemptTextBack(db, { ...event, callId, hash, number });
  }
  return { callId, created: true, enquiryId, followUp };
}

/**
 * The missed-call text-back, asked of the gate.
 *
 * ⛔ It calls `gate()` and stops. It does NOT call `gatedSend`, because there is
 * no SMS transport in this system and pretending otherwise would produce the
 * exact failure this codebase keeps finding — a component that reports success
 * while doing nothing. What it produces is a real decision row explaining why
 * the text did not go, which is a true statement about today and a working
 * system the day an SMS legal basis and a transport exist.
 */
async function attemptTextBack(
  db: Db,
  input: CallEvent & { callId: string; hash: Buffer; number: string },
): Promise<{ allowed: boolean; decisionId: string; reason?: string }> {
  const message: OutboundMessage = {
    // ⛔ The caller's number hashed into BOTH slots. The gate's suppression rule
    // reads emailHash unconditionally, and passing a zero buffer would make
    // every caller look unsuppressed regardless of what they had asked for.
    emailHash: input.hash,
    phoneHash: input.hash,
    countryCode: input.countryCode ?? "GB",
    subscriberType: "unknown",
    channel: "sms",
    messageClass: "transactional",
    domainClass: "brand",
    idempotencyKey: `callback:${input.provider}:${input.providerCallId}`,
    body: "Sorry we missed your call — we'll ring you back shortly.",
    headers: {},
  };
  const decision = await gate(message, { db });
  const reason = decision.allow ? undefined : decision.reason;
  await db.query(
    "UPDATE calls SET gate_decision_id = $2, gate_reason = $3, followed_up = $4 WHERE id = $1",
    [input.callId, decision.decisionId, reason ?? null, decision.allow],
  );
  return {
    allowed: decision.allow,
    decisionId: decision.decisionId,
    ...(reason === undefined ? {} : { reason }),
  };
}

export interface MissedCall {
  callId: string;
  callerNumber: string | null;
  startedAt: Date;
  transcript: string | null;
  enquiryId: string | null;
  gateReason: string | null;
}

/**
 * What nobody has rung back.
 *
 * ⛔ Includes `gateReason`, so the owner sees "we did not text them because
 * there is no legal basis for SMS in this market" rather than an unexplained
 * silence. An automation that quietly does nothing is worse than one that says
 * what it will not do.
 */
export async function missedCalls(db: Db, customerId: string, limit = 50): Promise<MissedCall[]> {
  const rows = await db.query<{
    id: string; caller_number: string | null; started_at: Date; transcript: string | null;
    enquiry_id: string | null; gate_reason: string | null;
  }>(
    `SELECT c.id, c.caller_number, c.started_at, c.transcript, c.enquiry_id, c.gate_reason
       FROM calls c
       LEFT JOIN enquiries e ON e.id = c.enquiry_id
      WHERE c.customer_id = $1 AND c.outcome <> 'answered'
        AND (e.id IS NULL OR e.status = 'open')
      ORDER BY c.started_at DESC
      LIMIT $2`,
    [customerId, limit],
  );
  return rows.rows.map((r) => ({
    callId: r.id,
    callerNumber: r.caller_number,
    startedAt: new Date(r.started_at),
    transcript: r.transcript,
    enquiryId: r.enquiry_id,
    gateReason: r.gate_reason,
  }));
}

/** The owner rang them back. Closes the enquiry with the call. */
export async function markReturned(db: Db, callId: string): Promise<boolean> {
  return db.tx(async (tx) => {
    const row = await tx.maybeOne<{ enquiry_id: string | null; followed_up: boolean }>(
      "SELECT enquiry_id, followed_up FROM calls WHERE id = $1",
      [callId],
    );
    if (row === null) return false;
    await tx.query("UPDATE calls SET followed_up = TRUE WHERE id = $1", [callId]);
    if (row.enquiry_id !== null) {
      await tx.query("UPDATE enquiries SET status = 'contacted' WHERE id = $1 AND status = 'open'", [row.enquiry_id]);
    }
    return true;
  });
}
