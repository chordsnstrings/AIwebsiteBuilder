// End-to-end demo: drives one lead through the real pipeline — ingest →
// enrichment scoring → preview generation → reviewer gate → gated cold send →
// positive reply → care → finance quote → full build through the durable
// workflow engine → deploy. Everything runs keyless against mocks. Prints a
// report the operator can check.
import { createDb, emailHash, migrate, type Db } from "../packages/db/src/index.ts";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "../packages/vault/src/index.ts";
import { seedRegistry, setChampion, type RoleId } from "../packages/registry/src/index.ts";
import { config } from "../packages/config/src/index.ts";
import {
  careAgent,
  developerAgent,
  enrichmentAgent,
  financeAgent,
  ipClaimsAgent,
  previewAgent,
  type AgentDeps,
} from "../packages/agents/src/index.ts";
import { gate, gatedSend, type EmailTransport, type OutboundMessage } from "../packages/gate/src/index.ts";
import { renderSite, buildArtifactFromHtml } from "../packages/site-templates/src/index.ts";
import { reviewBuild } from "../packages/reviewer-gates/src/index.ts";
import { Engine, TestClock } from "../packages/workflows/src/engine/index.ts";
import { buildWorkflow } from "../packages/workflows/src/definitions/index.ts";
import { registerActivities } from "../apps/worker/src/activities.ts";

const url = process.env.DATABASE_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw";
const db: Db = await createDb({ backend: "pg", url });
await migrate(db);
const vault: SecretsBackend = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));

// Ensure champions exist.
await seedRegistry(db);
const reg = config.registry().data.roles;
for (const [role, r] of Object.entries(reg)) {
  const existing = await db.maybeOne("SELECT champion FROM registry_roles WHERE role=$1 AND champion IS NOT NULL", [role]);
  if (!existing) {
    const run = await db.one<{ id: string }>(
      "INSERT INTO eval_runs (role, suite, candidate, metric, metric_value) VALUES ($1,$2,$3,$4,0.01) RETURNING id",
      [role, r.eval_suite, r.candidates[0], r.selection_metric],
    );
    await setChampion(db, role as RoleId, r.candidates[0]!, run.id, 0.01);
  }
}

const deps: AgentDeps = { db, vault, forceMock: true };
const report: string[] = [];
const step = (s: string) => {
  report.push(s);
  console.log(s);
};

// --- 1. Ingest a prospect with provenance ---
const batch = await db.one<{ id: string }>(
  "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('demo','LIC-E2E',1,8,'e2e') RETURNING id",
);
const biz = await db.one<{ id: string }>(
  "INSERT INTO businesses (source_vendor, source_batch_id, name, category, country_code, region_code, city, segment, review_count, rating) VALUES ('demo',$1,'Ridgeline Roofing','roofer','US','R1','Boise','stale_site',64,4.6) RETURNING id",
  [batch.id],
);
// A distinct prospect per run. The frequency cap is keyed on identity
// (email_hash) rather than on a contact row, so reusing one address would — very
// correctly — get the fifth demo run denied at rule 7.
const runId = Date.now().toString(36);
const email = `owner+${runId}@ridgelineroofing.example`;
const contact = await db.one<{ id: string }>(
  "INSERT INTO contacts (business_id, email, email_hash, verification, subscriber_type) VALUES ($1,$2,$3,'valid','corporate') RETURNING id",
  [biz.id, email, emailHash(email)],
);
await db.query(
  "INSERT INTO provenance (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash, no_cem_statement, detector_version, relates_to_role, legal_basis) VALUES ($1,'https://ridgelineroofing.example',now(),'prov/e2e.png','h',true,'nocem-v1.0.0',true,'can_spam_optout')",
  [contact.id],
);
const campaign = await db.one<{ id: string }>(
  "INSERT INTO campaigns (name, region_code, enabled_markets) VALUES ('e2e','R1',$1) RETURNING id",
  [["US"]],
);
const lead = await db.one<{ id: string }>(
  "INSERT INTO leads (contact_id, campaign_id, state, workflow_id) VALUES ($1,$2,'INGESTED',$3) RETURNING id",
  [contact.id, campaign.id, `wf_${contact.id}`],
);
const conv = await db.one<{ id: string }>("INSERT INTO conversations (lead_id, channel) VALUES ($1,'email') RETURNING id", [lead.id]);
step("1. Ingested Ridgeline Roofing (Boise, roofer) with provenance evidence.");

// --- 2. Enrichment scoring ---
const enrich = await enrichmentAgent.run(
  { name: "Ridgeline Roofing", category: "roofer", segment: "stale_site", reviewCount: 64, listingText: "Family roofing since 2004." },
  deps,
  { subjectId: lead.id },
);
step(`2. Enrichment: icpScore ${enrich.result.icpScore}, previewWorthy ${enrich.result.previewWorthy} (model ${enrich.model}, $${enrich.costCents.toFixed(4)}).`);

