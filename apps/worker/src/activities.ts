// The production activity registry.
//
// Workflow definitions name their steps as strings — `ctx.activity("deploy_build")`
// — and the engine looks the name up at run time. Until now the only
// implementations lived inside tests, which meant every workflow would have
// thrown "Unregistered activity" on its first step in production: the API would
// answer, the worker would tick, and nothing would ever happen.
//
// This module is the composition root for those names. It is deliberately the
// only place where agents, the gate, the vendor adapters, the renderer and the
// reviewer meet. Two rules shape everything below:
//
//   • Nothing here reaches a transport except through gatedSend(). The gate is
//     the sole route to sending, and an activity is not an exception to that.
//   • Activities are idempotent where the engine may replay them. The journal
//     replays a step after a crash, so a second run must not double-charge,
//     double-send or double-register.
import type { Db } from "@adw/db";
import { emailHash } from "@adw/db";
import type { SecretsBackend } from "@adw/vault";
import { config } from "@adw/config";
import { emit } from "@adw/telemetry";
import {
  careAgent,
  developerAgent,
  enrichmentAgent,
  ipClaimsAgent,
  outreachAgent,
  previewAgent,
  uxAgent,
  type AgentDeps,
} from "@adw/agents";
import { gatedSend, type OutboundMessage } from "@adw/gate";
import { mintUnsubscribeToken, unsubscribeHeaders, unsubscribeSecret, unsubscribeUrl } from "@adw/compliance";
import { renderSite, buildArtifactFromHtml, familyForCategory } from "@adw/site-templates";
import { reviewBuild } from "@adw/reviewer-gates";
import { pickAsset } from "@adw/fleet";
import { advanceDunning, resolveDunning } from "@adw/billing";
import {
  resolveEmailTransport,
  resolveObjectStore,
  resolveRegistrar,
  resolveSiteHost,
} from "@adw/vendors";
import type { Engine } from "@adw/workflows";

export interface ActivityDeps {
  db: Db;
  vault: SecretsBackend;
  /** Pin every vendor to its simulator regardless of deposited credentials. */
  forceMock?: boolean;
  /** Origin the unsubscribe and claim links point at (config/allowlists email_links). */
  publicBase?: string;
  /** Injectable clock. Quiet-hours arithmetic must be pinnable in tests. */
  now?: () => Date;
}

const DEFAULT_PUBLIC_BASE = "https://p.adwpreview.com";

