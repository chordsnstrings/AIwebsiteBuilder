// The agent roster (spec §17–33). Each role is a defineAgent() with a typed
// output schema, a deterministic demo simulator, and — where the spec requires
// it — deterministic post-processing (clamps, parking) that is code, not prompt.
import { z } from "zod";
import { config } from "@adw/config";
import { prompts } from "@adw/prompts";
import { defineAgent } from "./framework.ts";

// --- Enrichment (spec §17) -------------------------------------------------
const enrichmentIn = z.object({
  name: z.string(),
  category: z.string(),
  segment: z.enum(["no_site", "stale_site", "ok_site"]),
  reviewCount: z.number().default(0),
  listingText: z.string().default(""),
});
const enrichmentOut = z.object({
  category: z.string(),
  segment: z.enum(["no_site", "stale_site", "ok_site"]),
  roleInferred: z.enum(["owner", "manager", "generic", "unknown"]),
  icpScore: z.number().min(0).max(100),
  scoreReasons: z.array(z.string()),
  previewWorthy: z.boolean(),
  injectionSuspected: z.boolean(),
  rejectReason: z.string().optional(),
});
export const enrichmentAgent = defineAgent({
  id: "enrichment",
  role: "enrichment",
  dataClass: "PUB",
  capabilities: ["read:business"],
  inputSchema: enrichmentIn,
  outputSchema: enrichmentOut,
  maxTokensOut: 400,
  budgetUsdPerPassingOutput: 0.002,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { name: input.name, category: input.category, segment: input.segment },
      outputShape: "{ category, segment, roleInferred, icpScore, scoreReasons, previewWorthy, injectionSuspected }",
      untrusted: { listing_description: input.listingText },
    }),
  simulate: (input) => {
    const base = input.segment === "stale_site" ? 70 : input.segment === "no_site" ? 55 : 30;
    const reviewBoost = Math.min(20, input.reviewCount / 5);
    const icpScore = Math.round(Math.min(100, base + reviewBoost));
    return {
      category: input.category,
      segment: input.segment,
      roleInferred: "owner" as const,
      icpScore,
      scoreReasons: [`segment ${input.segment}`, `${input.reviewCount} reviews`],
      previewWorthy: icpScore >= 62,
      injectionSuspected: /ignore (previous|all) instructions/i.test(input.listingText),
    };
  },
});

// --- Site scoring (spec §18) -----------------------------------------------
const siteScoringIn = z.object({ name: z.string(), url: z.string(), defects: z.array(z.string()) });
const siteScoringOut = z.object({
  visualEraEstimate: z.string(),
  layoutQuality: z.number().min(1).max(5),
  looksAbandoned: z.boolean(),
  topThreeDefects: z.array(z.string()).max(3),
  aiVisibilityGrade: z.enum(["A", "B", "C", "D", "F"]),
  quotableFinding: z.string(),
});
export const siteScoringAgent = defineAgent({
  id: "site_scoring",
  role: "site_scoring",
  dataClass: "PUB",
  capabilities: ["read:business"],
  inputSchema: siteScoringIn,
  outputSchema: siteScoringOut,
  maxTokensOut: 400,
  budgetUsdPerPassingOutput: 0.006,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { name: input.name, verifiedDefects: input.defects },
      outputShape: "{ visualEraEstimate, layoutQuality, looksAbandoned, topThreeDefects, aiVisibilityGrade, quotableFinding }",
    }),
  simulate: (input) => ({
    visualEraEstimate: "2012-2015",
    layoutQuality: 2,
    looksAbandoned: input.defects.length > 2,
    // Truth constraint: defects only from the verified list.
    topThreeDefects: input.defects.slice(0, 3),
    aiVisibilityGrade: (input.defects.includes("no_schema") ? "D" : "C") as "A" | "B" | "C" | "D" | "F",
    quotableFinding: `${input.name}'s site shows ${input.defects.length} issues that hurt visibility in AI assistants.`,
  }),
});

