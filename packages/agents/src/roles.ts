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
      { title: "Fast response", blurb: "We answer quickly and show up when we say we will, every time." },
      { title: "Quality work", blurb: "Careful, professional workmanship that holds up and looks great for years." },
      { title: "Fair pricing", blurb: "Clear, upfront quotes with no hidden fees and no surprises at the end." },
    ],
    about: `${input.name} is a locally owned ${input.category} business built on doing careful, honest work and treating every customer the way we'd want to be treated. We show up on time, quote clearly, and stand behind everything we do.`,
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
    // Each alternation is parenthesised. Written flat, `\b` binds only to the
    // first and last branch, so `/\bcure|treat|heal\b/` matched "treat" inside
    // "treating every customer well" — which flagged our own default copy and
    // would have sent every build to the exception queue.
    // "treat" carries two senses and only one is regulated. The medical sense
    // takes a condition as its object ("treats type 2 diabetes"); the everyday
    // sense takes a person ("treating every customer the way we'd want to be
    // treated") or no object at all. So: flag a treat-form followed by an object
    // that is not a person. Recall stays total — any condition noun matches,
    // without the suite having to enumerate diseases.
    const treatsACondition =
      /\btreat(s|ed|ing)?\s+(?!(?:every|each|our|their|the|you|your|people|everyone|customers?|clients?|us|them|homeowners?|neighbou?rs?)\b)[a-z]/.test(c);
    if (/\b(cures?|cured|curing|heals?|healed|healing)\b/.test(c) || treatsACondition) {
      findings.push({ category: "regulated_claim", excerpt: "cure/treat", severity: 3, reason: "medical outcome claim" });
    }
    if (/\b(best|#1|number one|guaranteed)\b/.test(c)) findings.push({ category: "superlative", excerpt: "best/#1", severity: 1, reason: "unverifiable superlative" });
    if (/\b(licensed|certified|insured)\b/.test(c)) findings.push({ category: "certification", excerpt: "licensed/certified", severity: 2, reason: "unverified certification claim" });
    return { verdict: findings.length > 0 ? ("flag" as const) : ("pass" as const), findings };
  },
});

