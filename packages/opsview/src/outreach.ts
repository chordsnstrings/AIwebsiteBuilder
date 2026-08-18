// Who ADW has reached out to, and what happened.
//
// ⛔ 676 businesses, 280 contacts, 228 leads, 125 gate decisions, 69 messages,
// 55 previews and 62 suppressions existed in the database with NO operator
// surface of any kind. The console had an "Acquisition" view covering the 33
// enterprise clusters and nothing at all for the SMB motion, which is the
// entire business.
//
// ⛔ The funnel below reports COUNTS AT EACH STAGE, not conversion percentages
// alone. A 12% preview-to-claim rate means one thing over 500 previews and
// nothing at all over 8, and this is a system whose whole compliance posture
// rests on being able to say exactly how many people were contacted and on what
// legal basis.

import type { Db } from "@adw/db";

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** What table and condition produced the number, shown on the screen. */
  source: string;
  /**
   * Share of the PREVIOUS stage, not of the top of the funnel. Null for the
   * first stage and whenever the previous stage is zero — a rate over an empty
   * denominator is undefined, not 0%.
   */
  ofPrevious: number | null;
  /** Share of the top of the funnel — the number an operator quotes. */
  ofCohort: number | null;
  /**
   * The stage this one must be a subset of, if any.
   *
   * ⛔ Declared per stage rather than assumed to be "the row above". The real
   * process is not a single chain: a business can claim a preview without ever
   * replying to an email, and a gate decision does not require a preview to
   * exist. Comparing each stage to its predecessor by position flagged three
   * perfectly legitimate states as impossible, which would have taught an
   * operator to ignore the flag before it ever caught a real one.
   */
  subsetOf: string | null;
  /**
   * ⛔ True when this stage is larger than the stage it must be a subset of.
   * That is a genuine defect — a join is wrong or a population leaked in — and
   * the most load-bearing one is `sent` exceeding `gate_allowed`, which would
   * mean a message left the system without a gate decision behind it.
   */
  violatesSubset: boolean;
}

export interface OutreachFunnel {
  stages: FunnelStage[];
  windowDays: number | null;
  asOf: Date;
}

/**
 * The SMB funnel, as a COHORT.
 *
 * ⛔ Every stage counts DISTINCT BUSINESSES that reached it, out of the same
 * starting population. This is not a stylistic choice — the first version
 * counted each stage's own table (contacts, leads, messages, customers) and
 * produced "contacts 583% of previous" and "customers won 2,687% of previous",
 * because those are independent populations and not subsets of one another.
 *
 * A funnel whose stages are not nested is not a funnel, and a percentage
 * derived from one is worse than no percentage: it is confident, precise and
 * meaningless. Counted this way the numbers are monotonically decreasing by
 * construction, and a stage that ISN'T smaller than the one above it is a real
 * defect the screen will now show rather than hide.
 */
