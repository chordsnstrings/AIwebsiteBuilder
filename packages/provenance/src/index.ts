// Provenance pipeline (spec §6). Runs at ingestion, before a contact is eligible
// for any campaign. Deterministic code — the enrichment agent does not touch
// this. In Canada/Australia the implied-consent defence exists only if this
// evidence exists, so a fetch/screenshot failure is never treated as a pass.
import { detectNoCem, NO_CEM_DETECTOR_VERSION, type SubscriberType } from "@adw/compliance";
import { emailHash, type Db } from "@adw/db";
import { emit } from "@adw/telemetry";

export interface EmailVerifier {
  verify(email: string): Promise<"valid" | "risky" | "invalid" | "unknown">;
}

export interface PageFetcher {
  // Fetch the published source page; returns null if it cannot be retrieved.
  fetch(url: string): Promise<{ text: string; screenshot: Buffer } | null>;
}

export interface ObjectStore {
  put(key: string, data: Buffer): Promise<void>;
}

export interface RegistryClassification {
  readonly subscriberType: SubscriberType;
  /** Evidence for the answer — `suffix:ltd`, `companies_house:12345678`, … */
  readonly ref: string | null;
}

export interface RegistryLookup {
  // Classify subscriber type for UK/IE (corporate vs sole trader).
  classify(businessName: string, countryCode: string): Promise<RegistryClassification>;
}

export interface ProvenanceDeps {
  db: Db;
  verifier: EmailVerifier;
  fetcher: PageFetcher;
  store: ObjectStore;
  registry: RegistryLookup;
  now?: () => Date;
}

export interface IngestRecord {
  businessId: string;
  email: string;
  sourceUrl: string;
  category: string;
  countryCode: string;
  businessName: string;
}

export type IngestOutcome =
  | { status: "accepted"; contactId: string; eligible: "all" | "opt_out_only" }
  | { status: "rejected"; reason: "invalid_email" | "duplicate" }
  | { status: "provenance_failed"; contactId: string; eligible: "opt_out_only" };

const RELATES_ROLE_CATEGORIES = new Set([
  "trades",
  "personal_services",
  "food_hospitality",
  "automotive",
  "professional_services",
  "retail",
]);

function legalBasisFor(countryCode: string): string {
  switch (countryCode) {
    case "CA": return "casl_10_9";
    case "AU": return "spam_act_sch2";
    case "NZ": return "uem_inferred";
    case "GB":
    case "IE": return "pecr_corporate";
    case "BR": return "lgpd_legit_interest";
    default: return "can_spam_optout";
  }
}

