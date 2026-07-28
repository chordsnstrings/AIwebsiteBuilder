// The coverage guard — the second gate, and the one that earns its keep.
//
// A similarity threshold alone is not grounding. Measured against a real pack:
//
//     "are you gas safe registered"  →  0.759  "Are you insured?"
//
// 0.759 clears the 0.65 hedged floor, so a score-only retriever answers a Gas
// Safe question with an insurance answer. That is the exact failure the product
// exists to prevent — an unverified certification claim made on the business's
// behalf, and under Moffatt v. Air Canada the liability for it is theirs.
//
// The reason the score is high is that the embedding is doing its job: both
// questions ARE about credentials. Concept similarity is the right signal for
// finding candidates and the wrong one for deciding an answer is about the same
// thing. So candidates are ranked by similarity and then checked for coverage:
//
//   ⛔ every term in the question that NARROWS it must appear in the pair.
//
// A narrowing term is anything that is not grammar and not question phrasing.
// "How much do you charge for a callout?" narrows to {callout} — "much" and
// "charge" are interchangeable phrasings of the same question. "Are you gas
// safe registered?" narrows to {gas, safe, registered}, and a pair about
// insurance carries none of them.
//
// The rule is deliberately strict, and it fails toward silence: a pair that
// used a synonym the visitor did not is a miss, the exact question lands in the
// gap list, and the owner answers it once. Being asked is cheap; asserting a
// certification the business never published is not.

/** Grammar. Carries no information about WHICH question is being asked. */
const STOPWORDS = new Set([
  "a", "about", "actually", "after", "all", "also", "am", "an", "and", "any", "anyone", "are",
  "as", "at", "be", "been", "being", "but", "by", "can", "could", "did", "do", "does", "doing",
  "for", "from", "had", "has", "have", "he", "her", "here", "hey", "hi", "hello", "him", "his",
  "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "might", "mine", "more",
  "my", "no", "not", "of", "on", "one", "only", "or", "our", "ours", "out", "over", "own",
  "please", "really", "s", "she", "should", "so", "some", "such", "thanks", "thank", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "too", "up",
  "us", "very", "was", "we", "were", "what", "whats", "when", "where", "which", "while", "who",
  "why", "will", "with", "would", "yes", "you", "your", "yours",
]);

/**
 * Question phrasing. Two questions that differ only by a word in here are the
 * same question — "what does it cost" and "how much do you charge" both narrow
 * to nothing and both mean "price".
 *
 * ⛔ Nothing that distinguishes two real questions may be added here. `open`
 * and `close` are absent on purpose: "what time do you open" and "what time do
 * you close" are different questions, and treating either as phrasing would let
 * one answer the other. Same for the credential words — `insured`, `certified`,
 * `registered` name distinct attributes and each may be answered only by
 * itself.
 */
const PHRASING = new Set([
  // generic verbs of enquiry
  "come", "comes", "deal", "deals", "get", "give", "gives", "go", "handle", "handles", "help",
  "know", "let", "look", "looking", "need", "needs", "offer", "offers", "provide", "provides",
  "say", "see", "tell", "take", "takes", "want", "wants", "work", "works", "cover", "covers",
  "covered", "coverage", "serve", "serves", "servicing", "doing", "done", "use", "uses",
  // the money question, in all its phrasings
  "charge", "charges", "cost", "costs", "estimate", "estimates", "fee", "fees", "many", "much",
  "price", "priced", "prices", "pricing", "quotation", "quote", "quotes", "rate", "rates",
  // generic nouns of enquiry
  "able", "available", "availability", "details", "info", "information", "long", "possible",
  "question", "questions", "soon", "quickly", "time", "times",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

/**
 * Light suffix stripping. Not a linguistic stemmer and not trying to be — it
 * exists so "boilers" in a question matches "boiler" in an answer, and the
 * failure mode of missing a match is a logged gap rather than a wrong answer.
 */
export function stem(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y";
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** The terms that make this question specific rather than generic. */
export function narrowingTerms(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens(question)) {
    if (STOPWORDS.has(token) || PHRASING.has(token)) continue;
    // Single letters are noise; digits are not — "3 bedroom" narrows.
    if (token.length < 2 && !/\d/.test(token)) continue;
    const s = stem(token);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function covers(pairStems: Set<string>, term: string): boolean {
  if (pairStems.has(term)) return true;
  // Prefix match absorbs the morphology the stemmer misses ("insur" from
  // "insured" against "insurance"). Held to 4+ characters so short tokens like
  // "gas" cannot prefix-match their way into an unrelated answer.
  if (term.length < 4) return false;
  for (const s of pairStems) {
    if (s.startsWith(term) || term.startsWith(s)) {
      const shorter = Math.min(s.length, term.length);
      if (shorter >= 4) return true;
    }
  }
  return false;
}

/** Stems of everything the pair says. Precomputed per pair at index build. */
export function stemSet(text: string): Set<string> {
  return new Set(tokens(text).map(stem));
}

/**
 * Which of the question's narrowing terms the pair does not contain. Empty
 * means the pair is about the same thing; anything else means it is not, no
 * matter how similar the two read.
 */
export function missingTerms(question: string, pairStems: Set<string>): string[] {
  return narrowingTerms(question).filter((t) => !covers(pairStems, t));
}
