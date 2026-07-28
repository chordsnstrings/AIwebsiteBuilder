// The refusal policy — one implementation, two surfaces.
//
// @adw/mcp declares `RefusalChecker` and takes it by injection precisely so
// that an AI assistant calling the MCP endpoint and a human typing into the
// chat widget get the SAME decision. Two copies of a refusal rule drift, and
// the drift is invisible until an assistant gets an answer a person would have
// been refused — at which point the machine surface has become the way around
// the guardrails. This file is that one implementation.
//
// The rules themselves live in config/playbooks.yaml, change class SENSITIVE.
// Nothing here decides what is refusable; it decides WHEN a configured refusal
// applies, and there are exactly two answers:
//
//   HARD        — never, from any source. Regulated advice, guaranteed arrival
//                 times, competitor comparisons, payment details in chat,
//                 pricing from a photo. No fact makes these sayable.
//
//   GROUNDABLE  — sayable if and only if the business published it. "Are you
//                 insured?" is answerable by a business that published its
//                 insurance and refused for one that did not, so the rule
//                 cannot fire on the question; it fires on text the model
//                 composed.
//
// ⛔ An unrecognised rule id is treated as HARD. A refusal added to the config
// without a corresponding entry here therefore refuses more, never less — the
// failure direction is silence, which is recoverable, rather than an
// unqualified claim on someone else's behalf, which is not.

import { config } from "@adw/config";
import type { RefusalChecker } from "@adw/mcp";

export interface RefusalRule {
  id: string;
  matches: string[];
  reason: string;
  /** True when a published fact satisfies the rule. See the header. */
  groundable: boolean;
  /** Empty for the universal set. */
  vertical: string;
}

/**
 * Rules a verified, published fact can satisfy. Everything else is hard.
 * Deliberately a short, explicit list rather than a heuristic over the reason
 * text: the reason strings are prose written for a compliance reviewer, and
 * pattern-matching on prose is how this guarantee would rot.
 */
const GROUNDABLE_RULE_IDS = new Set([
  "unverified_credential",
  "unpublished_price",
  "trade_certification",
  "electrical_certification",
  "gas_certification",
  "refrigerant_certification",
]);

interface PlaybookRefusal {
  id: string;
  matches?: string[];
  reason: string;
}

function escapeRe(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary matching, not substring. "award" must not fire on "awarded a
 * contract" — a false refusal is cheap but a false refusal that fires on a
 * common word makes the agent useless, and useless is its own failure.
 */
function matcher(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRe(phrase.toLowerCase())}\\b`, "i");
}

const matcherCache = new Map<string, RegExp>();
function cachedMatcher(phrase: string): RegExp {
  let re = matcherCache.get(phrase);
  if (re === undefined) {
    re = matcher(phrase);
    matcherCache.set(phrase, re);
  }
  return re;
}

function ruleMatches(rule: RefusalRule, text: string): boolean {
  return rule.matches.some((m) => cachedMatcher(m).test(text));
}

/** Every rule that applies to this vertical: the universal set plus its own. */
export function refusalRules(vertical: string): RefusalRule[] {
  const data = config.playbooks().data as {
    universal_refusals?: PlaybookRefusal[];
    verticals?: Record<string, { refusals?: PlaybookRefusal[] }>;
  };
  const build = (row: PlaybookRefusal, v: string): RefusalRule => ({
    id: row.id,
    matches: row.matches ?? [],
    reason: row.reason,
    groundable: GROUNDABLE_RULE_IDS.has(row.id),
    vertical: v,
  });
  return [
    ...(data.universal_refusals ?? []).map((r) => build(r, "")),
    ...(data.verticals?.[vertical]?.refusals ?? []).map((r) => build(r, vertical)),
  ];
}

/**
 * Is this utterance ASKING the agent for something, as opposed to describing a
 * situation? Several rules are written as constraints on what the agent may
 * say — auto_repair's "the problem is", for instance — and firing those on a
 * visitor's own words would refuse "the problem is my car won't start", which
 * is a customer describing a fault, not asking for a diagnosis.
 *
 * A declarative sentence still gets its ANSWER guarded; only the up-front
 * refusal is withheld.
 */
export function isQuestionShaped(text: string): boolean {
  if (text.includes("?")) return true;
  return /^\s*(what|when|where|who|why|how|which|do|does|did|can|could|are|is|was|will|would|should|shall|may|might|am|have|has|any|tell|give|show|explain|please)\b/i.test(
    text,
  );
}

export interface AnswerGuardContext {
  /** True when the words came verbatim from a stored, owner-approved pair. */
  grounded: boolean;
}

export interface RefusalPolicy extends RefusalChecker {
  readonly vertical: string;
  readonly rules: RefusalRule[];
  /** Hard refusals only, and only for a question-shaped utterance. */
  check(question: string, context: { vertical: string }): string | null;
  /** Applied to every outgoing answer. Groundable rules are skipped for text
   *  that came verbatim from an approved pair. */
  guardAnswer(answer: string, context: AnswerGuardContext): string | null;
}

export function refusalPolicy(vertical: string): RefusalPolicy {
  const rules = refusalRules(vertical);
  return {
    vertical,
    rules,
    check(question: string): string | null {
      if (!isQuestionShaped(question)) return null;
      for (const rule of rules) {
        if (rule.groundable) continue;
        if (ruleMatches(rule, question)) return rule.reason;
      }
      return null;
    },
    guardAnswer(answer: string, context: AnswerGuardContext): string | null {
      for (const rule of rules) {
        // A stored pair IS the business's published position; a groundable rule
        // has nothing left to protect against once the owner has approved the
        // words. Model-composed text gets no such benefit of the doubt.
        if (rule.groundable && context.grounded) continue;
        if (ruleMatches(rule, answer)) return rule.reason;
      }
      return null;
    },
  };
}

/** The wording a refusal reaches the visitor as. Never the internal reason —
 *  "Only prices the business has published may be stated" is a note to an
 *  operator, not something to say to a customer. */
export const REFUSAL_TEXT =
  "That's not something I can answer for them — I'd only be guessing, and I don't want to. " +
  "I've passed the question on and someone from the business will come back to you.";
