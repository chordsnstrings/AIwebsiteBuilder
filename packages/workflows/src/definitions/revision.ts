// Customer revision workflow (spec §36 step 3). This is the loop that closes
// "the customer asked for a change" back onto "the revised site is live".
//
// It carries the same structural guarantee as the build pipeline: deploy is
// unreachable except from a passing reviewer gate AND a clean IP screen, and it
// is the workflow shape — not a conditional an agent could talk its way past —
// that enforces it. One extra hazard exists here that the build pipeline does
// not have: the input is free text written by a customer, so it is untrusted.
// A suspected prompt injection stops before the developer ever sees it.
import type { WorkflowContext, WorkflowDefinition } from "../engine/index.ts";

/** Revision rounds included in the price. Beyond this a round is quoted. */
export const ROUNDS_INCLUDED = 3;

/** True when `round` is past the included allowance (rounds are 1-based). */
export function revisionRoundsExceeded(round: number): boolean {
  return round > ROUNDS_INCLUDED;
}

export interface RevisionInput {
  customerId: string;
  businessId: string;
  /** The build being revised — the new build's parent. */
  buildId: string;
  /** Verbatim customer prose. Untrusted. */
  requestText: string;
  /** 1-based round number. */
  round: number;
}

export type RevisionHaltReason =
  | "injection_suspected"
  | "hard_fail"
  | "reviewer_unresolved"
  | "ip_flag"
  | "rounds_exhausted";

export interface RevisionOutput {
  applied: boolean;
  round: number;
  buildId?: string;
  url?: string;
  reason?: RevisionHaltReason;
}

/** What the Care agent turns the customer's free text into. */
export interface StructuredChangeRequest {
  requestedChanges: string[];
  injectionSuspected: boolean;
}

interface GateResult {
  pass: boolean;
  hardFail: boolean;
}

/**
 * The revision activity sequence. Shared so the standalone revision workflow and
 * the revision rounds embedded in onboarding run byte-for-byte the same steps —
 * there is exactly one path from a change request to a deploy.
 */
export async function runRevision(ctx: WorkflowContext, input: RevisionInput): Promise<RevisionOutput> {
  // 0. Rounds past the included allowance are quoted commercially, never built
  //    silently. Nothing below this line runs — in particular, no deploy.
  if (revisionRoundsExceeded(input.round)) {
    return { applied: false, round: input.round, reason: "rounds_exhausted" };
  }

  // 1. Care structures the free text. The customer's prose is untrusted input;
  //    a suspected injection halts here, so the developer and the deploy step
  //    are never reached with attacker-controlled instructions.
  const structured = await ctx.activity<RevisionInput, StructuredChangeRequest>(
    "structure_change_request",
    input,
  );
  if (structured.injectionSuspected) {
    await ctx.activity("raise_revision_exception", { ...input, reason: "injection_suspected" });
    return { applied: false, round: input.round, reason: "injection_suspected" };
  }

  // 2. Developer produces the revised artefact from the structured changes.
  const revised = await ctx.activity<
    RevisionInput & { requestedChanges: string[] },
    { artefactKey: string }
  >("apply_revision", { ...input, requestedChanges: structured.requestedChanges });

  // 3. Reviewer gate — the same deterministic contract the build pipeline uses.
  //    Patch loop capped at 2 iterations.
  let gate = await ctx.activity<{ artefactKey: string }, GateResult>("reviewer_gate", revised);
  let patches = 0;
  while (!gate.pass && !gate.hardFail && patches < 2) {
    await ctx.activity("patch_build", revised);
    gate = await ctx.activity("reviewer_gate", revised);
    patches++;
  }
  if (gate.hardFail) {
    await ctx.activity("raise_revision_exception", { ...input, reason: "hard_fail" });
    return { applied: false, round: input.round, reason: "hard_fail" };
  }
  if (!gate.pass) {
    await ctx.activity("raise_revision_exception", { ...input, reason: "reviewer_unresolved" });
    return { applied: false, round: input.round, reason: "reviewer_unresolved" };
  }

  // 4. IP / claims screen — a flag is a hard stop → human.
  const ip = await ctx.activity<{ artefactKey: string }, { verdict: string }>("ip_screen", revised);
  if (ip.verdict === "flag") {
    await ctx.activity("raise_revision_exception", { ...input, reason: "ip_flag" });
    return { applied: false, round: input.round, reason: "ip_flag" };
  }

  // 5. Deploy the revision — reachable only from here, past both gates.
  const deployed = await ctx.activity<
    { artefactKey: string; parentBuildId: string; customerId: string; businessId: string },
    { buildId: string; url: string }
  >("deploy_revision", {
    artefactKey: revised.artefactKey,
    parentBuildId: input.buildId,
    customerId: input.customerId,
    businessId: input.businessId,
  });

  return { applied: true, round: input.round, buildId: deployed.buildId, url: deployed.url };
}

export const revisionWorkflow: WorkflowDefinition<RevisionInput, RevisionOutput> = {
  type: "revision",
  run: (ctx: WorkflowContext, input: RevisionInput): Promise<RevisionOutput> => runRevision(ctx, input),
};