/** Ingest one record through the full provenance pipeline. */
export async function ingestRecord(rec: IngestRecord, deps: ProvenanceDeps): Promise<IngestOutcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const hash = emailHash(rec.email);

  // Dedupe on email_hash.
  const existing = await db.maybeOne<{ id: string }>(
    "SELECT c.id FROM contacts c WHERE c.email_hash = $1 AND c.business_id = $2",
    [hash, rec.businessId],
  );
  if (existing) return { status: "rejected", reason: "duplicate" };

  // Email verification — drop invalid.
  const verification = await deps.verifier.verify(rec.email);
  if (verification === "invalid") {
    await emit({ eventType: "ingest.record.rejected", payload: { reason: "invalid_email" } });
    return { status: "rejected", reason: "invalid_email" };
  }

  // Subscriber-type classification (UK/IE need it for the legal basis).
  const needsRegistry = rec.countryCode === "GB" || rec.countryCode === "IE";
  const classification: RegistryClassification = needsRegistry
    ? await deps.registry.classify(rec.businessName, rec.countryCode)
    : { subscriberType: "unknown", ref: null };

  const contact = await db.one<{ id: string }>(
    `INSERT INTO contacts (business_id, email, email_hash, verification, verified_at, subscriber_type, registry_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id, email) DO UPDATE SET verification = EXCLUDED.verification
     RETURNING id`,
    [rec.businessId, rec.email, hash, verification, now, classification.subscriberType, classification.ref],
  );

  // Fetch + screenshot the published source page.
  const page = await deps.fetcher.fetch(rec.sourceUrl);
  if (!page) {
    // Do not treat a failure as a pass — opt-out markets only (currently US).
    await emit({ eventType: "provenance.failed", subject: { kind: "contact", id: contact.id }, payload: { url: rec.sourceUrl } });
    return { status: "provenance_failed", contactId: contact.id, eligible: "opt_out_only" };
  }

  const r2Key = `prov/${now.getUTCFullYear()}/${now.getUTCMonth() + 1}/${now.getUTCDate()}/${hash.toString("hex").slice(0, 16)}.png`;
  await deps.store.put(r2Key, page.screenshot);

  const noCem = detectNoCem(page.text);
  const relatesToRole = RELATES_ROLE_CATEGORIES.has(rec.category);

  await db.query(
    `INSERT INTO provenance
      (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash, no_cem_statement, detector_version, relates_to_role, legal_basis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      contact.id,
      rec.sourceUrl,
      now,
      r2Key,
      hashPage(page.text),
      noCem,
      NO_CEM_DETECTOR_VERSION,
      relatesToRole,
      legalBasisFor(rec.countryCode),
    ],
  );
  await emit({ eventType: "provenance.captured", subject: { kind: "contact", id: contact.id }, payload: { noCem, relatesToRole } });

  return { status: "accepted", contactId: contact.id, eligible: "all" };
}

import { createHash } from "node:crypto";
function hashPage(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export { detectNoCem, NO_CEM_DETECTOR_VERSION } from "@adw/compliance";
import { enqueueIntent, executionId } from "@adw/workflows";

/**
 * Enrol an ingested contact into a campaign and hand it to the pipeline.
 *
 * ingestRecord() ends with a contact and its provenance evidence — a legal
 * artefact, not a lead. This is the step that turns one into the other, and it
 * is the only entry point into the lead workflow. Without it the system ingests
 * perfectly and then does nothing with any of it.
 *
 * Idempotent twice over: the partial unique index allows one non-terminal lead
 * per contact, and the outbox allows one start per execution id. Re-running an
 * ingest batch does not double-contact anyone.
 */
export async function enrolLead(
  db: Db,
  input: { contactId: string; campaignId: string; businessId: string },
): Promise<{ leadId: string; enqueued: boolean } | { leadId: null; reason: "already_active" | "suppressed" }> {
  // A suppressed contact is never enrolled. The gate would deny the send anyway
  // — this just avoids creating a lead that can only ever dead-end.
  const suppressed = await db.maybeOne(
    `SELECT 1 AS x FROM suppression s JOIN contacts c ON c.email_hash = s.email_hash WHERE c.id = $1`,
    [input.contactId],
  );
  if (suppressed) return { leadId: null, reason: "suppressed" };

  const active = await db.maybeOne<{ id: string }>(
    `SELECT id FROM leads WHERE contact_id = $1
       AND state NOT IN ('WON','LOST','EXHAUSTED','SUPPRESSED','CANCELLED') LIMIT 1`,
    [input.contactId],
  );
  if (active) return { leadId: null, reason: "already_active" };

  const lead = await db.one<{ id: string }>(
    `INSERT INTO leads (contact_id, campaign_id, state, workflow_id)
     VALUES ($1,$2,'INGESTED',$3)
     ON CONFLICT (contact_id, campaign_id) DO UPDATE SET state = leads.state
     RETURNING id`,
    [input.contactId, input.campaignId, executionId.lead(input.contactId)],
  );
  await db.query("INSERT INTO conversations (lead_id, channel) VALUES ($1,'email') ON CONFLICT DO NOTHING", [
    lead.id,
  ]);
  await enqueueIntent(db, {
    kind: "start",
    workflowType: "lead",
    executionId: executionId.lead(lead.id),
    payload: { leadId: lead.id, contactId: input.contactId, businessId: input.businessId },
  });
  await emit({ eventType: "lead.enrolled", subject: { kind: "lead", id: lead.id } });
  return { leadId: lead.id, enqueued: true };
}

export {
  remainingSendCapacity,
  standingCampaign,
  sourceLeads,
  type LeadSourceLike,
  type SourceOptions,
  type SourceOutcome,
} from "./source.ts";

export {
  reclassifySubscribers,
  type ReclassifyOptions,
  type ReclassifyOutcome,
} from "./reclassify.ts";