// --- Finance / pricing (spec §28) — discount floor is a code clamp ---------
const financeIn = z.object({ region: z.enum(["R1", "R2", "R3", "R4"]), scope: z.string(), proposedDiscount: z.number().default(0) });
const financeOut = z.object({
  setupFeeCents: z.number(),
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
    prompts.developer!.build({ facts: { region: input.region, scope: input.scope }, outputShape: "{ setupFeeCents, mrrCents, discountPct, addonsRecommended, rationale }" }),
  simulate: (input) => {
    const p = config.pricing().data[input.region]!;
    return {
      setupFeeCents: p.setup_fee_cents,
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


// ---------------------------------------------------------------------------
// v3.0 — the transaction layer (spec §20, §21, §39, §41)
//
// These roles produce and serve the CUSTOMER'S agent. The constraints here are
// sharper than anywhere else in the roster, because a mistake is not our
// liability: under Moffatt the business operating the agent answers for what it
// says. Grounding is enforced structurally — a stored answer is returned, not
// composed — and every one of these roles is downstream of that.
// ---------------------------------------------------------------------------

// --- Vertical Architect (§20) — classifies; the playbook decides ------------
const architectIn = z.object({
  name: z.string(),
  category: z.string(),
  hasWebsite: z.boolean(),
  bookingFound: z.boolean(),
  pricingFound: z.boolean(),
  pageCount: z.number().default(0),
  wordCount: z.number().default(0),
  reviewSample: z.array(z.string()).default([]),
  siteText: z.string().default(""),
});
const architectOut = z.object({
  vertical: z.string(),
  confidence: z.number().min(0).max(1),
  modifiers: z.array(z.string()),
  unresolved: z.array(z.string()),
  escalate: z.boolean(),
  escalateReason: z.string().optional(),
});
export const architectAgent = defineAgent({
  id: "vertical_architect",
  role: "vertical_architect",
  dataClass: "PUB",
  capabilities: ["read:business", "write:draft"],
  inputSchema: architectIn,
  outputSchema: architectOut,
  maxTokensOut: 2000,
  budgetUsdPerPassingOutput: 0.012,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { name: input.name, category: input.category, bookingFound: input.bookingFound },
      outputShape: "{ vertical, confidence, modifiers[], unresolved[], escalate }",
      untrusted: { site_text: input.siteText, reviews: input.reviewSample.join(" \n") },
    }),
  simulate: (input) => {
    const text = `${input.category} ${input.siteText} ${input.reviewSample.join(" ")}`.toLowerCase();
    const byCategory: Record<string, string> = {
      roofer: "roofing", roofing: "roofing", plumber: "plumber", plumbing: "plumber",
      electrician: "electrician", hvac: "hvac", landscaper: "landscaping",
      landscaping: "landscaping", accountant: "accountant", lawyer: "lawyer",
      solicitor: "lawyer", "pest control": "pest_control", "auto repair": "auto_repair",
      mechanic: "auto_repair", cleaner: "cleaning", cleaning: "cleaning",
    };
    const vertical = byCategory[input.category.toLowerCase()] ?? "unknown";
    const modifiers: string[] = [];
    if (/24\/7|24 hour|emergency|call ?out/.test(text)) modifiers.push("emergency_service");
    if (!input.pricingFound) modifiers.push("no_published_pricing");
    if (input.bookingFound) modifiers.push("appointment_based");
    if (input.pageCount < 5 || input.wordCount < 400) modifiers.push("thin_content");
    if (/companies|contracts|commercial|offices/.test(text)) modifiers.push("b2b_serving");
    // Confidence is the routing signal, not a truth claim. An unmapped category
    // lands below the 0.75 escalation floor by construction — an unclassifiable
    // business produces a bad preview, so refusing is the cheaper outcome.
    const confidence = vertical === "unknown" ? 0.4 : input.hasWebsite ? 0.92 : 0.81;
    return {
      vertical,
      confidence,
      modifiers,
      unresolved: modifiers.includes("thin_content") ? ["services offered", "areas covered", "opening hours"] : [],
      escalate: confidence < 0.75,
      ...(confidence < 0.75 ? { escalateReason: "vertical_unresolved" } : {}),
    };
  },
});

// --- Knowledge-base extraction (§21.2) — provenance per fact ---------------
const kbIn = z.object({
  sourceUrl: z.string(),
  pageText: z.string(),
  gbpText: z.string().default(""),
});
const kbOut = z.object({
  facts: z.array(
    z.object({
      factKey: z.string(),
      type: z.string(),
      value: z.string(),
      // 'claimed_unverified' is the load-bearing one: a certification on their
      // site we could not verify. The agent may never assert it.
      status: z.enum(["verified", "claimed_unverified", "stale", "inferred"]),
      confidence: z.number().min(0).max(1),
    }),
  ),
  conflicts: z.array(z.object({ description: z.string() })),
  gaps: z.array(z.string()),
  injectionSuspected: z.boolean(),
});
export const kbExtractAgent = defineAgent({
  id: "kb_extract",
  role: "kb_extract",
  dataClass: "PUB",
  capabilities: ["read:business", "write:draft"],
  inputSchema: kbIn,
  outputSchema: kbOut,
  maxTokensOut: 2000,
  budgetUsdPerPassingOutput: 0.032,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { sourceUrl: input.sourceUrl },
      outputShape: "{ facts[{factKey,type,value,status,confidence}], conflicts[], gaps[], injectionSuspected }",
      untrusted: { page_text: input.pageText, gbp_text: input.gbpText },
    }),
  simulate: (input) => {
    const text = input.pageText;
    const facts: { factKey: string; type: string; value: string; status: "verified" | "claimed_unverified" | "stale" | "inferred"; confidence: number }[] = [];
    const hours = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(text);
    if (hours) facts.push({ factKey: "hours", type: "hours", value: hours[0]!, status: "verified", confidence: 0.9 });
    for (const m of text.matchAll(/\b(?:we (?:offer|provide|do)|services?:)\s*([^.\n]{4,80})/gi)) {
      facts.push({ factKey: "service", type: "service", value: m[1]!.trim(), status: "verified", confidence: 0.85 });
    }
    for (const m of text.matchAll(/[£$€]\s?\d[\d,]*(?:\.\d{2})?/g)) {
      facts.push({ factKey: "price", type: "price", value: m[0]!, status: "verified", confidence: 0.8 });
    }
    // A credential claimed on their own site is a claim, not a verification. We
    // cannot check a licence register from page text, so it never reads as
    // 'verified' — that distinction is the whole point of the status field.
    for (const m of text.matchAll(/\b(licen[sc]ed|certified|insured|accredited|gas safe|niceic)\b/gi)) {
      facts.push({ factKey: "credential", type: "credential", value: m[0]!, status: "claimed_unverified", confidence: 0.6 });
    }
    return {
      facts,
      conflicts: [],
      gaps: facts.some((f) => f.factKey === "price") ? [] : ["published pricing"],
      injectionSuspected: /ignore (previous|all) instructions|system prompt/i.test(text),
    };
  },
});

