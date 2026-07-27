// Sale, onboarding and delivery workflow (spec §36). The delivery email does not
// fire until integration verification passes; the guarantee is a keyword handler
// on the inbound rail, not part of this flow.
import type { WorkflowContext, WorkflowDefinition } from "../engine/index.ts";

const DAY = 24 * 60 * 60 * 1000;

export interface OnboardingInput {
  leadId: string;
  businessId: string;
  region: string;
}

export interface OnboardingOutput {
  customerId: string;
  delivered: boolean;
}

export const onboardingWorkflow: WorkflowDefinition<OnboardingInput, OnboardingOutput> = {
  type: "onboarding",
  run: async (ctx: WorkflowContext, input: OnboardingInput): Promise<OnboardingOutput> => {
    await ctx.activity("record_payment", input);
    const customer = await ctx.activity<OnboardingInput, { customerId: string }>("create_customer", input);
    await ctx.activity("run_full_build", { businessId: input.businessId, customerId: customer.customerId });
    await ctx.activity("register_domain", customer);
    await ctx.sleep("dns_propagation", 1 * DAY); // durable wait, capped at 48h in prod
    await ctx.activity("verify_ssl", customer);
    // Integration verification MUST pass before delivery.
    const verify = await ctx.activity<{ customerId: string }, { ok: boolean }>("integration_verify", customer);
    if (verify.ok) {
      await ctx.activity("send_delivery_email", customer);
      await ctx.activity("provision_dashboard", customer);
      return { customerId: customer.customerId, delivered: true };
    }
    await ctx.activity("raise_onboarding_exception", customer);
    return { customerId: customer.customerId, delivered: false };
  },
};
