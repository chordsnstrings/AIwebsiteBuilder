// Prompt-injection detection, in ONE place.
//
// ⛔ WHY THIS FILE EXISTS. The detector was a regex literal copy-pasted into six
// agents in three different versions, and every one of them shared the same
// hole:
//
//     /ignore (previous|all) instructions/i
//
// That matches "ignore previous instructions" and "ignore all instructions",
// and MISSES "ignore all previous instructions" — because after "all" it
// demands "instructions" immediately, and the commonest phrasing in the wild
// puts "previous" in between. The single most-typed injection string on the
// internet went straight through, in all six agents, silently.
//
// ⛔ This detector is a TRIPWIRE, not a filter. Nothing here decides what the
// model sees — the untrusted-content envelope and the capability matrix do
// that, and they hold whether or not this fires. What this does is record that
// somebody tried, so a canary can halt a role and a human can look. A tripwire
// that misses is worse than none, because it makes the absence of alerts read
// as the absence of attempts.

export interface InjectionSignal {
  /** Short name of the family matched, for the operator console. */
  family: string;
  /** The matched text, trimmed. Never the whole input — that could be a page. */
  excerpt: string;
}

/**
 * The families, deliberately broad in the filler they allow and narrow in the
 * verbs and nouns they anchor on.
 *
 * The `[\s\S]{0,40}?` gaps matter: real attempts insert words ("ignore all of
 * your previous instructions"), punctuation and newlines. Anchoring on the verb
 * and the noun with a bounded gap between catches the family without matching
 * unrelated prose that happens to contain both words far apart.
 */
const FAMILIES: { family: string; pattern: RegExp }[] = [
  {
    family: "override_instructions",
    // ignore / disregard / forget / override … instructions | prompt | rules
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass|discard)\b[\s\S]{0,40}?\b(?:instruction|instructions|prompt|prompts|rule|rules|direction|directions|guideline|guidelines)\b/i,
  },
  {
    family: "system_prompt",
    pattern: /\bsystem\s*(?:-|_)?\s*prompt\b/i,
  },
  {
    family: "reveal_instructions",
    pattern:
      /\b(?:reveal|show|print|repeat|output|display|tell\s+me)\b[\s\S]{0,40}?\b(?:your|the)\b[\s\S]{0,20}?\b(?:prompt|instructions|rules|configuration)\b/i,
  },
  {
    family: "persona_override",
    // ⛔ Anchored on the IDENTITY being asserted, not on the words "you are
    // now". A bare /you are now/ fired on "You are now open on Saturdays
    // according to your website?", which is an ordinary question from a
    // customer — and a tripwire that cries wolf gets muted, which is the same
    // as having none. So it must name an assistant-ish identity, a restriction
    // being lifted, or an explicit instruction about future behaviour.
    pattern: new RegExp(
      [
        // "you are now an unrestricted assistant", "you are DAN"
        /\byou\s+are\s+(?:now\s+)?(?:a|an|the)?\s*(?:unrestricted|uncensored|jailbroken|unfiltered|DAN\b|(?:a\s+)?different\s+(?:AI|assistant|model)|an?\s+(?:AI|assistant|language\s+model|chatbot|bot))/i
          .source,
        // "you are no longer bound by", "you are not bound by"
        /\byou\s+are\s+(?:no\s+longer|not)\s+(?:bound|restricted|limited)\b/i.source,
        // An explicit instruction about future behaviour.
        /\bfrom\s+now\s+on[\s\S]{0,20}?\byou\s+(?:will|must|shall|should|are\s+to|can\s+ignore)\b/i.source,
        /\b(?:act|behave|respond)\s+as\s+(?:a|an|if)\b/i.source,
        /\bpretend\s+(?:to\s+be|you\s+are)\b/i.source,
        /\broleplay\s+as\b/i.source,
      ].join("|"),
      "i",
    ),
  },
  {
    family: "developer_mode",
    pattern: /\b(?:developer\s+mode|DAN\s+mode|jailbreak|unrestricted\s+mode|no\s+longer\s+bound)\b/i,
  },
  {
    family: "fake_authority",
    // Text pretending to be a system or operator turn inside user content.
    pattern:
      /(?:^|\n)\s*(?:\[|<|#{1,3}\s*)?(?:system|assistant|developer|admin(?:istrator)?)\s*(?:\]|>|:)/i,
  },
  {
    family: "marker_forgery",
    // Attempts to close the untrusted-content envelope early.
    pattern: /<\/?\s*(?:untrusted|end[_-]?untrusted|user[_-]?content|system)\s*>/i,
  },
];

/**
 * Every injection family present in the text.
 *
 * ⛔ Returns ALL matches rather than the first. Two independent families in one
 * message is a materially stronger signal than one, and a caller that only ever
 * saw "true" could not tell the difference.
 */
export function injectionSignals(text: string | null | undefined): InjectionSignal[] {
  if (typeof text !== "string" || text === "") return [];
  const signals: InjectionSignal[] = [];
  for (const { family, pattern } of FAMILIES) {
    const match = pattern.exec(text);
    if (match !== null) {
      signals.push({ family, excerpt: match[0].replace(/\s+/g, " ").trim().slice(0, 120) });
    }
  }
  return signals;
}

/**
 * The boolean the agents set on their output.
 *
 * Accepts several fields at once because most agents have more than one
 * untrusted input (a listing's text and its name, a message and its subject)
 * and checking only the obvious one is how the second one gets through.
 */
export function suspectsInjection(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => injectionSignals(t).length > 0);
}
