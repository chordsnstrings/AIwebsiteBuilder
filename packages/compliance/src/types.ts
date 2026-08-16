// Shared compliance/gate types (spec §4, §10).
export type MessageClass = "cold" | "preview_link" | "transactional";
export type ChannelKind = "email" | "sms" | "whatsapp" | "voice";
export type DomainClass = "burner" | "brand";
export type SubscriberType = "corporate" | "sole_trader" | "unknown";

export type Obligation =
  | "one_click_unsubscribe"
  | "plaintext_unsubscribe_link"
  | "physical_postal_address"
  | "sender_identification"
  | "ai_disclosure"
  | "privacy_notice_link"
  | "acquirer_disclosure";

export type DenyReason =
  | "KILL_SWITCH"
  | "SUPPRESSED"
  | "MARKET_NOT_ENABLED"
  | "NO_LEGAL_BASIS"
  | "PROVENANCE_MISSING"
  | "PROVENANCE_STALE"
  | "QUIET_HOURS"
  | "FREQUENCY_CAP"
  | "ASSET_UNHEALTHY"
  | "DOMAIN_CLASS_MISMATCH"
  | "MISSING_REQUIRED_ELEMENT"
  | "CONTENT_UNSAFE"
  | "DUPLICATE_SEND"
  | "UNVERIFIED_RECIPIENT"
  | "NO_ROLE_RELEVANCE";

export interface OutboundMessage {
  contactId?: string;
  emailHash: Buffer;
  phoneHash?: Buffer;
  countryCode: string;
  subscriberType: SubscriberType;
  channel: ChannelKind;
  messageClass: MessageClass;
  domainClass: DomainClass;
  sendingAssetId?: string;
  /**
   * Absent for transactional mail, which belongs to a customer rather than a
   * campaign. Cold outreach always carries one.
   */
  campaignId?: string;
  idempotencyKey: string;
  // Rendered message body + headers, for the required-elements and injection checks.
  body: string;
  headers: Record<string, string>;
  localHour?: number; // recipient-local hour (0-23); if absent, derived as UTC
  localWeekday?: number; // 0=Sun..6=Sat
  /**
   * Which acquisition motion this message belongs to (@adw/acquisition).
   * Absent is treated as SMB, because every existing SMB call site predates
   * this field and the enterprise path sets it explicitly.
   */
  segment?: "smb_local" | "enterprise_global";
  /**
   * ⛔ Why this message is about THIS person's job. Required for enterprise cold
   * outreach in every market, not only where a jurisdiction demands it.
   */
  roleRelevance?: string;
}

export type GateDecision =
  | { allow: true; obligations: Obligation[]; decisionId: string; jurisdiction: string; legalBasis: string; configVersion: string }
  | { allow: false; reason: DenyReason; ruleId: string; decisionId: string; configVersion: string };
