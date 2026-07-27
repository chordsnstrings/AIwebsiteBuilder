// Build pipeline workflow (spec §35). Reviewer gate runs BEFORE UX review;
// deploy is unreachable except from a passing IP screen — enforced by the
// workflow structure, not a conditional the agent could influence.
import type { WorkflowContext, WorkflowDefinition } from "../engine/index.ts";

export interface BuildInput {
  businessId: string;
  mode: "preview" | "full" | "revision";
  customerId?: string;
}

export interface BuildOutput {
  deployed: boolean;
  deployUrl?: string;
  buildId?: string;
  haltedReason?: string;
}

export const buildWorkflow: WorkflowDefinition<BuildInput, BuildOutput> = {
  type: "build",
  run: async (ctx: WorkflowContext, input: BuildInput): Promise<BuildOutput> => {
    // 1-3. Assemble context, generate copy, render.
    const rendered = await ctx.activity<BuildInput, { artefactKey: string }>("assemble_and_render", input);

    // 4. Reviewer gate (deterministic). Patch loop up to 2 iterations.
    let gate = await ctx.activity<{ artefactKey: string }, { pass: boolean; hardFail: boolean }>(
      "reviewer_gate",
      rendered,
    );
    let patches = 0;
    while (!gate.pass && !gate.hardFail && patches < 2) {
      await ctx.activity("patch_build", rendered);
      gate = await ctx.activity("reviewer_gate", rendered);
      patches++;
    }
    if (gate.hardFail) {
      await ctx.activity("raise_build_exception", { ...input, reason: "hard_fail" });
      return { deployed: false, haltedReason: "hard_fail" };
    }
    if (!gate.pass) {
      await ctx.activity("raise_build_exception", { ...input, reason: "reviewer_unresolved" });
      return { deployed: false, haltedReason: "reviewer_unresolved" };
    }

    // 5. UX review (after the reviewer gate).
    const ux = await ctx.activity<{ artefactKey: string }, { verdict: string }>("ux_review", rendered);
    if (ux.verdict === "reject") {
      await ctx.activity("raise_build_exception", { ...input, reason: "ux_reject" });
      return { deployed: false, haltedReason: "ux_reject" };
    }

    // 6. IP / claims screen — a flag is a hard stop → human.
    const ip = await ctx.activity<{ artefactKey: string }, { verdict: string }>("ip_screen", rendered);
    if (ip.verdict === "flag") {
      await ctx.activity("raise_build_exception", { ...input, reason: "ip_flag" });
      return { deployed: false, haltedReason: "ip_flag" };
    }

    // 7. Deploy (deterministic, content-addressed) — reachable only here.
    const deploy = await ctx.activity<{ artefactKey: string }, { buildId: string; url: string }>(
      "deploy_build",
      rendered,
    );
    return { deployed: true, deployUrl: deploy.url, buildId: deploy.buildId };
  },
};
