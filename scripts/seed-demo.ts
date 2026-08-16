// Seeds the demo database so every surface renders meaningfully in keyless mode:
// migrates the schema, populates the model registry with champions (via real
// stored eval runs against the mock rail), seeds the vendor register, kill
// switches, and a handful of businesses/contacts/leads/customers.
import { createDb, emailHash, migrate, type Db } from "../packages/db/src/index.ts";
import { LocalKeyWrapper, LocalPgBackend } from "../packages/vault/src/index.ts";
import { runFullSweep } from "../packages/evals-harness/src/index.ts";
import { seedVendors } from "../packages/orchestrator/src/index.ts";
import { KILL_SWITCHES } from "../packages/gate/src/index.ts";
import { embedText, persistQAPack, type QAPack, type QAPair } from "../packages/qapack/src/index.ts";
import { contextFromPack, handleTurn, openSession } from "../packages/concierge/src/index.ts";
import { classify, persistManifest } from "../packages/architect/src/index.ts";
import { assertAgentEvalPassed, runAgentEval } from "../packages/agenteval/src/index.ts";
import { randomUUID } from "node:crypto";

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
  // ⛔ `vertical` set explicitly. In production the Architect activity writes
  // it; the seed calls the agent directly, so without this the demo customer
  // has a NULL vertical and every per-archetype family resolves to nothing.
  "INSERT INTO businesses (source_vendor, source_batch_id, name, category, vertical, country_code, region_code, city, segment) VALUES ('demo_aggregator',$1,'Bright Plumbing','plumber','plumber','US','R1','Denver','stale_site') RETURNING id",
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

// ---------------------------------------------------------------------------
// The v3 product: a knowledge base, an approved pack, and a conversation that
// actually happened.
//
// Seeding this is not decoration. Two nightly invariants — the retrieval hit
// rate and the Architect escalation rate — are computed over a window, and with
// no rows in that window they pass vacuously. A green check that cannot go red
// is worse than no check, because it is read as evidence.
// ---------------------------------------------------------------------------
console.log("→ the customer's agent: knowledge base, pack, and a live conversation");

const kb = await db.one<{ id: string }>(
  "INSERT INTO knowledge_bases (business_id, customer_id) VALUES ($1,$2) RETURNING id",
  [custBiz.id, customer.id],
);
const FACTS: [string, string, string, string][] = [
  ["hours", "hours", "Open Monday to Friday, 7am to 6pm", "verified"],
  ["area", "area", "We cover Denver, Aurora, Lakewood and Arvada", "verified"],
  ["price_callout", "price", "Standard callout $89, credited against the work", "verified"],
  ["service_drains", "service", "Blocked drain clearing with rods and jetting", "verified"],
  ["service_boilers", "service", "Boiler installation, servicing and repair", "verified"],
  ["service_leaks", "service", "Leak detection and pipe repair", "verified"],
  ["emergency", "service", "24 hour emergency line for burst pipes", "verified"],
  ["warranty", "warranty", "Twelve month workmanship warranty on installation", "verified"],
  ["payment", "payment", "Card or bank transfer on completion", "verified"],
  // ⛔ Unverified on purpose. It is on their site and we could not confirm it,
  // so the agent may never assert it — the demo should show that, not hide it.
  ["credential_insurance", "credential", "Fully insured and bonded", "claimed_unverified"],
];
for (const [key, type, value, status] of FACTS) {
  await db.query(
    `INSERT INTO kb_facts (kb_id, fact_key, type, value, status, source_url, retrieved_at)
     VALUES ($1,$2,$3,$4,$5,'https://brightplumbing.example/about', now())`,
    [kb.id, key, type, value, status],
  );
}

