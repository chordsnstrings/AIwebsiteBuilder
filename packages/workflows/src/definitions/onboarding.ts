// Sale, onboarding and delivery — Pipeline C (spec §47, agent-workflow §4).
//
//   payment → deep KB → deep pack → build → revisions → agent activation
//           → AGENT EVAL GATE → deploy → integration verify → DELIVERY EMAIL
//           → dashboard → DNS cutover (optional, after the customer has both)
//
// Two structural guarantees, both enforced by the shape of this function rather
// than by a conditional an agent could influence:
//
//   1. ⛔ The delivery email is unreachable except from a PASSING agent eval
//      gate. Telling a customer their agent is live when it improvises about
//      their licensing is the worst available first experience — and under
//      Moffatt v. Air Canada the liability for what their agent says is THEIRS.
//
//   2. ⛔ The DNS cutover is not on the critical path. `business.adwsites.com`
//      is live, HTTPS, agent-enabled and complete from the moment of the
//      speculative preview, so delivery does not depend on touching their
//      domain. That removes the one step we cannot automate from the one flow
//      we can, and it means a customer who declines cutover still has the whole
//      product.
import type { WorkflowContext, WorkflowDefinition } from "../engine/index.ts";
import { ROUNDS_INCLUDED, runRevision } from "./revision.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Spec §47 step 3 — the customer reviews before anything touches their domain,
 * and gets ROUNDS_INCLUDED rounds included in the price.
 *
 * Each round opens two durable waits. The engine parks on one signal name at a
 * time, so the short approval window comes first (an explicit "ship it" ends the
 * loop immediately) and the long change-request window second. Only a change
 * request loops: approval and silence both fall through, which is the behaviour
 * that matters — a customer who says nothing still goes live.
 */
const APPROVAL_WINDOW_MS = 6 * HOUR;
const REVISION_WINDOW_MS = 3 * DAY;

/** How long we wait for the customer to approve the DNS cutover before parking. */
const CUTOVER_APPROVAL_WINDOW_MS = 10 * DAY;

export interface OnboardingInput {
  leadId: string;
  businessId: string;
  region: string;
}

export interface OnboardingOutput {
  customerId: string;
  delivered: boolean;
  /** Included revision rounds that produced a redeployed site. */
  revisionsApplied: number;
  /** False when the 30-case gate failed — delivery is then unreachable. */
  agentLive: boolean;
  /** 'declined', 'parked' and 'halted' are ordinary outcomes, not failures —
   *  'halted' means the cutover refused itself (e.g. no DNS snapshot exists for
   *  the requested domain) and raised for a person, with the delivered site
   *  untouched on its subdomain. */
  cutover: "completed" | "declined" | "parked" | "reverted" | "halted" | "not_attempted";
}

interface EvalGateResult {
  verdict: "pass" | "fail";
  passed: number;
  total: number;
  /** Set when no calendar was connected: ship with booking disabled. */
  bookingSkipped: boolean;
  reason?: string;
}

interface CutoverResult {
  // ⛔ Matches what the activity actually returns. "halted" (no snapshot for
  // the requested domain — refused, exception raised) and "parked" (no domain
  // to move) were being returned by the activity while this union claimed they
  // could not be, and the out-of-union value flowed silently into the output.
  status: "completed" | "reverted" | "parked" | "halted";
  mailRecordsChanged: boolean;
}

