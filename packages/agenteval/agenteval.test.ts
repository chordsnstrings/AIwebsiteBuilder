// The gate that stands between a built agent and a customer's visitors.
//
// The tests here are mostly about the ways a gate stops being a gate: partial
// credit creeping in, a refusal probe the pack can legitimately answer, a
// "paraphrase" that quietly asks a different question, and a caller that reads
// the verdict and carries on regardless.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import { buildPackIndex, narrowingTerms } from "@adw/concierge";
import { embedText, persistQAPack, type QAPack, type QAPair } from "@adw/qapack";
import {
  AgentEvalFailed,
  assertAgentEvalPassed,
  buildCases,
  evalCounts,
  groundedCases,
  judgeCase,
  latestRun,
  refusalCases,
  runAgentEval,
  selectPairs,
} from "./src/index.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

// A pack the size onboarding actually produces. Twenty grounded cases need at
// least twenty pairs, and a fixture that only just clears the bar would hide a
// selection bug.
const PAIRS: [string, string][] = [
  ["What areas do you cover?", "We cover Bur Dubai, Deira and Jumeirah, and travel to Sharjah for larger jobs."],
  ["What are your opening hours?", "We're open Monday to Friday, 8am to 5pm."],
  ["How much is a callout?", "Our standard callout is AED 150, which comes off the job if you go ahead."],
  ["Do you offer emergency callouts?", "Yes, we run an out-of-hours emergency line for burst pipes and leaks."],
  ["Are you insured?", "We hold public liability insurance."],
  ["Do you install boilers?", "We install and service boilers, including replacements for older systems."],
  ["How do I book an appointment?", "Tell us what you need and a time that suits, and we'll confirm the slot."],
  ["Do you offer a warranty?", "All installation work carries a twelve month workmanship warranty."],
  ["Do you fix leaking taps?", "Leaking taps and washers are one of our most common jobs."],
  ["Do you clear blocked drains?", "We clear blocked drains using rods and high pressure jetting."],
  ["Do you fit bathrooms?", "We fit complete bathrooms, from removal through to tiling."],
  ["Do you handle water heater repairs?", "We repair and replace water heaters of most makes."],
  ["Can you help with low water pressure?", "Low water pressure is something we diagnose on site."],
  ["Do you work with landlords?", "We look after several landlords and their rental portfolios."],
  ["How long have you been trading?", "The business has been trading since 2011."],
  ["Do you replace radiators?", "We replace radiators and can rebalance a system afterwards."],
  ["Do you offer annual servicing?", "We offer an annual service visit for boilers and water heaters."],
  ["Which payment methods do you accept?", "We accept bank transfer and all major debit cards on completion."],
  ["Do you fit water softeners?", "Water softener installation is something we do regularly."],
  ["Can you deal with a burst pipe?", "A burst pipe is treated as an emergency and we attend the same day."],
  ["Do you fit outside taps?", "Outside taps are a straightforward job we do often."],
  ["Do you provide written quotations?", "Every job over a small repair comes with a written quotation first."],
  ["Do you work at weekends?", "Weekend visits are available through the emergency line."],
  ["Do you tidy up afterwards?", "We sheet up before starting and clear everything away when we finish."],
];

function pair(question: string, answer: string): QAPair {
  return {
    id: randomUUID(),
    question,
    answer,
    sourceFactIds: [randomUUID()],
    embedding: embedText(question),
    confidence: 0.9,
    source: "generated",
  };
}

function makePack(overrides: Partial<QAPack> = {}): QAPack {
  return {
    id: randomUUID(),
    kbId: randomUUID(),
    businessId: randomUUID(),
    version: 1,
    vertical: "plumber",
    playbookVersion: "test",
    embeddingProvider: "adw-hashed-ngram-v1",
    pairs: PAIRS.map(([q, a]) => pair(q!, a!)),
    coverage: { byTopic: {}, byVerticalTemplate: { answered: 0, total: 0, ratio: 0 }, factsUsed: 24, factsAvailable: 30 },
    templateFallbacks: [],
    gaps: [],
    excluded: [],
    thin: false,
    extendedOnboarding: false,
    approvedAt: new Date("2026-01-01T00:00:00Z"),
    approvedBy: "owner@example.com",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Point one pair's vector at something else entirely, leaving the text alone.
 *
 * Corrupting the ANSWER would not do it: the index scans question + answer, so
 * a pair with a nonsense answer is still found by its own question. The thing
 * that actually strands a pair is a bad vector, which is why that is what the
 * fixture breaks.
 */
function misindex(pack: QAPack, index: number): QAPack {
  return {
    ...pack,
    pairs: pack.pairs.map((p, i) =>
      i === index ? { ...p, embedding: embedText("unrelated filler with no bearing on anything") } : p,
    ),
  };
}

async function seed(): Promise<{ customerId: string; businessId: string; pack: QAPack }> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,'Eval Plumbing','AE','R3','no_site','plumber') RETURNING id`,
    [batch.id],
  );
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R3','Eval Plumbing',$2,'en-GB','Asia/Dubai','active') RETURNING id`,
    [biz.id, `eval_${randomUUID()}@example.com`],
  );
  const kb = await db.one<{ id: string }>(
    `INSERT INTO knowledge_bases (business_id, customer_id) VALUES ($1,$2) RETURNING id`,
    [biz.id, cust.id],
  );
  const pack = makePack({ kbId: kb.id, businessId: biz.id, customerId: cust.id });
  await persistQAPack(db, pack);
  return { customerId: cust.id, businessId: biz.id, pack };
}