// --- Preview generation (spec §19) — the model writes SIX text fields only --
const previewIn = z.object({
  name: z.string(),
  category: z.string(),
  city: z.string(),
  services: z.array(z.string()),
});
const previewOut = z.object({
  headline: z.string(),
  services: z.array(z.object({ title: z.string(), blurb: z.string() })),
  about: z.string(),
  cta: z.string(),
});
export const previewAgent = defineAgent({
  id: "preview_gen",
  role: "preview_gen",
  dataClass: "PUB",
  capabilities: ["write:draft", "deploy:preview"],
  inputSchema: previewIn,
  outputSchema: previewOut,
  maxTokensOut: 800,
  budgetUsdPerPassingOutput: 0.01,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { name: input.name, category: input.category, city: input.city },
      outputShape: "{ headline, services[{title,blurb}], about, cta }",
    }),
  simulate: (input) => ({
    headline: `${input.name} — trusted ${input.category} in ${input.city}`,
    services: input.services.slice(0, 3).map((s) => ({
      title: s,
      blurb: `Professional ${s.toLowerCase()} you can count on, done right the first time.`,
    })),
    about: `${input.name} has served ${input.city} with dependable ${input.category} work. We show up on time, do quality work, and stand behind it.`,
    cta: "Get a free quote today",
  }),
});

// --- Outreach (spec §20) ---------------------------------------------------
const outreachIn = z.object({
  name: z.string(),
  city: z.string(),
  verifiedDefects: z.array(z.string()),
  previewUrl: z.string(),
  sequenceStep: z.number(),
  locale: z.string().default("en-US"),
});
const outreachOut = z.object({ subject: z.string(), bodyText: z.string() });
export const outreachAgent = defineAgent({
  id: "outreach_draft",
  role: "outreach_draft",
  dataClass: "PUB",
  capabilities: ["write:draft", "send:gated"],
  inputSchema: outreachIn,
  outputSchema: outreachOut,
  maxTokensOut: 500,
  budgetUsdPerPassingOutput: 0.003,
  buildPrompt: (input) =>
    prompts.outreach_draft!.build({
      facts: { name: input.name, verifiedDefects: input.verifiedDefects, step: input.sequenceStep },
      outputShape: "{ subject, bodyText }",
    }),
  simulate: (input) => {
    const subjects = [
      `A website preview for ${input.name}`,
      `One thing your ${input.city} customers can't find`,
      `Last note about ${input.name}'s web presence`,
    ];
    return {
      subject: subjects[Math.min(input.sequenceStep, 2)]!,
      bodyText: `Hi, we built a quick preview of a website for ${input.name}. Your current listing has ${input.verifiedDefects.length} issues that make you hard to find. See it here: ${input.previewUrl}`,
    };
  },
});

// --- Customer care (spec §21) — parking is a code clamp --------------------
const careIn = z.object({
  message: z.string(),
  exchangeCount: z.number(),
  priorIntent: z.number().default(50),
});
const careOut = z.object({
  replyText: z.string(),
  intentScore: z.number().min(0).max(100),
  stage: z.enum(["discovery", "objection", "pricing", "closing", "support", "park"]),
  requestedChanges: z.array(z.string()),
  quoteRequested: z.boolean(),
  escalate: z.boolean(),
  escalateReason: z.enum(["legal_threat", "refund_demand", "press", "ip_complaint", "regulated_claims", "distress"]).optional(),
  injectionSuspected: z.boolean(),
});
export const careAgent = defineAgent({
  id: "customer_care",
  role: "customer_care",
  dataClass: "CUST",
  capabilities: ["read:conversation", "read:business", "write:draft", "send:gated"],
  inputSchema: careIn,
  outputSchema: careOut,
  maxTokensOut: 600,
  budgetUsdPerPassingOutput: 0.06,
  buildPrompt: (input) =>
    prompts.customer_care!.build({
      facts: { exchangeCount: input.exchangeCount },
      outputShape: "{ replyText, intentScore, stage, requestedChanges, quoteRequested, escalate, escalateReason?, injectionSuspected }",
      untrusted: { inbound_email: input.message },
    }),
  simulate: (input) => {
    const m = input.message.toLowerCase();
    type EscReason = "legal_threat" | "refund_demand" | "press" | "ip_complaint" | "regulated_claims" | "distress";
    const escalate: EscReason | undefined =
      /lawyer|sue|legal|court/.test(m) ? "legal_threat" :
      /journalist|press|reporter/.test(m) ? "press" :
      /logo|trademark|copyright/.test(m) ? "ip_complaint" :
      /cure|treat|guaranteed returns/.test(m) ? "regulated_claims" :
      /passed away|bereave|dying|can't cope/.test(m) ? "distress" : undefined;
    const intent = escalate ? 0 : /price|cost|how much|interested|yes/.test(m) ? 82 : 20;
    return {
      replyText: escalate ? "I understand. Let me connect you with a person." : "Thanks for the reply — happy to help.",
      intentScore: intent,
      stage: "discovery" as const,
      requestedChanges: [],
      quoteRequested: /quote|price|how much/.test(m),
      escalate: escalate !== undefined,
      escalateReason: escalate,
      injectionSuspected: /ignore (previous|all) instructions|system prompt/i.test(input.message),
    };
  },
  // Parking is a code clamp, not prompt guidance: below intent 30 after two
  // exchanges, park the lead regardless of what the model returned.
  postProcess: (out, input) => {
    if (!out.escalate && out.intentScore < 30 && input.exchangeCount >= 2) {
      return { ...out, stage: "park" as const };
    }
    return out;
  },
  detectEscalation: (out) => (out.escalate ? out.escalateReason : undefined),
});

