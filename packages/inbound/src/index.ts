// @adw/inbound — the path a received email takes.
//
// It exists because the system was outbound-only: replies to cold mail landed
// in a mailbox nobody read, `messages.replied_at` was written by nothing, and
// `LeadWorkflow` waited on a `reply` signal with no production emitter, so every
// lead ran the full three touches and was marked EXHAUSTED no matter what the
// recipient said. A cold programme without an inbound path is not a slow
// conversation — it is a monologue that reports engagement it never had.
export {
  extractAddress,
  extractAddresses,
  extractBody,
  parseEmail,
  parseHeaders,
  splitMime,
  stripQuoted,
  type Headers,
  type ParsedEmail,
} from "./parse.ts";

export {
  classifyInbound,
  isAutoSubmitted,
  isNullSender,
  mayAdvanceLead,
  type Classification,
  type InboundKind,
} from "./classify.ts";

export {
  matchConversation,
  mintReplyToken,
  replyAddress,
  tokenFromAddress,
  verifyReplyToken,
  type MatchDeps,
  type MatchResult,
  type ReplyToken,
} from "./match.ts";

export {
  extractFailedRecipient,
  routeInbound,
  type InboundDeps,
  type InboundOutcome,
} from "./route.ts";

export { extractSesInbound, type SesInboundNotification } from "./ses.ts";

export {
  applyEmailFeedback,
  providerMessageId,
  type WebhookOutcome,
} from "./feedback.ts";
