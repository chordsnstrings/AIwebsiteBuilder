// @adw/watch — watchers for the customer's market (MF7, 92 units).
//
// The Sentinel watches OUR vendors: probes, signals, a heartbeat, a remediation
// allowlist. Every one of these 92 units is the same machine pointed outward —
// at the customer's reviews, their listing, their ranking, a competitor's
// prices, a register they appear on, a rule that changed. Nothing in this
// system looked outward on a customer's behalf.
//
// Three clamps carry the family:
//
//   1. A finding is a CHANGE between two successful observations. There is no
//      path that produces one from a single observation, because a watcher that
//      reports on first sight reports the entire world as new on day one.
//   2. A failed collection never overwrites the last good value and never
//      updates `last_ok_at`, so "unchanged" and "we could not see" stay
//      distinguishable. The board withholds a stale reading rather than
//      captioning it.
//   3. Nothing here acts. Every unit in this family flags; the owner decides.

export {
  allWatches,
  clearWatchCache,
  watchById,
  watchFor,
  watchVersion,
  watchesFor,
  RULE_KINDS,
  WATCH_SOURCES,
  type Watch,
  type WatchRule,
  type WatchSource,
} from "./catalogue.ts";

export { detectChanges, valueHash, type Finding } from "./detect.ts";

export {
  acknowledgeFinding,
  dismissFinding,
  openFindings,
  pauseWatch,
  pruneObservations,
  runDueWatches,
  subscribeWatch,
  watchBoard,
  type Collector,
  type CollectorInput,
  type CollectorResult,
  type Collectors,
  type SubscribeInput,
  type SubscribeResult,
  type WatchBoardRow,
  type WatchFinding,
  type WatchRunResult,
  type WatchState,
} from "./run.ts";

export {
  assertPublicUrl,
  httpCollectors,
  httpJsonCollector,
  readableText,
  simulatedCollectors,
  uptimeCollector,
  webPageCollector,
  UnsafeWatchUrlError,
  type FetchLike,
  type MinimalResponse,
} from "./collectors.ts";
