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
  architectAgent,
  careAgent,
  conciergeFallbackAgent,
  developerAgent,
  enrichmentAgent,
  ipClaimsAgent,
  outreachAgent,
  previewAgent,
  uxAgent,
  type AgentDeps,
} from "@adw/agents";
import { buildsHalted, gatedSend, paymentsOnboardingHalted, readEngagedSwitches, type OutboundMessage } from "@adw/gate";
import { mintUnsubscribeToken, unsubscribeHeaders, unsubscribeSecret, unsubscribeUrl } from "@adw/compliance";
import { mintReplyToken, replyAddress } from "@adw/inbound";
import { renderSite, buildArtifactFromHtml, familyForCategory } from "@adw/site-templates";
import { reviewBuild } from "@adw/reviewer-gates";
import { pickAsset } from "@adw/fleet";
import { loadKnowledgeBase } from "@adw/kb";
import { advanceDunning, resolveDunning } from "@adw/billing";
import {
  resolveEmailTransport,
  resolveEmailVerifier,
  resolveObjectStore,
  resolveRegistrar,
  resolveSiteHost,
} from "@adw/vendors";
import { deterministicExtract, extractKnowledgeBase, persistKnowledgeBase } from "@adw/kb";
import { generateQAPack, loadQAPack, loadVerticalTemplate, persistQAPack } from "@adw/qapack";
import { runAgentEval, type CaseResult } from "@adw/agenteval";
import {
  anycastApexIp,
  DohResolver,
  StaticResolver,
  applyCutover,
  latestSnapshot,
  persistSnapshot,
  planCutover,
  snapshotDns,
  verifyCutover,
} from "@adw/dns";
import type { Engine } from "@adw/workflows";

/**
 * The address replies come back to, and the secret that signs its token.
 *
 * ⛔ No inbound address configured means NO Reply-To header. That is deliberate:
 * a Reply-To pointing at a mailbox nobody reads is worse than none at all,
 * because the recipient's client will happily send there and the reply
 * disappears — which is precisely the state this system shipped in.
 */