// At least the 20 grounded cases the eval gate requires — a smaller pack is
// legitimately un-shippable, and seeding one would leave the demo with a live
// agent that never passed its gate.
const PACK_PAIRS: [string, string][] = [
  ["What are your opening hours?", "We're open Monday to Friday, 7am to 6pm."],
  ["Which areas do you cover?", "We cover Denver, Aurora, Lakewood and Arvada."],
  ["How much is a callout?", "Our standard callout is $89, credited against the work if you go ahead."],
  ["Do you clear blocked drains?", "We clear blocked drains with rods and high pressure jetting."],
  ["Do you install boilers?", "We install, service and repair boilers."],
  ["Can you find a leak?", "We do leak detection and pipe repair."],
  ["Do you do emergency callouts?", "We run a 24 hour emergency line for burst pipes."],
  ["Do you offer a warranty?", "Installation work carries a twelve month workmanship warranty."],
  ["How can I pay?", "We take card or bank transfer on completion."],
  ["Do you work at weekends?", "Weekend work goes through the 24 hour emergency line."],
  ["Do you replace radiators?", "We replace radiators and rebalance the system afterwards."],
  ["Do you fit bathrooms?", "We fit complete bathrooms, from strip-out through to tiling."],
  ["Do you repair water heaters?", "We repair and replace water heaters of most makes."],
  ["Can you help with low water pressure?", "Low water pressure is something we diagnose on site."],
  ["Do you work with landlords?", "We look after several landlords and their rental properties."],
  ["How long have you been trading?", "The business has been trading in Denver since 2009."],
  ["Do you fit outside taps?", "Outside taps are a straightforward job we do regularly."],
  ["Do you provide written quotations?", "Anything beyond a small repair comes with a written quotation first."],
  ["Do you tidy up afterwards?", "We sheet up before starting and clear everything away when we finish."],
  ["Do you fit water softeners?", "Water softener installation is something we do often."],
  ["Do you service sump pumps?", "We service and replace sump pumps."],
  ["Can you re-pipe a whole house?", "Whole-house re-piping is work we take on, usually over several days."],
];
const seedPair = (question: string, answer: string): QAPair => ({
  id: randomUUID(),
  question,
  answer,
  sourceFactIds: [randomUUID()],
  embedding: embedText(question),
  confidence: 0.9,
  source: "generated",
});
const pack: QAPack = {
  id: randomUUID(),
  kbId: kb.id,
  businessId: custBiz.id,
  customerId: customer.id,
  version: 1,
  vertical: "plumber",
  playbookVersion: "seed",
  embeddingProvider: "adw-hashed-ngram-v1",
  pairs: PACK_PAIRS.map(([q, a]) => seedPair(q!, a!)),
  coverage: {
    byTopic: { hours: { answered: 1, total: 1 }, area: { answered: 1, total: 1 }, price: { answered: 1, total: 1 } },
    byVerticalTemplate: { answered: 10, total: 14, ratio: 10 / 14 },
    factsUsed: FACTS.length,
    factsAvailable: FACTS.length,
  },
  templateFallbacks: ["Do you offer finance?", "Are you a member of a trade body?"],
  gaps: [],
  excluded: [],
  thin: true,
  extendedOnboarding: true,
  approvedAt: new Date(),
  approvedBy: "owner@brightplumbing.example",
  createdAt: new Date(),
};
await persistQAPack(db, pack);
await db.query("UPDATE qa_packs SET approved_at = now(), approved_by = $2 WHERE id = $1", [
  pack.id,
  "owner@brightplumbing.example",
]);

// A delivery manifest, so the dashboard knows which capabilities this agent has
// and the Architect escalation-rate invariant has something to measure.
const audit = await db.one<{ id: string }>(
  `INSERT INTO site_audits (business_id, has_website, https, pricing_found, booking_found,
                            has_service_schema, llms_txt, page_count, word_count,
                            transactability_gap, top_defects)
   VALUES ($1,TRUE,TRUE,FALSE,FALSE,FALSE,FALSE,6,820,TRUE,$2) RETURNING id`,
  [custBiz.id, JSON.stringify(["no_service_schema", "no_online_booking", "no_llms_txt"])],
);
void audit;
const classified = await classify({
  businessId: custBiz.id,
  category: "plumber",
  siteAudit: {
    hasWebsite: true,
    pricingFound: false,
    bookingFound: false,
    pageCount: 6,
    wordCount: 820,
    transactabilityGap: true,
  },
});
if (!classified.escalate) await persistManifest(db, { ...classified.manifest, customerId: customer.id });

// ⛔ The gate, for real. Nothing goes live on an approved pack alone — the
// nightly invariant "no customer agent is live without a passing eval run"
// exists precisely to catch a seed that skipped this.
const evalRun = await runAgentEval(
  { db },
  { customerId: customer.id, businessId: custBiz.id, pack },
  { businessName: "Bright Plumbing", kbSlice: FACTS.filter(([, , , st]) => st === "verified").map(([, , v]) => v) },
);
assertAgentEvalPassed(evalRun);
console.log(`   agent eval: ${evalRun.passed}/${evalRun.total} — ${evalRun.verdict}`);