// --- Q&A pack generation (§21.3) — every answer traces to a fact -----------
const qaIn = z.object({
  question: z.string(),
  // factKey is supplied because it is what actually answers the question.
  // "What are your opening hours?" and "Open Mon-Fri 8am-5pm" share no words;
  // matching on prose would reproduce the string-similarity failure the whole
  // retrieval design exists to avoid (§39.1).
  facts: z.array(z.object({ id: z.string(), factKey: z.string().default("fact"), value: z.string() })),
});
const qaOut = z.object({
  // Null when the facts do not answer the question. A plausible answer here is
  // precisely the failure the architecture exists to prevent, so the schema
  // makes "no answer" a first-class result rather than something to be coaxed.
  answer: z.string().nullable(),
  sourceFactIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export const qaGenerateAgent = defineAgent({
  id: "qa_generate",
  role: "qa_generate",
  dataClass: "PUB",
  capabilities: ["read:business", "write:draft"],
  inputSchema: qaIn,
  outputSchema: qaOut,
  maxTokensOut: 400,
  budgetUsdPerPassingOutput: 0.0006,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { question: input.question, factCount: input.facts.length },
      outputShape: "{ answer|null, sourceFactIds[], confidence }",
      untrusted: { facts: input.facts.map((f) => f.value).join(" \n") },
    }),
  simulate: (input) => {
    const q = input.question.toLowerCase();
    // Topic -> factKey. The deterministic stand-in for what an embedding does.
    const topics: Record<string, string[]> = {
      hours: ["hour", "open", "close", "when are you", "what time"],
      price: ["price", "cost", "charge", "how much", "fee", "rate"],
      service: ["service", "do you do", "can you", "offer", "provide"],
      area: ["area", "cover", "serve", "travel", "come to", "based"],
      credential: ["licen", "certif", "insur", "accredit", "qualified", "registered"],
    };
    const wanted = Object.entries(topics).find(([, cues]) => cues.some((c) => q.includes(c)))?.[0];
    if (wanted !== undefined) {
      // The question asks for a specific attribute, so ONLY that attribute can
      // answer it. Knowing a business does roof replacement is not knowing what
      // it charges for one — matching on shared words would answer a price
      // question with a service name, which is a price we invented.
      const exact = input.facts.find((f) => f.factKey === wanted);
      return exact
        ? { answer: exact.value, sourceFactIds: [exact.id], confidence: 0.9 }
        : { answer: null, sourceFactIds: [], confidence: 0 };
    }
    // No attribute asked for: an open question, where topical overlap is a
    // reasonable signal.
    const hit = input.facts.find((f) => {
      const v = f.value.toLowerCase();
      return q.split(/\W+/).some((w) => w.length > 3 && v.includes(w));
    });
    if (!hit) return { answer: null, sourceFactIds: [], confidence: 0 };
    return { answer: hit.value, sourceFactIds: [hit.id], confidence: 0.9 };
  },
});

