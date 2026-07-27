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

export interface RegistryLookup {
  // Classify subscriber type for UK/IE (corporate vs sole trader).
  classify(businessName: string, countryCode: string): Promise<SubscriberType>;
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
  const subscriberType: SubscriberType = needsRegistry
    ? await deps.registry.classify(rec.businessName, rec.countryCode)
    : "unknown";

  const contact = await db.one<{ id: string }>(
    `INSERT INTO contacts (business_id, email, email_hash, verification, verified_at, subscriber_type)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (business_id, email) DO UPDATE SET verification = EXCLUDED.verification
     RETURNING id`,
    [rec.businessId, rec.email, hash, verification, now, subscriberType],
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
