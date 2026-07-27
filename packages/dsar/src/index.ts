// Subject access requests and erasure (spec §9.2–9.3). A single
// `dsarExport(identity)` assembles every record we hold about a person into a
// signed archive with a manifest — runnable from the operator console with no
// code changes, target under 10 minutes.
//
// The erasure algorithm is deliberately partial and that is the point: the
// email_hash, the suppression row and the provenance evidence SURVIVE an
// erasure request, because deleting them would mean re-contacting someone who
// asked us to stop and losing the evidence that the original contact was
// lawful. The privacy notice states this explicitly.
import { createHash, createHmac } from "node:crypto";
import { emailHash, type Db } from "@adw/db";

export interface DsarSection {
  name: string;
  rows: Record<string, unknown>[];
}

export interface DsarManifest {
  identity: string;
  identityHash: string;
  generatedAt: string;
  sections: { name: string; rowCount: number }[];
  totalRows: number;
  retentionNotes: string[];
  signature: string;
}

export interface DsarArchive {
  manifest: DsarManifest;
  sections: DsarSection[];
  /** Serialised archive content (the bytes that would be zipped). */
  content: string;
}

const RETENTION_NOTES = [
  "Provenance evidence (source URL, retrieval timestamp, screenshot) is retained for 7 years and survives an erasure request — it is the lawful-basis evidence for the original contact.",
  "Suppression records are retained indefinitely and survive an erasure request — deleting one would mean contacting you again.",
  "Gate decisions are retained for 7 years as a compliance record.",
  "Message bodies are purged on erasure; metadata and hashes are retained.",
];

/** Assemble every record held about an identity (an email address). */
export async function dsarExport(db: Db, identity: string, now = new Date()): Promise<DsarArchive> {
  const hash = emailHash(identity);
  const sections: DsarSection[] = [];

  const push = async (name: string, sql: string, params: unknown[]) => {
    const res = await db.query<Record<string, unknown>>(sql, params);
    sections.push({ name, rows: res.rows });
  };

  await push(
    "contacts",
    `SELECT c.id, c.email, c.verification, c.verified_at, c.role_inferred, c.subscriber_type, c.created_at,
            b.name AS business_name, b.category, b.city, b.country_code
     FROM contacts c JOIN businesses b ON b.id = c.business_id
     WHERE c.email_hash = $1`,
    [hash],
  );

  await push(
    "provenance",
    `SELECT p.source_url, p.retrieved_at, p.screenshot_r2_key, p.no_cem_statement,
            p.relates_to_role, p.legal_basis, p.detector_version
     FROM provenance p JOIN contacts c ON c.id = p.contact_id
     WHERE c.email_hash = $1 ORDER BY p.retrieved_at DESC`,
    [hash],
  );

  await push(
    "messages",
    `SELECT m.id, m.direction, m.channel, m.subject, m.body_hash, m.sent_at, m.delivered_at,
            m.opened_at, m.replied_at, m.bounced_at, m.complained_at, m.gate_decision_id
     FROM messages m
     JOIN conversations cv ON cv.id = m.conversation_id
     JOIN leads l ON l.id = cv.lead_id
     JOIN contacts c ON c.id = l.contact_id
     WHERE c.email_hash = $1 ORDER BY m.sent_at`,
    [hash],
  );

  await push(
    "gate_decisions",
    `SELECT id, decided_at, allow, rule_id, reason, channel, message_class, jurisdiction,
            legal_basis, config_version, obligations
     FROM gate_decisions WHERE contact_hash = $1 ORDER BY decided_at DESC`,
    [hash],
  );

  await push(
    "suppression",
    "SELECT reason, channel_scope, suppressed_at FROM suppression WHERE email_hash = $1",
    [hash],
  );

  await push(
    "leads",
    `SELECT l.id, l.state, l.score, l.sequence_step, l.entered_state_at, l.cooldown_until
     FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.email_hash = $1`,
    [hash],
  );

  await push(
    "customer",
    `SELECT id, legal_name, contact_email, region_code, locale, status, won_at, cancelled_at
     FROM customers WHERE contact_email = $1`,
    [identity],
  );

  await push(
    "subscriptions",
    `SELECT s.id, s.plan_code, s.billing_interval, s.amount_cents, s.currency, s.status,
            s.current_period_end, s.started_at
     FROM subscriptions s JOIN customers cu ON cu.id = s.customer_id
     WHERE cu.contact_email = $1`,
    [identity],
  );

  await push(
    "invoices",
    `SELECT i.id, i.amount_cents, i.currency, i.status, i.issued_at, i.paid_at
     FROM invoices i JOIN customers cu ON cu.id = i.customer_id
     WHERE cu.contact_email = $1`,
    [identity],
  );

  await push(
    "builds",
    `SELECT bl.id, bl.mode, bl.first_pass, bl.escalation_depth, bl.deployed_url, bl.created_at
     FROM builds bl JOIN customers cu ON cu.id = bl.customer_id
     WHERE cu.contact_email = $1`,
    [identity],
  );

  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
  const content = JSON.stringify({ identity, generatedAt: now.toISOString(), sections }, null, 2);

  const manifest: DsarManifest = {
    identity,
    identityHash: hash.toString("hex"),
    generatedAt: now.toISOString(),
    sections: sections.map((s) => ({ name: s.name, rowCount: s.rows.length })),
    totalRows,
    retentionNotes: RETENTION_NOTES,
    signature: signArchive(content),
  };

  return { manifest, sections, content };
}