// --- Intent router (§39.1) — classifies, never answers ---------------------
const routerIn = z.object({ text: z.string(), turnIndex: z.number().default(0) });
const routerOut = z.object({
  intent: z.enum(["question", "book", "quote", "photo", "complaint", "ambiguous"]),
  urgency: z.enum(["emergency", "urgent", "normal"]),
  injectionSuspected: z.boolean(),
});
export const intentRouterAgent = defineAgent({
  id: "intent_router",
  role: "intent_router",
  dataClass: "CUST",
  capabilities: ["read:conversation"],
  inputSchema: routerIn,
  outputSchema: routerOut,
  maxTokensOut: 100,
  budgetUsdPerPassingOutput: 0.0002,
  buildPrompt: (input) =>
    prompts.customer_care!.build({
      facts: { turnIndex: input.turnIndex },
      outputShape: "{ intent, urgency, injectionSuspected }",
      untrusted: { visitor_message: input.text },
    }),
  simulate: (input) => {
    const t = input.text.toLowerCase();
    const intent =
      /\bbook|appointment|schedule|slot\b/.test(t) ? "book" as const :
      /\bquote|estimate|call me|call back|callback\b/.test(t) ? "quote" as const :
      /\bphoto|picture|image|attached\b/.test(t) ? "photo" as const :
      /\bcomplain|angry|terrible|urgent|emergency|flooding|leaking|no power\b/.test(t) ? "complaint" as const :
      /\?|^(what|where|when|who|how|do|does|can|are|is)\b/.test(t) ? "question" as const :
      "ambiguous" as const;
    return {
      intent,
      urgency: /emergency|flooding|gas|no power|burst/.test(t) ? "emergency" as const
             : /urgent|asap|today|right now/.test(t) ? "urgent" as const
             : "normal" as const,
      injectionSuspected: /ignore (previous|all) instructions|system prompt/i.test(input.text),
    };
  },
});

// --- Concierge fallback (§39.1) — runs ONLY on a retrieval miss ------------
const fallbackIn = z.object({
  question: z.string(),
  kbSlice: z.array(z.string()),
  refusals: z.array(z.string()).default([]),
});
const fallbackOut = z.object({
  // `refused` is not a failure mode — it is the correct answer whenever the KB
  // does not contain one, and the eval gate fails an agent that improvises.
  answer: z.string(),
  refused: z.boolean(),
  groundedIn: z.array(z.string()),
  escalate: z.boolean(),
  injectionSuspected: z.boolean(),
});
export const conciergeFallbackAgent = defineAgent({
  id: "concierge_fallback",
  role: "concierge_fallback",
  dataClass: "CUST",
  capabilities: ["read:conversation", "read:business", "write:draft"],
  inputSchema: fallbackIn,
  outputSchema: fallbackOut,
  maxTokensOut: 400,
  budgetUsdPerPassingOutput: 0.005,
  buildPrompt: (input) =>
    prompts.customer_care!.build({
      facts: { refusals: input.refusals, kbFactCount: input.kbSlice.length },
      outputShape: "{ answer, refused, groundedIn[], escalate, injectionSuspected }",
      untrusted: { visitor_question: input.question },
    }),
  simulate: (input) => {
    const q = input.question.toLowerCase();
    // Attribute questions are answerable only by a slice that actually carries
    // that attribute. "We install boilers" does not answer "how much is a new
    // boiler" — and answering it anyway is a price the business never quoted.
    const attributes: { cues: string[]; present: RegExp }[] = [
      { cues: ["how much", "price", "cost", "charge", "fee", "rate"], present: /[£$€]\s?\d|\bper hour\b|\bfrom \d/ },
      { cues: ["insur", "licen", "certif", "accredit", "registered", "qualified"], present: /\b(insured|licen[sc]ed|certified|accredited|registered)\b/ },
      { cues: ["warrant", "guarantee"], present: /\b(warrant|guarantee)/ },
      { cues: ["within the hour", "how soon", "how quickly", "arrival"], present: /\bwithin \d|\bsame day\b|\bhours?\b/ },
      { cues: ["cheaper than", "better than", "compared to", "versus"], present: /$^/ },
    ];
    const asked = attributes.find((a) => a.cues.some((c) => q.includes(c)));
    const grounded = input.kbSlice.filter((f) =>
      asked
        ? asked.present.test(f.toLowerCase())
        : q.split(/\W+/).some((w) => w.length > 3 && f.toLowerCase().includes(w)),
    );
    if (grounded.length === 0) {
      return {
        answer:
          "I don't have that in what the business has published, so I don't want to guess. " +
          "I've noted your question and someone will come back to you.",
        refused: true,
        groundedIn: [],
        escalate: false,
        injectionSuspected: /ignore (previous|all) instructions/i.test(input.question),
      };
    }
    return {
      answer: grounded[0]!,
      refused: false,
      groundedIn: grounded.slice(0, 2),
      escalate: false,
      injectionSuspected: false,
    };
  },
});

