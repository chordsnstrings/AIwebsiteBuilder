// Stateful in-memory EmailTransport simulator. It records every send and
// manufactures the feedback stream that drives the deliverability loop demo:
// bounces, complaints and replies at configurable rates. Outcomes are chosen by
// hashing the message id, so a given send always produces the same outcome —
// the loop is reproducible, not lucky.
import { BaseMockVendor, seedHex, seedUnit } from "../health.ts";
import type { EmailEvent, EmailMessage, EmailRates, EmailTransport, SendResult, SentMessage } from "./types.ts";

/** A message carrying this header is a Sentinel probe: it never reaches a human
 *  and never enters the feedback stream, but it does traverse the send path. */
export const PROBE_HEADER = "x-adw-probe";

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export class MockEmailTransport extends BaseMockVendor implements EmailTransport {
  private readonly sent: SentMessage[] = [];
  private readonly events: EmailEvent[] = [];
  private rates: Required<EmailRates> = { bounceRate: 0, complaintRate: 0, replyRate: 0 };
  private seq = 0;
  private probes = 0;

  /** Merge-update the simulated outcome mix. */
  setRates(rates: EmailRates): void {
    this.rates = {
      bounceRate: clamp01(rates.bounceRate ?? this.rates.bounceRate),
      complaintRate: clamp01(rates.complaintRate ?? this.rates.complaintRate),
      replyRate: clamp01(rates.replyRate ?? this.rates.replyRate),
    };
  }

  getRates(): Required<EmailRates> {
    return { ...this.rates };
  }

  async send(message: EmailMessage): Promise<SendResult> {
    this.assertUp("send");
    if (!message.to.includes("@")) throw new Error(`invalid recipient '${message.to}'`);

    if (headerValue(message.headers, PROBE_HEADER) !== undefined) {
      this.probes += 1;
      return { messageId: `${this.vendorId}-probe-${this.probes}`, accepted: true };
    }

    this.seq += 1;
    const messageId = `${this.vendorId}-${this.seq}-${seedHex(12, this.vendorId, message.to, message.subject, message.body)}`;
    this.sent.push({ ...message, messageId, seq: this.seq });
    this.recordOutcome(messageId, message.to);
    return { messageId, accepted: true };
  }

  /** One delivery outcome per send, plus an optional reply on a delivered one. */
  private recordOutcome(messageId: string, to: string): void {
    const roll = seedUnit(messageId, "outcome");
    const { bounceRate, complaintRate, replyRate } = this.rates;
    if (roll < bounceRate) {
      this.events.push({ type: "bounce", messageId, to });
      return;
    }
    if (roll < bounceRate + complaintRate) {
      this.events.push({ type: "complaint", messageId, to });
      return;
    }
    this.events.push({ type: "delivered", messageId, to });
    if (seedUnit(messageId, "reply") < replyRate) {
      this.events.push({ type: "reply", messageId, to });
    }
  }

  /** Take and clear the pending feedback events (the webhook drain). */
  drainEvents(): EmailEvent[] {
    return this.events.splice(0, this.events.length);
  }

  pendingEventCount(): number {
    return this.events.length;
  }

  sentMessages(): readonly SentMessage[] {
    return [...this.sent];
  }

  sentCount(): number {
    return this.sent.length;
  }

  lastSent(): SentMessage | null {
    return this.sent[this.sent.length - 1] ?? null;
  }

  protected override async probeOperation(): Promise<string> {
    const result = await this.send({
      to: `probe@${this.vendorId}.invalid`,
      from: `sentinel@adw.invalid`,
      subject: "sentinel probe",
      body: "round trip",
      headers: { [PROBE_HEADER]: "1" },
    });
    if (!result.accepted) throw new Error("probe send was not accepted");
    return `send accepted (${result.messageId})`;
  }
}