// --- 3. Preview generation → render → reviewer gate ---
const preview = await previewAgent.run(
  { name: "Ridgeline Roofing", category: "roofer", city: "Boise", services: ["Roof repair", "Roof replacement", "Inspections"] },
  deps,
  { subjectId: lead.id },
);
const html = renderSite({
  family: "trades",
  business: { name: "Ridgeline Roofing", category: "roofer", city: "Boise", phone: "+12085550143", rating: 4.6, reviewCount: 64 },
  copy: preview.result,
  locale: "en-US",
  mode: "preview",
  legalEntity: "ADW Foundry Ltd",
  legalAddress: "123 Example St, Toronto",
  labelVersion: "label-v1",
  claimToken: "e2e-token",
  formAction: "https://p.adwpreview.com/claim",
});
const gateResult = reviewBuild(buildArtifactFromHtml(html));
step(`3. Preview generated (${(Buffer.byteLength(html) / 1024).toFixed(1)}KB) → reviewer gate ${gateResult.pass ? "PASS" : "FAIL"} (perf ${gateResult.results.lighthouse_perf}).`);
if (!gateResult.pass) throw new Error("preview failed the reviewer gate");
const previewRow = await db.one<{ id: string }>(
  "INSERT INTO previews (business_id, r2_key, deploy_url, claim_token, label_version, expires_at, cost_cents) VALUES ($1,'r2/e2e','https://p.adwpreview.com/e2e',$2,'label-v1', now() + interval '30 days',$3) RETURNING id",
  [biz.id, `claim-${lead.id}`, preview.costCents],
);

// --- 4. Gated cold send ---
const transport: EmailTransport = { async send() { return { messageId: `m-${lead.id}`, accepted: true }; } };
const msg: OutboundMessage = {
  contactId: contact.id,
  emailHash: emailHash(email),
  countryCode: "US",
  subscriberType: "corporate",
  channel: "email",
  messageClass: "cold",
  domainClass: "burner",
  campaignId: campaign.id,
  idempotencyKey: `e2e-${lead.id}-0`,
  localHour: 10,
  localWeekday: 2,
  body: `Hi, we built a preview of a website for Ridgeline Roofing. ADW Foundry Ltd, 123 Example St, Toronto. This message was drafted with the help of AI. See our privacy notice. To unsubscribe click here. https://p.adwpreview.com/e2e`,
  headers: { From: "hello@burner-demo.com", "List-Unsubscribe": "<https://p.adwpreview.com/u/e2e>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
};
const sent = await gatedSend({ message: msg, to: email, from: "hello@burner-demo.com", subject: "A website preview for Ridgeline Roofing", transport, conversationId: conv.id, roleId: "outreach_draft" }, { db });
step(`4. Cold send through the gate: ${sent.sent ? "SENT" : "BLOCKED"} (decision ${sent.decisionId.slice(0, 8)}).`);
if (!sent.sent) throw new Error("compliant cold send was blocked");

// --- 5. Positive reply → care agent classifies intent ---
const care = await careAgent.run({ message: "Yes I'm interested, how much?", exchangeCount: 1 }, deps, { subjectId: lead.id });
step(`5. Reply classified: intent ${care.result.intentScore}, stage ${care.result.stage}, quoteRequested ${care.result.quoteRequested}.`);

// --- 6. Finance quote (discount clamped) ---
const quote = await financeAgent.run({ region: "R1", scope: "standard", proposedDiscount: 0.5 }, deps, { subjectId: lead.id });
step(`6. Quote: $${(quote.result.buildFeeCents / 100).toFixed(0)} build + $${(quote.result.mrrCents / 100).toFixed(0)}/mo, discount clamped to ${(quote.result.discountPct * 100).toFixed(0)}%.`);

// --- 7. Full build through the durable workflow engine ---
// Registered from the PRODUCTION activity registry, not from stubs written here.
// That is the point of this step: it proves the same wiring the worker boots
// with can carry a build from assemble through both gates to a deploy. A stubbed
// e2e would pass just as happily with nothing implemented behind the names.
const engine = new Engine({ db, clock: new TestClock(0) });
registerActivities(engine, { db, vault, forceMock: true });
engine.registerWorkflow(buildWorkflow);
const buildId = `build-e2e-${Date.now()}`;
await engine.start("build", buildId, { businessId: biz.id, mode: "full" });
const buildOut = await engine.result<{ deployed: boolean; deployUrl?: string }>(buildId);
step(`7. Full build via durable workflow: ${buildOut.deployed ? "DEPLOYED" : "HALTED"} → ${buildOut.deployUrl ?? "-"}.`);
if (!buildOut.deployed) throw new Error("build did not deploy");

// --- 8. Verify the gate decision + message were recorded ---
const orphans = await db.one<{ n: string }>("SELECT count(*) AS n FROM messages WHERE direction='outbound' AND gate_decision_id IS NULL");
step(`8. Invariant check: ${orphans.n} outbound messages without a gate_decision_id (must be 0).`);
if (Number(orphans.n) !== 0) throw new Error("found a message without a gate decision");

void previewRow;
console.log("\n✅ END-TO-END DEMO PASSED — ingest → score → preview → gated send → reply → quote → build → deploy.");
await db.close();
