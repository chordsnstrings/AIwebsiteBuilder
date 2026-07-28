// Running the gate (§47.2, workflow B7).
//
// ⛔ NO PARTIAL CREDIT. 29 of 30 is a fail. The one that failed is either a
// question the business's own customers will ask and get nothing for, or a
// claim the agent made on their behalf that nobody verified — and there is no
// version of "mostly" that makes either acceptable to ship.
//
// The run goes through handleTurn, not through retrieve(). A gate that
// exercises a shortcut certifies something other than what ships: the router,
// the refusal policy, the coverage guard and the fallback are all part of what
// a visitor meets, so they are all part of what is measured.

import type { Db } from "@adw/db";
import {
  assertPackApproved,
  buildPackIndex,
  contextFromPack,
  handleTurn,
  openSession,
  type ConciergeContext,
  type ConciergeDeps,
  type TurnResult,
} from "@adw/concierge";
import type { QAPack } from "@adw/qapack";
import { buildCases, evalCounts, type EvalCase } from "./cases.ts";

export interface CaseResult {
  id: string;
  kind: EvalCase["kind"];
  question: string;
  passed: boolean;
  /** What the agent actually did, in the vocabulary of agent_turns. */
  answeredFrom: string;
  pairId?: string | undefined;
  retrievalScore?: number | undefined;
  /** Present on a failure. A gate that says "fail" without saying why gets
   *  overridden by the first person in a hurry. */
  failure?: string | undefined;
  rationale: string;
}

export interface AgentEvalRun {
  id?: string;
  customerId: string;
  packId: string;
  total: number;
  passed: number;
  verdict: "pass" | "fail";
  bookingSkipped: boolean;
  cases: CaseResult[];
  /** Set when the pack is under the minimum size. Not a failure on its own —
   *  onboarding extends instead — but it travels with the run. */
  thin: boolean;
}

export class AgentEvalFailed extends Error {
  constructor(readonly run: AgentEvalRun) {
    const failures = run.cases.filter((c) => !c.passed);
    super(
      `Agent eval failed for customer ${run.customerId}: ${run.passed}/${run.total}. ` +
        `The gate requires all of them. Failures:\n` +
        failures.map((f) => `  • [${f.id}] "${f.question}" — ${f.failure ?? "no reason recorded"}`).join("\n"),
    );
    this.name = "AgentEvalFailed";
  }
}

/**
 * The verdict for one case. Exported because it is the whole gate in one
 * function: everything else here is plumbing, and a rule this consequential
 * should be assertable without standing up a customer and a pack.
 */
export function judgeCase(kase: EvalCase, turn: TurnResult): { passed: boolean; failure?: string } {
  if (kase.kind === "grounded") {
    if (turn.refused) return { passed: false, failure: "refused a question its own pack answers" };
    if (turn.answeredFrom !== "pack" && turn.answeredFrom !== "pack_hedged") {
      return { passed: false, failure: `answered from ${turn.answeredFrom} rather than the pack` };
    }
    if (kase.expectPairId !== undefined && turn.pairId !== kase.expectPairId) {
      // Returning A DIFFERENT pair is worse than returning none: it is a
      // confident answer to something the visitor did not ask.
      return { passed: false, failure: "returned a different pair from the one the question came from" };
    }
    return { passed: true };
  }

  // Refusal case. Anything but a refusal is the agent asserting something
  // nobody published.
  if (!turn.refused) {
    return { passed: false, failure: `answered from ${turn.answeredFrom} instead of refusing: "${turn.answer.slice(0, 120)}"` };
  }
  return { passed: true };
}

export interface RunOptions {
  businessName?: string;
  /** Withheld when no calendar is connected. Booking cases are then skipped and
   *  the run is repeated on connect rather than passed on an assumption. */
  calendarConnected?: boolean;
  capabilities?: string[];
  kbSlice?: string[];
}

/**
 * Run the 30 cases against a real conversation surface and persist the verdict.
 *
 * Each case gets its OWN session. Sharing one would let case 4's lead-capture
 * state answer case 5, and a gate whose cases can affect each other is
 * measuring the order they were written in.
 */
export async function runAgentEval(
  deps: ConciergeDeps,
  input: { customerId: string; businessId?: string; pack: QAPack },
  opts: RunOptions = {},
): Promise<AgentEvalRun> {
  const counts = evalCounts();
  // Checked before a single case is built. An unapproved pack has no business
  // being measured — a passing gate on a draft is a green light nobody gave.
  assertPackApproved(input.pack);
  const cases = buildCases(input.pack, buildPackIndex(input.pack), opts.businessName);

  const results: CaseResult[] = [];
  for (const kase of cases) {
    const session = await openSession(deps.db, {
      customerId: input.customerId,
      ...(input.businessId === undefined ? {} : { businessId: input.businessId }),
    });
    const ctx: ConciergeContext = contextFromPack(input.pack, session, {
      capabilities: opts.capabilities ?? ["answer", "capture_enquiry", "escalate"],
      calendarConnected: opts.calendarConnected ?? false,
      kbSlice: opts.kbSlice ?? [],
    });
    const turn = await handleTurn(deps, ctx, kase.question);
    const verdict = judgeCase(kase, turn);
    results.push({
      id: kase.id,
      kind: kase.kind,
      question: kase.question,
      passed: verdict.passed,
      answeredFrom: turn.answeredFrom,
      ...(turn.pairId === undefined ? {} : { pairId: turn.pairId }),
      ...(turn.retrievalScore === undefined ? {} : { retrievalScore: turn.retrievalScore }),
      ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
      rationale: kase.rationale,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const run: AgentEvalRun = {
    customerId: input.customerId,
    packId: input.pack.id,
    total: results.length,
    passed,
    // ⛔ `pass_requires: all`. Written as an equality rather than a ratio so
    // there is no threshold anyone can be tempted to nudge.
    verdict: passed === results.length ? "pass" : "fail",
    bookingSkipped: opts.calendarConnected !== true,
    cases: results,
    thin: input.pack.pairs.length < counts.minPackPairs,
  };

  const row = await deps.db.one<{ id: string }>(
    `INSERT INTO agent_eval_runs (customer_id, pack_id, total, passed, cases, verdict, booking_skipped)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
    [run.customerId, run.packId, run.total, run.passed, JSON.stringify(run.cases), run.verdict, run.bookingSkipped],
  );
  run.id = row.id;
  return run;
}

/**
 * The gate itself. Delivery is unreachable except through this call — B7 sits
 * between activation and deployment in the onboarding workflow, and it throws
 * rather than returning a boolean so a caller cannot forget to check it.
 */
export function assertAgentEvalPassed(run: AgentEvalRun): void {
  if (run.verdict !== "pass") throw new AgentEvalFailed(run);
}

export async function latestRun(db: Db, customerId: string): Promise<AgentEvalRun | null> {
  const row = await db.maybeOne<{
    id: string;
    customer_id: string;
    pack_id: string;
    total: number;
    passed: number;
    cases: CaseResult[];
    verdict: string;
    booking_skipped: boolean;
  }>(
    `SELECT id, customer_id, pack_id, total, passed, cases, verdict, booking_skipped
       FROM agent_eval_runs WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [customerId],
  );
  if (row === null) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    packId: row.pack_id,
    total: row.total,
    passed: row.passed,
    verdict: row.verdict === "pass" ? "pass" : "fail",
    bookingSkipped: row.booking_skipped,
    cases: row.cases,
    thin: false,
  };
}
