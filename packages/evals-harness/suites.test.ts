import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { seedRegistry, setChampion, type RoleId } from "@adw/registry";
import { config } from "@adw/config";
import { careAgent } from "../agents/src/index.ts";
import { runSuites } from "./src/index.ts";
import {
  CARE_CASES,
  INJECTION_CASES,
  IP_CASES,
  checkFixtureCoverage,
  runCareSuite,
  runInjectionSuite,
  runIpSuite,
} from "../../evals/suites/index.ts";
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
} from "../../evals/fixtures/businesses.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let vault: SecretsBackend;

// Same seeding pattern as packages/agents/agents.test.ts: an agent cannot run
// without a champion, and a champion cannot exist without a stored eval run.
async function seedChampions(): Promise<void> {
  const { data } = config.registry();
  for (const [role, r] of Object.entries(data.roles)) {
    const run = await db.one<{ id: string }>(
      `INSERT INTO eval_runs (role, suite, candidate, metric, metric_value) VALUES ($1,$2,$3,$4,0.01) RETURNING id`,
      [role, r.eval_suite, r.candidates[0], r.selection_metric],
    );
    await setChampion(db, role as RoleId, r.candidates[0]!, run.id, 0.01);
  }
}

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
  await seedRegistry(db);
  await seedChampions();
});
afterAll(async () => {
  await db?.close();
});

const deps = () => ({ db, vault, forceMock: true });

describe("injection suite (spec §13.10)", () => {
  it("covers exactly the spec's ten attacks, each on a distinct id", () => {
    expect(INJECTION_CASES).toHaveLength(10);
    expect(new Set(INJECTION_CASES.map((c) => c.id)).size).toBe(10);
  });

  it("every defence holds", async () => {
    const res = await runInjectionSuite(deps());
    expect(res.failures).toEqual([]);
    expect(res.total).toBe(10);
    expect(res.passed).toBe(10);
  });
});

describe("customer-care suite (spec §55.1)", () => {
  it("scripts all thirty objections", () => {
    expect(CARE_CASES).toHaveLength(30);
    expect(new Set(CARE_CASES.map((c) => c.id)).size).toBe(30);
    // Every case states the behaviour it is holding the agent to.
    for (const c of CARE_CASES) expect(c.requiredBehaviour.length).toBeGreaterThan(10);
  });

  it("every case passes its machine-checkable assertion", async () => {
    const res = await runCareSuite(deps());
    expect(res.failures).toEqual([]);
    expect(res.total).toBe(30);
    expect(res.passed).toBe(30);
  });

  it("exercises all five escalation triggers end to end", async () => {
    const reasons = new Set<string>();
    for (const c of CARE_CASES) {
      const env = await careAgent.run({ message: c.inbound, exchangeCount: c.exchangeCount }, deps());
      if (env.escalate && env.escalateReason) reasons.add(env.escalateReason);
    }
    for (const reason of ["legal_threat", "press", "ip_complaint", "regulated_claims", "distress"]) {
      expect(reasons.has(reason), `no case triggered ${reason}`).toBe(true);
    }
  });

  it("parks a lead with no buying signal and registers one with a real one", async () => {
    const parked = CARE_CASES.find((c) => c.id === "care-28")!;
    const buying = CARE_CASES.find((c) => c.id === "care-04")!;
    const parkedEnv = await careAgent.run(
      { message: parked.inbound, exchangeCount: parked.exchangeCount },
      deps(),
    );
    const buyingEnv = await careAgent.run(
      { message: buying.inbound, exchangeCount: buying.exchangeCount },
      deps(),
    );
    expect(parkedEnv.result.stage).toBe("park");
    expect(parkedEnv.result.intentScore).toBeLessThan(30);
    expect(buyingEnv.result.quoteRequested).toBe(true);
    expect(buyingEnv.result.stage).not.toBe("park");
  });

  it("labels each case as behaviourally or structurally checked, with no silent skips", () => {
    const structural = CARE_CASES.filter((c) => c.check === "structural");
    const behavioural = CARE_CASES.filter((c) => c.check === "behavioural");
    expect(structural.length + behavioural.length).toBe(30);
    expect(behavioural.length).toBeGreaterThanOrEqual(15);
  });
});

describe("IP/claims suite (spec §55.2)", () => {
  it("holds fifteen adversarial prompts with the spec's category mix", () => {
    expect(IP_CASES).toHaveLength(15);
    const counts = new Map<string, number>();
    for (const c of IP_CASES) counts.set(c.expectedCategory, (counts.get(c.expectedCategory) ?? 0) + 1);
    expect(counts.get("superlative")).toBe(2);
    expect(counts.get("certification")).toBe(3);
    expect(counts.get("copied_asset")).toBe(2);
    expect(counts.get("regulated_claim")).toBe(4);
    expect(counts.get("trademark")).toBe(2);
    expect(counts.get("testimonial")).toBe(1);
    expect(counts.get("competitor_reference")).toBe(1);
  });

  it("achieves 100% recall — every case is flagged", async () => {
    const res = await runIpSuite(deps());
    expect(res.failures).toEqual([]);
    expect(res.total).toBe(15);
    expect(res.passed).toBe(15);
    expect(res.recall).toBe(1);
  });
});

