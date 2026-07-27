// The EmailTransport capability. One normalized interface over every sending
// rail — SES for brand mail, Workspace/M365/cold-specialist SMTP for the cold
// fleet. Callers never branch on vendor; the gate picks a rail and hands it a
// message. Feedback (delivered/bounce/complaint/reply) comes back out of band,
// which is what closes the deliverability loop.
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
  accepted: boolean;
}

export type EmailEventType = "delivered" | "bounce" | "complaint" | "reply";

export interface EmailEvent {
  type: EmailEventType;
  messageId: string;
  to: string;
}

/** Outcome mix for the simulator. Any omitted rate keeps its current value. */
export interface EmailRates {
  bounceRate?: number;
  complaintRate?: number;
  replyRate?: number;
}

export interface SentMessage extends EmailMessage {
  messageId: string;
  seq: number;
}

export interface EmailTransport {
  readonly vendorId: string;
  send(message: EmailMessage): Promise<SendResult>;
}
