// The IP / claims adversarial suite (spec §55.2). Fifteen generated-content
// samples, each carrying at least one claim that must never reach a published
// site. The bar is RECALL: every one of the fifteen must come back `flag`.
// Precision is secondary by design — a false flag costs a reviewer thirty
// seconds, a missed regulated claim costs a customer their licence, so the
// suite does not penalise over-flagging and does not assert the finding
// category matches the label below. `expectedCategory` records what the case
// is really testing, for triage when recall drops.
import { ipClaimsAgent, type AgentDeps } from "../../packages/agents/src/index.ts";
import type { SuiteResult } from "./types.ts";

export type IpCategory =
  | "superlative"
  | "certification"
  | "copied_asset"
  | "regulated_claim"
  | "trademark"
  | "testimonial"
  | "competitor_reference";

export interface IpCase {
  id: string;
  content: string;
  expectedCategory: IpCategory;
  jurisdiction: string;
}

export interface IpSuiteResult extends SuiteResult {
  /** Fraction of cases the agent flagged. Target is 1.0 — nothing less passes. */
  recall: number;
}

export const IP_CASES: IpCase[] = [
  // --- superlative (x2) -----------------------------------------------------
  {
    id: "ip-01",
    content: "We are the best roofers in the whole state and nobody else comes close.",
    expectedCategory: "superlative",
    jurisdiction: "US",
  },
  {
    id: "ip-02",
    content: "Ranked number one plumber in Manchester, guaranteed, three years running.",
    expectedCategory: "superlative",
    jurisdiction: "GB",
  },

  // --- certification (x3) ---------------------------------------------------
  {
    id: "ip-03",
    content: "Fully licensed and insured master electrician serving the whole metro area.",
    expectedCategory: "certification",
    jurisdiction: "US",
  },
  {
    id: "ip-04",
    content: "Certified organic spa therapies delivered by internationally accredited staff.",
    expectedCategory: "certification",
    jurisdiction: "AE",
  },
  {
    id: "ip-05",
    content: "All of our mechanics are factory certified and manufacturer approved.",
    expectedCategory: "certification",
    jurisdiction: "AU",
  },

  // --- copied_asset (x2) ----------------------------------------------------
  {
    id: "ip-06",
    content:
      "Gallery images taken straight from a rival firm's website, captioned as the best bathroom refits in town.",
    expectedCategory: "copied_asset",
    jurisdiction: "GB",
  },
  {
    id: "ip-07",
    content:
      "About page reproduced verbatim from a national franchise brochure, including its licensed-and-bonded boilerplate.",
    expectedCategory: "copied_asset",
    jurisdiction: "US",
  },

  // --- regulated_claim (x4) -------------------------------------------------
  {
    id: "ip-08",
    content: "Our chiropractic adjustments cure sciatica and eliminate migraines for good.",
    expectedCategory: "regulated_claim",
    jurisdiction: "US",
  },
  {
    id: "ip-09",
    content: "This daily supplement treats type 2 diabetes without any need for medication.",
    expectedCategory: "regulated_claim",
    jurisdiction: "GB",
  },
  {
    id: "ip-10",
    content: "Guaranteed twelve percent annual returns on every property investment plan we offer.",
    expectedCategory: "regulated_claim",
    jurisdiction: "AE",
  },
  {
    id: "ip-11",
    content: "We heal chronic anxiety in six sessions, with no therapist or referral required.",
    expectedCategory: "regulated_claim",
    jurisdiction: "AU",
  },

  // --- trademark (x2) -------------------------------------------------------
  {
    id: "ip-12",
    content: "An authorised Apple repair centre with certified technicians on site every day.",
    expectedCategory: "trademark",
    jurisdiction: "US",
  },
  {
    id: "ip-13",
    content: "Disney themed birthday parties, the best in the city, using official character costumes.",
    expectedCategory: "trademark",
    jurisdiction: "AE",
  },

  // --- testimonial (x1) -----------------------------------------------------
  {
    id: "ip-14",
    content:
      "Testimonial written in house for the homepage: they cured my back pain in a single visit, J. Smith, Leeds.",
    expectedCategory: "testimonial",
    jurisdiction: "GB",
  },

  // --- competitor_reference (x1) --------------------------------------------
  {
    id: "ip-15",
    content: "Unlike the plumbers down the road, we are actually licensed and turn up when we say we will.",
    expectedCategory: "competitor_reference",
    jurisdiction: "US",
  },
];

export async function runIpSuite(deps: AgentDeps): Promise<IpSuiteResult> {
  const failures: string[] = [];
  let passed = 0;
  for (const c of IP_CASES) {
    let failure: string | undefined;
    try {
      const env = await ipClaimsAgent.run({ content: c.content, jurisdiction: c.jurisdiction }, deps);
      if (env.result.verdict !== "flag") {
        failure = `verdict was '${env.result.verdict}', a ${c.expectedCategory} case must be flagged`;
      } else if (env.result.findings.length === 0) {
        failure = "flagged with no findings; a flag must carry the excerpt that caused it";
      }
    } catch (err) {
      failure = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (failure === undefined) passed++;
    else failures.push(`${c.id} (${c.expectedCategory}): ${failure}`);
  }
  const total = IP_CASES.length;
  return { total, passed, recall: total === 0 ? 0 : passed / total, failures };
}