export async function outreachFunnel(db: Db, now: Date): Promise<OutreachFunnel> {
  const defs: { key: string; label: string; sql: string; source: string; subsetOf?: string }[] = [
    {
      key: "ingested", label: "Businesses ingested",
      sql: "SELECT count(*) AS n FROM businesses",
      source: "businesses — the cohort every stage below is measured against",
    },
    {
      key: "provenanced", label: "…with provenance captured", subsetOf: "ingested",
      sql: `SELECT count(DISTINCT c.business_id) AS n
              FROM provenance p JOIN contacts c ON c.id = p.contact_id`,
      source: "businesses having at least one contact with a provenance row — none may lawfully be contacted without it",
    },
    {
      key: "contacted", label: "…with a contact identified", subsetOf: "ingested",
      sql: "SELECT count(DISTINCT business_id) AS n FROM contacts",
      source: "businesses having at least one addressable person",
    },
    {
      key: "leads", label: "…enrolled as a lead", subsetOf: "contacted",
      sql: `SELECT count(DISTINCT c.business_id) AS n
              FROM leads l JOIN contacts c ON c.id = l.contact_id`,
      source: "businesses with at least one contact entered into a campaign",
    },
    {
      key: "previews", label: "…given a preview", subsetOf: "ingested",
      sql: "SELECT count(DISTINCT business_id) AS n FROM previews",
      source: "businesses with a speculative site built — SMB only, never enterprise",
    },
    {
      key: "gate_allowed", label: "…cleared by the gate", subsetOf: "contacted",
      sql: `SELECT count(DISTINCT c.business_id) AS n
              FROM gate_decisions g JOIN contacts c ON c.email_hash = g.contact_hash
             WHERE g.allow = true`,
      source: "businesses with at least one allowed gate decision — the only route to transport",
    },
    {
      // ⛔ Must be a subset of gate_allowed. A business sent to without an
      // allowed gate decision is the single worst invariant breach in this
      // system — it means transport happened outside the only route to it.
      key: "sent", label: "…actually sent to", subsetOf: "gate_allowed",
      sql: `SELECT count(DISTINCT c.business_id) AS n
              FROM messages m
              JOIN conversations cv ON cv.id = m.conversation_id
              JOIN leads l ON l.id = cv.lead_id
              JOIN contacts c ON c.id = l.contact_id
             WHERE m.sent_at IS NOT NULL`,
      source: "businesses that received at least one message that left the system",
    },
    {
      key: "replied", label: "…who replied", subsetOf: "sent",
      sql: `SELECT count(DISTINCT c.business_id) AS n
              FROM messages m
              JOIN conversations cv ON cv.id = m.conversation_id
              JOIN leads l ON l.id = cv.lead_id
              JOIN contacts c ON c.id = l.contact_id
             WHERE m.direction = 'inbound'`,
      source: "businesses with at least one inbound message — a real reply, not an open",
    },
    {
      key: "claimed", label: "…who claimed their preview", subsetOf: "previews",
      sql: "SELECT count(DISTINCT business_id) AS n FROM previews WHERE claimed_at IS NOT NULL",
      source: "businesses whose owner took control of the speculative site",
    },
    {
      key: "customers", label: "…who became customers", subsetOf: "ingested",
      sql: "SELECT count(DISTINCT business_id) AS n FROM customers WHERE won_at IS NOT NULL",
      source: "businesses with a won subscription",
    },
  ];

  const stages: FunnelStage[] = [];
  const byKey = new Map<string, number>();
  let previous: number | null = null;
  let top: number | null = null;
  for (const d of defs) {
    let count = 0;
    let source = d.source;
    try {
      count = Number((await db.one<{ n: string }>(d.sql)).n);
    } catch (err) {
      // ⛔ A stage whose query failed reports the failure rather than zero. Zero
      // at the top of a funnel reads as "nobody was contacted", which is the
      // most reassuring possible rendering of a broken query.
      source = `QUERY FAILED: ${err instanceof Error ? err.message : String(err)}`;
      count = -1;
    }
    const parent = d.subsetOf === undefined ? null : (byKey.get(d.subsetOf) ?? null);
    stages.push({
      key: d.key,
      label: d.label,
      count,
      source,
      ofPrevious: previous === null || previous === 0 || count < 0 ? null : count / previous,
      ofCohort: top === null || top === 0 || count < 0 ? null : count / top,
      subsetOf: d.subsetOf ?? null,
      violatesSubset: parent !== null && count >= 0 && count > parent,
    });
    if (count >= 0) {
      byKey.set(d.key, count);
      previous = count;
      if (top === null) top = count;
    }
  }
  return { stages, windowDays: null, asOf: now };
}

// ── Gate denials: why sends did not happen ────────────────────────────────

export interface DenialReason {
  ruleId: string;
  reason: string;
  count: number;
}

export interface GateSummary {
  total: number;
  allowed: number;
  denied: number;
  /** ⛔ Null when nothing was ever evaluated. */
  denialRate: number | null;
  reasons: DenialReason[];
  asOf: Date;
}

/**
 * ⛔ Denials broken down by RULE. "We denied 40%" is not actionable; "we denied
 * 40% and 90% of that was PROVENANCE_STALE" tells an operator to go and refresh
 * provenance. The gate's whole value is that it says which rule fired.
 */
