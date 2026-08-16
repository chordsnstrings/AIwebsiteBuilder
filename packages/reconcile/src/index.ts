// @adw/reconcile — reconciliation (MF8, 32 units).
//
// Two lists that ought to agree, and what to do about the lines that do not.
// Nothing in this system held two lists side by side on a customer's behalf:
// `refunds` and `subscriptions` track ADW's own money and nothing else.
//
// ⛔ Every unit in this family PROPOSES. Not one posts. There is no function
// here that adjusts an amount, creates a balancing line, or makes a difference
// go away — a reconciliation that writes its own correcting entry can hide the
// very thing it was run to find, and the difference staying visible until a
// person has looked at it is the entire product.
//
// ⛔ And when the matcher cannot tell which of two candidates is right, it
// refuses. An ambiguous pairing reported as a match is worse than no match:
// the difference it was concealing is now off the list.

export {
  allReconTypes,
  clearReconCache,
  reconTypeById,
  reconTypeFor,
  reconTypesFor,
  reconVersion,
  MATCH_STRATEGIES,
  type MatchStrategy,
  type ReconType,
} from "./catalogue.ts";

export {
  matchItems,
  normaliseReference,
  type MatchResult,
  type MatchStatus,
  type ReconItem,
} from "./match.ts";

export {
  closeRun,
  ingest,
  openDifferences,
  openRun,
  resolveDifference,
  runReconciliation,
  runsFor,
  type CloseResult,
  type IngestLine,
  type OpenDifference,
  type OpenRunInput,
  type OpenRunResult,
  type ReconSummary,
  type RunListRow,
} from "./store.ts";
