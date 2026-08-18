// The operator console's read model.
//
// One place that knows how to ask the fourteen families, the scheduler and the
// money tables the questions an operator actually has. It exists so those
// questions are answered identically wherever they are asked, and so the API
// composition root does not grow a thousand lines of ad-hoc SQL.
//
// ⛔ Read-only by construction, with one exception: the job heartbeat writer,
// which lives beside its reader so the two cannot drift. Nothing else in this
// package writes.

export {
  FAILING_AFTER,
  STALE_CADENCES,
  jobBoard,
  pruneJobRuns,
  recentJobFailures,
  recordJobRun,
  registerJob,
  type JobFailure,
  type JobRow,
  type JobRunRecord,
  type JobState,
} from "./jobs.ts";

export {
  worklist,
  type SourceCoverage,
  type WorkItem,
  type Worklist,
  type WorkSource,
} from "./worklist.ts";

export {
  FAMILIES,
  applicableFamilies,
  configuredCounts,
  customerBoard,
  type CustomerBoard,
  type CustomerRow,
  type FamilyCell,
  type FamilyId,
  type FamilyState,
} from "./families.ts";

export {
  GATEWAY_DAILY_CAP_CENTS,
  costByRole,
  spendBoard,
  type Figure,
  type RoleCost,
  type SpendBoard,
} from "./spend.ts";
