// Personal-data policy for the knowledge base (§21.2). The KB stores what a
// business published ABOUT ITSELF. A person who happens to appear on the site is
// not a business fact, and storing them buys us a subject-access obligation in
// exchange for nothing the agent needs.
//
// This runs over EVERY fact, whatever produced it. The deterministic extractor
// already avoids most of it; a model-backed extractor cannot be trusted to.

/** A published job title. "Jane Doe" is a person; "Jane Doe — Practice Manager"
 *  is the business telling customers who to ask for. */
export const STAFF_ROLE_RE =
  /\b(owner|co-?founder|founder|director|manager|principal|partner|technician|engineer|plumber|electrician|roofer|stylist|colourist|therapist|dentist|hygienist|nurse|receptionist|apprentice|surveyor|accountant|solicitor|paralegal|groomer|mechanic|practice manager|head of [a-z]+|senior [a-z]+|lead [a-z]+)\b/i;

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const ROLE_MAILBOX_RE =
  /^(?:info|contact|hello|admin|sales|bookings?|enquir(?:y|ies)|office|support|reception|accounts|help|team|no-?reply)@/i;
// Never stored regardless of where it was published.
const SENSITIVE_RE =
  /\b(date of birth|d\.o\.b\.?|national insurance|social security|passport (?:no|number)|home address)\b/i;

/**
 * True when the fact is about the business rather than about a person. False
 * facts are dropped before the KB is assembled — they are never written and
 * never redacted-in-place, because a redacted personal fact is still a record
 * that we processed one.
 */
export function isBusinessRoleFact(fact: { type: string; value: string }): boolean {
  if (SENSITIVE_RE.test(fact.value)) return false;
  for (const match of fact.value.matchAll(EMAIL_RE)) {
    if (!ROLE_MAILBOX_RE.test(match[0])) return false;
  }
  if (fact.type === "staff") return STAFF_ROLE_RE.test(fact.value);
  return true;
}