// --- Photo triage (§41) — ⛔ never prices ----------------------------------
const photoIn = z.object({
  imageDescription: z.string(),
  vertical: z.string(),
});
const photoOut = z.object({
  whatItIs: z.string(),
  apparentScope: z.string(),
  visibleComplications: z.array(z.string()),
  // Stating what the photo does NOT show is the difference between an
  // assessment and a guess — a ceiling stain does not show the leak.
  notDeterminable: z.array(z.string()),
  urgent: z.boolean(),
  suggestedReply: z.string(),
});
export const photoTriageAgent = defineAgent({
  id: "photo_triage",
  role: "photo_triage",
  dataClass: "CUST",
  capabilities: ["read:conversation", "write:draft"],
  inputSchema: photoIn,
  outputSchema: photoOut,
  maxTokensOut: 500,
  budgetUsdPerPassingOutput: 0.003,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { vertical: input.vertical },
      // Text rendered inside an image is an injection vector text scanning
      // misses entirely, so the image description arrives as untrusted content.
      outputShape: "{ whatItIs, apparentScope, visibleComplications[], notDeterminable[], urgent, suggestedReply }",
      untrusted: { image_description: input.imageDescription },
    }),
  simulate: (input) => {
    const d = input.imageDescription.toLowerCase();
    const urgent = /exposed wir|gas|structural|collapse|sparking|smoke/.test(d);
    return {
      whatItIs: input.imageDescription.slice(0, 80),
      apparentScope: "Localised, from what is visible in the frame",
      visibleComplications: urgent ? ["visible safety hazard"] : [],
      notDeterminable: ["the extent behind the visible surface", "the underlying cause", "access and working height"],
      urgent,
      suggestedReply:
        "Thanks for the photo. I can see the area you've flagged. I can't tell from the image " +
        "what's behind it, so the owner will confirm scope and price.",
    };
  },
  // ⛔ The agent never prices. A price cannot leak out of this role because the
  // output schema has no field for one — the constraint is structural rather
  // than a prompt instruction that could be talked past.
});

// --- Review responder (§40) — drafts only, owner approves ------------------
const reviewIn = z.object({ reviewText: z.string(), rating: z.number().min(1).max(5), businessName: z.string() });
const reviewOut = z.object({ draft: z.string(), tone: z.enum(["thankful", "apologetic", "neutral"]), escalate: z.boolean() });
export const reviewResponderAgent = defineAgent({
  id: "review_responder",
  role: "review_responder",
  dataClass: "CUST",
  capabilities: ["read:customer", "write:draft"],
  inputSchema: reviewIn,
  outputSchema: reviewOut,
  maxTokensOut: 300,
  budgetUsdPerPassingOutput: 0.002,
  buildPrompt: (input) =>
    prompts.customer_care!.build({
      facts: { rating: input.rating, businessName: input.businessName },
      outputShape: "{ draft, tone, escalate }",
      untrusted: { review_text: input.reviewText },
    }),
  simulate: (input) => ({
    draft:
      input.rating >= 4
        ? `Thanks for taking the time to leave this — glad we could help. — ${input.businessName}`
        : `Sorry this fell short. We'd like to put it right; please get in touch directly. — ${input.businessName}`,
    tone: input.rating >= 4 ? ("thankful" as const) : ("apologetic" as const),
    // A legal threat inside a review is not something to draft a reply to.
    escalate: /lawyer|sue|legal|trading standards|ombudsman/i.test(input.reviewText),
  }),
});