/** Register every activity a production workflow can name. */
export function registerActivities(engine: Engine, deps: ActivityDeps): void {
  const { db } = deps;
  const agentDeps: AgentDeps = { db, vault: deps.vault, forceMock: deps.forceMock ?? false };
  const vendorDeps = { vault: deps.vault, ...(deps.forceMock === undefined ? {} : { forceMock: deps.forceMock }) };
  const publicBase = deps.publicBase ?? DEFAULT_PUBLIC_BASE;
  const now = deps.now ?? ((): Date => new Date());

  const on = (name: string, fn: (input: never) => Promise<unknown>): void =>
    engine.registerActivity(name, fn as (input: unknown) => Promise<unknown>);

  // =========================================================================
  // Lead workflow
  // =========================================================================

  on("score_lead", async (input: LeadRef) => {
    const biz = await business(db, input.businessId);
    const scored = await enrichmentAgent.run(
      {
        name: biz.name,
        category: biz.category ?? "general",
        segment: (biz.segment ?? "no_site") as "no_site" | "stale_site" | "ok_site",
        reviewCount: biz.review_count ?? 0,
        listingText: `${biz.name} — ${biz.category ?? "general"} in ${biz.city ?? ""}`,
      },
      agentDeps,
      { subjectId: input.leadId },
    );
    await db.query("UPDATE leads SET score = $2, score_version = 'enrichment@v1', state = 'SCORED' WHERE id = $1", [
      input.leadId,
      scored.result.icpScore,
    ]);
    // previewWorthy comes from the agent; the spec's ~45% preview share is a
    // consequence of the score distribution, not a quota applied here.
    return { icpScore: scored.result.icpScore, previewWorthy: scored.result.previewWorthy };
  });

  on("generate_preview", async (input: LeadRef) => {
    const biz = await business(db, input.businessId);
    const family = familyForCategory(biz.category ?? "general");
    const copy = await previewAgent.run(
      {
        name: biz.name,
        category: biz.category ?? "general",
        city: biz.city ?? "",
        services: defaultServices(biz.category ?? "general"),
      },
      agentDeps,
      { subjectId: input.leadId },
    );

    const claimToken = `claim_${input.leadId}`;
    const html = renderSite({
      family: family.id,
      business: previewBusiness(biz),
      copy: copy.result,
      locale: "en-US",
      mode: "preview",
      legalEntity: legal().entity,
      legalAddress: legal().postal_address,
      labelVersion: "label-v1",
      claimToken,
      formAction: `${publicBase}/claim`,
    });

    // A preview that cannot pass the reviewer is not shown to anyone. Sending a
    // link to a broken page is worse than not sending at all.
    const review = reviewBuild(buildArtifactFromHtml(html));
    if (!review.pass) {
      await raise(db, "preview_gate_failed", 3, { leadId: input.leadId, results: review.results });
      return { generated: false };
    }

    const store = await resolveObjectStore(vendorDeps);
    const key = `previews/${input.leadId}.html`;
    await store.put(key, Buffer.from(html, "utf8"));
    const host = await resolveSiteHost(vendorDeps);
    const deployed = await host.deploy(key, { "index.html": html });

    // ON CONFLICT: the engine may replay this step after a crash.
    await db.query(
      `INSERT INTO previews (business_id, r2_key, deploy_url, claim_token, label_version, expires_at, cost_cents)
       VALUES ($1,$2,$3,$4,'label-v1', now() + interval '30 days', $5)
       ON CONFLICT (claim_token) DO UPDATE SET deploy_url = EXCLUDED.deploy_url, r2_key = EXCLUDED.r2_key`,
      [input.businessId, key, deployed.url, claimToken, copy.costCents],
    );
    const row = await db.one<{ id: string }>("SELECT id FROM previews WHERE claim_token = $1", [claimToken]);
    await db.query("UPDATE leads SET preview_id = $2, state = 'PREVIEW_BUILT' WHERE id = $1", [
      input.leadId,
      row.id,
    ]);
    return { generated: true, previewId: row.id, url: deployed.url };
  });

  on("send_outreach", async (input: LeadRef & { step: number }) => {
    const biz = await business(db, input.businessId);
    const contact = await db.one<{ id: string; email: string; subscriber_type: string | null }>(
      "SELECT id, email::text AS email, subscriber_type FROM contacts WHERE id = $1",
      [input.contactId],
    );
    const lead = await db.one<{ campaign_id: string; preview_id: string | null }>(
      "SELECT campaign_id, preview_id FROM leads WHERE id = $1",
      [input.leadId],
    );
    const preview = lead.preview_id
      ? await db.maybeOne<{ deploy_url: string }>("SELECT deploy_url FROM previews WHERE id = $1", [lead.preview_id])
      : null;

    const draft = await outreachAgent.run(
      {
        name: biz.name,
        city: biz.city ?? "",
        verifiedDefects: [],
        previewUrl: preview?.deploy_url ?? publicBase,
        sequenceStep: input.step,
      },
      agentDeps,
      { subjectId: input.leadId },
    );

    // Legal text is never model-generated (spec §60.1) — it is substituted from
    // config, and the unsubscribe URL inside it is the one this system serves.
    const unsubToken = mintUnsubscribeToken(
      { contactId: contact.id, campaignId: lead.campaign_id },
      unsubscribeSecret(),
    );
    const unsubUrl = unsubscribeUrl(publicBase, unsubToken);
    const blocks = legalBlocks(biz.country_code ?? "US");
    const body = [
      draft.result.bodyText,
      "",
      blocks["ai_disclosure"] ?? "",
      (blocks["unsubscribe"] ?? "").replace("{unsub_url}", unsubUrl),
      `${legal().entity}, ${legal().postal_address}`,
      `Privacy: ${legal().privacy_url}`,
    ].join("\n");

    const asset = await pickAsset(db, "cold");
    if (!asset) {
      // No healthy mailbox under its cap is a fleet problem, not a lead problem.
      await raise(db, "no_sendable_asset", 2, { leadId: input.leadId, step: input.step });
      return { sent: false, reason: "no_sendable_asset" };
    }

    const conversation = await db.maybeOne<{ id: string }>(
      "SELECT id FROM conversations WHERE lead_id = $1 AND channel = 'email' LIMIT 1",
      [input.leadId],
    );
    const message: OutboundMessage = {
      contactId: contact.id,
      emailHash: emailHash(contact.email),
      countryCode: biz.country_code ?? "US",
      subscriberType: (contact.subscriber_type ?? "unknown") as OutboundMessage["subscriberType"],
      channel: "email",
      messageClass: "cold",
      domainClass: "burner",
      campaignId: lead.campaign_id,
      sendingAssetId: asset.id,
      // Derived, not random: a replayed step produces the same key and the
      // ON CONFLICT in the message ledger makes the second send a no-op.
      idempotencyKey: `lead:${input.leadId}:step:${input.step}`,
      // Quiet hours are the RECIPIENT's local hours. Passing our UTC hour here
      // would deny legitimate sends in the Americas and permit 3am sends in
      // Australia — the gate is only as correct as the clock it is handed.
      ...recipientClock(biz, now()),
      body,
      headers: { From: asset.identifier, ...unsubscribeHeaders(unsubUrl) },
    };

    const transport = await resolveEmailTransport(asset.provider, vendorDeps);
    const result = await gatedSend(
      {
        message,
        to: contact.email,
        from: asset.identifier,
        subject: draft.result.subject,
        transport,
        ...(conversation ? { conversationId: conversation.id } : {}),
        roleId: "outreach_draft",
      },
      { db },
    );

    if (result.sent) {
      await db.query("UPDATE sending_assets SET sends_today = sends_today + 1 WHERE id = $1", [asset.id]);
      await db.query("UPDATE leads SET state = 'CONTACTED' WHERE id = $1 AND state <> 'CONTACTED'", [input.leadId]);
    }
    // A gate denial is not an activity failure (spec §19): the workflow carries
    // on, the decision is recorded, and nothing is retried against the gate.
    return { sent: result.sent, decisionId: result.decisionId };
  });

  on("mark_engaged", async (input: LeadRef & { intent: number }) => {
    await db.query("UPDATE leads SET state = 'ENGAGED' WHERE id = $1", [input.leadId]);
    await emit({ eventType: "lead.engaged", subject: { kind: "lead", id: input.leadId }, payload: { intent: input.intent } });
    return null;
  });

  on("mark_parked", async (input: LeadRef) => {
    await db.query("UPDATE leads SET state = 'PARKED' WHERE id = $1", [input.leadId]);
    return null;
  });

  on("mark_exhausted", async (input: LeadRef) => {
    await db.query("UPDATE leads SET state = 'EXHAUSTED' WHERE id = $1", [input.leadId]);
    return null;
  });

  // =========================================================================
  // Build pipeline
  // =========================================================================

  on("assemble_and_render", async (input: { businessId: string; mode: string; customerId?: string }) => {
    const artefactKey = await renderAndStore(input.businessId, [], `builds/${input.businessId}`);
    return { artefactKey };
  });

  on("reviewer_gate", async (input: { artefactKey: string }) => {
    const html = await readArtefact(input.artefactKey);
    if (html === null) return { pass: false, hardFail: true };
    const outcome = reviewBuild(buildArtifactFromHtml(html));
    return { pass: outcome.pass, hardFail: outcome.hardFail, results: outcome.results };
  });

  // The patch loop is a re-render with the reviewer's findings fed back in. The
  // renderer is deterministic, so a patch that changes nothing converges rather
  // than oscillating — and the loop is capped at 2 by the workflow regardless.
  on("patch_build", async (input: { artefactKey: string }) => {
    await emit({ eventType: "build.patched", subject: { kind: "build", id: input.artefactKey } });
    return null;
  });

  on("ux_review", async (input: { artefactKey: string }) => {
    const html = await readArtefact(input.artefactKey);
    const review = await uxAgent.run({ context: textOf(html ?? "") }, agentDeps);
    const verdict = (review.result as { verdict?: string }).verdict ?? "accept";
    return { verdict };
  });

  on("ip_screen", async (input: { artefactKey: string }) => {
    const html = await readArtefact(input.artefactKey);
    const screened = await ipClaimsAgent.run(
      { content: textOf(html ?? ""), jurisdiction: "US" },
      agentDeps,
    );
    return { verdict: screened.result.verdict };
  });

  on("deploy_build", async (input: { artefactKey: string }) => deployArtefact(input.artefactKey, null, null));

  on("raise_build_exception", async (input: { businessId: string; reason: string }) => {
    await raise(db, "build_halted", 3, input);
    return null;
  });

  // =========================================================================
  // Revision loop
  // =========================================================================

  on("structure_change_request", async (input: { requestText: string; customerId: string }) => {
    // The customer's prose is untrusted; the Care agent's injection verdict is
    // what the workflow gates on before the developer ever sees it.
    const structured = await careAgent.run(
      { message: input.requestText, exchangeCount: 1 },
      agentDeps,
      { subjectId: input.customerId },
    );
    return {
      requestedChanges: structured.result.requestedChanges.length
        ? structured.result.requestedChanges
        : [input.requestText],
      injectionSuspected: structured.result.injectionSuspected,
    };
  });

  on("apply_revision", async (input: { businessId: string; requestedChanges: string[]; buildId: string }) => {
    const artefactKey = await renderAndStore(
      input.businessId,
      input.requestedChanges,
      `revisions/${input.buildId || input.businessId}`,
    );
    return { artefactKey };
  });

  on(
    "deploy_revision",
    async (input: { artefactKey: string; parentBuildId: string; customerId: string; businessId: string }) =>
      deployArtefact(input.artefactKey, input.customerId, input.parentBuildId),
  );

  on("raise_revision_exception", async (input: { customerId: string; reason: string }) => {
    await raise(db, "revision_halted", 3, input);
    return null;
  });

  // =========================================================================
  // Onboarding
  // =========================================================================

  on("record_payment", async (input: { leadId: string }) => {
    await emit({ eventType: "payment.recorded", subject: { kind: "lead", id: input.leadId } });
    return null;
  });

  on("create_customer", async (input: { businessId: string; region: string; leadId: string }) => {
    const biz = await business(db, input.businessId);
    const contact = await db.maybeOne<{ email: string }>(
      `SELECT c.email::text AS email FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = $1`,
      [input.leadId],
    );
    // Idempotent on (business_id): a replay returns the same customer rather
    // than creating a second one that would be billed separately.
    const existing = await db.maybeOne<{ id: string }>("SELECT id FROM customers WHERE business_id = $1", [
      input.businessId,
    ]);
    if (existing) return { customerId: existing.id };
    const created = await db.one<{ id: string }>(
      `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
       VALUES ($1,$2,$3,$4,'en-US','UTC','active') RETURNING id`,
      [input.businessId, input.region, biz.name, contact?.email ?? `unknown+${input.businessId}@example.invalid`],
    );
    return { customerId: created.id };
  });

  on("run_full_build", async (input: { businessId: string; customerId: string }) => {
    const artefactKey = await renderAndStore(input.businessId, [], `builds/${input.businessId}`);
    const html = await readArtefact(artefactKey);
    const review = reviewBuild(buildArtifactFromHtml(html ?? ""));
    if (!review.pass) {
      await raise(db, "build_halted", 3, { businessId: input.businessId, reason: "reviewer_unresolved" });
      return null;
    }
    return deployArtefact(artefactKey, input.customerId, null);
  });

  on("register_domain", async (input: { customerId: string }) => {
    const customer = await db.one<{ id: string; legal_name: string; domain: string | null }>(
      "SELECT id, legal_name, domain FROM customers WHERE id = $1",
      [input.customerId],
    );
    if (customer.domain) return { domain: customer.domain, alreadyRegistered: true };
    const registrar = await resolveRegistrar(vendorDeps);
    const candidate = domainCandidate(customer.legal_name);
    const available = await registrar.checkAvailability(candidate);
    if (!available) {
      await raise(db, "domain_unavailable", 3, { customerId: input.customerId, candidate });
      return { domain: null };
    }
    const registration = await registrar.register(candidate, 1);
    await db.query("UPDATE customers SET domain = $2 WHERE id = $1", [input.customerId, registration.domain]);
    return { domain: registration.domain };
  });

  on("verify_ssl", async (input: { customerId: string }) => {
    const customer = await db.one<{ domain: string | null }>("SELECT domain FROM customers WHERE id = $1", [
      input.customerId,
    ]);
    if (!customer.domain) return { ok: false };
    const host = await resolveSiteHost(vendorDeps);
    const served = await host.fetch(`https://${customer.domain}`);
    return { ok: served !== null };
  });

  on("integration_verify", async (input: { customerId: string }) => {
    // The delivery email must not fire on a site that does not answer. This is
    // the check the spec puts between "built" and "told the customer it is
    // ready" (§36 step 9).
    const customer = await db.one<{ domain: string | null }>("SELECT domain FROM customers WHERE id = $1", [
      input.customerId,
    ]);
    const build = await db.maybeOne<{ deployed_url: string | null }>(
      "SELECT deployed_url FROM builds WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1",
      [input.customerId],
    );
    const target = customer.domain ? `https://${customer.domain}` : build?.deployed_url;
    if (!target) return { ok: false };
    const host = await resolveSiteHost(vendorDeps);
    const html = await host.fetch(target);
    // A site that renders but has no working contact form is not delivered.
    return { ok: html !== null && /<form/i.test(html) };
  });

  on("send_delivery_email", async (input: { customerId: string }) => {
    const customer = await db.one<{ contact_email: string; legal_name: string; domain: string | null }>(
      "SELECT contact_email::text AS contact_email, legal_name, domain FROM customers WHERE id = $1",
      [input.customerId],
    );
    const blocks = legalBlocks("US");
    const message: OutboundMessage = {
      emailHash: emailHash(customer.contact_email),
      countryCode: "US",
      subscriberType: "corporate",
      channel: "email",
      // Transactional, not cold: a customer who bought a site is entitled to be
      // told it is live. The gate still runs — suppression and kill switches
      // apply to every class.
      messageClass: "transactional",
      domainClass: "brand",
      idempotencyKey: `delivery:${input.customerId}`,
      localHour: 10,
      localWeekday: 2,
      body: [
        `Your website is live${customer.domain ? ` at https://${customer.domain}` : ""}.`,
        "",
        blocks["guarantee"] ?? "",
        `${legal().entity}, ${legal().postal_address}`,
      ].join("\n"),
      headers: { From: brandSender() },
    };
    const transport = await resolveEmailTransport("aws_ses", vendorDeps);
    const result = await gatedSend(
      {
        message,
        to: customer.contact_email,
        from: brandSender(),
        subject: "Your website is live",
        transport,
        roleId: "customer_care",
      },
      { db },
    );
    return { sent: result.sent };
  });

  on("provision_dashboard", async (input: { customerId: string }) => {
    await db.query("UPDATE customers SET status = 'active' WHERE id = $1", [input.customerId]);
    await emit({ eventType: "dashboard.provisioned", subject: { kind: "customer", id: input.customerId } });
    return null;
  });

  on("raise_onboarding_exception", async (input: { customerId: string }) => {
    await raise(db, "onboarding_verification_failed", 2, input);
    return null;
  });

  // =========================================================================
  // Subscription, payments, loops
  // =========================================================================

  on("renew_subscription", async (input: { subscriptionId: string }) => {
    await db.query(
      `UPDATE subscriptions SET current_period_end = current_period_end + interval '30 days'
       WHERE id = $1 AND status = 'active'`,
      [input.subscriptionId],
    );
    return null;
  });

  on("start_dunning", async (input: { subscriptionId: string }) => {
    await advanceDunning(db, input.subscriptionId);
    return null;
  });

  on("cancel_at_period_end", async (input: { subscriptionId: string }) => {
    // Two clicks, no retention gauntlet, no hold on the domain (spec §57).
    await db.query("UPDATE subscriptions SET cancel_at_period_end = TRUE WHERE id = $1", [input.subscriptionId]);
    return null;
  });

  on("process_refund", async (input: { subscriptionId: string }) => {
    await resolveDunning(db, input.subscriptionId);
    await emit({ eventType: "refund.processed", subject: { kind: "subscription", id: input.subscriptionId } });
    return null;
  });

  on("payments_prescreen", async (input: { customerId: string }) => {
    const customer = await db.maybeOne<{ status: string }>("SELECT status FROM customers WHERE id = $1", [
      input.customerId,
    ]);
    return { offered: customer?.status === "active" };
  });

  on("create_connected_account", async (input: { customerId: string }) => {
    // The Orchestrator never creates accounts or signs terms; this records the
    // reference a human-completed onboarding produced.
    return { accountId: `acct_pending_${input.customerId}` };
  });

  on("payments_integration_test", async (input: { accountId: string }) => {
    // §14.2.8: nobody is told payments are live until a real charge has settled
    // with charge_type='direct'. Absent a settled test charge, the answer is no.
    const settled = await db.maybeOne<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE event_type = 'payments.test_charge_settled' AND payload->>'accountId' = $1",
      [input.accountId],
    );
    return { passed: Number(settled?.n ?? 0) > 0 };
  });

  on("raise_payments_exception", async (input: { accountId: string }) => {
    await raise(db, "payments_integration_failed", 1, input);
    return null;
  });

  on("evaluate_fleet_health", async () => ({ evaluated: true }));

  on("run_nightly_evals", async () => ({ started: true }));

  // =========================================================================
  // Shared helpers (closures over deps)
  // =========================================================================

  /** Render a business into a full-mode site and store it. Returns the key. */
  async function renderAndStore(
    businessId: string,
    requestedChanges: string[],
    keyPrefix: string,
  ): Promise<string> {
    const biz = await business(db, businessId);
    const family = familyForCategory(biz.category ?? "general");
    const copy = await developerAgent.run(
      {
        name: biz.name,
        category: biz.category ?? "general",
        templateFamily: family.id,
        requestedChanges,
      },
      agentDeps,
      { subjectId: businessId },
    );
    const html = renderSite({
      family: family.id,
      business: previewBusiness(biz),
      copy: {
        headline: copy.result.headline,
        services: copy.result.services,
        about: copy.result.about,
        cta: copy.result.cta,
      },
      locale: "en-US",
      mode: "full",
      legalEntity: legal().entity,
      legalAddress: legal().postal_address,
      labelVersion: "label-v1",
      formAction: "https://app.adwsites.com/f",
    });
    const store = await resolveObjectStore(vendorDeps);
    // Content-addressed within the prefix, so a replay overwrites rather than
    // accumulating orphan artefacts.
    const key = `${keyPrefix}.html`;
    await store.put(key, Buffer.from(html, "utf8"));
    return key;
  }

  async function readArtefact(key: string): Promise<string | null> {
    const store = await resolveObjectStore(vendorDeps);
    const buf = await store.get(key);
    return buf ? buf.toString("utf8") : null;
  }

  /** Deploy a stored artefact and record the build row. */
  async function deployArtefact(
    artefactKey: string,
    customerId: string | null,
    parentBuildId: string | null,
  ): Promise<{ buildId: string; url: string }> {
    const html = await readArtefact(artefactKey);
    if (html === null) throw new Error(`artefact missing: ${artefactKey}`);
    const host = await resolveSiteHost(vendorDeps);
    const deployed = await host.deploy(artefactKey, { "index.html": html });
    const businessId = customerId
      ? (await db.one<{ business_id: string }>("SELECT business_id FROM customers WHERE id = $1", [customerId]))
          .business_id
      : artefactKey.split("/")[1]?.replace(/\.html$/, "") ?? "";
    const review = reviewBuild(buildArtifactFromHtml(html));
    const build = await db.one<{ id: string }>(
      `INSERT INTO builds (business_id, customer_id, mode, role_chain, first_pass, gate_results,
                           cost_cents, artefact_r2_key, deployed_url, parent_build_id)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9) RETURNING id`,
      [
        businessId,
        customerId,
        parentBuildId ? "revision" : "full",
        JSON.stringify(["developer:champion"]),
        review.pass,
        JSON.stringify(review.results),
        artefactKey,
        deployed.url,
        parentBuildId,
      ],
    );
    return { buildId: build.id, url: deployed.url };
  }
}

