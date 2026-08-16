// Getting raw MIME out of an SES receipt-rule notification.
//
// SES delivers received mail one of two ways: inline as base64 in the SNS
// message (`content`), or written to S3 with only a pointer in the notification.
// Which one you get depends on the receipt rule's action, and a deployment can
// have both — so both are recognised, and the S3 case returns a pointer for the
// caller to fetch rather than pretending it has the message.
//
// ⛔ The S3 case must not be treated as "no mail". A receipt rule switched from
// SNS-inline to S3 for size reasons would otherwise turn every reply into
// silence, which is precisely the failure this package was built to end.

export interface SesInboundNotification {
  notificationType?: string;
  content?: string;
  receipt?: {
    action?: { type?: string; bucketName?: string; objectKey?: string };
    spamVerdict?: { status?: string };
    virusVerdict?: { status?: string };
    spfVerdict?: { status?: string };
    dkimVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
  };
  mail?: { messageId?: string; source?: string; destination?: string[] };
}

export type SesInboundResult =
  | { kind: "mime"; raw: string; verdicts: Record<string, string> }
  | { kind: "s3"; bucket: string; key: string; verdicts: Record<string, string> }
  | { kind: "not_inbound" }
  | { kind: "rejected"; reason: string };

/**
 * Extract the message, or say why there isn't one.
 *
 * ⛔ A FAIL virus verdict is refused before the MIME is handed on. The parser is
 * hand-rolled and does not execute anything, but "we only parse it" is the
 * argument every mail-borne compromise starts from, and a message Amazon has
 * already told us carries a virus has no business entering the pipeline.
 */
export function extractSesInbound(notification: SesInboundNotification): SesInboundResult {
  if (notification.notificationType !== "Received") return { kind: "not_inbound" };

  const r = notification.receipt ?? {};
  const verdicts: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.endsWith("Verdict") && typeof v === "object" && v !== null) {
      const status = (v as { status?: string }).status;
      if (status !== undefined) verdicts[k.replace("Verdict", "")] = status;
    }
  }
  if (verdicts["virus"] === "FAIL") return { kind: "rejected", reason: "SES virus verdict FAIL" };

  // Spam is NOT a rejection. A cold-outreach reply routinely trips a spam
  // verdict, and dropping those would discard exactly the messages that matter
  // most. It is recorded so a human can see it.
  if (notification.content !== undefined && notification.content.length > 0) {
    let raw: string;
    try {
      raw = Buffer.from(notification.content, "base64").toString("utf8");
    } catch {
      return { kind: "rejected", reason: "content is not base64" };
    }
    // A notification whose content decodes to nothing is a bug worth surfacing,
    // not an empty email.
    if (raw.trim().length === 0) return { kind: "rejected", reason: "content decoded to an empty message" };
    return { kind: "mime", raw, verdicts };
  }

  const action = r.action;
  if (action?.type === "S3" && action.bucketName !== undefined && action.objectKey !== undefined) {
    return { kind: "s3", bucket: action.bucketName, key: action.objectKey, verdicts };
  }

  return { kind: "rejected", reason: `Received notification with no content and no S3 action (action=${action?.type ?? "none"})` };
}
