// Fetching customers — the step that did not exist.
//
// ⛔ THE PIPELINE HAD NO BEGINNING. `LeadSource.fetchBatch()` was implemented,
// registered in the vendor hub and probed by the Sentinel. `ingestRecord()` was
// implemented and correctly enqueued a lead workflow. NOTHING CONNECTED THEM —
// no job, no activity, no route called either one. `leadSourcingAgent` had zero
// call sites.
//
// So the autonomous business could execute the whole pipeline — score, build a
// preview, clear the gate, send, handle the reply, quote, build, deploy — and
// nothing ever handed it a business to start from. Everything downstream worked
// and was never given anything to work on.
//
// ⛔ This job is deliberately CONSERVATIVE about volume. Licensed lead data
// costs money per record and provenance goes stale on a clock, so sourcing more
// than the fleet can lawfully send builds a backlog that expires before it is
// ever contacted — money spent to create a compliance liability. The batch is
// therefore sized to real remaining send capacity, never to a fixed number.

import type { Db } from "@adw/db";
import { resolveJurisdiction } from "@adw/compliance";
import { segmentOf, resolveVertical } from "@adw/taxonomy";
import { emit } from "@adw/telemetry";
import { createHash } from "node:crypto";
import { enrolLead, ingestRecord, type IngestOutcome, type ProvenanceDeps } from "./index.ts";

/** What the vendor hub supplies. Structural, so this file needs no vendor import. */
export interface LeadSourceLike {
  readonly vendorId: string;
  fetchBatch(
    query: string,
    limit: number,
  ): Promise<{
    records: {
      externalRef: string; name: string; category: string; countryCode: string;
      city: string; phone: string; websiteUrl: string | null;
      reviewCount: number; rating: number; email: string | null; sourceUrl: string;
    }[];
    licenceRef: string;
    costCents: number;
  }>;
}

export interface SourceOptions {
  /** The vendor's own search expression — a trade and a place. */
  query: string;
  /**
   * Hard ceiling on records requested.
   *
   * ⛔ The ACTUAL number requested is the smaller of this and the fleet's
   * remaining capacity for today. A cap alone is not enough: it is a constant,
   * and the fleet's ability to send is not.
   */
  maxRecords: number;
  now?: Date;
  /** Skip the capacity check. Only for tests that assert ingest behaviour. */
  ignoreCapacity?: boolean;
}

/**
 * The standing campaign for a region, resolved or created once.
 *
 * ⛔ ONE campaign per (region, message class), addressed by a STABLE name.
 * Creating a fresh campaign per sourcing run would be easier and would quietly
 * destroy two invariants: `leads` is unique on (contact_id, campaign_id), and
 * the gate's frequency cap counts touches within a campaign. A new campaign
 * every hour means the same person can be enrolled every hour and the 4-in-30-
 * days cap never binds — which is the exact failure the cap exists to prevent.
 */
export async function standingCampaign(
  db: Db,
  regionCode: string,
  countryCode: string,
): Promise<string> {
  const name = `standing:${regionCode}:web_presence`;
  const existing = await db.maybeOne<{ id: string; enabled_markets: string[] }>(
    "SELECT id, enabled_markets FROM campaigns WHERE name = $1",
    [name],
  );
  if (existing !== null) {
    // Widen the market list as new countries appear in the same region, so one
    // campaign covers the region rather than fragmenting per country.
    if (!existing.enabled_markets.includes(countryCode)) {
      await db.query(
        "UPDATE campaigns SET enabled_markets = array_append(enabled_markets, $2) WHERE id = $1",
        [existing.id, countryCode],
      );
    }
    return existing.id;
  }
  const created = await db.one<{ id: string }>(
    `INSERT INTO campaigns (name, region_code, enabled_markets, message_class)
     VALUES ($1,$2,$3,'web_presence')
     ON CONFLICT (name) DO UPDATE SET name = campaigns.name
     RETURNING id`,
    [name, regionCode, [countryCode]],
  );
  return created.id;
}

