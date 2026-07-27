export {
  renderSite,
  renderLlmsTxt,
  validateSlots,
  weightKb,
  SlotViolationError,
  type BusinessRecord,
  type CopySlots,
  type RenderOptions,
} from "./render.ts";

/** Build a reviewer-gate artifact from a rendered preview (demo helper). */
export { buildArtifactFromHtml } from "./artifact.ts";

/** Template families as data: layouts, section order, colour/type tokens, copy guidance (spec §59). */
export {
  FAMILIES,
  FAMILY_FALLBACKS,
  DEFAULT_FAMILY_ID,
  familyForCategory,
  familyById,
  taxonomyFamilyForCategory,
  trades,
  personalServices,
  foodHospitality,
  LAYOUT_SECTIONS,
  DEFAULT_LAYOUT,
  TemplateVariantError,
  contrastRatio,
  relativeLuminance,
  pairContrast,
  resolveContrastPair,
  AA_CONTRAST_MIN,
  ON_PRIMARY,
  type LayoutId,
  type CopySlotName,
  type ColorSystem,
  type TypePairing,
  type TemplateFamily,
} from "./families/index.ts";

/** Deterministic render fixtures — the reviewer-gate corpus and snapshot inputs. */
export {
  RENDER_FIXTURES,
  renderFixture,
  fixtureFamily,
  FIXTURE_FORM_ACTION,
  FIXTURE_LEGAL_ENTITY,
  FIXTURE_LEGAL_ADDRESS,
  FIXTURE_LABEL_VERSION,
  FIXTURE_CLAIM_TOKEN,
  type RenderFixture,
  type A11yBaseline,
} from "./fixtures/index.ts";

/** Content-hash visual regression over every fixture. */
export {
  SNAPSHOT_VERSION,
  renderAllFixtures,
  snapshotFixture,
  snapshotManifest,
  contentHash,
  type RenderSnapshot,
  type SnapshotManifest,
} from "./visual-regression.ts";
