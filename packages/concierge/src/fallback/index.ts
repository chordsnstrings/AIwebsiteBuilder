// The fallback (§39.1). Built last, on purpose.
//
// Everything upstream is a retrieval guarantee: a stored answer is returned or
// nothing is. The fallback is the one place a model composes words a visitor
// will read, which makes it the only place a hallucination can enter — so it is
// wrapped rather than trusted, and the wrapping is not a prompt.
//
//   ⛔ Suspected injection never reaches the model at all.
//   ⛔ The output must be covered by the question's narrowing terms, checked by
//      the same function retrieval uses. An answer about insurance does not
//      answer a question about Gas Safe registration here either.
//   ⛔ The output may not contain a currency amount. Not "should not" — the
//      check is structural, like the photo triage schema having no price field,
//      because a price the business never published is the single most
//      expensive thing this system could say.
//   ⛔ Every refusal writes the exact question to the gap list. A refusal that
//      does not is a lost sale nobody ever hears about.
//
// The model earns one thing: phrasing. Anything it asserts that the guards
// cannot verify is discarded and the visitor gets the refusal.

import type { Db } from "@adw/db";
import { missingTerms, stemSet } from "../retrieval/coverage.ts";
import { REFUSAL_TEXT, type RefusalPolicy } from "../refusals.ts";
import { recordGap } from "./gaps.ts";

export { normaliseQuestion, openGaps, recordGap, type GapInput, type GapRecord, type OpenGap } from "./gaps.ts";

/**
 * Any published amount, in any of the currencies the enabled markets use. A
 * composed answer containing one is discarded outright — if the price is real
 * it is in the pack, and the pack is retrieved, not composed.
 */
const CURRENCY =
  /[£$€₹]\s?\d|\bAED\s?\d|\b\d+(?:[.,]\d{2})?\s?(?:gbp|usd|eur|aed|cad|aud|dollars?|pounds?|euros?|dirhams?)\b|\b\d+\s?(?:per hour|an hour|p\/h)\b/i;

/** What the fallback model is allowed to be. Injected so this package stays
 *  free of the gateway and testable without one. */
export interface FallbackModel {
  answer(input: { question: string; kbSlice: string[]; refusals: string[] }): Promise<{
    answer: string;
    refused: boolean;
    groundedIn: string[];
    injectionSuspected: boolean;
    /** What the call actually cost. Reported by the gateway, not estimated
     *  here — a per-turn cost the agent guesses at is not a cost. */
    costCents?: number;
  }>;
}

export interface FallbackInput {
  question: string;
  kbSlice: string[];
  injectionSuspected: boolean;
  owner: { customerId?: string | undefined; businessId?: string | undefined };
}

export interface FallbackDeps {
  db: Db;
  model?: FallbackModel | undefined;
  policy: RefusalPolicy;
}

export interface FallbackResult {
  answer: string;
  refused: boolean;
  /** Populated when the model's own text was thrown away, and why. */
  discarded?: string | undefined;
  gapLogged: boolean;
  gapTimesAsked?: number | undefined;
  modelCalls: number;
  costCents: number;
}

async function refuse(
  deps: FallbackDeps,
  input: FallbackInput,
  discarded?: string,
  modelCalls = 0,
  costCents = 0,
): Promise<FallbackResult> {
  const gap = await recordGap(deps.db, { question: input.question, ...input.owner });
  return {
    answer: REFUSAL_TEXT,
    refused: true,
    ...(discarded === undefined ? {} : { discarded }),
    gapLogged: true,
    gapTimesAsked: gap.timesAsked,
    modelCalls,
    costCents,
  };
}

export async function runFallback(deps: FallbackDeps, input: FallbackInput): Promise<FallbackResult> {
  // ⛔ Prompt injection is answered by removing the model from the path, not by
  // telling the model to be careful. There is nothing here for a payload to
  // talk to.
  if (input.injectionSuspected) return refuse(deps, input, "injection markers in the visitor's message");

  if (deps.model === undefined || input.kbSlice.length === 0) {
    return refuse(deps, input, deps.model === undefined ? "no fallback model configured" : "knowledge base has nothing on this");
  }

  const out = await deps.model.answer({
    question: input.question,
    kbSlice: input.kbSlice,
    refusals: deps.policy.rules.map((r) => r.reason),
  });

  const cost = out.costCents ?? 0;
  if (out.refused || out.injectionSuspected) return refuse(deps, input, "model declined to answer", 1, cost);

  const missing = missingTerms(input.question, stemSet(out.answer));
  if (missing.length > 0) {
    return refuse(deps, input, `answer does not cover: ${missing.join(", ")}`, 1, cost);
  }
  if (CURRENCY.test(out.answer)) {
    return refuse(deps, input, "composed answer contained a price", 1, cost);
  }
  const blocked = deps.policy.guardAnswer(out.answer, { grounded: false });
  if (blocked !== null) return refuse(deps, input, blocked, 1, cost);

  // It survived every guard, which means it restated something the knowledge
  // base already contained. The visitor gets it with the hedge that it came
  // from published material rather than from the business directly.
  return { answer: out.answer, refused: false, gapLogged: false, modelCalls: 1, costCents: cost };
}