// --- Developer (spec §23) --------------------------------------------------
const developerIn = z.object({
  name: z.string(),
  category: z.string(),
  templateFamily: z.string(),
  requestedChanges: z.array(z.string()).default([]),
});
const developerOut = z.object({
  headline: z.string(),
  services: z.array(z.object({ title: z.string(), blurb: z.string() })),
  about: z.string(),
  cta: z.string(),
  sectionOrder: z.array(z.string()),
});
export const developerAgent = defineAgent({
  id: "developer",
  role: "developer",
  dataClass: "PUBLISHABLE",
  capabilities: ["write:draft"],
  inputSchema: developerIn,
  outputSchema: developerOut,
  maxTokensOut: 1200,
  budgetUsdPerPassingOutput: 0.22,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { name: input.name, category: input.category, family: input.templateFamily },
      outputShape: "{ headline, services[{title,blurb}], about, cta, sectionOrder[] }",
    }),
  simulate: (input) => ({
    headline: `${input.name} — ${input.category} done right`,
    services: [
      { title: "Fast response", blurb: "We answer quickly and show up when we say we will." },
      { title: "Quality work", blurb: "Careful, professional work that lasts." },
      { title: "Fair pricing", blurb: "Clear quotes with no surprises." },
    ],
    about: `${input.name} is a local ${input.category} business built on doing good work and treating people right.`,
    cta: "Request a quote",
    sectionOrder: ["hero", "services", "about", "contact"],
  }),
});