// A conversation. Mostly questions the pack answers and a couple it does not,
// so the hit rate lands at a real number and the gap list has something in it.
const session = await openSession(db, { customerId: customer.id, businessId: custBiz.id });
const ctx = contextFromPack(pack, session, {
  capabilities: ["answer", "capture_enquiry", "escalate"],
  kbSlice: FACTS.filter(([, , , status]) => status === "verified").map(([, , value]) => value),
});
const TRANSCRIPT = [
  "What are your opening hours?",
  "Do you work in Lakewood?",
  "How much is a callout?",
  "Do you replace radiators?",
  "Can you unblock a drain?",
  "Do you provide written quotations?",
  "How long have you been trading?",
  "Do you take American Express?",
  "Do you do solar thermal?",
  "Do you service sump pumps?",
];
for (const [i, question] of TRANSCRIPT.entries()) {
  await handleTurn({ db }, ctx, question, { turnIndex: i });
}

await db.query(
  `INSERT INTO enquiries (customer_id, business_id, name, need, contact, urgency)
   VALUES ($1,$2,'Dana Whitfield','Kitchen tap dripping overnight, getting worse','+13035550142','urgent'),
          ($1,$2,'Ray Okonjo','Wants a quote for a new boiler','ray@example.com','normal')`,
  [customer.id, custBiz.id],
);

