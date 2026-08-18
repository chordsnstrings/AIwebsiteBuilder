// Lead lifecycle workflow — Pipeline A (spec §45, agent-workflow §2).
//
//   ingest → A1 enrich → A2 grade → A3 architect → A4 KB → A5 Q&A
//          → A6 preview + live agent → E1 gate → A7 outreach → transport
//
// What changed in v3: the pitch is no longer "here is a website you don't have"
// — 92-98% of them already have one. It is "here is an AI receptionist that
// already knows your business; ask it what you charge." That is only possible
// because A4 and A5 run BEFORE contact, so the preview ships with a working
// agent bound to facts extracted from what the business itself published.
//
// The ordering is not cosmetic. Each step can reject, and the expensive ones
// are last: grading rejects the 11.6% who are already agent-ready, the Architect
// rejects what it cannot classify, and both run before a single preview token is
// spent. Target: under 12 minutes elapsed, ~$0.13 on a score-gated lead.
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
  /** True when the preview shipped with a live agent bound to a Q&A pack. */
  agentBound: boolean;
  rejectedReason?: string;
}

interface ScoreResult {
  icpScore: number;
  previewWorthy: boolean;
}

interface GradeResult {
  /** False means they are already machine-readable AND bookable. */
  transactabilityGap: boolean;
  auditId: string;
  topDefects: string[];
}

interface ArchitectResult {
  escalate: boolean;
  vertical?: string;
  manifestId?: string;
  reason?: string;
}

interface SegmentResult {
  segment: "smb_local" | "enterprise_global";
  speculativePreview: boolean;
}

interface PackResult {
  packId?: string;
  pairCount: number;
  thin: boolean;
}

export const leadWorkflow: WorkflowDefinition<LeadInput, LeadOutput> = {
  type: "lead",
  run: async (ctx: WorkflowContext, input: LeadInput): Promise<LeadOutput> => {
    // A0 — is this address even real?
    //
    // ⛔ First, before any spend. Verification is the cheapest step in the
    // pipeline and the only one that protects the sending domain — grading a
    // site, classifying a vertical and generating a preview for a mailbox that
    // does not exist spends model budget to produce a bounce, and a bounce is a
    // deposit against a reputation that took 21 days to build and cannot be
    // rebuilt faster.
    const verified = await ctx.activity<LeadInput, { verdict: string }>("verify_recipient", input);
    if (verified.verdict === "invalid") {
      return {
        finalState: "SUPPRESSED",
        contacted: false,
        previewGenerated: false,
        agentBound: false,
        rejectedReason: "undeliverable_address",
      };
    }

    // A1 — enrichment. Cheap, runs on every lead.
    const scored = await ctx.activity<LeadInput, ScoreResult>("score_lead", input);

    if (!scored.previewWorthy) {
      // Below the preview threshold: a text-only pitch, no generation spend.
      // This threshold is the single largest cost lever in acquisition.
      //
      // ⛔ No audit has run on this branch, so there are no verified defects and
      // no preview. Both are stated explicitly rather than left to a default:
      // the activity used to substitute the foundry's own homepage for the
      // missing preview URL, so "the text-only pitch" was in fact a preview
      // pitch pointing at our marketing site.
      await ctx.activity("send_outreach", { ...input, step: 0, topDefects: [] });
      return await waitOutSequence(ctx, input, { previewGenerated: false, agentBound: false, topDefects: [] });
    }

    // A2 — transactability grading. The audit is what makes the outreach copy
    // true; every claim in it traces to a deterministic check here.
    const graded = await ctx.activity<LeadInput, GradeResult>("grade_site", input);

    // ⛔ Already machine-readable and bookable. They are the 11.6% and the gap
    // we sell against does not exist for them. Rejecting costs nothing; pitching
    // them costs a complaint and the copy would have to be untrue to work.
    if (!graded.transactabilityGap) {
      await ctx.activity("mark_rejected", { ...input, reason: "already_transactable" });
      return {
        finalState: "REJECTED",
        contacted: false,
        previewGenerated: false,
        agentBound: false,
        rejectedReason: "already_transactable",
      };
    }

    // A3 — the Vertical Architect decides what this business would actually
    // receive. It escalates rather than guessing: an unclassifiable business
    // produces a bad preview, and a bad preview is worse than no contact.
    const architect = await ctx.activity<LeadInput & { auditId: string }, ArchitectResult>(
      "classify_vertical",
      { ...input, auditId: graded.auditId },
    );
    if (architect.escalate) {
      await ctx.activity("raise_lead_exception", { ...input, reason: architect.reason ?? "vertical_unresolved" });
      return {
        finalState: "REJECTED",
        contacted: false,
        previewGenerated: false,
        agentBound: false,
        rejectedReason: architect.reason ?? "vertical_unresolved",
      };
    }

    // A3b — which motion does this account get?
    //
    // ⛔ Immediately after classification and BEFORE the knowledge base, the
    // Q&A pack and the preview. Those three steps exist to produce a
    // speculative preview, and for an enterprise account we are not going to
    // build one — hosting an unofficial copy of a hospital group's website
    // under their name is passing off. Spending the tokens first and refusing
    // at the render would be correct and wasteful; refusing here is correct.
    const routed = await ctx.activity<{ businessId: string; vertical?: string }, SegmentResult>(
      "resolve_acquisition_track",
      { businessId: input.businessId, ...(architect.vertical === undefined ? {} : { vertical: architect.vertical }) },
    );
    if (!routed.speculativePreview) {
      // The enterprise motion is a named-account track with a human on our side
      // of it: qualification, a business case, a discovery call, a security
      // review, a quote and a signature. None of that is a workflow step, and
      // pretending it is would be the fiction this branch exists to avoid.
      await ctx.activity("open_enterprise_opportunity", {
        businessId: input.businessId,
        ...(architect.vertical === undefined ? {} : { vertical: architect.vertical }),
      });
      return {
        finalState: "ROUTED_ENTERPRISE",
        contacted: false,
        previewGenerated: false,
        agentBound: false,
        rejectedReason: "enterprise_segment",
      };
    }

    // A4 + A5 — knowledge base then Q&A pack. The pack is what the agent
    // retrieves from; without it the preview is just a page again.
    const kb = await ctx.activity<LeadInput & { manifestId?: string }, { kbId?: string; factCount: number }>(
      "extract_knowledge_base",
      { ...input, ...(architect.manifestId === undefined ? {} : { manifestId: architect.manifestId }) },
    );
    const pack = await ctx.activity<{ kbId?: string; businessId: string }, PackResult>("generate_qa_pack", {
      businessId: input.businessId,
      ...(kb.kbId === undefined ? {} : { kbId: kb.kbId }),
    });

    // A6 — the preview, with the agent bound to that pack. A preview whose agent
    // cannot answer is worse than no preview, so the activity smoke-tests it.
    const preview = await ctx.activity<
      LeadInput & { packId?: string; manifestId?: string },
      { generated: boolean; agentBound: boolean }
    >("generate_preview", {
      ...input,
      ...(pack.packId === undefined ? {} : { packId: pack.packId }),
      ...(architect.manifestId === undefined ? {} : { manifestId: architect.manifestId }),
    });

    // E1 → A7 — the gate, then transport. Step 0 of the sequence.
    //
    // ⛔ The audit's defects travel WITH the send. A2's comment says "the audit
    // is what makes the outreach copy true; every claim in it traces to a
    // deterministic check here" — and the defects never left this function, so
    // the copy printed "your current listing has 0 issues" on every email.
    await ctx.activity("send_outreach", { ...input, step: 0, topDefects: graded.topDefects });
    return await waitOutSequence(ctx, input, {
      previewGenerated: preview.generated,
      agentBound: preview.agentBound,
      topDefects: graded.topDefects,
    });
  },
};

