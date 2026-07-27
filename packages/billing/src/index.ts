// @adw/billing — subscriptions, refunds, dunning and dispute evidence
// (spec §29, §36, §37). The REFUND keyword path is a deterministic rule with no
// agent in the loop; dunning never pauses a site before day 14; cancellation is
// two-click with no retention gauntlet.
export {
  handleInboundKeyword,
  assembleDisputePack,
  type InboundKeyword,
  type RefundOutcome,
  type DisputePack,
} from "./refunds.ts";
export {
  dunningSteps,
  advanceDunning,
  resolveDunning,
  type DunningStep,
  type DunningState,
} from "./dunning.ts";
export {
  createSubscription,
  requestCancellation,
  type BillingInterval,
  type CreateSubscriptionInput,
  type CreatedSubscription,
} from "./subscriptions.ts";
