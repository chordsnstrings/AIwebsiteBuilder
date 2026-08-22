// Q&A pack generation (§21.3, HANDOVER A4→A5). Deterministic: the same KB and
// the same playbook version produce the same pack, byte for byte, including ids.
//
// The single rule everything else serves: an answer that does not trace to a
// published fact is not written. Not hedged, not flagged — not written. Every
// branch below either attaches source fact ids or produces a refusal.
import { cosine, localEmbeddingProvider, type EmbeddingProvider } from "./embedding.ts";
import { packId, pairId } from "./ids.ts";
import { FACT_QUESTION_FORMS, refusalFor, type RefusalRule, type TemplateQuestion, type VerticalTemplate } from "./template.ts";
import type { ExcludedPair, KbFact, KnowledgeBase, PackCoverage, QAPack, QAPair } from "./types.ts";

/** Two pairs above this cosine answer the same question; the lower-confidence one goes. */
export const DEDUPE_SIMILARITY = 0.95;

// A fact's status discounts the pair built from it. Stale content is still
// published content, but the owner has not confirmed it recently and the agent
// must not present it as current without saying so.
const STATUS_CONFIDENCE: Record<KbFact["status"], number> = {
  verified: 1,
  inferred: 0.7,
  stale: 0.6,
  claimed_unverified: 0,
};

/** How many published values one template answer will quote before it stops. */
const MAX_FACTS_PER_ANSWER = 6;

export interface GenerateDeps {
  embeddings?: EmbeddingProvider;
  /** Injectable clock. Only stamps createdAt — no identifier depends on it. */
  now?: () => Date;
}

function normaliseForMatch(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * A phrase from the vertical refusal set may appear in an answer ONLY when a
 * verified fact published it. "Only prices the business has published may be
 * stated" is a rule about provenance, not about the word "price" — so the check
 * asks whether the source facts carry the phrase, and discards the pair when
 * they do not.
 */
function prohibitedClaim(answer: string, facts: readonly KbFact[], rules: readonly RefusalRule[]): RefusalRule | null {
  const haystack = normaliseForMatch(answer);
  const published = facts
    .filter((f) => f.status === "verified")
    .map((f) => normaliseForMatch(f.value));
  for (const rule of rules) {
    for (const phrase of rule.matches) {
      const needle = normaliseForMatch(phrase).trim();
      if (needle.length === 0 || !haystack.includes(` ${needle} `)) continue;
      if (!published.some((value) => value.includes(needle))) return rule;
    }
  }
  return null;
}

function round3(n: number): number {
  // NUMERIC(4,3) in qa_pairs — round here so the value that round-trips through
  // the database is the value the dedupe comparison already used.
  return Math.round(Math.min(Math.max(n, 0), 1) * 1000) / 1000;
}

function confidenceOf(facts: readonly KbFact[]): number {
  let worst = 1;
  for (const fact of facts) {
    worst = Math.min(worst, fact.confidence * (STATUS_CONFIDENCE[fact.status] ?? 0));
  }
  return round3(worst);
}

function composeAnswer(lead: string, facts: readonly KbFact[]): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const fact of facts) {
    const value = fact.value.trim().replace(/[.;]+$/, "");
    if (value.length === 0 || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
  }
  const body = `${lead} ${values.join("; ")}.`;
  const stale = facts.filter((f) => f.status === "stale");
  const oldest = stale.map((f) => f.retrievedAt.toISOString().slice(0, 10)).sort()[0];
  // The hedge carries the date the content was retrieved, not today's date —
  // the pair must embed and read identically whenever it is rebuilt.
  return oldest === undefined
    ? body
    : `${body} That was last published as of ${oldest}; the owner can confirm it's still current.`;
}

/** Facts that may answer this question, best first. Ordered for determinism. */
function factsFor(question: TemplateQuestion, byKey: Map<string, KbFact[]>): KbFact[] {
  const out: KbFact[] = [];
  for (const key of question.factKeys) {
    for (const fact of byKey.get(key) ?? []) {
      out.push(fact);
      if (out.length >= MAX_FACTS_PER_ANSWER) return out;
    }
  }
  return out;
}

interface Candidate {
  question: string;
  answer: string;
  facts: KbFact[];
  source: QAPair["source"];
  topic: string;
  templateId?: string;
}

/**
 * Build the pack. `verticalTemplate` comes from loadVerticalTemplate(); `deps`
 * carries the embedding provider so a real endpoint can be swapped in without
 * touching this file.
 */