export interface SourceOutcome {
  /** Records the vendor returned. */
  fetched: number;
  /** Businesses created (an externalRef already held is not re-created). */
  businessesCreated: number;
  /** Records ingested as contactable leads. */
  ingested: number;
  /** Per-reason counts for everything not ingested. Always adds up. */
  skipped: Record<string, number>;
  costCents: number;
  licenceRef: string | null;
  batchId: string | null;
  /** How many the fleet could still lawfully send to when this ran. */
  capacity: number;
  /** Set when nothing was fetched, with the reason. */
  halted?: string;
}

/**
 * How many more cold sends the fleet can take today.
 *
 * ⛔ Read from the fleet's own daily caps and today's usage, not from a
 * constant. Sourcing is the one place in this system that spends money to
 * create future obligations, so the amount is bounded by what can actually be
 * acted on.
 */
export async function remainingSendCapacity(db: Db): Promise<number> {
  const row = await db.maybeOne<{ remaining: string }>(
    `SELECT COALESCE(sum(GREATEST(daily_cap - sends_today, 0)), 0) AS remaining
       FROM sending_assets
      WHERE retired_at IS NULL AND health IN ('healthy', 'warming')`,
  );
  return row === null ? 0 : Number(row.remaining);
}

/**
 * Source one batch and drive every eligible record into the pipeline.
 *
 * Returns a full accounting: everything fetched is either ingested or counted
 * under a named skip reason. A sourcing run that silently drops records is
 * indistinguishable from a vendor that returned fewer.
 */
