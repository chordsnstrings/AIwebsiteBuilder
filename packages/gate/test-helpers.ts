// Seeding helpers for the gate suite. Each test builds an isolated contact +
// lead + campaign in the test database.
import { emailHash, type Db } from "@adw/db";
import type { MessageClass, OutboundMessage, SubscriberType } from "@adw/compliance";

export async function makeBatch(db: Db): Promise<string> {
  const b = await db.one<{ id: string }>(
    `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
     VALUES ('demo','lic-1',1,0,'x') RETURNING id`,
  );
  return b.id;
}

export async function makeBusiness(db: Db, batchId: string, country = "US"): Promise<string> {
  const region = country === "US" || country === "CA" ? "R1" : country === "GB" || country === "AU" ? "R2" : "R4";
  const r = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('demo',$1,'Acme',$2,$3,'no_site') RETURNING id`,
    [batchId, country, region],
  );
  return r.id;
}

export interface SeedContactOpts {
  country?: string;
  subscriberType?: SubscriberType;
  email?: string;
}

export async function seedContact(
  db: Db,
  opts: SeedContactOpts = {},
): Promise<{ contactId: string; campaignId: string; leadId: string; conversationId: string; hash: Buffer; email: string }> {
  const country = opts.country ?? "US";
  const email = opts.email ?? `c${Math.random().toString(36).slice(2)}@example.com`;
  const hash = emailHash(email);
  const batch = await makeBatch(db);
  const business = await makeBusiness(db, batch, country);
  const contact = await db.one<{ id: string }>(
    `INSERT INTO contacts (business_id, email, email_hash, verification, subscriber_type)
     VALUES ($1,$2,$3,'valid',$4) RETURNING id`,
    [business, email, hash, opts.subscriberType ?? "unknown"],
  );
  const campaign = await db.one<{ id: string }>(
    `INSERT INTO campaigns (name, region_code, enabled_markets) VALUES ('camp','R1',$1) RETURNING id`,
    [[country]],
  );
  const lead = await db.one<{ id: string }>(
    `INSERT INTO leads (contact_id, campaign_id, state, workflow_id)
     VALUES ($1,$2,'CONTACTED',$3) RETURNING id`,
    [contact.id, campaign.id, `wf_${contact.id}`],
  );
  const conv = await db.one<{ id: string }>(
    `INSERT INTO conversations (lead_id, channel) VALUES ($1,'email') RETURNING id`,
    [lead.id],
  );
  return { contactId: contact.id, campaignId: campaign.id, leadId: lead.id, conversationId: conv.id, hash, email };
}

export async function addProvenance(
  db: Db,
  contactId: string,
  opts: { retrievedAt?: Date; noCem?: boolean; relatesToRole?: boolean; legalBasis?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO provenance (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash, no_cem_statement, detector_version, relates_to_role, legal_basis)
     VALUES ($1,'https://example.com',$2,'prov/x.png','h',$3,'nocem-v1.0.0',$4,$5)`,
    [
      contactId,
      opts.retrievedAt ?? new Date(),
      opts.noCem ?? true,
      opts.relatesToRole ?? true,
      opts.legalBasis ?? "casl_10_9",
    ],
  );
}

/** A fully-compliant cold email with all obligations materially present. */
export function compliantColdMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    emailHash: overrides.emailHash ?? emailHash("x@example.com"),
    countryCode: "US",
    subscriberType: "unknown",
    channel: "email",
    messageClass: "cold" as MessageClass,
    domainClass: "burner",
    campaignId: "c",
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    localHour: 10,
    localWeekday: 2,
    body: [
      "Hi, we built a preview of a website for your business.",
      "ADW Foundry Ltd, 123 Example Street, Toronto, ON.",
      "This message was drafted with the help of AI.",
      "See our privacy notice. To unsubscribe click here.",
    ].join("\n"),
    headers: {
      From: "hello@burner-domain.com",
      "List-Unsubscribe": "<https://p.adwpreview.com/u/abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    ...overrides,
  };
}