export async function gateSummary(db: Db, now: Date): Promise<GateSummary> {
  const totals = await db.one<{ total: string; allowed: string }>(
    "SELECT count(*) AS total, count(*) FILTER (WHERE allow) AS allowed FROM gate_decisions",
  );
  const reasons = await db.query<{ rule_id: string | null; reason: string | null; n: string }>(
    `SELECT rule_id, reason, count(*) AS n FROM gate_decisions
      WHERE allow = false GROUP BY rule_id, reason ORDER BY n DESC`,
  );
  const total = Number(totals.total);
  const allowed = Number(totals.allowed);
  return {
    total,
    allowed,
    denied: total - allowed,
    denialRate: total === 0 ? null : (total - allowed) / total,
    reasons: reasons.rows.map((r) => ({
      ruleId: r.rule_id ?? "(no rule recorded)",
      reason: r.reason ?? "(no reason recorded)",
      count: Number(r.n),
    })),
    asOf: now,
  };
}

// ── The business list, and one business in full ───────────────────────────

export interface BusinessRow {
  id: string;
  name: string;
  vertical: string | null;
  category: string | null;
  segment: string;
  countryCode: string;
  regionCode: string;
  city: string | null;
  websiteUrl: string | null;
  ingestedAt: Date;
  hasProvenance: boolean;
  contacts: number;
  leads: number;
  messagesSent: number;
  gateAllowed: number;
  gateDenied: number;
  hasPreview: boolean;
  previewClaimed: boolean;
  isCustomer: boolean;
  /** Any contact of this business is on the suppression list. */
  suppressed: boolean;
}

export interface BusinessBoard {
  rows: BusinessRow[];
  total: number;
  /** ⛔ Businesses with no provenance row — none of them may lawfully be contacted. */
  withoutProvenance: number;
  asOf: Date;
}

