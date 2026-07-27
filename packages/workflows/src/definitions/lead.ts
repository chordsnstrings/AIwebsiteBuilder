// Lead lifecycle workflow (spec §34). Durable across the multi-week journey:
// score → preview → contact → sequence steps with durable timers → engage or
// cool down 180 days. Agents are activities; every timer is durable.
import type { WorkflowContext, WorkflowDefinition } from "../engine/index.ts";

const DAY = 24 * 60 * 60 * 1000;

export interface LeadInput {
  leadId: string;
  contactId: string;
  businessId: string;
}

export interface LeadOutput {
  finalState: string;
  contacted: boolean;
  previewGenerated: boolean;
}

export const leadWorkflow: WorkflowDefinition<LeadInput, LeadOutput> = {
  type: "lead",
  run: async (ctx: WorkflowContext, input: LeadInput): Promise<LeadOutput> => {
    // Score the lead (enrichment + site scoring).
    const scored = await ctx.activity<LeadInput, { icpScore: number; previewWorthy: boolean }>(
      "score_lead",
      input,
    );

    let previewGenerated = false;
    if (scored.previewWorthy) {
      await ctx.activity("generate_preview", input);
      previewGenerated = true;
    }

    // Contact (gate → send), sequence step 1.
    await ctx.activity("send_outreach", { ...input, step: 0 });

    // Wait for a reply, with sequence follow-ups on durable timers.
    for (let step = 1; step <= 3; step++) {
      const reply = await ctx.waitForSignal<{ intent: number }>("reply", step === 3 ? 14 * DAY : (step === 1 ? 4 : 5) * DAY);
      if (reply.received) {
        const intent = reply.payload?.intent ?? 0;
        if (intent >= 30) {
          await ctx.activity("mark_engaged", { ...input, intent });
          return { finalState: "ENGAGED", contacted: true, previewGenerated };
        }
        await ctx.activity("mark_parked", input);
        return { finalState: "PARKED", contacted: true, previewGenerated };
      }
      if (step < 3) {
        await ctx.activity("send_outreach", { ...input, step });
      }
    }

    // No response after the sequence → 180-day cooldown, then exhausted.
    await ctx.sleep("cooldown", 180 * DAY);
    await ctx.activity("mark_exhausted", input);
    return { finalState: "EXHAUSTED", contacted: true, previewGenerated };
  },
};