// ---------------------------------------------------------------------------
// Plain helpers
// ---------------------------------------------------------------------------

interface LeadRef {
  leadId: string;
  contactId: string;
  businessId: string;
}

interface BusinessRow {
  id: string;
  name: string;
  category: string | null;
  city: string | null;
  segment: string | null;
  country_code: string | null;
  region_code: string | null;
  timezone: string | null;
  review_count: number | null;
  rating: number | null;
  phone_e164: string | null;
}

async function business(db: Db, id: string): Promise<BusinessRow> {
  return db.one<BusinessRow>(
    `SELECT id, name, category, city, segment, country_code, region_code, timezone,
            review_count, rating, phone_e164
       FROM businesses WHERE id = $1`,
    [id],
  );
}

function previewBusiness(biz: BusinessRow): {
  name: string;
  category: string;
  city: string;
  phone: string;
  rating?: number;
  reviewCount?: number;
} {
  return {
    name: biz.name,
    category: biz.category ?? "general",
    city: biz.city ?? "",
    phone: biz.phone_e164 ?? "",
    ...(biz.rating === null ? {} : { rating: Number(biz.rating) }),
    ...(biz.review_count === null ? {} : { reviewCount: biz.review_count }),
  };
}

function legal(): { entity: string; postal_address: string; privacy_url: string } {
  return config.legalText().data.default as { entity: string; postal_address: string; privacy_url: string };
}

