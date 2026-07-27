// Deterministic compliance logic: legal-basis resolution, obligations,
// required-elements, quiet-hours and injection-marker scanning. No model.
import { config, type JurisdictionRow } from "@adw/config";
import type {
  DomainClass,
  MessageClass,
  Obligation,
  OutboundMessage,
  SubscriberType,
} from "./types.ts";

export * from "./types.ts";

export interface JurisdictionResolution {
  configVersion: string;
  row: JurisdictionRow | undefined;
  enabled: boolean;
}

export function resolveJurisdiction(countryCode: string): JurisdictionResolution {
  const { data, version } = config.jurisdictions();
  const row = data.countries[countryCode];
  return { configVersion: version, row, enabled: row?.enabled ?? false };
}

/**
 * Resolve the legal basis for (country, subscriber_type, message_class).
 * Returns null when no basis applies (rule 4 denies). UK/IE require corporate.
 */
export function resolveLegalBasis(
  row: JurisdictionRow | undefined,
  subscriberType: SubscriberType,
): string | null {
  if (!row || !row.enabled) return null;
  if (row.subscriber_type_required) {
    // PECR corporate-only: unknown is not permission.
    if (subscriberType !== "corporate") return null;
  }
  return row.legal_basis;
}

export interface ProvenanceRequirement {
  required: boolean;
  maxAgeMonths: number;
  requiresNoCem: boolean;
  requiresRelatesToRole: boolean;
}

export function provenanceRequirement(row: JurisdictionRow): ProvenanceRequirement {
  return {
    required: row.provenance_required ?? false,
    maxAgeMonths: row.provenance_max_age_months ?? 24,
    requiresNoCem: row.requires_no_cem_statement ?? false,
    requiresRelatesToRole: row.requires_relates_to_role ?? false,
  };
}

/** Quiet-hours check: send window is weekdays within [start, end) recipient-local. */
export function withinSendWindow(row: JurisdictionRow, hour: number, weekday: number): boolean {
  const qh = row.quiet_hours ?? { start: 8, end: 18, tz: "recipient_local" };
  const isWeekday = weekday >= 1 && weekday <= 5;
  return isWeekday && hour >= qh.start && hour < qh.end;
}

/** Frequency cap: default 4 messages per 30 days. */
export function frequencyCap(row: JurisdictionRow): { count: number; window_days: number } {
  return row.frequency_cap ?? { count: 4, window_days: 30 };
}

/** Obligations returned on allow (spec §10.3). */
export function obligationsFor(messageClass: MessageClass, row: JurisdictionRow): Obligation[] {
  const base: Obligation[] = ["sender_identification", "privacy_notice_link"];
  if (messageClass === "cold" || messageClass === "preview_link") {
    base.push(
      "one_click_unsubscribe",
      "plaintext_unsubscribe_link",
      "physical_postal_address",
    );
    if (row.ai_disclosure && row.ai_disclosure !== "none") base.push("ai_disclosure");
  }
  return base;
}

/**
 * Required-elements check (spec §10.5). The transport must inject each
 * obligation *materially* — we check for literal header/body presence, never
 * `obligations.includes(...)`.
 */
export function requiredElementsPresent(
  msg: OutboundMessage,
  obligations: Obligation[],
): { ok: boolean; missing: Obligation[] } {
  const missing: Obligation[] = [];
  for (const ob of obligations) {
    switch (ob) {
      case "one_click_unsubscribe":
        if (!msg.headers["List-Unsubscribe"] || !msg.headers["List-Unsubscribe-Post"]) {
          missing.push(ob);
        }
        break;
      case "plaintext_unsubscribe_link":
        if (!/unsubscribe/i.test(msg.body)) missing.push(ob);
        break;
      case "physical_postal_address":
        // A postal address: look for a street-number + comma pattern or explicit marker.
        if (!/\d{1,5}\s+\S+.*,/.test(msg.body)) missing.push(ob);
        break;
      case "sender_identification":
        if (!msg.headers["From"]) missing.push(ob);
        break;
      case "ai_disclosure":
        if (!/\bAI\b/i.test(msg.body)) missing.push(ob);
        break;
      case "privacy_notice_link":
        if (!/privacy/i.test(msg.body)) missing.push(ob);
        break;
      case "acquirer_disclosure":
        break; // payments-only, checked elsewhere
    }
  }
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Injection-marker scan (spec §13.6). Cheap deterministic scan over content.
// ---------------------------------------------------------------------------
const INJECTION_MARKERS: RegExp[] = [
  /ignore (all )?(previous|prior) instructions/i,
  /disregard (the|your|all) (above|previous|system)/i,
  /system prompt/i,
  /you are now/i,
  /\bprint your (system )?prompt\b/i,
  /<\s*script/i,
  /\bdata:text\/html/i,
  /[​-‏‪-‮]/, // zero-width + bidi override marks
  /base64,[A-Za-z0-9+/]{40,}/,
];

export function scanForInjection(text: string): { flagged: boolean; marker?: string } {
  for (const re of INJECTION_MARKERS) {
    if (re.test(text)) return { flagged: true, marker: re.source.slice(0, 40) };
  }
  return { flagged: false };
}

/** Normalise text: strip zero-width and bidi-override characters (injection vector). */
export function normalizeText(text: string): string {
  return text.replace(/[​-‏‪-‮﻿]/g, "");
}

// ---------------------------------------------------------------------------
// Domain-class ↔ message-class rule (spec §1 one-way rule).
// ---------------------------------------------------------------------------
export function domainClassMatches(messageClass: MessageClass, domainClass: DomainClass): boolean {
  // Cold and preview-link mail rides burner domains; transactional rides brand.
  if (messageClass === "transactional") return domainClass === "brand";
  return domainClass === "burner";
}

// ---------------------------------------------------------------------------
// no-CEM detector (spec §6). Deterministic regex over page text.
// ---------------------------------------------------------------------------
const CEM_PATTERNS = [
  /no unsolicited/i,
  /do not (e-?mail|contact)/i,
  /no marketing/i,
  /keine werbung/i,
  /pas de démarchage/i,
  /no soliciting/i,
];
export const NO_CEM_DETECTOR_VERSION = "nocem-v1.0.0";

export function detectNoCem(pageText: string): boolean {
  // Returns TRUE when NO "do not email"-style statement is found.
  return !CEM_PATTERNS.some((re) => re.test(pageText));
}