// --- B2B lead sourcing (§40.2) — ⛔ never sends ----------------------------
const sourcingIn = z.object({
  targetProfile: z.string(),
  serviceArea: z.string(),
  candidateName: z.string(),
  candidateContext: z.string().default(""),
});
const sourcingOut = z.object({
  qualified: z.boolean(),
  rationale: z.string(),
  suggestedOpening: z.string(),
  researchedContext: z.array(z.string()),
});
export const leadSourcingAgent = defineAgent({
  id: "lead_sourcing",
  role: "lead_sourcing",
  dataClass: "CUST",
  // ⛔ No send:gated. One customer's list quality must never touch the fleet's
  // reputation, and the protection is that no code path exists — not a policy.
  capabilities: ["read:business", "write:draft"],
  inputSchema: sourcingIn,
  outputSchema: sourcingOut,
  maxTokensOut: 400,
  budgetUsdPerPassingOutput: 0.004,
  buildPrompt: (input) =>
    prompts.developer!.build({
      facts: { targetProfile: input.targetProfile, serviceArea: input.serviceArea },
      outputShape: "{ qualified, rationale, suggestedOpening, researchedContext[] }",
      untrusted: { candidate_context: input.candidateContext },
    }),
  simulate: (input) => ({
    qualified: input.candidateContext.length > 0,
    rationale: `Matches ${input.targetProfile} in ${input.serviceArea}`,
    suggestedOpening: `Noticed ${input.candidateName} covers ${input.serviceArea} — worth a conversation.`,
    researchedContext: input.candidateContext ? [input.candidateContext.slice(0, 120)] : [],
  }),
});

// --- Design decision -------------------------------------------------------
//
// The agent that decides what a site LOOKS like, before a line of markup
// exists. It emits five tokens and a section order — nothing else.
//
// ⛔ It proposes. It does not decide. Everything it returns is checked against
// config/design-catalogue.yaml and against the recent history for its trade by
// @adw/designer, and a proposal that fails either is replaced wholesale by a
// deterministic choice rather than patched. The reason is measured: told in
// prose to make each site different, the model varied layout and then put four
// of six sites in the same typeface. A model asked to avoid an attractor still
// walks to it, so the constraint is arithmetic over stored history.
//
// The strings here are deliberately untyped against the catalogue's unions.
// This package must not import @adw/designer — the validation belongs on the
// far side of the boundary, where a bad token fails loudly.
const designIn = z.object({
  businessName: z.string(),
  vertical: z.string(),
  about: z.string().default(""),
  imageCount: z.number().default(0),
  publishesPrices: z.boolean().default(false),
  /** What is still open after the catalogue and the diversity window have had
   *  their say. The agent chooses from these, never from memory. */
  openArchetypes: z.array(z.string()),
  openPairings: z.array(z.string()),
  openMotion: z.array(z.string()),
  openDensity: z.array(z.string()),
  /** Combinations already spent in this trade, as "archetype|pairing". */
  usedCombinations: z.array(z.string()).default([]),
});
const designOut = z.object({
  heroArchetype: z.string(),
  typePairingId: z.string(),
  motion: z.string(),
  parallax: z.boolean(),
  density: z.string(),
  sectionOrder: z.array(z.string()),
  rationale: z.string(),
});
export const designAgent = defineAgent({
  id: "design_decide",
  role: "design_decide",
  dataClass: "PUB",
  capabilities: ["read:business", "write:draft"],
  inputSchema: designIn,
  outputSchema: designOut,
  maxTokensOut: 600,
  budgetUsdPerPassingOutput: 0.004,
  buildPrompt: (input) =>
    prompts.design_decide!.build({
      facts: {
        business: input.businessName,
        vertical: input.vertical,
        photographs: input.imageCount,
        publishesPrices: input.publishesPrices,
        chooseHeroFrom: input.openArchetypes,
        chooseTypeFrom: input.openPairings,
        chooseMotionFrom: input.openMotion,
        chooseDensityFrom: input.openDensity,
        alreadyUsedInThisTrade: input.usedCombinations,
      },
      outputShape:
        "{ heroArchetype, typePairingId, motion, parallax, density, sectionOrder[], rationale }",
      // Their own words about themselves are third-party text, and this agent
      // reads it for register cues. It is not an instruction channel.
      untrusted: { business_description: input.about },
    }),
  simulate: (input) => {
    // The demo path picks the first open combination that is not spent. The real
    // deterministic chooser lives in @adw/designer and is seeded per business;
    // duplicating that here would be a second source of truth for the same
    // decision, so this stays deliberately dumb.
    const archetype =
      input.openArchetypes.find((a) => input.openPairings.some((p) => !input.usedCombinations.includes(`${a}|${p}`))) ??
      input.openArchetypes[0] ??
      "typographic";
    const pairing =
      input.openPairings.find((p) => !input.usedCombinations.includes(`${archetype}|${p}`)) ??
      input.openPairings[0] ??
      "";
    return {
      heroArchetype: archetype,
      typePairingId: pairing,
      motion: input.openMotion[0] ?? "still",
      // ⛔ Never proposed by the simulator. Parallax needs three photographs and
      // a vocabulary that permits it, and asserting it here would mean the demo
      // path routinely proposes something the catalogue rejects.
      parallax: false,
      density: input.openDensity[0] ?? "balanced",
      sectionOrder: ["proof", "services", "work", "about", "contact"],
      rationale: `First combination open to ${input.vertical} that this trade has not already used.`,
    };
  },
});