// ---------------------------------------------------------------------------

describe("case construction", () => {
  it("takes its counts from config, never from literals", () => {
    const counts = evalCounts();
    expect(counts.grounded).toBe(20);
    expect(counts.refusals).toBe(10);
    expect(counts.grounded + counts.refusals).toBe(30);
  });

  it("spreads the grounded sample across the pack instead of taking the first N", () => {
    const pack = makePack();
    const picked = selectPairs(pack.pairs, 20);
    expect(picked).toHaveLength(20);
    // A prefix slice would end at index 19; a spread reaches the tail.
    const lastIndex = pack.pairs.indexOf(picked[picked.length - 1]!);
    expect(lastIndex).toBeGreaterThan(19);
    expect(new Set(picked.map((p) => p.id)).size).toBe(20);
  });

  it("⛔ never rewrites a question into a different one", () => {
    // A rewrite that drops a narrowing term asks something else, and the case
    // would then fail an agent that is behaving perfectly.
    const pack = makePack();
    for (const kase of groundedCases(pack, 20)) {
      const source = pack.pairs.find((p) => p.id === kase.expectPairId)!;
      expect(new Set(narrowingTerms(kase.question))).toEqual(new Set(narrowingTerms(source.question)));
    }
  });

  it("⛔ drops any refusal probe the pack could legitimately answer", () => {
    const plain = refusalCases(buildPackIndex(makePack()), 10);
    expect(plain).toHaveLength(10);
    expect(plain.map((c) => c.question).join(" ")).toMatch(/subcontract/i);

    // A business that publishes its subcontracting policy CAN answer that
    // question. Keeping the probe would fail an agent for being right.
    const discloses = makePack();
    discloses.pairs = [
      ...discloses.pairs,
      pair("Do you use subcontractors?", "We never subcontract; every job is done by our own vetted team."),
    ];
    const filtered = refusalCases(buildPackIndex(discloses), 10);
    expect(filtered.map((c) => c.question).join(" ")).not.toMatch(/subcontract/i);
    // And the count still holds, because the catalogue has headroom.
    expect(filtered).toHaveLength(10);
  });

  it("errors rather than quietly shipping fewer refusal cases", () => {
    // A silent shortfall would report "30 cases passed" over a 27-case run.
    const index = buildPackIndex(makePack());
    expect(() => refusalCases(index, 40)).toThrow(/Add probes/);
  });

  it("builds exactly thirty", () => {
    const pack = makePack();
    expect(buildCases(pack, buildPackIndex(pack))).toHaveLength(30);
  });
});