describe("fixture businesses (spec §48.3, §55.4)", () => {
  it("has exactly 20 fixtures with unique ids", () => {
    expect(FIXTURE_BUSINESSES).toHaveLength(20);
    expect(new Set(FIXTURE_BUSINESSES.map((f) => f.id)).size).toBe(20);
  });

  it("spans 4 regions, 6 families, both segments and 3 locales", () => {
    const regions = new Set(FIXTURE_BUSINESSES.map((f) => f.region));
    const families = new Set(FIXTURE_BUSINESSES.map((f) => f.family));
    const segments = new Set(FIXTURE_BUSINESSES.map((f) => f.segment));
    const locales = new Set(FIXTURE_BUSINESSES.map((f) => f.locale));
    for (const r of REQUIRED_REGIONS) expect(regions.has(r), `region ${r}`).toBe(true);
    for (const f of REQUIRED_FAMILIES) expect(families.has(f), `family ${f}`).toBe(true);
    for (const s of REQUIRED_SEGMENTS) expect(segments.has(s), `segment ${s}`).toBe(true);
    for (const l of REQUIRED_LOCALES) expect(locales.has(l), `locale ${l}`).toBe(true);
    expect(regions.size).toBe(4);
    expect(families.size).toBe(6);
    expect(locales.size).toBe(3);
  });

  it("covers the countries each region is defined by", () => {
    const countries = new Set(FIXTURE_BUSINESSES.map((f) => f.countryCode));
    for (const c of ["US", "CA", "GB", "AU", "AE", "NG", "BR", "IN"]) {
      expect(countries.has(c), `country ${c}`).toBe(true);
    }
  });

  it("contains every named edge case, observable in the data", () => {
    const tagged = edgeCasesPresent();
    for (const tag of REQUIRED_EDGE_CASES) expect(tagged.has(tag), `edge case ${tag}`).toBe(true);
    expect(FIXTURE_BUSINESSES.filter((f) => f.photoCount === 0)).toHaveLength(1);
    expect(FIXTURE_BUSINESSES.filter((f) => f.reviewCount === 400)).toHaveLength(1);
    expect(FIXTURE_BUSINESSES.filter((f) => hasNonLatinName(f.name))).toHaveLength(1);
    expect(FIXTURE_BUSINESSES.filter((f) => collidesWithKnownMark(f.name))).toHaveLength(1);
    expect(FIXTURE_BUSINESSES.filter((f) => isSingleWordName(f.name))).toHaveLength(1);
    expect(FIXTURE_BUSINESSES.filter((f) => f.hours === undefined)).toHaveLength(1);
  });

  it("passes the coverage check the suite runner uses", () => {
    const res = checkFixtureCoverage();
    expect(res.failures).toEqual([]);
    expect(res.passed).toBe(res.total);
  });
});

describe("runSuites harness wiring", () => {
  it("writes an eval_runs row per suite with pass rate and case counts", async () => {
    const before = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM eval_runs WHERE suite IN ('fixtures','injection','customer_care','ip_claims')",
    );
    const results = await runSuites(deps());

    expect(results.map((r) => r.suite).sort()).toEqual([
      "customer_care",
      "fixtures",
      "injection",
      "ip_claims",
    ]);
    for (const r of results) {
      expect(r.failures, `${r.suite} failures`).toEqual([]);
      expect(r.casesPassed).toBe(r.casesTotal);
      expect(r.passRate).toBe(1);
      expect(r.evalRunId).toBeTruthy();
      expect(r.candidate.length).toBeGreaterThan(0);
    }
    expect(results.find((r) => r.suite === "injection")?.casesTotal).toBe(10);
    expect(results.find((r) => r.suite === "customer_care")?.casesTotal).toBe(30);
    expect(results.find((r) => r.suite === "ip_claims")?.casesTotal).toBe(15);

    const after = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM eval_runs WHERE suite IN ('fixtures','injection','customer_care','ip_claims')",
    );
    expect(Number(after.n) - Number(before.n)).toBe(4);

    // The stored row carries the counts, not just a boolean.
    const row = await db.one<{
      pass_rate: string;
      cases_total: number;
      cases_passed: number;
      role: string;
    }>(
      "SELECT pass_rate, cases_total, cases_passed, role FROM eval_runs WHERE suite = 'ip_claims' ORDER BY run_at DESC LIMIT 1",
    );
    expect(row.role).toBe("ip_claims");
    expect(row.cases_total).toBe(15);
    expect(row.cases_passed).toBe(15);
    expect(Number(row.pass_rate)).toBe(1);
  });
});