/** HMAC signature over the archive so a recipient can verify integrity. */
export function signArchive(content: string, key = process.env.ADW_DSAR_SIGNING_KEY ?? "demo-dsar-key"): string {
  return "sha256:" + createHmac("sha256", key).update(content).digest("hex");
}

export function verifyArchive(content: string, signature: string, key?: string): boolean {
  return signArchive(content, key) === signature;
}

export interface ErasureResult {
  contactsNulled: number;
  messageBodiesPurged: number;
  provenanceRetained: number;
  suppressionRetained: number;
}

/**
 * Erasure (spec §9.2). Nulls the identifying fields and purges message bodies,
 * while retaining the email_hash, suppression and provenance evidence. Runs in
 * a transaction. Note the append-only tables reject UPDATE/DELETE at the
 * database layer — we never attempt to modify them.
 */
export async function erase(db: Db, identity: string): Promise<ErasureResult> {
  const hash = emailHash(identity);
  return db.tx(async (tx) => {
    const prov = await tx.one<{ n: string }>(
      "SELECT count(*) AS n FROM provenance p JOIN contacts c ON c.id = p.contact_id WHERE c.email_hash = $1",
      [hash],
    );
    const supp = await tx.one<{ n: string }>("SELECT count(*) AS n FROM suppression WHERE email_hash = $1", [hash]);

    // Purge message bodies (the R2 object would also be deleted by the caller);
    // metadata and hashes are retained.
    const msgs = await tx.query(
      `UPDATE messages m SET body_r2_key = 'purged', subject = NULL
       FROM conversations cv, leads l, contacts c
       WHERE m.conversation_id = cv.id AND cv.lead_id = l.id AND l.contact_id = c.id
         AND c.email_hash = $1 AND m.body_r2_key <> 'purged'`,
      [hash],
    );

    // Null the identifying contact fields; email_hash is retained deliberately.
    const contacts = await tx.query(
      "UPDATE contacts SET email = concat('erased+', id, '@invalid'), role_inferred = NULL WHERE email_hash = $1",
      [hash],
    );

    return {
      contactsNulled: contacts.rowCount,
      messageBodiesPurged: msgs.rowCount,
      provenanceRetained: Number(prov.n),
      suppressionRetained: Number(supp.n),
    };
  });
}

/** Stable content hash of an archive, for audit logging. */
export function archiveHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