describe("the gate", () => {
  it("passes a pack that answers its own questions and refuses the rest", async () => {
    const { customerId, businessId, pack } = await seed();
    const run = await runAgentEval({ db }, { customerId, businessId, pack });
    if (run.verdict !== "pass") {
      // Surfacing the failures makes a regression here readable instead of a
      // bare "expected fail to be pass".
      throw new Error(new AgentEvalFailed(run).message);
    }
    expect(run.total).toBe(30);
    expect(run.passed).toBe(30);
    expect(run.bookingSkipped).toBe(true);
  });

  it("⛔ gives no partial credit — 29 of 30 is a fail", async () => {
    const { customerId, businessId, pack } = await seed();
    // One pair indexed against the wrong vector. This is the realistic
    // failure — a pack that generated fine and embedded badly — and it is
    // invisible until someone asks the question it was supposed to answer.
    const broken = misindex(pack, 0);
    const run = await runAgentEval({ db }, { customerId, businessId, pack: broken });
    expect(run.passed).toBeLessThan(run.total);
    expect(run.verdict).toBe("fail");
    expect(() => assertAgentEvalPassed(run)).toThrow(AgentEvalFailed);
  });

  it("names the case that failed and why", async () => {
    const { customerId, businessId, pack } = await seed();
    const broken = misindex(pack, 0);
    const run = await runAgentEval({ db }, { customerId, businessId, pack: broken });
    try {
      assertAgentEvalPassed(run);
      throw new Error("gate did not throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/grounded-01/);
      expect((err as Error).message).toMatch(/areas do you cover/i);
    }
  });

  it("⛔ fails a refusal case the moment the agent answers it", () => {
    // Tested at the judge rather than through a pack, because the collision
    // filter makes this unreachable from a pack — which is the point of the
    // filter. The rule still has to be right on its own.
    const kase = { id: "refusal-01", kind: "refusal" as const, question: "Are you ISO 45999 certified?", rationale: "r" };
    const answered = judgeCase(kase, {
      answer: "Yes, the team is fully certified.",
      route: "retrieval",
      answeredFrom: "pack",
      urgency: "normal",
      refused: false,
      escalate: false,
      gapLogged: false,
      injectionSuspected: false,
      modelCalls: 0,
      costCents: 0,
      latencyMs: 1,
    });
    expect(answered.passed).toBe(false);
    expect(answered.failure).toMatch(/instead of refusing/);

    const refused = judgeCase(kase, {
      answer: "I don't have that.",
      route: "retrieval",
      answeredFrom: "refusal",
      urgency: "normal",
      refused: true,
      escalate: false,
      gapLogged: true,
      injectionSuspected: false,
      modelCalls: 0,
      costCents: 0,
      latencyMs: 1,
    });
    expect(refused.passed).toBe(true);
  });

  it("⛔ fails a grounded case answered from the WRONG pair", () => {
    // Worse than no answer: a confident reply to something nobody asked.
    const verdict = judgeCase(
      { id: "grounded-01", kind: "grounded", question: "What areas do you cover?", expectPairId: "pair-a", rationale: "r" },
      {
        answer: "We're open Monday to Friday.",
        route: "retrieval",
        answeredFrom: "pack",
        pairId: "pair-b",
        urgency: "normal",
        refused: false,
        escalate: false,
        gapLogged: false,
        injectionSuspected: false,
        modelCalls: 0,
        costCents: 0,
        latencyMs: 1,
      },
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failure).toMatch(/different pair/);
  });

  it("records the run so the verdict survives the process that produced it", async () => {
    const { customerId, businessId, pack } = await seed();
    const run = await runAgentEval({ db }, { customerId, businessId, pack });
    const stored = await latestRun(db, customerId);
    expect(stored?.id).toBe(run.id);
    expect(stored?.verdict).toBe(run.verdict);
    expect(stored?.cases).toHaveLength(30);
    expect(stored?.cases[0]?.rationale).toMatch(/Must return the pair/);
  });

  it("marks booking as skipped when no calendar is connected", async () => {
    const { customerId, businessId, pack } = await seed();
    const withCalendar = await runAgentEval({ db }, { customerId, businessId, pack }, { calendarConnected: true, capabilities: ["answer", "book"] });
    expect(withCalendar.bookingSkipped).toBe(false);
  });

  it("flags a thin pack without failing it", async () => {
    const { customerId, businessId, pack } = await seed();
    // 24 pairs is under the 40-pair minimum: onboarding extends, the gate does
    // not fail. Conflating the two would block a small business whose agent
    // answers everything it should.
    const run = await runAgentEval({ db }, { customerId, businessId, pack });
    expect(run.thin).toBe(true);
    expect(run.verdict).toBe("pass");
  });

  it("⛔ refuses to measure an unapproved pack", async () => {
    const { customerId, businessId, pack } = await seed();
    const draft = makePack({ ...pack });
    delete (draft as { approvedAt?: Date }).approvedAt;
    await expect(runAgentEval({ db }, { customerId, businessId, pack: draft })).rejects.toThrow(/not been approved/);
  });

  it("runs each case in its own conversation", async () => {
    const { customerId, businessId, pack } = await seed();
    await runAgentEval({ db }, { customerId, businessId, pack });
    const sessions = await db.query(`SELECT id FROM agent_sessions WHERE customer_id = $1`, [customerId]);
    expect(sessions.rowCount).toBe(30);
  });
});
