// @adw/assets — generated images and video (MF13, the ModelArk half).
//
// The drafting half of MF13 shipped with @adw/publish. This is the other half,
// and it is the only place in the system where calling a function debits a real
// account per invocation. Everything here is shaped by that:
//
//   ⛔ Approval BEFORE generation, with the estimate shown. "Approve" means
//      nothing if the person pressing it does not know the number.
//   ⛔ A monthly cap, re-checked immediately before the call, counting approved
//      and in-flight work as well as completed — ten approved videos in the
//      queue have not been paid for yet, but they will be.
//   ⛔ An idempotency key on the row AND on the wire, so a retry after a
//      network timeout is not a second charge.
//   ⛔ `provenance = 'ai_generated'`, by CHECK constraint with one permitted
//      value. An AI render of a finished roof in a roofer's gallery is a false
//      statement about a job they did.
//   ⛔ No people, and no slot a reader takes as evidence of work done. Both are
//      enforced when the config loads, because both are things a reasonable
//      person will ask for in good faith.

export {
  allAssetKinds,
  assetConfigVersion,
  assetKindById,
  assetKindFor,
  assetKindsFor,
  clearAssetCache,
  estimateCostCents,
  isDecorativeSlot,
  type AssetKind,
} from "./catalogue.ts";

export {
  approveAsset,
  assetIdempotencyKey,
  assetLibrary,
  budgetFor,
  checkBrief,
  composePrompt,
  generateApproved,
  pendingAssets,
  rejectAsset,
  requestAsset,
  setMonthlyCap,
  spentThisMonthCents,
  DEFAULT_MONTHLY_CAP_CENTS,
  type ApproveAssetResult,
  type AssetRow,
  type GenerateDeps,
  type GenerateRunResult,
  type RequestAssetInput,
  type RequestResult,
} from "./pipeline.ts";