// --- Reviewer patch (spec §29.4) -------------------------------------------
//
// Repairs a build against named gate failures. It receives the gate names and
// their numeric results, never the gate implementations — a patcher that can
// see the check can satisfy the check instead of the requirement.
const patchIn = z.object({
  buildId: z.string(),
  failingGates: z.array(z.object({ gate: z.string(), score: z.number(), threshold: z.number(), detail: z.string() })),
  attempt: z.number().default(1),
});
const patchOut = z.object({
  patches: z.array(z.object({ gate: z.string(), file: z.string(), change: z.string() })),
  /** Gates the agent believes it cannot fix, with why. Returning these is a
   *  success — a patch loop that always claims a fix produces a build that
   *  fails the same gate three times and then gives up with no diagnosis. */
  unfixable: z.array(z.object({ gate: z.string(), reason: z.string() })),
  injectionSuspected: z.boolean(),
});
export const reviewerPatchAgent = defineAgent({
  id: "reviewer_patch",
  role: "reviewer_patch",
  dataClass: "PUBLISHABLE",
  capabilities: ["read:business", "write:draft"],
  inputSchema: patchIn,
  outputSchema: patchOut,
  maxTokensOut: 3000,
  budgetUsdPerPassingOutput: 0.03,
  buildPrompt: (input) =>
    prompts.reviewer_patch!.build({
      facts: { buildId: input.buildId, attempt: input.attempt, failing: input.failingGates },
      outputShape: "{ patches[{gate,file,change}], unfixable[{gate,reason}], injectionSuspected }",
    }),
  simulate: (input) => ({
    patches: input.failingGates.map((g) => ({ gate: g.gate, file: "index.html", change: `raise ${g.gate} to ${g.threshold}` })),
    unfixable: [],
    injectionSuspected: false,
  }),
  // ⛔ Attempt three is the last one. The BuildWorkflow's cost ceiling assumes a
  // bounded loop, and "patch until it passes" is how a $1.50 build becomes $40.
  detectEscalation: (out, input) =>
    input.attempt >= 3 && out.unfixable.length === 0 && out.patches.length > 0 ? "patch_loop_exhausted" : undefined,
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
  reviewer_patch: reviewerPatchAgent,
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
  // v3.0 — the transaction layer.
  vertical_architect: architectAgent,
  kb_extract: kbExtractAgent,
  qa_generate: qaGenerateAgent,
  intent_router: intentRouterAgent,
  concierge_fallback: conciergeFallbackAgent,
  photo_triage: photoTriageAgent,
  review_responder: reviewResponderAgent,
  lead_sourcing: leadSourcingAgent,
  design_decide: designAgent,
};