export async function generateQAPack(
  kb: KnowledgeBase,
  verticalTemplate: VerticalTemplate,
  deps: GenerateDeps = {},
): Promise<QAPack> {
  const embeddings = deps.embeddings ?? localEmbeddingProvider;
  const now = deps.now?.() ?? new Date();
  const id = packId(kb.id, kb.version);

  // A claimed-but-unverified certification is never a source. The agent may not
  // assert it (§21.2), and an answer built on it would be exactly that.
  const usable = kb.facts
    .filter((f) => f.status !== "claimed_unverified")
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value) || a.id.localeCompare(b.id));
  const unverifiable = kb.facts.filter((f) => f.status === "claimed_unverified");

  const byKey = new Map<string, KbFact[]>();
  for (const fact of usable) {
    const bucket = byKey.get(fact.factKey);
    if (bucket === undefined) byKey.set(fact.factKey, [fact]);
    else bucket.push(fact);
  }

  const candidates: Candidate[] = [];
  const excluded: ExcludedPair[] = [];
  const templateFallbacks: string[] = [];
  // The KB's gaps are structured (key, reason, question); the pack records the
  // QUESTION, because that is what the owner is asked to answer and what the
  // dashboard shows them.
  const gaps: string[] = kb.gaps.map((g) => g.question);
  const byTopic: Record<string, { answered: number; total: number }> = {};
  const usedFactIds = new Set<string>();

  const refuse = (q: TemplateQuestion): void => {
    templateFallbacks.push(q.question);
    gaps.push(q.question);
    candidates.push({
      question: q.question,
      answer: refusalFor(q),
      facts: [],
      source: "template_refusal",
      topic: q.topic,
      templateId: q.id,
    });
  };

  for (const q of verticalTemplate.questions) {
    const topic = (byTopic[q.topic] ??= { answered: 0, total: 0 });
    topic.total += 1;

    const facts = factsFor(q, byKey);
    if (facts.length === 0) {
      // The one case where an unanswerable question still earns a pair: the
      // template asked it, so the agent answers "we don't publish that" rather
      // than falling through to a model.
      refuse(q);
      const onlyUnverifiable = unverifiable.filter((f) => q.factKeys.includes(f.factKey));
      if (onlyUnverifiable.length > 0) {
        excluded.push({
          question: q.question,
          ruleId: "claimed_unverified",
          reason: `Only unverifiable claims answer this (${onlyUnverifiable.map((f) => f.factKey).join(", ")})`,
        });
      }
      continue;
    }

    const answer = composeAnswer(q.lead, facts);
    const rule = prohibitedClaim(answer, facts, verticalTemplate.refusals);
    if (rule !== null) {
      excluded.push({ question: q.question, ruleId: rule.id, reason: rule.reason });
      refuse(q);
      continue;
    }

    topic.answered += 1;
    for (const fact of facts) usedFactIds.add(fact.id);
    candidates.push({ question: q.question, answer, facts, source: "generated", topic: q.topic, templateId: q.id });
  }

  // Fact-derived pairs: one published fact, one question, one source id.
  for (const fact of usable) {
    const form = FACT_QUESTION_FORMS[fact.factKey];
    if (form === undefined) continue;
    const question = form.question(fact.value.trim().replace(/[.;]+$/, ""));
    const answer = composeAnswer(form.lead, [fact]);
    const rule = prohibitedClaim(answer, [fact], verticalTemplate.refusals);
    if (rule !== null) {
      excluded.push({ question, ruleId: rule.id, reason: rule.reason });
      continue;
    }
    usedFactIds.add(fact.id);
    candidates.push({ question, answer, facts: [fact], source: "generated", topic: form.topic });
  }

  const vectors = await embeddings.embed(candidates.map((c) => c.question));

  const pairs: QAPair[] = [];
  const kept: Float32Array[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const vector = vectors[i];
    if (candidate === undefined || vector === undefined) continue;

    const pair: QAPair = {
      id: pairId(id, candidate.question),
      question: candidate.question,
      answer: candidate.answer,
      sourceFactIds: candidate.facts.map((f) => f.id),
      embedding: vector,
      confidence: candidate.source === "template_refusal" ? 1 : confidenceOf(candidate.facts),
      source: candidate.source,
    };

    // MUST, checked here and not left to the DB CHECK: a generated pair with no
    // source is the failure this architecture exists to prevent, and the caller
    // needs to see it at generation time, not at INSERT time.
    if (pair.source === "generated" && pair.sourceFactIds.length === 0) {
      throw new Error(`Generated pair has no source fact: "${pair.question}"`);
    }

    let duplicate = -1;
    for (let j = 0; j < kept.length; j++) {
      const other = kept[j];
      if (other !== undefined && cosine(vector, other) > DEDUPE_SIMILARITY) {
        duplicate = j;
        break;
      }
    }
    if (duplicate === -1) {
      pairs.push(pair);
      kept.push(vector);
      continue;
    }

    const incumbent = pairs[duplicate];
    if (incumbent === undefined) continue;
    // Keep the higher-confidence pair. On a tie the incumbent wins, which means
    // the template phrasing beats the fact-derived one — template questions are
    // the ones coverage is measured against.
    if (pair.confidence > incumbent.confidence) {
      excluded.push({ question: incumbent.question, ruleId: "duplicate", reason: `Same question as "${pair.question}", lower confidence` });
      pairs[duplicate] = pair;
      kept[duplicate] = vector;
    } else {
      excluded.push({ question: pair.question, ruleId: "duplicate", reason: `Same question as "${incumbent.question}", lower confidence` });
    }
  }

  const grounded = pairs.filter((p) => p.source !== "template_refusal").length;
  const templateTotal = verticalTemplate.questions.length;
  const templateAnswered = Object.values(byTopic).reduce((sum, t) => sum + t.answered, 0);

  const coverage: PackCoverage = {
    byTopic,
    byVerticalTemplate: {
      answered: templateAnswered,
      total: templateTotal,
      ratio: templateTotal === 0 ? 0 : Math.round((templateAnswered / templateTotal) * 1000) / 1000,
    },
    factsUsed: usedFactIds.size,
    factsAvailable: kb.facts.length,
  };

  // Thin is measured on GROUNDED pairs. Counting the refusals would make every
  // pack clear the bar by construction, since the whole template is always
  // present as refusals — the number that matters is how much of this business
  // the agent can actually answer for.
  const thin = kb.thin || grounded < verticalTemplate.minPackPairs;

  return {
    id,
    kbId: kb.id,
    businessId: kb.businessId,
    ...(kb.customerId === undefined ? {} : { customerId: kb.customerId }),
    version: kb.version,
    vertical: verticalTemplate.vertical,
    playbookVersion: verticalTemplate.playbookVersion,
    embeddingProvider: embeddings.id,
    pairs,
    coverage,
    templateFallbacks,
    gaps,
    excluded,
    thin,
    extendedOnboarding: thin,
    createdAt: now,
  };
}