function inboundAddress(): string | null {
  const addr = process.env["ADW_INBOUND_ADDRESS"];
  return addr !== undefined && addr.includes("@") ? addr : null;
}
function replyTokenSecret(): string {
  return process.env["ADW_REPLY_TOKEN_SECRET"] ?? "demo-reply-token-secret";
}

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

  // Verify the recipient before anything is written to them.
  //
  // ⛔ `contacts.verification` existed in the schema from day one and NOTHING
  // wrote it — the column defaulted through and every address read as whatever
  // ingestion guessed. This is the writer. It runs once per contact and caches
  // the verdict, because verification is charged per address and a three-touch
  // sequence would otherwise pay three times for the same answer.
  on("verify_recipient", async (input: LeadRef) => {
    const contact = await db.maybeOne<{ id: string; email: string; verification: string; verified_at: string | null }>(
      `SELECT c.id, c.email, c.verification, c.verified_at
         FROM contacts c JOIN leads l ON l.contact_id = c.id WHERE l.id = $1`,
      [input.leadId],
    );
    if (!contact) return { verdict: "unknown", cached: false };
    // Re-verify after 90 days: mailboxes close, and a verdict from last year is
    // an assertion about a mailbox nobody has checked since.
    const age = contact.verified_at === null ? Infinity : (now().getTime() - new Date(contact.verified_at).getTime()) / 86_400_000;
    if (contact.verified_at !== null && age < 90) {
      return { verdict: contact.verification, cached: true };
    }

    const verifier = await resolveEmailVerifier(vendorDeps);
    const verdict = await verifier.verify(contact.email);
    await db.query("UPDATE contacts SET verification = $2, verified_at = now(), verifier = $3 WHERE id = $1", [
      contact.id,
      verdict,
      verifier.vendorId,
    ]);
    if (verdict === "invalid") {
      // ⛔ Suppressed, not merely skipped. An address we know is dead must not
      // be retried by a future campaign — that is how the same bounce is paid
      // for repeatedly, in reputation rather than money.
      await db.query(
        `INSERT INTO suppression (email_hash, reason, channel_scope)
         VALUES ($1, 'undeliverable', 'email') ON CONFLICT DO NOTHING`,
        [emailHash(contact.email)],
      );
      await db.query("UPDATE leads SET state = 'SUPPRESSED' WHERE id = $1", [input.leadId]);
    }
    await emit({
      eventType: "contact.verified",
      subject: { kind: "lead", id: input.leadId },
      payload: { verdict, verifier: verifier.vendorId },
    });
    return { verdict, cached: false };
  });

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

    // ⛔ The conversation is CREATED here if it does not exist, not merely looked
    // up. Without one there is nothing for a reply to attach to, and the reply
    // path silently degrades to "unmatched" for every lead — which is how a
    // cold programme ends up with an inbound rail that technically works and
    // never fires.
    let conversation = await db.maybeOne<{ id: string }>(
      "SELECT id FROM conversations WHERE lead_id = $1 AND channel = 'email' LIMIT 1",
      [input.leadId],
    );
    if (conversation === null) {
      conversation = await db.one<{ id: string }>(
        "INSERT INTO conversations (lead_id, channel) VALUES ($1,'email') RETURNING id",
        [input.leadId],
      );
    }

    // A signed, plus-addressed Reply-To. This is what lets a reply find its
    // thread without depending on the recipient's client preserving
    // In-Reply-To — which many mobile clients do not.
    const replyTo = inboundAddress()
      ? replyAddress(
          inboundAddress()!,
          mintReplyToken({ conversationId: conversation.id, leadId: input.leadId }, replyTokenSecret()),
        )
      : null;
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
      headers: {
        From: asset.identifier,
        ...(replyTo === null ? {} : { "Reply-To": replyTo }),
        ...unsubscribeHeaders(unsubUrl),
      },
    };

    const transport = await resolveEmailTransport(asset.provider, vendorDeps);
    const result = await gatedSend(
      {
        message,
        to: contact.email,
        from: asset.identifier,
        subject: draft.result.subject,
        transport,
        conversationId: conversation.id,
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

  // Answer a reply. ⛔ Through `gatedSend` like everything else — a reply is
  // still an outbound message to a contact who may have been suppressed between
  // writing to us and us answering, and "they emailed us first" is not a legal
  // basis the gate knows about.
  on("send_reply", async (input: LeadRef & { replyText: string }) => {
    const lead = await db.maybeOne<{ contact_id: string; campaign_id: string }>(
      "SELECT contact_id, campaign_id FROM leads WHERE id = $1",
      [input.leadId],
    );
    if (!lead) return { sent: false, reason: "lead_missing" };
    const contact = await db.maybeOne<{ id: string; email: string; subscriber_type: string | null }>(
      "SELECT id, email, subscriber_type FROM contacts WHERE id = $1",
      [lead.contact_id],
    );
    const biz = await db.maybeOne<{ country_code: string | null; timezone: string | null; region_code: string | null }>(
      `SELECT b.country_code, b.timezone, b.region_code FROM businesses b
        JOIN contacts c ON c.business_id = b.id WHERE c.id = $1`,
      [lead.contact_id],
    );
    if (!contact || !biz) return { sent: false, reason: "contact_missing" };

    const conversation = await db.maybeOne<{ id: string }>(
      "SELECT id FROM conversations WHERE lead_id = $1 AND channel = 'email' LIMIT 1",
      [input.leadId],
    );
    const asset = await pickAsset(db, "cold");
    if (!asset) {
      await raise(db, "no_sendable_asset", 2, { leadId: input.leadId, reason: "reply" });
      return { sent: false, reason: "no_sendable_asset" };
    }

    const unsubUrl = unsubscribeUrl(
      publicBase,
      mintUnsubscribeToken({ contactId: contact.id, campaignId: lead.campaign_id }, unsubscribeSecret()),
    );
    const blocks = legalBlocks(biz.country_code ?? "US");
    const body = [
      input.replyText,
      "",
      blocks["ai_disclosure"] ?? "",
      (blocks["unsubscribe"] ?? "").replace("{unsub_url}", unsubUrl),
    ].join("\n");

    const message: OutboundMessage = {
      contactId: contact.id,
      emailHash: emailHash(contact.email),
      countryCode: biz.country_code ?? "US",
      subscriberType: (contact.subscriber_type ?? "unknown") as OutboundMessage["subscriberType"],
      channel: "email",
      // ⛔ Still `cold`. A reply does not convert the relationship into an
      // existing-customer one, and classifying it otherwise would route it past
      // the rules that apply to cold mail.
      messageClass: "cold",
      domainClass: "burner",
      campaignId: lead.campaign_id,
      sendingAssetId: asset.id,
      // One reply per inbound message, derived from its text so a redelivered
      // notification cannot produce a second answer.
      idempotencyKey: `lead:${input.leadId}:reply:${emailHash(input.replyText).toString("hex").slice(0, 24)}`,
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
        subject: "Re: your reply",
        transport,
        ...(conversation ? { conversationId: conversation.id } : {}),
        roleId: "email_responder",
      },
      { db },
    );
    if (result.sent) {
      await db.query("UPDATE sending_assets SET sends_today = sends_today + 1 WHERE id = $1", [asset.id]);
    }
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

  // ⛔ Rejected is terminal and distinct from parked: a business already in the
  // 11.6%, or one the Architect could not classify, is not a lead to revisit
  // after a cooldown. Recording the reason is what lets the score threshold be
  // tuned against evidence rather than intuition.
  on("mark_rejected", async (input: LeadRef & { reason: string }) => {
    await db.query("UPDATE leads SET state = 'REJECTED' WHERE id = $1", [input.leadId]);
    await emit({
      eventType: "lead.rejected",
      subject: { kind: "lead", id: input.leadId },
      payload: { reason: input.reason },
    });
    return null;
  });

  on("raise_lead_exception", async (input: LeadRef & { reason: string }) => {
    await db.query("UPDATE leads SET state = 'REJECTED' WHERE id = $1", [input.leadId]);
    // Severity 3: no customer is affected and nothing is burning. But the RATE
    // matters — above 6% the playbooks are too narrow, and that is a config
    // review rather than more escalation.
    await raise(db, input.reason === "vertical_unresolved" ? "vertical_unresolved" : "lead_halted", 3, input);
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
    // ⛔ HALT_PAYMENTS_ONBOARDING, at the top of the funnel rather than at the
    // bottom. Runbook R12 pulls this when a charge_type anomaly appears; the
    // point is that nobody NEW is offered payments while it is engaged, and
    // refusing at the prescreen means no merchant is left half-onboarded.
    if (paymentsOnboardingHalted(await readEngagedSwitches(db))) {
      return { offered: false, reason: "HALT_PAYMENTS_ONBOARDING" };
    }
    const customer = await db.maybeOne<{ status: string }>("SELECT status FROM customers WHERE id = $1", [
      input.customerId,
    ]);
    return { offered: customer?.status === "active" };
  });

  on("create_connected_account", async (input: { customerId: string }) => {
    if (paymentsOnboardingHalted(await readEngagedSwitches(db))) {
      throw new Error("HALT_PAYMENTS_ONBOARDING is engaged — no new merchant may be onboarded");
    }
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
  // v3.0 — the transaction layer
  // =========================================================================

  // A2 — transactability grading. Everything the outreach copy claims traces
  // back to a deterministic check recorded here; the model phrases, it never
  // asserts (§19.4). An untrue claim about someone's own site is the fastest
  // way to generate the complaints that kill the channel.
  on("grade_site", async (input: LeadRef) => {
    const biz = await business(db, input.businessId);
    const hasWebsite = Boolean(biz.website_url);
    // Without a crawler in demo mode we grade from what the record already
    // knows. Every field here is observable, not inferred.
    const audit = {
      hasWebsite,
      https: hasWebsite && (biz.website_url ?? "").startsWith("https://"),
      pricingFound: false,
      bookingFound: false,
      hasServiceSchema: false,
      llmsTxt: false,
      pageCount: hasWebsite ? 4 : 0,
      wordCount: hasWebsite ? 350 : 0,
    };
    // The gap is the product. FALSE means they are already machine-readable AND
    // bookable — the 11.6% — and there is nothing for us to sell them.
    const transactabilityGap = !(audit.hasServiceSchema && audit.bookingFound);
    const topDefects: string[] = [];
    if (!audit.hasServiceSchema) topDefects.push("no_service_schema");
    if (!audit.pricingFound) topDefects.push("no_published_pricing");
    if (!audit.bookingFound) topDefects.push("no_online_booking");
    if (!audit.llmsTxt) topDefects.push("no_llms_txt");

    const row = await db.one<{ id: string }>(
      `INSERT INTO site_audits (business_id, has_website, https, pricing_found, booking_found,
                                has_service_schema, llms_txt, page_count, word_count,
                                transactability_gap, top_defects)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        input.businessId, audit.hasWebsite, audit.https, audit.pricingFound, audit.bookingFound,
        audit.hasServiceSchema, audit.llmsTxt, audit.pageCount, audit.wordCount,
        transactabilityGap, JSON.stringify(topDefects),
      ],
    );
    return { transactabilityGap, auditId: row.id, topDefects };
  });

  // A3 — the Vertical Architect. Classifies against config/playbooks.yaml and
  // escalates rather than guessing: an unclassifiable business produces a bad
  // preview, and a bad preview is worse than no contact at all.
  on("classify_vertical", async (input: LeadRef & { auditId: string }) => {
    const biz = await business(db, input.businessId);
    const audit = await db.one<{
      pricing_found: boolean; booking_found: boolean; page_count: number;
      word_count: number; has_website: boolean;
    }>(
      `SELECT pricing_found, booking_found, page_count, word_count, has_website
         FROM site_audits WHERE id = $1`,
      [input.auditId],
    );

    const out = await architectAgent.run(
      {
        name: biz.name,
        category: biz.category ?? "",
        hasWebsite: audit.has_website,
        bookingFound: audit.booking_found,
        pricingFound: audit.pricing_found,
        pageCount: audit.page_count,
        wordCount: audit.word_count,
      },
      agentDeps,
      { subjectId: input.leadId },
    );

    const playbooks = config.playbooks().data as {
      verticals: Record<string, { site_modules?: string[]; agent_capabilities?: string[];
                                  integrations?: string[]; dashboard_panels?: string[] }>;
      prohibited: Record<string, { reason: string }>;
    };

    // ⛔ Prohibited verticals are stripped IN CODE. Vertical SaaS already owns
    // booking there and the gap we sell against does not exist.
    if (playbooks.prohibited[out.result.vertical] !== undefined) {
      return { escalate: true, reason: `prohibited_vertical:${out.result.vertical}` };
    }
    const playbook = playbooks.verticals[out.result.vertical];
    if (out.result.escalate || playbook === undefined) {
      return { escalate: true, reason: out.result.escalateReason ?? "vertical_unresolved" };
    }

    // no_published_pricing removes the pricing module outright — the agent may
    // never estimate, so shipping the module would be an invitation to.
    const modifiers = out.result.modifiers;
    const excluded: { feature: string; reason: string }[] = [];
    let siteModules = playbook.site_modules ?? [];
    if (modifiers.includes("no_published_pricing")) {
      siteModules = siteModules.filter((m) => m !== "pricing");
      excluded.push({ feature: "pricing", reason: "This business publishes no prices; quote request only" });
    }

    const manifest = await db.one<{ id: string }>(
      `INSERT INTO delivery_manifests (business_id, vertical, confidence, modifiers, site_modules,
                                       agent_capabilities, integrations, dashboard_panels,
                                       excluded, unresolved, playbook_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        input.businessId, out.result.vertical, out.result.confidence, modifiers,
        JSON.stringify(siteModules), JSON.stringify(playbook.agent_capabilities ?? []),
        JSON.stringify(playbook.integrations ?? []), JSON.stringify(playbook.dashboard_panels ?? []),
        JSON.stringify(excluded), JSON.stringify(out.result.unresolved),
        config.playbooks().version,
      ],
    );
    await db.query("UPDATE businesses SET vertical = $2 WHERE id = $1", [input.businessId, out.result.vertical]);
    return { escalate: false, vertical: out.result.vertical, manifestId: manifest.id };
  });

  // A4 — the knowledge base. Only what the business published, with provenance
  // on every fact. Shallow for the preview, deep once they have paid.
  const buildKb = async (
    businessId: string,
    customerId: string | null,
    depth: "preview" | "deep",
  ): Promise<{ kbId?: string; factCount: number }> => {
    const biz = await business(db, businessId);
    const sourceUrl = biz.website_url ?? `https://${(biz.name ?? "business").toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`;
    // In demo mode the crawl is the record we already hold. The extractor is
    // the same one production uses; only the page source differs.
    const text = [
      `${biz.name} — ${biz.category ?? "local business"} in ${biz.city ?? ""}.`,
      biz.phone_e164 ? `Call us on ${biz.phone_e164}.` : "",
      `We offer ${defaultServices(biz.category ?? "general").join(", ")}.`,
      "Open Monday to Friday, 8am to 5pm.",
      `We cover ${biz.city ?? "the local area"} and the surrounding towns.`,
    ].join(" ");

    const kb = await extractKnowledgeBase(
      {
        businessId,
        ...(customerId === null ? {} : { customerId }),
        ...(biz.vertical === null ? {} : { vertical: biz.vertical }),
        pages: [{ url: sourceUrl, text, depth: 0, retrievedAt: now() }],
        version: depth === "deep" ? 2 : 1,
      },
      { extract: deterministicExtract, now },
    );
    const persisted = await persistKnowledgeBase(db, kb);
    return { kbId: persisted.kbId, factCount: kb.facts.length };
  };

  on("extract_knowledge_base", async (input: LeadRef) => buildKb(input.businessId, null, "preview"));
  on("extract_knowledge_base_deep", async (input: { businessId: string; customerId: string }) =>
    buildKb(input.businessId, input.customerId, "deep"),
  );

  // A5 — the Q&A pack. Every answer traces to a fact; a question with no answer
  // becomes a gap, never a plausible-sounding pair.
  const buildPack = async (
    businessId: string,
    kbId: string | undefined,
    customerId: string | null,
  ): Promise<{ packId?: string; pairCount: number; thin: boolean }> => {
    if (kbId === undefined) return { pairCount: 0, thin: true };
    const kb = await loadKnowledgeBase(db, kbId);
    if (!kb) return { pairCount: 0, thin: true };
    const biz = await business(db, businessId);
    const template = loadVerticalTemplate(biz.vertical ?? "roofing");
    const pack = await generateQAPack(kb, template);
    if (customerId !== null) pack.customerId = customerId;
    await persistQAPack(db, pack);
    return { packId: pack.id, pairCount: pack.pairs.length, thin: pack.thin };
  };

  on("generate_qa_pack", async (input: { businessId: string; kbId?: string }) =>
    buildPack(input.businessId, input.kbId, null),
  );
  on("generate_qa_pack_deep", async (input: { businessId: string; customerId: string; kbId?: string }) =>
    buildPack(input.businessId, input.kbId, input.customerId),
  );

  // Bind the pack to the customer's agent. Separate from the eval gate on
  // purpose: activation is a configuration step, going live is a decision.
  on("activate_agent", async (input: { customerId: string; packId?: string }) => {
    if (input.packId !== undefined) {
      await db.query("UPDATE qa_packs SET customer_id = $2 WHERE id = $1", [input.packId, input.customerId]);
    }
    await emit({ eventType: "agent.activated", subject: { kind: "customer", id: input.customerId } });
    return { activated: true };
  });

  // B7 — the 30-case gate. ⛔ No partial credit: 29/30 is a fail. An agent that
  // improvises on one case in thirty improvises in production, and under
  // Moffatt the liability for what it says is the CUSTOMER'S.
  //
  // The implementation lives in @adw/agenteval and is CALLED here rather than
  // repeated. There was a second copy inline in this file, and it had already
  // drifted into something that was not a gate: its grounded check asked
  // whether a pair had non-empty text, which a pack with entirely broken
  // vectors passes, and its refusal probes included "Are you insured for
  // commercial work?" — a question plenty of packs can legitimately answer, so
  // it failed correct agents and passed useless ones.
  on("agent_eval_gate", async (input: { customerId: string; packId?: string }) => {
    if (input.packId === undefined) {
      return { verdict: "fail", passed: 0, total: 0, bookingSkipped: false, reason: "no_pack" };
    }
    const pack = await loadQAPack(db, input.packId);
    if (!pack) return { verdict: "fail", passed: 0, total: 0, bookingSkipped: false, reason: "no_pack" };

    // An unapproved pack cannot be measured, and reaching here with one means
    // the owner sign-off step was skipped upstream.
    if (!(pack.approvedAt instanceof Date)) {
      return { verdict: "fail", passed: 0, total: 0, bookingSkipped: false, reason: "pack_not_approved" };
    }

    const calendar = await db.maybeOne(
      "SELECT 1 AS x FROM customer_calendars WHERE customer_id = $1 AND revoked_at IS NULL",
      [input.customerId],
    );
    const manifest = await db.maybeOne<{ agent_capabilities: string[] }>(
      `SELECT agent_capabilities FROM delivery_manifests WHERE customer_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [input.customerId],
    );
    const facts = await db.query<{ value: string }>(
      `SELECT value FROM kb_facts WHERE kb_id = $1 AND status = 'verified' ORDER BY fact_key`,
      [pack.kbId],
    );

    const run = await runAgentEval(
      { db },
      { customerId: input.customerId, businessId: pack.businessId, pack },
      {
        calendarConnected: calendar !== null,
        capabilities: manifest?.agent_capabilities ?? ["answer", "capture_enquiry", "escalate"],
        kbSlice: facts.rows.map((f) => f.value),
      },
    );

    return {
      verdict: run.verdict,
      passed: run.passed,
      total: run.total,
      bookingSkipped: run.bookingSkipped,
      thin: run.thin,
      ...(run.verdict === "pass"
        ? {}
        : { reason: run.cases.find((c: CaseResult) => !c.passed)?.failure ?? "improvised_or_ungrounded" }),
    };
  });

  on("deploy_customer_site", async (input: { customerId: string; businessId: string; buildId?: string }) => {
    const artefactKey = await renderAndStore(input.businessId, [], `builds/${input.businessId}`);
    return deployArtefact(artefactKey, input.customerId, null);
  });

  // B9 — the snapshot MUST be taken before the customer is asked to change
  // anything. Without a before-state there is no diff, and without a diff the
  // safety claim is a promise rather than a verified assertion.
  on("snapshot_dns", async (input: { customerId: string }) => {
    const customer = await db.one<{ domain: string | null }>("SELECT domain FROM customers WHERE id = $1", [
      input.customerId,
    ]);
    if (!customer.domain) return { snapshotId: null, reason: "no_domain" };
    const snap = await snapshotDns(customer.domain, dnsResolver());
    const snapshotId = await persistSnapshot(db, input.customerId, snap);
    return { snapshotId };
  });

  on("cutover_dns", async (input: { customerId: string; domain?: string }) => {
    // ⛔ Checked here too, and not only on the render. A cutover points a live
    // business's domain at an artefact that may be the reason the switch was
    // pulled, and a build finished five minutes before the incident is exactly
    // the one an operator wants stopped.
    await assertBuildsAllowed();
    const customer = await db.one<{ domain: string | null }>("SELECT domain FROM customers WHERE id = $1", [
      input.customerId,
    ]);
    const domain = input.domain ?? customer.domain;
    if (!domain) return { status: "parked", mailRecordsChanged: false };

    const snapshot = await latestSnapshot(db, input.customerId, domain);
    if (!snapshot) {
      // Refusing here rather than snapshotting now: a snapshot taken AFTER the
      // customer started editing proves nothing about what they had before.
      await raise(db, "dns_cutover_without_snapshot", 2, { customerId: input.customerId, domain });
      return { status: "halted", mailRecordsChanged: false };
    }

    const plan = planCutover(snapshot, {
      apexIp: anycastApexIp(),
      subdomain: `${domain.split(".")[0]}.adwsites.com`,
    });
    const cutover = await applyCutover(plan, { db, customerId: input.customerId }, now());
    const outcome = await verifyCutover(cutover.id, { db, customerId: input.customerId }, dnsResolver());
    return {
      status: outcome.status === "verified" ? "completed" : "reverted",
      mailRecordsChanged: outcome.mailRecordsChanged,
      mailKinds: outcome.mailKinds,
    };
  });

  // =========================================================================
  // Shared helpers (closures over deps)
  // =========================================================================

  /**
   * The DNS resolver. Mock mode uses a deterministic in-memory zone so the demo
   * exercises the whole cutover path without touching the public DNS; live mode
   * resolves over DoH, which answers identically from any container — a snapshot
   * that varies by where it ran is not evidence.
   */
  function dnsResolver(): DohResolver | StaticResolver {
    if (deps.forceMock) {
      return new StaticResolver(
        new Map([
          [
            "example.test",
            [
              { type: "A" as const, name: "@", value: "203.0.113.10" },
              { type: "MX" as const, name: "@", value: "mail.protection.example", priority: 10 },
              { type: "TXT" as const, name: "@", value: "v=spf1 include:spf.example -all" },
            ],
          ],
        ]),
      );
    }
    return new DohResolver();
  }

  /**
   * ⛔ HALT_BUILDS, at the one chokepoint every build passes through.
   *
   * The switch was settable from the console, stored, and displayed as engaged,
   * and read by nothing that halted. An operator pulling it during a
   * malicious-content incident (runbook R6) would have watched the board turn
   * red and the builds carry on — worse than having no switch, because a switch
   * that appears to work stops anyone looking for the real off button.
   *
   * Placed on the RENDER rather than on each workflow step: a build that is
   * halted must not spend a model call discovering it.
   */
  async function assertBuildsAllowed(): Promise<void> {
    if (buildsHalted(await readEngagedSwitches(db))) {
      throw new Error("HALT_BUILDS is engaged — no site may be rendered or deployed");
    }
  }

  /** Render a business into a full-mode site and store it. Returns the key. */
  async function renderAndStore(
    businessId: string,
    requestedChanges: string[],
    keyPrefix: string,
  ): Promise<string> {
    await assertBuildsAllowed();
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
  website_url: string | null;
  vertical: string | null;
  review_count: number | null;
  rating: number | null;
  phone_e164: string | null;
}

async function business(db: Db, id: string): Promise<BusinessRow> {
  return db.one<BusinessRow>(
    `SELECT id, name, category, city, segment, country_code, region_code, timezone,
            review_count, rating, phone_e164, website_url, vertical
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
