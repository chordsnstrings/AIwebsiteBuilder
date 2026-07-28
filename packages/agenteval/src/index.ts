// @adw/agenteval — the per-customer go-live gate (§47.2).
//
// Thirty questions against this customer's own pack: twenty it must answer from
// what they published, ten it must refuse. All thirty, or the agent does not
// ship. The delivery email is unreachable except through a pass.
export {
  buildCases,
  evalCounts,
  groundedCases,
  refusalCases,
  selectPairs,
  type CaseKind,
  type EvalCase,
  type EvalCaseCounts,
} from "./cases.ts";

export {
  AgentEvalFailed,
  assertAgentEvalPassed,
  judgeCase,
  latestRun,
  runAgentEval,
  type AgentEvalRun,
  type CaseResult,
  type RunOptions,
} from "./run.ts";
