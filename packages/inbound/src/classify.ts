// Deciding, without a model, what KIND of thing just arrived.
//
// ⛔ This runs before any agent sees the message, and some of its verdicts are
// terminal. An out-of-office counted as engagement is the specific failure that
// makes a cold programme look like it is working while it is not: the lead is
// marked ENGAGED, the sequence stops, a human never follows up, and the reply
// rate in the dashboard is a fiction. Auto-replies outnumber real replies on
// most cold lists, so this is not an edge case — it is most of the volume.
//
// Everything here is deterministic. A model may later read the message to judge
// intent, but "is this even a person" is a header question with a right answer,
// and paying a model to guess it would be both slower and worse.

import type { Headers, ParsedEmail } from "./parse.ts";

export type InboundKind =
  /** A human wrote this. The only kind that may advance a lead. */
  | "human"
  /** Out-of-office, vacation, or any Auto-Submitted machine reply. */
  | "auto_reply"
  /** A delivery status notification that arrived as mail rather than a webhook. */
  | "bounce"
  /** An explicit request to stop, however phrased. Terminal and immediate. */
  | "unsubscribe"
  /** A spam-complaint feedback loop report (ARF). */
  | "complaint";

export interface Classification {
  kind: InboundKind;
  /** Why, in a form a human reading the exception queue can act on. */
  reason: string;
}

const AUTO_SUBJECT = [
  /^\s*(re:\s*)?(automatic reply|auto[- ]?reply|autoreply)\b/i,
  /^\s*(re:\s*)?out of (the )?office\b/i,
  /^\s*(re:\s*)?away from (my )?(the )?(office|desk|email)\b/i,
  /^\s*(re:\s*)?on (annual |parental |sick )?leave\b/i,
  /^\s*(re:\s*)?vacation (reply|response|notice)\b/i,
  /^\s*(re:\s*)?abwesenheitsnotiz\b/i,
  /^\s*(re:\s*)?réponse automatique\b/i,
  /^\s*(re:\s*)?respuesta autom[áa]tica\b/i,
];

const BOUNCE_SUBJECT = [
  /^\s*(mail delivery (failed|subsystem)|undeliverable|delivery status notification|returned mail)\b/i,
  /^\s*(failure notice|delivery has failed|message not delivered)\b/i,
];

/**
 * Explicit stop requests.
 *
 * ⛔ Deliberately broad and matched against the STRIPPED body only, so that a
 * quoted footer containing the word "unsubscribe" — which every one of our own
 * emails carries by law — cannot suppress a contact who replied "sounds great".
 * That is not hypothetical: our List-Unsubscribe footer is in the quoted
 * history of every reply we receive.
 */
const STOP_PHRASES = [
  /\bunsubscribe\b/i,
  /\b(take|remove) (me|us) off\b/i,
  /\bremove (me|us) from\b/i,
  /\bstop (emailing|contacting|messaging)\b/i,
  /\bdo not (contact|email|write to) (me|us)\b/i,
  /\bdon'?t (contact|email) (me|us)\b/i,
  /\bopt(ing)? out\b/i,
  /^\s*stop\s*$/i,
  /^\s*no\s+thanks?\.?\s*$/i,
];

function has(headers: Headers, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

/**
 * RFC 3834 and the de-facto headers every mail system actually sets.
 *
 * `Auto-Submitted: no` is explicitly NOT auto — the header exists precisely so a
 * human-generated message can say so, and treating its presence as the signal
 * would misclassify well-behaved senders.
 */
export function isAutoSubmitted(headers: Headers): string | null {
  const autoSubmitted = has(headers, "auto-submitted");
  if (autoSubmitted !== undefined && !/^no$/i.test(autoSubmitted.trim())) {
    return `Auto-Submitted: ${autoSubmitted}`;
  }
  for (const h of ["x-autoreply", "x-autorespond", "x-auto-response-suppress"]) {
    const v = has(headers, h);
    if (v !== undefined) return `${h}: ${v}`;
  }
  const precedence = has(headers, "precedence");
  if (precedence !== undefined && /^(bulk|auto_reply|junk|list)$/i.test(precedence.trim())) {
    return `Precedence: ${precedence}`;
  }
  // Microsoft Exchange marks OOO with this rather than Auto-Submitted.
  const msgClass = has(headers, "x-ms-exchange-inbox-rules-loop") ?? has(headers, "x-ms-exchange-parent-message-id");
  if (msgClass !== undefined) return "X-MS-Exchange auto-response marker";
  return null;
}

/**
 * An empty `Return-Path: <>` is the null sender. Only automated systems use it,
 * and every bounce does.
 */
export function isNullSender(headers: Headers): boolean {
  const rp = has(headers, "return-path");
  return rp !== undefined && rp.replace(/\s/g, "") === "<>";
}

export function classifyInbound(email: ParsedEmail): Classification {
  const h = email.headers;
  const contentType = has(h, "content-type") ?? "";

  // ARF feedback loops are a specific MIME type. They are how a mailbox provider
  // tells us a recipient pressed "spam", and they must reach suppression whether
  // or not the ESP also fires a webhook.
  if (/message\/feedback-report/i.test(contentType) || /report-type=["']?feedback-report/i.test(contentType)) {
    return { kind: "complaint", reason: "ARF feedback report" };
  }
  if (/report-type=["']?delivery-status/i.test(contentType) || /multipart\/report/i.test(contentType)) {
    return { kind: "bounce", reason: "multipart/report delivery-status" };
  }
  if (BOUNCE_SUBJECT.some((re) => re.test(email.subject))) {
    return { kind: "bounce", reason: `bounce subject: ${email.subject.slice(0, 60)}` };
  }
  if (isNullSender(h) && email.from === "") {
    return { kind: "bounce", reason: "null Return-Path with no From" };
  }

  const auto = isAutoSubmitted(h);
  if (auto !== null) return { kind: "auto_reply", reason: auto };
  if (AUTO_SUBJECT.some((re) => re.test(email.subject))) {
    return { kind: "auto_reply", reason: `auto-reply subject: ${email.subject.slice(0, 60)}` };
  }

  // ⛔ Checked against the STRIPPED body. Our own unsubscribe footer appears in
  // the quoted history of every reply we get, and matching it there would
  // suppress people who replied "yes please".
  if (STOP_PHRASES.some((re) => re.test(email.text))) {
    return { kind: "unsubscribe", reason: "explicit stop request in the reply body" };
  }

  return { kind: "human", reason: "no automation markers" };
}

/** ⛔ Only a human reply may advance a lead. Stated as a function so no caller
 *  has to remember which of the five kinds count. */
export function mayAdvanceLead(kind: InboundKind): boolean {
  return kind === "human";
}
