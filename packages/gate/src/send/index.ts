// The sole transport layer. Every send passes through gate() first; this module
// is the only place transport adapters may be imported (lint-enforced). Before
// handing to transport it re-asserts that each obligation is materially present
// (literal header/body check), not merely that gate() listed it.
import type { Db } from "@adw/db";
import { requiredElementsPresent, type GateDecision, type OutboundMessage } from "@adw/compliance";
import { emit } from "@adw/telemetry";
import { gate, type GateDeps } from "../gate.ts";

export interface EmailTransport {
  send(input: {
    to: string;
    from: string;
    subject: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<{ messageId: string; accepted: boolean }>;
}

export interface SendInput {
  message: OutboundMessage;
  to: string;
  from: string;
  subject: string;
  transport: EmailTransport;
  conversationId?: string;
  roleId?: string;
}

export type SendResult =
  | { sent: true; decisionId: string; messageId: string }
  | { sent: false; decisionId: string; reason: string };

/**
 * Gated send. This is the only function that touches a transport. A caller
 * cannot reach transport without a passing gate decision AND materially-present
 * obligations — a defence in depth against a decision row that lies.
 */
export async function gatedSend(input: SendInput, deps: GateDeps): Promise<SendResult> {
  const decision: GateDecision = await gate(input.message, deps);
  if (!decision.allow) {
    await emit({
      eventType: "gate.evaluated",
      subject: { kind: "contact", id: input.message.contactId ?? "unknown" },
      payload: { allow: false, reason: decision.reason, ruleId: decision.ruleId },
    });
    return { sent: false, decisionId: decision.decisionId, reason: decision.reason };
  }

  // Defence in depth: transport asserts each obligation is materially present.
  const check = requiredElementsPresent(input.message, decision.obligations);
  if (!check.ok) {
    return { sent: false, decisionId: decision.decisionId, reason: `MISSING_AT_TRANSPORT:${check.missing.join(",")}` };
  }

  const res = await input.transport.send({
    to: input.to,
    from: input.from,
    subject: input.subject,
    body: input.message.body,
    headers: input.message.headers,
  });

  await recordMessage(deps.db, input, decision.decisionId, res.messageId);
  await emit({
    eventType: "email.sent",
    subject: { kind: "contact", id: input.message.contactId ?? "unknown" },
    payload: { decisionId: decision.decisionId, messageId: res.messageId },
  });
  return { sent: true, decisionId: decision.decisionId, messageId: res.messageId };
}

async function recordMessage(
  db: Db,
  input: SendInput,
  gateDecisionId: string,
  messageId: string,
): Promise<void> {
  if (!input.conversationId) return;
  // provider_message_id is the join the deliverability loop depends on: a bounce
  // or complaint notification names the message by the provider's id and nothing
  // else, so a send that does not record it can never be scored.
  await db.query(
    `INSERT INTO messages
      (conversation_id, direction, channel, sending_asset_id, subject, body_r2_key, body_hash,
       gate_decision_id, idempotency_key, role_id, provider_message_id, sent_at)
     VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.conversationId,
      input.message.channel,
      input.message.sendingAssetId ?? null,
      input.subject,
      `msg/${messageId}`,
      messageId,
      gateDecisionId,
      input.message.idempotencyKey,
      input.roleId ?? null,
      messageId,
    ],
  );
}
