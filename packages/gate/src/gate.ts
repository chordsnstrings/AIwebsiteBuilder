// The Compliance Gate (spec §10). Deterministic code, no language model, fails
// closed. Twelve rules, evaluated in order, first denial wins. Every outbound
// path calls gate() — there is no second path. The decision is persisted to
// gate_decisions BEFORE any send is attempted.
import type { Db } from "@adw/db";
import {
  domainClassMatches,
  frequencyCap,
  obligationsFor,
  provenanceRequirement,
  requiredElementsPresent,
  resolveJurisdiction,
  resolveLegalBasis,
  scanForInjection,
  withinSendWindow,
  type DenyReason,
  type GateDecision,
  type OutboundMessage,
} from "@adw/compliance";
import { readEngagedSwitches, sendingHalted } from "./killswitch.ts";

export interface GateDeps {
  db: Db;
  now?: () => Date;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function gate(msg: OutboundMessage, deps: GateDeps): Promise<GateDecision> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const juris = resolveJurisdiction(msg.countryCode);
  const configVersion = juris.configVersion;

  // Helper to persist a decision row and return the typed result.
  async function decide(
    result:
      | { allow: true; obligations: ReturnType<typeof obligationsFor>; legalBasis: string }
      | { allow: false; reason: DenyReason; ruleId: string },
  ): Promise<GateDecision> {
    const row = await db.one<{ id: string }>(
      `INSERT INTO gate_decisions
        (allow, rule_id, reason, contact_hash, channel, message_class, jurisdiction, legal_basis, config_version, obligations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        result.allow,
        result.allow ? null : result.ruleId,
        result.allow ? null : result.reason,
        msg.emailHash,
        msg.channel,
        msg.messageClass,
        msg.countryCode,
        result.allow ? result.legalBasis : null,
        configVersion,
        result.allow ? JSON.stringify(result.obligations) : null,
      ],
    );
    if (result.allow) {
      return {
        allow: true,
        obligations: result.obligations,
        decisionId: row.id,
        jurisdiction: msg.countryCode,
        legalBasis: result.legalBasis,
        configVersion,
      };
    }
    return { allow: false, reason: result.reason, ruleId: result.ruleId, decisionId: row.id, configVersion };
  }

  // Rule 1 — kill switch.
  const engaged = await readEngagedSwitches(db, now.getTime());
  if (sendingHalted(engaged, msg.channel, msg.messageClass)) {
    return decide({ allow: false, reason: "KILL_SWITCH", ruleId: "rule_1_kill_switch" });
  }

  // Rule 2 — suppression on any channel for this identity.
  const suppressed = await db.maybeOne(
    `SELECT 1 AS x FROM suppression
     WHERE (email_hash = $1) OR ($2::bytea IS NOT NULL AND phone_hash = $2)
     LIMIT 1`,
    [msg.emailHash, msg.phoneHash ?? null],
  );
  if (suppressed) {
    return decide({ allow: false, reason: "SUPPRESSED", ruleId: "rule_2_suppression" });
  }

  // Rule 3 — market enabled for this campaign.
  if (!juris.enabled || !juris.row) {
    return decide({ allow: false, reason: "MARKET_NOT_ENABLED", ruleId: "rule_3_market" });
  }
  const row = juris.row;

  // Rule 4 — legal basis resolves.
  const legalBasis = resolveLegalBasis(row, msg.subscriberType);
  if (!legalBasis) {
    return decide({ allow: false, reason: "NO_LEGAL_BASIS", ruleId: "rule_4_legal_basis" });
  }

  // Rule 5 — provenance where required.
  const prov = provenanceRequirement(row);
  if (prov.required) {
    if (!msg.contactId) {
      return decide({ allow: false, reason: "PROVENANCE_MISSING", ruleId: "rule_5_provenance" });
    }
    const p = await db.maybeOne<{ retrieved_at: string; no_cem_statement: boolean; relates_to_role: boolean }>(
      `SELECT retrieved_at, no_cem_statement, relates_to_role
       FROM provenance WHERE contact_id = $1 ORDER BY retrieved_at DESC LIMIT 1`,
      [msg.contactId],
    );
    if (!p) {
      return decide({ allow: false, reason: "PROVENANCE_MISSING", ruleId: "rule_5_provenance" });
    }
    if (prov.requiresNoCem && !p.no_cem_statement) {
      return decide({ allow: false, reason: "PROVENANCE_MISSING", ruleId: "rule_5_provenance_no_cem" });
    }
    if (prov.requiresRelatesToRole && !p.relates_to_role) {
      return decide({ allow: false, reason: "PROVENANCE_MISSING", ruleId: "rule_5_provenance_role" });
    }
    const ageMs = now.getTime() - new Date(p.retrieved_at).getTime();
    if (ageMs > prov.maxAgeMonths * MONTH_MS) {
      return decide({ allow: false, reason: "PROVENANCE_STALE", ruleId: "rule_5_provenance_stale" });
    }
  }

  // Rule 6 — quiet hours (recipient local).
  //
  // ⛔ MARKETING CLASSES ONLY, on the same reasoning rule 8b spells out below:
  // "A customer who is being invoiced does not stop receiving their invoice
  // because a verifier had an opinion." Quiet hours exist so we do not solicit
  // strangers at night. They are not a reason to withhold a message a paying
  // customer is owed — and applied to `transactional` they did real damage in
  // two places:
  //
  //   • an enquiry notification ("someone just asked for an emergency callout
  //     and left their number") could only be delivered 08:00–18:00 Mon–Fri, so
  //     every evening and every weekend enquiry — the hours a trade business
  //     actually gets emergencies — was denied and the owner never heard;
  //   • `send_delivery_email` had to pass a hardcoded `localHour: 10,
  //     localWeekday: 2` to get out at all, which is not a fix but a lie told
  //     to the gate, and it is the shape of workaround that survives into
  //     production and then gets copied.
  //
  // `obligationsFor` already draws exactly this line between the marketing
  // classes and the rest; this makes rule 6 agree with it.
  if (msg.messageClass === "cold" || msg.messageClass === "preview_link") {
    const hour = msg.localHour ?? now.getUTCHours();
    const weekday = msg.localWeekday ?? now.getUTCDay();
    if (!withinSendWindow(row, hour, weekday)) {
      return decide({ allow: false, reason: "QUIET_HOURS", ruleId: "rule_6_quiet_hours" });
    }
  }

  // Rule 7 — frequency cap.
  const cap = frequencyCap(row);
  const since = new Date(now.getTime() - cap.window_days * 24 * 60 * 60 * 1000);
  const countRow = await db.one<{ n: string }>(
    `SELECT count(*) AS n FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     JOIN leads l ON l.id = c.lead_id
     JOIN contacts ct ON ct.id = l.contact_id
     WHERE ct.email_hash = $1 AND m.direction = 'outbound' AND m.sent_at >= $2`,
    [msg.emailHash, since],
  );
  if (Number(countRow.n) >= cap.count) {
    return decide({ allow: false, reason: "FREQUENCY_CAP", ruleId: "rule_7_frequency" });
  }

  // Rule 8 — sending asset health.
  if (msg.sendingAssetId) {
    const asset = await db.maybeOne<{ health: string }>(
      "SELECT health FROM sending_assets WHERE id = $1",
      [msg.sendingAssetId],
    );
    // 'warn' is allowed; 'throttled'/'halted'/'retired'/'warming' are not.
    if (!asset || !(asset.health === "healthy" || asset.health === "warn")) {
      return decide({ allow: false, reason: "ASSET_UNHEALTHY", ruleId: "rule_8_asset_health" });
    }
  }

  // Rule 8b — the recipient is deliverable.
  //
  // ⛔ The system had NO pre-send verification of any kind: no MX check, no
  // disposable-domain check, no role-account detection, and no adapter behind
  // the `email_verification` vault slot that DEPLOYMENT.md claimed flipped it
  // live. Cold mail went out with nothing between it and a dead mailbox.
  //
  // A bounce is not a wasted send, it is a deposit against the sending domain's
  // reputation. At the configured 2.0% halt threshold a list with 5% dead
  // addresses retires a domain that took 21 days to warm up, and a warm-up
  // cannot be compressed. So this is a gate rule, at the chokepoint, rather
  // than a courtesy check somewhere upstream that a new code path can forget.
  //
  // It applies to COLD mail only. A customer who is being invoiced does not stop
  // receiving their invoice because a verifier had an opinion.
  if (msg.messageClass === "cold" && msg.contactId) {
    const c = await db.maybeOne<{ verification: string; verified_at: string | null }>(
      "SELECT verification, verified_at FROM contacts WHERE id = $1",
      [msg.contactId],
    );
    // ⛔ `unknown` is ALLOWED and `invalid` is not. Denying on unknown would
    // halt the entire programme the first time a verifier had an outage — the
    // verifier answers `unknown` rather than throwing precisely so that the
    // policy for "we could not check" is decided here, once, in the open.
    if (c && c.verification === "invalid") {
      return decide({ allow: false, reason: "UNVERIFIED_RECIPIENT", ruleId: "rule_8b_deliverability" });
    }
  }

  // Rule 8c — enterprise cold outreach is about the recipient's actual job.
  //
  // ⛔ Applies in EVERY market, not only where `requires_relates_to_role` is set
  // in jurisdictions.yaml. The enterprise track never routes through
  // `send_outreach` at all — it produces an approved business case instead — so
  // reaching this rule at all means something has routed an enterprise contact
  // down the SMB path, and failing closed there is the whole point of having a
  // gate rather than a policy.
  //
  // A named individual inside a governed organisation is a different recipient
  // from a sole trader who published their address to get work. We must be able
  // to state, before sending, why the message concerns their role.
  if (msg.messageClass === "cold" && msg.segment === "enterprise_global") {
    if (typeof msg.roleRelevance !== "string" || msg.roleRelevance.trim().length === 0) {
      return decide({ allow: false, reason: "NO_ROLE_RELEVANCE", ruleId: "rule_8c_role_relevance" });
    }
  }

  // Rule 9 — domain class matches message class (the one-way rule).
  if (!domainClassMatches(msg.messageClass, msg.domainClass)) {
    return decide({ allow: false, reason: "DOMAIN_CLASS_MISMATCH", ruleId: "rule_9_domain_class" });
  }

  // Rule 10 — required elements present.
  const obligations = obligationsFor(msg.messageClass, row);
  const elems = requiredElementsPresent(msg, obligations);
  if (!elems.ok) {
    return decide({ allow: false, reason: "MISSING_REQUIRED_ELEMENT", ruleId: "rule_10_required_elements" });
  }

  // Rule 11 — content injection scan.
  const scan = scanForInjection(msg.body);
  if (scan.flagged) {
    return decide({ allow: false, reason: "CONTENT_UNSAFE", ruleId: "rule_11_content_scan" });
  }

  // Rule 12 — idempotency key unused.
  const dup = await db.maybeOne("SELECT 1 AS x FROM messages WHERE idempotency_key = $1", [
    msg.idempotencyKey,
  ]);
  if (dup) {
    return decide({ allow: false, reason: "DUPLICATE_SEND", ruleId: "rule_12_idempotency" });
  }

  return decide({ allow: true, obligations, legalBasis });
}
