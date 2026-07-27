// The evals/ suite entry point. `runAllSuites` runs every suite plus the
// fixture-coverage check and returns one named result per suite, shaped so the
// eval harness can write an eval_runs row for each without knowing anything
// about the suites themselves.
import type { AgentDeps } from "../../packages/agents/src/index.ts";
import {
  FIXTURE_BUSINESSES,
  REQUIRED_EDGE_CASES,
  REQUIRED_FAMILIES,
  REQUIRED_LOCALES,
  REQUIRED_REGIONS,
  REQUIRED_SEGMENTS,
  collidesWithKnownMark,
  edgeCasesPresent,
  hasNonLatinName,
  isSingleWordName,
  type FixtureBusiness,
} from "../fixtures/businesses.ts";
import { runCareSuite } from "./customer-care.ts";
import { runInjectionSuite } from "./injection.ts";
import { runIpSuite } from "./ip-claims.ts";
import type { NamedSuiteResult, SuiteResult } from "./types.ts";

export { CARE_CASES, runCareSuite, type CareCase } from "./customer-care.ts";
export {
  INJECTION_CASES,
  runInjectionSuite,
  simulateDuplicateBuilds,
  type InjectionCase,
} from "./injection.ts";
export { IP_CASES, runIpSuite, type IpCase, type IpSuiteResult } from "./ip-claims.ts";
export { passRate, type NamedSuiteResult, type SuiteResult } from "./types.ts";

export const FIXTURE_COUNT = 20;

/**
 * The fixture set is itself under test: a suite that runs against a set which
 * has quietly lost a region, a family or an edge case is a suite that reports
 * green while covering less. Each requirement counts as one case.
 */
export function checkFixtureCoverage(fixtures: FixtureBusiness[] = FIXTURE_BUSINESSES): SuiteResult {
  const checks: { name: string; failure: string | undefined }[] = [];
  const add = (name: string, failure: string | undefined): void => {
    checks.push({ name, failure });
  };

  add(
    "exactly 20 fixtures",
    fixtures.length === FIXTURE_COUNT ? undefined : `found ${fixtures.length}`,
  );

  const ids = new Set(fixtures.map((f) => f.id));
  add("fixture ids are unique", ids.size === fixtures.length ? undefined : "duplicate id");

  const regions = new Set(fixtures.map((f) => f.region));
  const missingRegions = REQUIRED_REGIONS.filter((r) => !regions.has(r));
  add("all 4 regions covered", missingRegions.length === 0 ? undefined : `missing ${missingRegions.join(", ")}`);

  const families = new Set(fixtures.map((f) => f.family));
  const missingFamilies = REQUIRED_FAMILIES.filter((f) => !families.has(f));
  add(
    "all 6 trade families covered",
    missingFamilies.length === 0 ? undefined : `missing ${missingFamilies.join(", ")}`,
  );

  const segments = new Set(fixtures.map((f) => f.segment));
  const missingSegments = REQUIRED_SEGMENTS.filter((s) => !segments.has(s));
  add("both segments covered", missingSegments.length === 0 ? undefined : `missing ${missingSegments.join(", ")}`);

  const locales = new Set(fixtures.map((f) => f.locale));
  const missingLocales = REQUIRED_LOCALES.filter((l) => !locales.has(l));
  add("all 3 locales covered", missingLocales.length === 0 ? undefined : `missing ${missingLocales.join(", ")}`);

  // Each named edge case must be tagged AND observable in the data where the
  // data can carry it — a tag with no matching row is a lie about coverage.
  const tagged = edgeCasesPresent(fixtures);
  const dataChecks: Partial<Record<(typeof REQUIRED_EDGE_CASES)[number], () => boolean>> = {
    no_photos: () => fixtures.some((f) => f.photoCount === 0),
    review_count_400: () => fixtures.some((f) => f.reviewCount === 400),
    non_latin_name: () => fixtures.some((f) => hasNonLatinName(f.name)),
    trademark_collision: () => fixtures.some((f) => collidesWithKnownMark(f.name)),
    single_word_name: () => fixtures.some((f) => isSingleWordName(f.name)),
    no_hours: () => fixtures.some((f) => f.hours === undefined),
  };
  for (const tag of REQUIRED_EDGE_CASES) {
    const dataCheck = dataChecks[tag];
    const failure = !tagged.has(tag)
      ? "no fixture is tagged with it"
      : dataCheck && !dataCheck()
        ? "tagged but no fixture row actually exhibits it"
        : undefined;
    add(`edge case ${tag}`, failure);
  }

  const failures = checks.filter((c) => c.failure !== undefined).map((c) => `${c.name}: ${c.failure}`);
  return { total: checks.length, passed: checks.length - failures.length, failures };
}

export interface AllSuitesResult {
  suites: NamedSuiteResult[];
  total: number;
  passed: number;
  failures: string[];
}

/**
 * Run every suite. The role on each result is the registry role the suite
 * exercises, so the harness can attribute the eval run to the right champion.
 */
export async function runAllSuites(deps: AgentDeps): Promise<AllSuitesResult> {
  const fixtures = checkFixtureCoverage();
  const injection = await runInjectionSuite(deps);
  const care = await runCareSuite(deps);
  const ip = await runIpSuite(deps);
  const { recall, ...ipCounts } = ip;

  const suites: NamedSuiteResult[] = [
    { suite: "fixtures", role: "enrichment", ...fixtures, detail: { fixtures: FIXTURE_BUSINESSES.length } },
    { suite: "injection", role: "customer_care", ...injection },
    { suite: "customer_care", role: "customer_care", ...care },
    { suite: "ip_claims", role: "ip_claims", ...ipCounts, detail: { recall } },
  ];

  return {
    suites,
    total: suites.reduce((n, s) => n + s.total, 0),
    passed: suites.reduce((n, s) => n + s.passed, 0),
    failures: suites.flatMap((s) => s.failures.map((f) => `[${s.suite}] ${f}`)),
  };
}
