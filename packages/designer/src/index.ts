// @adw/designer — decides how a site looks, before any CSS exists.
//
// Separated from generation because a decision buried in a 19KB prose brief
// cannot be stored, compared, or checked for repetition. Nine fields can be all
// three, and that is what makes "two customers in one trade must not get the
// same site" enforceable rather than aspirational.
export {
  allowedPairings,
  archetype,
  assertDiverse,
  assertInCatalogue,
  foldBudget,
  loadCatalogue,
  openOptions,
  verticalRules,
  type Catalogue,
  type LoadedCatalogue,
} from "./catalogue.ts";

export {
  chooseDeterministic,
  decideDesign,
  renderDesignBrief,
  type DesignerDeps,
  type DesignProposal,
} from "./decide.ts";

export {
  DesignCatalogueError,
  DesignRepetitionError,
  type DesignManifest,
  type DesignerInput,
  type Density,
  type HeroArchetype,
  type MotionVocabulary,
  type PaletteDecision,
  type TypePairing,
} from "./types.ts";