/**
 * What arrives on the `reply` signal.
 *
 * Emitted by `@adw/inbound` once a received email has been classified as
 * written by a human and scored by the `email_responder` agent. ⛔ An
 * out-of-office never produces one of these — auto-replies are filtered off the
 * headers before anything reaches this workflow, because counting one as
 * engagement stops the sequence for someone who never read the message.
 */
interface ReplySignal {
  intent: number;
  /** The responder could not run. NOT the same as a low score. */
  pending?: boolean;
  disposition?: string;
  /** Empty when the responder declined to answer at all. */
  replyText?: string;
  escalate?: boolean;
  escalateReason?: string;
}

/**
 * The follow-up sequence and its durable timers. Steps at +4d and +9d, exhausted
 * at +14d, then a 180-day cooldown.
 *
 * ⛔ There is no fourth touch. The marginal reply is not worth the marginal
 * complaint, and complaint rate is the metric that kills the channel.
 */
async function waitOutSequence(
  ctx: WorkflowContext,
  input: LeadInput,
  // ⛔ `topDefects` travels the whole sequence, not just step 0. Follow-ups are
  // the same claim made again; a step-1 email that says "0 issues" because the
  // defects were dropped after the first send is no truer than the first one.
  flags: { previewGenerated: boolean; agentBound: boolean; topDefects: string[] },
): Promise<LeadOutput> {
  for (let step = 1; step <= 3; step++) {
    const reply = await ctx.waitForSignal<ReplySignal>(
      "reply",
      step === 3 ? 14 * DAY : (step === 1 ? 4 : 5) * DAY,
    );
    if (reply.received) {
      const payload = reply.payload;
      const intent = payload?.intent ?? 0;

      // ⛔ An unscored reply goes to a human, not to the parking threshold.
      // `pending` means the responder could not run — a gateway outage, a
      // budget stop. Treating that as intent 0 would park a genuinely
      // interested prospect on the strength of an infrastructure failure, and
      // parking is silent.
      if (payload?.pending === true) {
        await ctx.activity("raise_lead_exception", { ...input, reason: "reply_unscored" });
        return { finalState: "PARKED", contacted: true, ...flags };
      }

      // The draft is sent through the gate like anything else. An empty draft
      // is the responder declining to answer — hostile, not interested, wrong
      // person, or suspected injection — and silence is the correct reply to
      // all four.
      if (typeof payload?.replyText === "string" && payload.replyText.length > 0) {
        await ctx.activity("send_reply", { ...input, replyText: payload.replyText });
      }
      if (payload?.escalate === true) {
        await ctx.activity("raise_lead_exception", {
          ...input,
          reason: payload.escalateReason ?? "responder_escalation",
        });
        return { finalState: "PARKED", contacted: true, ...flags };
      }

      if (intent >= 30) {
        await ctx.activity("mark_engaged", { ...input, intent });
        return { finalState: "ENGAGED", contacted: true, ...flags };
      }
      // Parked is not suppressed. Parked leads re-enter after cooldown.
      await ctx.activity("mark_parked", input);
      return { finalState: "PARKED", contacted: true, ...flags };
    }
    if (step < 3) {
      await ctx.activity("send_outreach", { ...input, step, topDefects: flags.topDefects });
    }
  }

  await ctx.sleep("cooldown", 180 * DAY);
  await ctx.activity("mark_exhausted", input);
  return { finalState: "EXHAUSTED", contacted: true, ...flags };
}