export async function sourceLeads(
  db: Db,
  source: LeadSourceLike,
  deps: Omit<ProvenanceDeps, "db">,
  opts: SourceOptions,
): Promise<SourceOutcome> {
  const now = opts.now ?? new Date();
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const capacity = opts.ignoreCapacity === true ? opts.maxRecords : await remainingSendCapacity(db);
  const want = Math.max(0, Math.min(opts.maxRecords, capacity));
  if (want === 0) {
    // ⛔ Not an error, and not silent. A fleet with no capacity is the normal
    // state during warm-up, and buying data that cannot be used for a fortnight
    // is exactly the waste this guard exists to prevent.
    return {
      fetched: 0, businessesCreated: 0, ingested: 0, skipped, costCents: 0,
      licenceRef: null, batchId: null, capacity,
      halted: "no remaining send capacity — sourcing would buy data that cannot be contacted",
    };
  }

  const batch = await source.fetchBatch(opts.query, want);
  if (batch.records.length === 0) {
    return {
      fetched: 0, businessesCreated: 0, ingested: 0, skipped, costCents: batch.costCents,
      licenceRef: batch.licenceRef, batchId: null, capacity,
      halted: "the vendor returned no records for this query",
    };
  }

  // ⛔ The batch row is written BEFORE anything is ingested, and carries the
  // licence reference and what it cost. A business row whose batch does not
  // exist is a record with no provenance of purchase, and the schema makes that
  // unrepresentable — source_batch_id is NOT NULL.
  const checksum = createHash("sha256")
    .update(batch.records.map((r) => r.externalRef).sort().join("\n"))
    .digest("hex")
    .slice(0, 32);
  const batchRow = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum, received_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [source.vendorId, batch.licenceRef, batch.records.length, batch.costCents, checksum, now],
  );

  let businessesCreated = 0;
  let ingested = 0;

  for (const rec of batch.records) {
    // ── Guards, in the order that costs least to check ────────────────────

    // ⛔ A record with no address cannot be contacted. Counted, never guessed
    // at: deriving info@<name> would be manufacturing a recipient.
    if (rec.email === null || rec.email.trim() === "") {
      skip("no_email");
      continue;
    }

    // ⛔ Market gate at SOURCING, not only at send. The gate would deny these
    // later anyway, but by then the data is bought, the provenance is captured
    // and a person's details are being held for a market we do not operate in.
    const jurisdiction = resolveJurisdiction(rec.countryCode);
    if (!jurisdiction.enabled) {
      skip(`market_disabled:${rec.countryCode}`);
      continue;
    }

    // ⛔ Enterprise accounts never enter the SMB motion — they receive a
    // business case from a human-owned pipeline, never a speculative preview.
    const vertical = resolveVertical(rec.category, rec.category);
    if (vertical !== "" && segmentOf(vertical) === "enterprise_global") {
      skip("enterprise_segment");
      continue;
    }

    // ── The business row, idempotent on the vendor's own identifier ────────
    const existing = await db.maybeOne<{ id: string }>(
      "SELECT id FROM businesses WHERE source_vendor = $1 AND external_ref = $2",
      [source.vendorId, rec.externalRef],
    );
    let businessId: string;
    if (existing !== null) {
      businessId = existing.id;
      skip("business_already_held");
    } else {
      const created = await db.one<{ id: string }>(
        `INSERT INTO businesses
           (source_vendor, source_batch_id, external_ref, name, category_raw, category,
            country_code, region_code, city, phone_e164, website_url, segment,
            review_count, rating, vertical, ingested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          source.vendorId, batchRow.id, rec.externalRef, rec.name, rec.category, rec.category,
          rec.countryCode, regionFor(rec.countryCode), rec.city, rec.phone, rec.websiteUrl,
          // The segment the foundry sells to: no site at all is the ICP.
          rec.websiteUrl === null ? "no_site" : "stale_site",
          rec.reviewCount, rec.rating,
          // ⛔ Resolved here, at the one place a business is created. Leaving it
          // null is the defect that silently switches off every customer-side
          // family later; "" is stored as null rather than as an empty string.
          vertical === "" ? null : vertical,
          now,
        ],
      );
      businessId = created.id;
      businessesCreated += 1;
    }

    // ── Ingest: provenance, verification, contact, and the lead workflow ───
    let outcome: IngestOutcome;
    try {
      outcome = await ingestRecord(
        {
          businessId,
          email: rec.email,
          sourceUrl: rec.sourceUrl,
          category: rec.category,
          countryCode: rec.countryCode,
          businessName: rec.name,
        },
        { ...deps, db, ...(opts.now === undefined ? {} : { now: () => now }) },
      );
    } catch (err) {
      // One bad record must not abandon the rest of a paid-for batch.
      skip(`ingest_error:${err instanceof Error ? err.message.slice(0, 40) : "unknown"}`);
      continue;
    }

    if (outcome.status === "rejected") {
      skip(`rejected:${outcome.reason}`);
      continue;
    }
    if (outcome.status === "provenance_failed") {
      // ⛔ Not enrolled. Without provenance the gate denies the send in every
      // market that requires it, so enrolling would create a lead that can only
      // dead-end — and would hold a person's details for a contact we cannot
      // lawfully make.
      skip("provenance_failed");
      continue;
    }

    // ⛔ THE SECOND MISSING LINK. `ingestRecord` ends with a contact and its
    // provenance — a legal artefact, not a lead. `enrolLead` is what turns one
    // into the other and enqueues the workflow, and it had ZERO call sites. Its
    // own comment says it: "Without it the system ingests perfectly and then
    // does nothing with any of it." That was literally true.
    const campaignId = await standingCampaign(db, regionFor(rec.countryCode), rec.countryCode);
    const enrolled = await enrolLead(db, {
      contactId: outcome.contactId,
      campaignId,
      businessId,
    });
    if (enrolled.leadId === null) {
      skip(`not_enrolled:${enrolled.reason}`);
      continue;
    }
    ingested += 1;
  }

  await emit({
    eventType: "leads.sourced",
    subject: { kind: "ingest_batch", id: batchRow.id },
    payload: {
      vendor: source.vendorId,
      query: opts.query,
      fetched: batch.records.length,
      ingested,
      businessesCreated,
      costCents: batch.costCents,
      capacity,
    },
  });

  return {
    fetched: batch.records.length,
    businessesCreated,
    ingested,
    skipped,
    costCents: batch.costCents,
    licenceRef: batch.licenceRef,
    batchId: batchRow.id,
    capacity,
  };
}

/**
 * Region code from country, matching the pricing bands.
 *
 * ⛔ Deliberately crude and total: `businesses.region_code` is NOT NULL and is
 * read by pricing, so an unmapped country must land somewhere defined rather
 * than fail an insert halfway through a paid batch.
 */
function regionFor(countryCode: string): string {
  switch (countryCode) {
    case "US":
    case "CA": return "R1";
    case "GB":
    case "IE": return "R2";
    case "AU":
    case "NZ": return "R3";
    default: return "R4";
  }
}
