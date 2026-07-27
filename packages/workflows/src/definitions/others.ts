// Subscription, payments onboarding, deliverability loop and eval loop workflows
// (spec §37–38, §12, §22). Kept compact; the domain logic lives in the fleet,
// billing, payments and evals packages and is invoked here as activities.
import type { WorkflowContext, WorkflowDefinition } from "../engine/index.ts";

const DAY = 24 * 60 * 60 * 1000;

// --- Subscription lifecycle (spec §37) -------------------------------------
export interface SubscriptionInput {
  subscriptionId: string;
}
export const subscriptionWorkflow: WorkflowDefinition<SubscriptionInput, { state: string }> = {
  type: "subscription",
  run: async (ctx: WorkflowContext, input: SubscriptionInput): Promise<{ state: string }> => {
    // Wait for a lifecycle event (payment failure, cancel, refund) or renew.
    const ev = await ctx.waitForSignal<{ kind: string }>("lifecycle", 30 * DAY);
    if (!ev.received) {
      await ctx.activity("renew_subscription", input);
      return { state: "RENEWED" };
    }
    switch (ev.payload?.kind) {
      case "payment_failed":
        await ctx.activity("start_dunning", input);
        return { state: "DUNNING" };
      case "cancel":
        await ctx.activity("cancel_at_period_end", input);
        return { state: "CANCELLED_AT_PERIOD_END" };
      case "refund":
        await ctx.activity("process_refund", input);
        return { state: "REFUNDED" };
      default:
        return { state: "ACTIVE" };
    }
  },
};

// --- Payments onboarding (spec §38) ----------------------------------------
export interface PaymentsOnboardingInput {
  customerId: string;
}
export const paymentsOnboardingWorkflow: WorkflowDefinition<PaymentsOnboardingInput, { state: string }> = {
  type: "payments_onboarding",
  run: async (ctx: WorkflowContext, input: PaymentsOnboardingInput): Promise<{ state: string }> => {
    const pre = await ctx.activity<PaymentsOnboardingInput, { offered: boolean }>("payments_prescreen", input);
    if (!pre.offered) return { state: "NOT_OFFERED" };
    const acct = await ctx.activity<PaymentsOnboardingInput, { accountId: string }>("create_connected_account", input);
    // Wait for the merchant to finish embedded onboarding.
    const done = await ctx.waitForSignal<{ chargesEnabled: boolean }>("charges_enabled", 10 * DAY);
    if (!done.received || !done.payload?.chargesEnabled) return { state: "STALLED" };
    // §14.2.8 integration test before anyone is told payments are live.
    const test = await ctx.activity<{ accountId: string }, { passed: boolean }>("payments_integration_test", acct);
    if (!test.passed) {
      await ctx.activity("raise_payments_exception", acct);
      return { state: "INTEGRATION_FAILED" };
    }
    return { state: "PAY_ACTIVE" };
  },
};

// --- Deliverability control loop (spec §22) — runs every 15 minutes --------
export const deliverabilityLoopWorkflow: WorkflowDefinition<{ tick: number }, { done: boolean }> = {
  type: "deliverability_loop",
  run: async (ctx: WorkflowContext, input: { tick: number }): Promise<{ done: boolean }> => {
    await ctx.activity("evaluate_fleet_health", input);
    // In production this continues-as-new every 15 minutes; the demo runs one tick.
    return { done: true };
  },
};

// --- Eval loop (spec §11) — nightly sweep ----------------------------------
export const evalLoopWorkflow: WorkflowDefinition<{ tick: number }, { done: boolean }> = {
  type: "eval_loop",
  run: async (ctx: WorkflowContext, input: { tick: number }): Promise<{ done: boolean }> => {
    await ctx.activity("run_nightly_evals", input);
    return { done: true };
  },
};