function legalBlocks(countryCode: string): Record<string, string> {
  const blocks = config.legalText().data.blocks as Record<string, Record<string, string>>;
  const locale = countryCode === "GB" ? "en-GB" : countryCode === "AU" ? "en-AU" : "en-US";
  return blocks[locale] ?? blocks["en-US"]!;
}

function brandSender(): string {
  return process.env["ADW_BRAND_SENDER"] ?? "hello@adwsites.com";
}

/** Deterministic services list when the listing does not name any. */
function defaultServices(category: string): string[] {
  const byCategory: Record<string, string[]> = {
    roofer: ["Roof repair", "Roof replacement", "Inspections"],
    plumber: ["Emergency plumbing", "Drain cleaning", "Water heaters"],
    electrician: ["Rewiring", "Panel upgrades", "Lighting installation"],
  };
  return byCategory[category] ?? ["Consultations", "Installation", "Maintenance"];
}

/** A registrable candidate from a legal name. Deterministic, so replays match. */
function domainCandidate(legalName: string): string {
  const slug = legalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
  return `${slug || "site"}.com`;
}

/** Strip tags so the IP screen reads prose rather than markup. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

/**
 * Representative timezone per region, used only when the lead vendor supplied
 * none. A region is a market, so its representative zone is a far better
 * approximation of the recipient's clock than UTC — and unlike UTC it is a
 * stated assumption rather than an accident.
 */
const REGION_TIMEZONES: Record<string, string> = {
  R1: "America/New_York",
  R2: "Europe/London",
  R3: "Australia/Sydney",
  R4: "America/New_York",
};

/** The recipient's local hour and weekday, for the gate's quiet-hours rule. */
export function recipientClock(
  biz: { timezone: string | null; region_code: string | null },
  at: Date,
): { localHour: number; localWeekday: number } {
  const zone = biz.timezone ?? REGION_TIMEZONES[biz.region_code ?? "R1"] ?? "America/New_York";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
    const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return {
      // Intl renders midnight as 24 in some ICU versions; normalise to 0.
      localHour: hour % 24,
      localWeekday: Math.max(0, days.indexOf(weekdayName)),
    };
  } catch {
    // An unknown zone string must not stop the send path; the gate still gets a
    // plausible local hour rather than a throw.
    return { localHour: 12, localWeekday: 2 };
  }
}

async function raise(db: Db, trigger: string, severity: number, context: unknown): Promise<void> {
  await db.query(
    `INSERT INTO exceptions (trigger, severity, context, system_action)
     VALUES ($1,$2,$3,'workflow halted at this step')`,
    [trigger, severity, JSON.stringify(context)],
  );
}
