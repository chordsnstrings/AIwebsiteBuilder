// Sale, onboarding and delivery workflow (spec §36). The delivery email does not
// fire until integration verification passes; the guarantee is a keyword handler
// on the inbound rail, not part of this flow.
import type { WorkflowContext, WorkflowDefinition } from "../engine/index.ts";
import { ROUNDS_INCLUDED, runRevision } from "./revision.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Spec §36 step 3 — the customer reviews the built site before the domain is
 * registered, and gets ROUNDS_INCLUDED revision rounds included in the price.
 *
 * Each round opens two durable waits. The engine parks on one signal name at a
 * time, so the short approval window comes first (an explicit "ship it" ends the
 * loop immediately and skips the remaining rounds) and the long change-request
 * window second. Only a change request loops: an approval and plain silence both
 * fall through to the domain step, which is the behaviour that matters — a
 * customer who says nothing still goes live.
 */
const APPROVAL_WINDOW_MS = 6 * HOUR;
const REVISION_WINDOW_MS = 3 * DAY;

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
}

export const onboardingWorkflow: WorkflowDefinition<OnboardingInput, OnboardingOutput> = {
  type: "onboarding",
  run: async (ctx: WorkflowContext, input: OnboardingInput): Promise<OnboardingOutput> => {
    await ctx.activity("record_payment", input);
    const customer = await ctx.activity<OnboardingInput, { customerId: string }>("create_customer", input);
    const build = await ctx.activity<{ businessId: string; customerId: string }, { buildId?: string } | null>(
      "run_full_build",
      { businessId: input.businessId, customerId: customer.customerId },
    );

    // --- Included revision rounds, BEFORE the domain is registered ----------
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
      // A halted revision (injection, hard fail, IP flag) has already raised an
      // exception for a human; the customer keeps their remaining rounds.
    }

    await ctx.activity("register_domain", customer);
    await ctx.sleep("dns_propagation", 1 * DAY); // durable wait, capped at 48h in prod
    await ctx.activity("verify_ssl", customer);
    // Integration verification MUST pass before delivery.
    const verify = await ctx.activity<{ customerId: string }, { ok: boolean }>("integration_verify", customer);
    if (verify.ok) {
      await ctx.activity("send_delivery_email", customer);
      await ctx.activity("provision_dashboard", customer);
      return { customerId: customer.customerId, delivered: true, revisionsApplied };
    }
    await ctx.activity("raise_onboarding_exception", customer);
    return { customerId: customer.customerId, delivered: false, revisionsApplied };
  },
};