// ---------------------------------------------------------------------------
// The customer-side families (MF2-MF13).
//
// ⛔ Seeded because the nightly invariants over these tables would otherwise
// pass over an empty population — the exact failure the approval invariant
// exhibited for months, holding true because nothing had ever reached the gate
// it guarded. Every check in eval-nightly.ts now reports its denominator, and
// these rows are what makes those denominators non-zero.
// ---------------------------------------------------------------------------
{
  const { openCase, advanceCase } = await import("../packages/cases/src/index.ts");
  const { scheduleReminder, startJourney, runJourneys } = await import("../packages/journeys/src/index.ts");
  const { subscribeWatch, runDueWatches, simulatedCollectors } = await import("../packages/watch/src/index.ts");
  const { openRun, ingest, runReconciliation, openDifferences, resolveDifference, closeRun } =
    await import("../packages/reconcile/src/index.ts");
  const { draftPublication, factsOnlyDrafter, approvePublication, publishApproved, simulatedConnectors } =
    await import("../packages/publish/src/index.ts");
  const { recordCall } = await import("../packages/voice/src/index.ts");

  const V = "plumber";
  const cid = customer.id;

  // MF2 — a case in flight and one completed.
  const caseId = await openCase(db, { customerId: cid, vertical: V, caseType: "emergency_job",
    reference: "JOB-1043", title: "Burst pipe, Elm Street" });
  await advanceCase(db, caseId, "dispatched", "dispatcher@brightplumbing.example", { vertical: V });

  // MF4 — one ordinary clock and one statutory.
  const day = 86_400_000;
  await scheduleReminder(db, { customerId: cid, vertical: V, kind: "annual_service",
    subjectRef: "12 Elm Street boiler", anchorAt: new Date(Date.now() - 300 * day) });
  await scheduleReminder(db, { customerId: cid, vertical: V, kind: "landlord_gas_safety",
    subjectRef: "44 Oak Road", anchorAt: new Date(Date.now() + 40 * day) });

  // MF5 — a journey with a step actually delivered.
  await startJourney(db, { customerId: cid, vertical: V, journeyId: "post_job_review",
    subjectRef: "JOB-1043", contact: "dana@example.com" }, new Date(Date.now() - 3 * day));
  await runJourneys(db, async () => ({ delivered: true }));

  // MF7 — two watches with a baseline and a second reading.
  const watchClock = { at: new Date(Date.now() - 2 * day) };
  const collectors = simulatedCollectors(() => watchClock.at);
  for (const [watchId, subject] of [["reviews_new", "gbp:bright-plumbing"], ["site_availability", "https://brightplumbing.example"]] as const) {
    await subscribeWatch(db, { customerId: cid, vertical: V, watchId, subject }, collectors);
  }
  await runDueWatches(db, collectors, watchClock.at, { customerId: cid });
  watchClock.at = new Date();
  await runDueWatches(db, collectors, watchClock.at, { customerId: cid });

  // MF8 — a reconciliation taken all the way to a signed-off close.
  const recon = await openRun(db, { customerId: cid, vertical: V, reconType: "invoices_vs_bank",
    periodStart: new Date(Date.now() - 30 * day), periodEnd: new Date() });
  if (recon.ok) {
    await ingest(db, recon.runId, "ours", [
      { sourceKey: "INV-2201", reference: "INV-2201", amountCents: 42000, occurredOn: new Date(Date.now() - 20 * day) },
      { sourceKey: "INV-2202", reference: "INV-2202", amountCents: 18500, occurredOn: new Date(Date.now() - 12 * day) },
    ]);
    await ingest(db, recon.runId, "theirs", [
      { sourceKey: "BANK-88", reference: "INV 2201", amountCents: 42000, occurredOn: new Date(Date.now() - 18 * day) },
      { sourceKey: "BANK-91", reference: "inv/2202", amountCents: 18450, occurredOn: new Date(Date.now() - 11 * day) },
    ]);
    await runReconciliation(db, recon.runId);
    for (const d of await openDifferences(db, recon.runId)) {
      await resolveDifference(db, d.id, "owner@brightplumbing.example", "bank charge, posted separately");
    }
    await closeRun(db, recon.runId, "owner@brightplumbing.example");
  }

  // MF12/MF13 — one post approved and published, one still awaiting the owner.
  const facts = ["We cover Denver and Aurora.", "Open Monday to Friday, 7am to 6pm."];
  const published = await draftPublication(db,
    { customerId: cid, vertical: V, channel: "gbp_post", topic: "Winter pipe checks", facts },
    factsOnlyDrafter());
  if (published.ok) {
    await approvePublication(db, published.publicationId, "owner@brightplumbing.example");
    await publishApproved(db, simulatedConnectors(), new Date(), { customerId: cid });
  }
  await draftPublication(db,
    { customerId: cid, vertical: V, channel: "social_post", topic: "Emergency call-outs this weekend", facts },
    factsOnlyDrafter());

  // MF11 — a missed call waiting to be returned.
  await recordCall(db, { customerId: cid, provider: "demo", providerCallId: "call-7781",
    outcome: "voicemail", callerNumber: "+13035550188", startedAt: new Date(Date.now() - 2 * 3_600_000),
    transcript: "Hi, no hot water since this morning — can someone come out today?" },
    { attemptFollowUp: true });
}

const counts = await db.one<{ b: string; c: string; v: string; r: string }>(
  "SELECT (SELECT count(*) FROM businesses) b, (SELECT count(*) FROM contacts) c, (SELECT count(*) FROM vendors) v, (SELECT count(*) FROM registry_roles WHERE champion IS NOT NULL) r",
);
const agent = await db.one<{ turns: string; gaps: string }>(
  "SELECT (SELECT count(*) FROM agent_turns) turns, (SELECT count(*) FROM agent_gaps) gaps",
);
const product = await db.one<{ cases: string; reminders: string; runs: string; watches: string; recon: string; pubs: string; calls: string }>(
  `SELECT (SELECT count(*) FROM cases) cases, (SELECT count(*) FROM reminders) reminders,
          (SELECT count(*) FROM journey_runs) runs, (SELECT count(*) FROM watch_subscriptions) watches,
          (SELECT count(*) FROM recon_runs) recon, (SELECT count(*) FROM publications) pubs,
          (SELECT count(*) FROM calls) calls`,
);
console.log(
  `✓ seeded: ${counts.b} businesses, ${counts.c} contacts, ${counts.v} vendors, ${counts.r} roles with champions, ` +
    `${pack.pairs.length} Q&A pairs, ${agent.turns} agent turns, ${agent.gaps} gaps`,
);
console.log(
  `✓ product: ${product.cases} cases, ${product.reminders} reminders, ${product.runs} journey runs, ` +
    `${product.watches} watches, ${product.recon} reconciliations, ${product.pubs} publications, ${product.calls} calls`,
);
await db.close();
