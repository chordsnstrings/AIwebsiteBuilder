// Classification from the trading name's legal suffix.
//
// ⛔ This is EVIDENCE, not a heuristic, and the distinction matters. A name
// ending "Ltd" or "Limited" is a statement the business itself publishes: those
// suffixes are reserved by the Companies Act and by the Irish Companies Act,
// and using one without being registered is an offence. So a matching suffix is
// a positive assertion of corporate status made by the subscriber, which is
// exactly what PECR legitimate interest needs.
//
// ⛔ EVERYTHING ELSE IS "unknown", never "sole_trader". Absence of a suffix is
// not evidence of anything: plenty of registered companies trade under a name
// that omits it. Both answers deny at the gate, but only one of them is true,
// and a database full of confident "sole_trader" rows would be a database of
// assertions nobody can defend.
//
// This is the floor, not the ceiling. A real registry lookup (Companies House,
// CRO) resolves the names this cannot, and slots in behind the same interface.

import type { Classification, CompanyRegistry } from "./types.ts";

/**
 * Reserved company-type suffixes, by country.
 *
 * Kept per-country rather than pooled: "Teoranta" is meaningless in Great
 * Britain and "CIC" is meaningless in Ireland, and a pooled list would classify
 * on evidence that does not apply in the jurisdiction being tested.
 */
const SUFFIXES: Record<string, string[]> = {
  GB: [
    "ltd", "ltd.", "limited",
    "plc", "p.l.c.", "public limited company",
    "llp", "l.l.p.", "limited liability partnership",
    "cic", "c.i.c.", "community interest company",
    "cio", "lp",
    "cyf", "cyfyngedig",           // Welsh "limited"
    "ccc",                          // Welsh public limited company
  ],
  IE: [
    "ltd", "ltd.", "limited",
    "dac", "designated activity company",
    "clg", "company limited by guarantee",
    "plc", "p.l.c.",
    "ucc", "ulc", "unlimited company",
    "teo", "teoranta",              // Irish "limited"
  ],
};

/**
 * ⛔ Anchored to the END of the name and required to be a whole token.
 * Substring matching would classify "Limitless Roofing" and "Ultimate Plumbing"
 * as companies — "ltd" appears inside neither, but "limited" is a prefix of
 * "limitless" and a careless `includes` would match "Plc" inside "Splcorp".
 * Whole-token-at-the-end is what an actual registered name looks like.
 */
export function suffixEvidence(businessName: string, countryCode: string): string | null {
  const list = SUFFIXES[countryCode.toUpperCase()];
  if (list === undefined) return null;

  // Normalise: strip trailing punctuation and collapse whitespace, but keep the
  // full dotted forms ("p.l.c.") intact for the comparison below.
  const cleaned = businessName.trim().toLowerCase().replace(/\s+/g, " ").replace(/[,;]+$/g, "");
  if (cleaned === "") return null;

  for (const suffix of list) {
    // Multi-word suffixes ("public limited company") compare as a tail string;
    // single-word ones must be the final whitespace-delimited token.
    if (suffix.includes(" ")) {
      if (cleaned.endsWith(` ${suffix}`)) return suffix;
      continue;
    }
    const tokens = cleaned.split(" ");
    const last = tokens[tokens.length - 1];
    if (last === undefined) continue;
    // Trailing full stop is part of "ltd." itself, so compare both forms.
    if (last === suffix || last.replace(/\.$/, "") === suffix.replace(/\.$/, "")) return suffix;
  }
  return null;
}

/**
 * The offline classifier.
 *
 * Used when no registry credential is deposited — which is the normal state,
 * and is enormously better than the stub it replaces. It resolves the names
 * that carry their own evidence and says "unknown" about the rest, rather than
 * saying "unknown" about all of them.
 */
export class SuffixCompanyRegistry implements CompanyRegistry {
  readonly vendorId = "registry_lookup_local";

  async classify(businessName: string, countryCode: string): Promise<Classification> {
    const country = countryCode.toUpperCase();
    // ⛔ Only GB and IE need this. Returning "corporate" for a US business
    // would be inventing a classification for a jurisdiction that does not use
    // one — CAN-SPAM has no such concept.
    if (country !== "GB" && country !== "IE") return { subscriberType: "unknown", ref: null };
    const evidence = suffixEvidence(businessName, country);
    if (evidence === null) return { subscriberType: "unknown", ref: null };
    // The evidence travels with the answer. `suffix:ltd` is a weaker reference
    // than `companies_house:12345678`, and saying which one it was is the
    // difference between a defensible record and a bare claim.
    return { subscriberType: "corporate", ref: `suffix:${evidence}` };
  }
}