export const onboardingWorkflow: WorkflowDefinition<OnboardingInput, OnboardingOutput> = {
  type: "onboarding",
  run: async (ctx: WorkflowContext, input: OnboardingInput): Promise<OnboardingOutput> => {
    await ctx.activity("record_payment", input);
    const customer = await ctx.activity<OnboardingInput, { customerId: string }>("create_customer", input);
    const scope = { customerId: customer.customerId, businessId: input.businessId };

    // A4' / A5' — the deep pass. The preview's pack was built from a shallow
    // crawl; a paying customer gets a comprehensive one, 150-250 pairs.
    const kb = await ctx.activity<typeof scope, { kbId?: string }>("extract_knowledge_base_deep", scope);
    const pack = await ctx.activity<typeof scope & { kbId?: string }, { packId?: string; thin: boolean }>(
      "generate_qa_pack_deep",
      { ...scope, ...(kb.kbId === undefined ? {} : { kbId: kb.kbId }) },
    );

    const build = await ctx.activity<typeof scope & { packId?: string }, { buildId?: string } | null>(
      "run_full_build",
      { ...scope, ...(pack.packId === undefined ? {} : { packId: pack.packId }) },
    );

    // --- Included revision rounds, BEFORE anything is announced -------------
    let buildId = build?.buildId ?? "";
    let revisionsApplied = 0;
    for (let round = 1; round <= ROUNDS_INCLUDED; round++) {
      const approval = await ctx.waitForSignal<{ approvedBy?: string }>("approved", APPROVAL_WINDOW_MS);
      if (approval.received) break; // "go live" — stop asking for changes
      const change = await ctx.waitForSignal<{ requestText: string }>("revision_requested", REVISION_WINDOW_MS);
      if (!change.received) break; // silence — the customer is happy
      const outcome = await runRevision(ctx, {
        customerId: customer.customerId,
        businessId: input.businessId,
        buildId,
        requestText: change.payload?.requestText ?? "",
        round,
      });
      if (outcome.applied && outcome.buildId) {
        buildId = outcome.buildId;
        revisionsApplied++;
      }
      // A halted revision has already raised an exception for a human; the
      // customer keeps their remaining rounds.
    }

    // --- Agent activation, then the gate that decides whether it is live ----
    await ctx.activity("activate_agent", { ...scope, ...(pack.packId === undefined ? {} : { packId: pack.packId }) });

    const gate = await ctx.activity<typeof scope & { packId?: string }, EvalGateResult>("agent_eval_gate", {
      ...scope,
      ...(pack.packId === undefined ? {} : { packId: pack.packId }),
    });

    // ⛔ No partial credit. 29/30 is a fail, and everything downstream of here —
    // deploy, cutover, the delivery email — is unreachable without a pass.
    if (gate.verdict !== "pass") {
      await ctx.activity("raise_onboarding_exception", {
        ...scope,
        reason: gate.reason ?? "agent_eval_failed",
        passed: gate.passed,
        total: gate.total,
      });
      return {
        customerId: customer.customerId,
        delivered: false,
        revisionsApplied,
        agentLive: false,
        cutover: "not_attempted",
      };
    }

    await ctx.activity("deploy_customer_site", { ...scope, buildId });

    // The snapshot is taken BEFORE the customer is asked to change anything:
    // without a before-state there is no diff, and without a diff the safety
    // claim is a promise rather than a verified assertion.
    await ctx.activity("snapshot_dns", scope);

    // Verification runs against the subdomain, which is the origin that is
    // live right now. A declined cutover is a complete product, not a degraded
    // one, so this is the check that gates delivery — not the cutover.
    const verify = await ctx.activity<typeof scope, { ok: boolean }>("integration_verify", scope);
    if (!verify.ok) {
      await ctx.activity("raise_onboarding_exception", { ...scope, reason: "integration_verification_failed" });
      return {
        customerId: customer.customerId,
        delivered: false,
        revisionsApplied,
        agentLive: true,
        cutover: "not_attempted",
      };
    }

    // ⛔ DELIVERY BEFORE THE CUTOVER WINDOW, NOT AFTER IT. This used to sit on
    // the far side of a ten-day `cutover_approved` wait, with the dashboard
    // provisioned later still — so the ordinary customer, the one the header
    // above promises a complete product without touching their domain, was told
    // their site was live TEN DAYS after it went live, and the dashboard
    // holding the cutover-approval button did not exist during the only window
    // in which approving was possible. The header's own guarantee, inverted by
    // ordering: the cutover was off the critical path in every way except the
    // one the customer experiences.
    await ctx.activity("send_delivery_email", { ...scope, bookingSkipped: gate.bookingSkipped });
    await ctx.activity("provision_dashboard", scope);

    // --- DNS cutover. Off the critical path, and now genuinely so -----------
    // The customer has the delivery email and a live dashboard; this parks
    // waiting for them to ask for their own domain, and silence is an ordinary
    // outcome that changes nothing they already have.
    const approvedCutover = await ctx.waitForSignal<{ domain: string }>(
      "cutover_approved",
      CUTOVER_APPROVAL_WINDOW_MS,
    );

    let cutover: OnboardingOutput["cutover"] = "declined";
    if (approvedCutover.received) {
      const result = await ctx.activity<typeof scope & { domain?: string }, CutoverResult>("cutover_dns", {
        ...scope,
        ...(approvedCutover.payload?.domain === undefined ? {} : { domain: approvedCutover.payload.domain }),
      });
      cutover = result.status;
      if (result.mailRecordsChanged) {
        // The worst thing this system can do to a customer. The activity has
        // already reverted; this raises the SEV1 and stops the flow announcing
        // a successful cutover on top of it.
        await ctx.activity("raise_onboarding_exception", { ...scope, reason: "mail_records_changed" });
      }
    }

    return { customerId: customer.customerId, delivered: true, revisionsApplied, agentLive: true, cutover };
  },
};