export async function businessBoard(
  db: Db,
  now: Date,
  opts: { q?: string | undefined; id?: string | undefined; limit?: number | undefined } = {},
): Promise<BusinessBoard> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const q = (opts.q ?? "").trim();
  const params: unknown[] = [];
  const clauses: string[] = [];
  // ⛔ An id filter, so the detail page can fetch ONE business by identity.
  // Without it the detail had to page through the list and hope its subject was
  // in the first few hundred rows — which for the 676th business it would not
  // have been.
  if (opts.id !== undefined) {
    params.push(opts.id);
    clauses.push(`b.id = $${params.length}::uuid`);
  }
  if (q !== "") {
    params.push(`%${q}%`);
    clauses.push(`(b.name ILIKE $${params.length} OR b.website_url ILIKE $${params.length})`);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  params.push(limit);

  const rows = await db.query<{
    id: string; name: string; vertical: string | null; category: string | null; segment: string;
    country_code: string; region_code: string; city: string | null; website_url: string | null;
    ingested_at: Date; has_provenance: boolean; contacts: string; leads: string;
    messages_sent: string; gate_allowed: string; gate_denied: string;
    has_preview: boolean; preview_claimed: boolean; is_customer: boolean; suppressed: boolean;
  }>(
    `SELECT b.id, b.name, b.vertical, b.category, b.segment, b.country_code, b.region_code,
            b.city, b.website_url, b.ingested_at,
            EXISTS (SELECT 1 FROM provenance p JOIN contacts pc ON pc.id = p.contact_id
                     WHERE pc.business_id = b.id)                                     AS has_provenance,
            COALESCE(c.n, 0)                                                      AS contacts,
            COALESCE(l.n, 0)                                                      AS leads,
            COALESCE(m.sent, 0)                                                   AS messages_sent,
            COALESCE(g.allowed, 0)                                                AS gate_allowed,
            COALESCE(g.denied, 0)                                                 AS gate_denied,
            EXISTS (SELECT 1 FROM previews pv WHERE pv.business_id = b.id)         AS has_preview,
            EXISTS (SELECT 1 FROM previews pv WHERE pv.business_id = b.id AND pv.claimed_at IS NOT NULL) AS preview_claimed,
            EXISTS (SELECT 1 FROM customers cu WHERE cu.business_id = b.id)        AS is_customer,
            COALESCE(s.suppressed, false)                                          AS suppressed
       FROM businesses b
       LEFT JOIN LATERAL (SELECT count(*) AS n FROM contacts WHERE business_id = b.id) c ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM leads le
          JOIN contacts co ON co.id = le.contact_id WHERE co.business_id = b.id
       ) l ON true
       -- ⛔ conversations hang off the LEAD, not the contact, so the path to a
       -- business is messages -> conversations -> leads -> contacts.
       LEFT JOIN LATERAL (
         SELECT count(*) AS sent FROM messages ms
          JOIN conversations cv ON cv.id = ms.conversation_id
          JOIN leads le ON le.id = cv.lead_id
          JOIN contacts co ON co.id = le.contact_id
          WHERE co.business_id = b.id
       ) m ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE gd.allow) AS allowed,
                count(*) FILTER (WHERE NOT gd.allow) AS denied
           FROM gate_decisions gd
           JOIN contacts co ON co.email_hash = gd.contact_hash
          WHERE co.business_id = b.id
       ) g ON true
       LEFT JOIN LATERAL (
         SELECT true AS suppressed FROM suppression su
          JOIN contacts co ON co.email_hash = su.email_hash
          WHERE co.business_id = b.id LIMIT 1
       ) s ON true
       ${where}
      ORDER BY b.ingested_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const totals = await db.one<{ n: string; no_prov: string }>(
    `SELECT count(*) AS n,
            count(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM provenance p JOIN contacts pc ON pc.id = p.contact_id
               WHERE pc.business_id = businesses.id)) AS no_prov
       FROM businesses`,
  );

  return {
    rows: rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      vertical: r.vertical,
      category: r.category,
      segment: r.segment,
      countryCode: r.country_code,
      regionCode: r.region_code,
      city: r.city,
      websiteUrl: r.website_url,
      ingestedAt: new Date(r.ingested_at),
      hasProvenance: r.has_provenance,
      contacts: Number(r.contacts),
      leads: Number(r.leads),
      messagesSent: Number(r.messages_sent),
      gateAllowed: Number(r.gate_allowed),
      gateDenied: Number(r.gate_denied),
      hasPreview: r.has_preview,
      previewClaimed: r.preview_claimed,
      isCustomer: r.is_customer,
      suppressed: r.suppressed,
    })),
    total: Number(totals.n),
    withoutProvenance: Number(totals.no_prov),
    asOf: now,
  };
}

export interface BusinessDetail {
  business: BusinessRow;
  contacts: {
    id: string;
    emailHash: string;
    verification: string | null;
    subscriberType: string | null;
    suppressed: boolean;
    suppressionReason: string | null;
  }[];
  /**
   * ⛔ Every send attempt with the gate's verdict and the rule behind it,
   * allowed AND denied. A page that shows only what was sent cannot answer the
   * question a regulator actually asks, which is "what did you decide about
   * this person, and why".
   */
  decisions: {
    id: string;
    allow: boolean;
    /** ⛔ WHICH RULE fired. "Denied" without the rule is not an explanation. */
    ruleId: string | null;
    reason: string | null;
    channel: string | null;
    messageClass: string | null;
    jurisdiction: string | null;
    legalBasis: string | null;
    decidedAt: Date;
    configVersion: string | null;
  }[];
  messages: {
    id: string;
    direction: string | null;
    subject: string | null;
    sentAt: Date | null;
    gateDecisionId: string | null;
  }[];
  provenance: {
    id: string; retrievedAt: Date; legalBasis: string | null; sourceUrl: string | null;
    noCemStatement: boolean | null; reviewedBy: string | null;
  }[];
  previews: {
    id: string; generatedAt: Date; claimedAt: Date | null; deployUrl: string | null;
    expiresAt: Date | null; takedownAt: Date | null;
  }[];
  asOf: Date;
}

export async function businessDetail(db: Db, businessId: string, now: Date): Promise<BusinessDetail | null> {
  // Reuses the board's own query so the list and the detail can never disagree
  // about what "suppressed" or "messages sent" means for the same business.
  const board = await businessBoard(db, now, { id: businessId, limit: 1 });
  const business = board.rows[0];
  if (business === undefined) return null;

  const contacts = await db.query<{
    id: string; email_hash: string; verification: string | null; subscriber_type: string | null;
    suppressed: boolean; suppression_reason: string | null;
  }>(
    `SELECT c.id, c.email_hash, c.verification, c.subscriber_type,
            s.email_hash IS NOT NULL AS suppressed, s.reason AS suppression_reason
       FROM contacts c
       LEFT JOIN suppression s ON s.email_hash = c.email_hash
      WHERE c.business_id = $1 ORDER BY c.id`,
    [businessId],
  );

  const decisions = await db.query<{
    id: string; allow: boolean; rule_id: string | null; reason: string | null;
    channel: string | null; message_class: string | null; jurisdiction: string | null;
    legal_basis: string | null; decided_at: Date; config_version: string | null;
  }>(
    `SELECT gd.id, gd.allow, gd.rule_id, gd.reason, gd.channel, gd.message_class,
            gd.jurisdiction, gd.legal_basis, gd.decided_at, gd.config_version
       FROM gate_decisions gd
       JOIN contacts c ON c.email_hash = gd.contact_hash
      WHERE c.business_id = $1 ORDER BY gd.decided_at DESC LIMIT 200`,
    [businessId],
  );

  const messages = await db.query<{
    id: string; direction: string | null; subject: string | null; sent_at: Date | null; gate_decision_id: string | null;
  }>(
    `SELECT m.id, m.direction, m.subject, m.sent_at, m.gate_decision_id
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       JOIN leads le ON le.id = cv.lead_id
       JOIN contacts c ON c.id = le.contact_id
      WHERE c.business_id = $1 ORDER BY m.sent_at DESC NULLS LAST LIMIT 200`,
    [businessId],
  );

  const provenance = await db.query<{
    id: string; retrieved_at: Date; legal_basis: string | null; source_url: string | null;
    no_cem_statement: boolean | null; reviewed_by: string | null;
  }>(
    `SELECT p.id, p.retrieved_at, p.legal_basis, p.source_url, p.no_cem_statement, p.reviewed_by
       FROM provenance p JOIN contacts c ON c.id = p.contact_id
      WHERE c.business_id = $1 ORDER BY p.retrieved_at DESC`,
    [businessId],
  );

  const previews = await db.query<{
    id: string; generated_at: Date; claimed_at: Date | null; deploy_url: string | null;
    expires_at: Date | null; takedown_at: Date | null;
  }>(
    `SELECT id, generated_at, claimed_at, deploy_url, expires_at, takedown_at
       FROM previews WHERE business_id = $1 ORDER BY generated_at DESC`,
    [businessId],
  );

  return {
    business,
    contacts: contacts.rows.map((c) => ({
      id: c.id,
      emailHash: c.email_hash,
      verification: c.verification,
      subscriberType: c.subscriber_type,
      suppressed: c.suppressed,
      suppressionReason: c.suppression_reason,
    })),
    decisions: decisions.rows.map((d) => ({
      id: d.id,
      allow: d.allow,
      ruleId: d.rule_id,
      reason: d.reason,
      channel: d.channel,
      messageClass: d.message_class,
      jurisdiction: d.jurisdiction,
      legalBasis: d.legal_basis,
      decidedAt: new Date(d.decided_at),
      configVersion: d.config_version,
    })),
    messages: messages.rows.map((m) => ({
      id: m.id,
      direction: m.direction,
      subject: m.subject,
      sentAt: m.sent_at === null ? null : new Date(m.sent_at),
      gateDecisionId: m.gate_decision_id,
    })),
    provenance: provenance.rows.map((p) => ({
      id: p.id,
      retrievedAt: new Date(p.retrieved_at),
      legalBasis: p.legal_basis,
      sourceUrl: p.source_url,
      noCemStatement: p.no_cem_statement,
      reviewedBy: p.reviewed_by,
    })),
    previews: previews.rows.map((p) => ({
      id: p.id,
      generatedAt: new Date(p.generated_at),
      claimedAt: p.claimed_at === null ? null : new Date(p.claimed_at),
      deployUrl: p.deploy_url,
      expiresAt: p.expires_at === null ? null : new Date(p.expires_at),
      takedownAt: p.takedown_at === null ? null : new Date(p.takedown_at),
    })),
    asOf: now,
  };
}
