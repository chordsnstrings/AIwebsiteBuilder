// @adw/acquisition — the acquisition motion, by segment.
//
// The whole funnel was SMB-shaped end to end: ingest a licensed lead, grade
// their site, build a SPECULATIVE PREVIEW of it, cold-email the link, take $399
// and $65 a month on a card, let them claim it themselves. That is right for a
// plumber. For the 33 enterprise clusters in the taxonomy it is not a mispriced
// version of the right motion — it is the wrong motion, and one part of it is
// actively damaging.
//
// ⛔ Building an unofficial copy of a hospital group's or a bank's website,
// hosting it on our domain under their name, and emailing the link to somebody
// who works there is passing off. `mayBuildSpeculativePreview()` returns false
// for every enterprise vertical, the config loader refuses to let that flag be
// flipped, and the preview activity asks before it renders.
//
// ⛔ An UNKNOWN trade gets the enterprise track. Defaulting an unclassifiable
// business to the permissive one means the first thing an unrecognised name
// receives is a speculative copy of its website.

export {
  allGates,
  clearTrackCache,
  gateById,
  mayBuildSpeculativePreview,
  maySelfServe,
  stagesFor,
  trackFor,
  trackForSegment,
  trackVersion,
  type ApprovalAuthority,
  type Gate,
  type PricingModel,
  type Track,
  type TrackStage,
} from "./tracks.ts";

export {
  advanceOpportunity,
  checkGate,
  openOpportunity,
  pipeline,
  recordEvidence,
  recordQuote,
  type AdvanceResult,
  type GateCheck,
  type OpenOpportunityInput,
  type OpenResult,
  type OpportunityRow,
  type QuoteResult,
} from "./opportunity.ts";

export {
  approveBusinessCase,
  casesFor,
  draftBusinessCase,
  unsupportedFigures,
  type ApproveCaseResult,
  type BusinessCaseRow,
  type CaseFinding,
  type DraftBusinessCaseInput,
  type DraftCaseResult,
} from "./business-case.ts";
