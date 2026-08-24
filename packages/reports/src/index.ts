// @adw/reports — the monthly value report (spec §58). Every figure is the result
// of a deterministic SQL query; no model writes a number and nothing is
// estimated. Exactly one suggested action ships with each report, and it is
// never an upsell in a month where the customer's metrics went down.
export {
  generateValueReport,
  suggestFor,
  downMetrics,
  periodBounds,
  priorMonth,
  EVENT_TYPES,
  TRAFFIC_SOURCES,
  WEB_FORM_CHANNEL,
  type ValueReport,
  type ValueMetrics,
  type ValueSuggestion,
  type MomDelta,
  type TrafficSources,
  type AiVisibility,
  type ReportMonth,
  type ReportPeriod,
} from "./value-report.ts";

// ⛔ The consumers this package never had. Until these existed, no report was
// ever produced for any customer.
export {
  latestReport,
  reportsFor,
  storeValueReport,
  sweepValueReports,
  type StoredReport,
  type SweepOutcome,
} from "./store.ts";