// --- IP / claims (spec §26) — recall-first, a flag is a hard stop ----------
const ipIn = z.object({ content: z.string(), jurisdiction: z.string() });
const ipOut = z.object({
  verdict: z.enum(["pass", "flag"]),
  findings: z.array(z.object({ category: z.string(), excerpt: z.string(), severity: z.number(), reason: z.string() })),
});
export const ipClaimsAgent = defineAgent({
  id: "ip_claims",
  role: "ip_claims",
  dataClass: "PUBLISHABLE",
  capabilities: ["read:business"],
  inputSchema: ipIn,
  outputSchema: ipOut,
  maxTokensOut: 500,
  budgetUsdPerPassingOutput: 0.04,
  buildPrompt: (input) =>
    prompts.ip_claims!.build({
      facts: { jurisdiction: input.jurisdiction },
      outputShape: "{ verdict, findings[{category,excerpt,severity,reason}] }",
      untrusted: { generated_content: input.content },
    }),
  simulate: (input) => {
    const c = input.content.toLowerCase();
    const findings: { category: string; excerpt: string; severity: number; reason: string }[] = [];
    if (/\bcure|treat|heal\b/.test(c)) findings.push({ category: "regulated_claim", excerpt: "cure/treat", severity: 3, reason: "medical outcome claim" });
    if (/\bbest\b|#1|number one|guaranteed/.test(c)) findings.push({ category: "superlative", excerpt: "best/#1", severity: 1, reason: "unverifiable superlative" });
    if (/\blicensed|certified|insured\b/.test(c)) findings.push({ category: "certification", excerpt: "licensed/certified", severity: 2, reason: "unverified certification claim" });
    return { verdict: findings.length > 0 ? ("flag" as const) : ("pass" as const), findings };
  },
});

// --- Finance / pricing (spec §28) — discount floor is a code clamp ---------
const financeIn = z.object({ region: z.enum(["R1", "R2", "R3", "R4"]), scope: z.string(), proposedDiscount: z.number().default(0) });
const financeOut = z.object({
  buildFeeCents: z.number(),
  mrrCents: z.number(),
  discountPct: z.number(),
  addonsRecommended: z.array(z.string()),
  rationale: z.string(),
});
export const financeAgent = defineAgent({
  id: "finance_pricing",
  role: "finance_pricing",
  dataClass: "CUST",
  capabilities: ["propose:price"],
  inputSchema: financeIn,
  outputSchema: financeOut,
  maxTokensOut: 300,
  budgetUsdPerPassingOutput: 0.005,
  buildPrompt: (input) =>
    prompts.developer!.build({ facts: { region: input.region, scope: input.scope }, outputShape: "{ buildFeeCents, mrrCents, discountPct, addonsRecommended, rationale }" }),
  simulate: (input) => {
    const p = config.pricing().data[input.region]!;
    return {
      buildFeeCents: p.build_fee_cents,
      mrrCents: p.mrr_cents,
      discountPct: input.proposedDiscount, // may be over the floor — clamped below
      addonsRecommended: ["receptionist"],
      rationale: "Standard package for the region.",
    };
  },
  // The clamp: discountPct <= floor[region], enforced in code AFTER the model
  // returns. A model told not to discount will eventually discount; a clamp will
  // not (spec §28.3).
  postProcess: (out, input) => {
    const floor = config.pricing().data[input.region]!.discount_floor_pct;
    return { ...out, discountPct: Math.min(out.discountPct, floor) };
  },
});

// --- Lighter roles (ux, retention, dunning, researcher, pr, orchestrator,
//     sentinel, ceo). Minimal schemas sufficient for the registry + demo. ----
const genericOut = z.object({ summary: z.string(), items: z.array(z.string()) });
function genericAgent(id: string, role: Parameters<typeof defineAgent>[0]["role"], dataClass: "PUB" | "PUBLISHABLE" | "CUST", caps: Parameters<typeof defineAgent>[0]["capabilities"]) {
  return defineAgent({
    id,
    role,
    dataClass,
    capabilities: caps,
    inputSchema: z.object({ context: z.string() }),
    outputSchema: genericOut,
    maxTokensOut: 400,
    budgetUsdPerPassingOutput: 0.02,
    buildPrompt: (input) => prompts.ceo!.build({ facts: { context: input.context }, outputShape: "{ summary, items[] }" }),
    simulate: (input) => ({ summary: `Processed: ${input.context.slice(0, 40)}`, items: [] }),
  });
}
export const uxAgent = genericAgent("ux_review", "ux_review", "PUB", ["read:business"]);
export const retentionAgent = genericAgent("retention", "retention", "CUST", ["read:customer", "write:draft", "send:gated"]);
export const dunningAgent = genericAgent("dunning", "dunning", "CUST", ["write:draft", "send:gated"]);
export const researcherAgent = genericAgent("researcher", "researcher", "PUB", ["read:business"]);
export const prAgent = genericAgent("pr_report", "pr_report", "PUB", ["read:metrics", "write:draft"]);
export const orchestratorAgent = genericAgent("vendor_orchestrator", "vendor_orchestrator", "PUB", ["read:vendor_registry", "write:vendor_state", "provision:scoped", "write:exception"]);
export const sentinelAgent = genericAgent("sentinel", "sentinel", "PUB", ["read:metrics", "write:exception", "trigger:remediation"]);
export const ceoAgent = genericAgent("ceo", "ceo", "CUST", ["read:metrics", "write:exception"]);

export const allAgents = {
  enrichment: enrichmentAgent,
  site_scoring: siteScoringAgent,
  preview_gen: previewAgent,
  outreach_draft: outreachAgent,
  customer_care: careAgent,
  developer: developerAgent,
  ip_claims: ipClaimsAgent,
  finance_pricing: financeAgent,
  ux_review: uxAgent,
  retention: retentionAgent,
  dunning: dunningAgent,
  researcher: researcherAgent,
  pr_report: prAgent,
  vendor_orchestrator: orchestratorAgent,
  sentinel: sentinelAgent,
  ceo: ceoAgent,
};
