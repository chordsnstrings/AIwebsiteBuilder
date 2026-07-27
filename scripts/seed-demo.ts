// Seeds the demo database so every surface renders meaningfully in keyless mode:
// migrates the schema, populates the model registry with champions (via real
// stored eval runs against the mock rail), seeds the vendor register, kill
// switches, and a handful of businesses/contacts/leads/customers.
import { createDb, emailHash, migrate, type Db } from "../packages/db/src/index.ts";
import { LocalKeyWrapper, LocalPgBackend } from "../packages/vault/src/index.ts";
import { runFullSweep } from "../packages/evals-harness/src/index.ts";
import { seedVendors } from "../packages/orchestrator/src/index.ts";
import { KILL_SWITCHES } from "../packages/gate/src/index.ts";

const url = process.env.DATABASE_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw";
const db: Db = await createDb({ backend: "pg", url });

console.log("→ migrating");
await migrate(db);

console.log("→ registry sweep (champions from stored eval runs)");
const vault = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));
await runFullSweep({ db, vault, forceMock: true });

console.log("→ vendor register");
await seedVendors(db);

console.log("→ kill switches");
for (const name of KILL_SWITCHES) {
  await db.query("INSERT INTO kill_switches (name, engaged) VALUES ($1, FALSE) ON CONFLICT (name) DO NOTHING", [name]);
}

console.log("→ superadmin operator (TOTP mandatory)");
const { createUser } = await import("../packages/auth/src/index.ts");
const adminEmail = process.env.ADW_SUPERADMIN_EMAIL ?? "admin@adw.example";
const existingAdmin = await db.maybeOne<{ id: string; totp_secret: string | null }>(
  "SELECT id, totp_secret FROM users WHERE email = $1",
  [adminEmail],
);
if (existingAdmin) {
  console.log(`   superadmin already seeded: ${adminEmail}`);
} else {
  const { totpSecret } = await createUser(db, {
    email: adminEmail,
    password: process.env.ADW_SUPERADMIN_PASSWORD ?? "changeme-in-production",
    role: "superadmin",
  });
  console.log(`   superadmin: ${adminEmail}`);
  console.log(`   TOTP secret (enrol in your authenticator, then rotate the password): ${totpSecret}`);
}

console.log("→ feature flags");
for (const [key, desc] of [
  ["payments_facilitation", "Stripe Connect payment facilitation (Phase 3)"],
  ["sms_bridge", "SMS channel behind the consent bridge (Phase 2)"],
]) {
  await db.query("INSERT INTO feature_flags (key, enabled, description) VALUES ($1, FALSE, $2) ON CONFLICT (key) DO NOTHING", [key, desc]);
}

console.log("→ businesses, contacts, provenance, leads");
const batch = await db.one<{ id: string }>(
  "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('demo_aggregator','LIC-DEMO-1',5,40,'demo') RETURNING id",
);
const campaign = await db.one<{ id: string }>(
  "INSERT INTO campaigns (name, region_code, enabled_markets) VALUES ('R1 pilot','R1',$1) RETURNING id",
  [["US", "CA"]],
);
const seedBiz = [
  { name: "Bright Plumbing", cat: "plumber", city: "Denver", seg: "stale_site", country: "US" },
  { name: "Sunrise Cafe", cat: "cafe", city: "Austin", seg: "no_site", country: "US" },
  { name: "Maple Auto Repair", cat: "auto_repair", city: "Toronto", seg: "stale_site", country: "CA" },
];
for (const s of seedBiz) {
  const region = s.country === "CA" ? "R1" : "R1";
  const biz = await db.one<{ id: string }>(
    "INSERT INTO businesses (source_vendor, source_batch_id, name, category, country_code, region_code, city, segment, review_count, rating) VALUES ('demo_aggregator',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [batch.id, s.name, s.cat, s.country, region, s.city, s.seg, 80, 4.7],
  );
  const email = `owner@${s.name.toLowerCase().replace(/\s+/g, "")}.example`;
  const contact = await db.one<{ id: string }>(
    "INSERT INTO contacts (business_id, email, email_hash, verification, subscriber_type) VALUES ($1,$2,$3,'valid','corporate') RETURNING id",
    [biz.id, email, emailHash(email)],
  );
  await db.query(
    "INSERT INTO provenance (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash, no_cem_statement, detector_version, relates_to_role, legal_basis) VALUES ($1,$2,now(),'prov/demo.png','h',true,'nocem-v1.0.0',true,$3)",
    [contact.id, `https://${s.name.toLowerCase().replace(/\s+/g, "")}.example`, s.country === "CA" ? "casl_10_9" : "can_spam_optout"],
  );
  await db.query(
    "INSERT INTO leads (contact_id, campaign_id, state, score, workflow_id) VALUES ($1,$2,'SCORED',72,$3) ON CONFLICT DO NOTHING",
    [contact.id, campaign.id, `wf_${contact.id}`],
  );
}

console.log("→ a live customer + subscription");
const custBiz = await db.one<{ id: string }>(
  "INSERT INTO businesses (source_vendor, source_batch_id, name, category, country_code, region_code, city, segment) VALUES ('demo_aggregator',$1,'Bright Plumbing','plumber','US','R1','Denver','stale_site') RETURNING id",
  [batch.id],
);
const customer = await db.one<{ id: string }>(
  "INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status) VALUES ($1,'R1','Bright Plumbing LLC','owner@brightplumbing.example','en-US','America/Denver','active') RETURNING id",
  [custBiz.id],
);
await db.query(
  "INSERT INTO subscriptions (customer_id, plan_code, billing_interval, amount_cents, currency, status, current_period_end) VALUES ($1,'care','month',6500,'USD','active', now() + interval '30 days')",
  [customer.id],
);

const counts = await db.one<{ b: string; c: string; v: string; r: string }>(
  "SELECT (SELECT count(*) FROM businesses) b, (SELECT count(*) FROM contacts) c, (SELECT count(*) FROM vendors) v, (SELECT count(*) FROM registry_roles WHERE champion IS NOT NULL) r",
);
console.log(`✓ seeded: ${counts.b} businesses, ${counts.c} contacts, ${counts.v} vendors, ${counts.r} roles with champions`);
await db.close();
