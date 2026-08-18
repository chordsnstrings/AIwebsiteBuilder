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

/**
 * The machine surface (§38.3) — the differentiator. 9.6% of the market publishes
 * Service schema and 24.7% publishes a price; this is what puts a customer in
 * the 11.6% that clears both.
 */
export {
  buildJsonLd,
  renderLlmsTxtV3,
  machineSurfaceHead,
  MACHINE_PATHS,
  type MachineSurfaceInput,
  type ServiceOffering,
  type OpeningHours,
} from "./machine-surface.ts";

/**
 * The live agent on the preview page — the acquisition hook (§22.1). A
 * speculative website is a pitch against a solved problem; a speculative agent
 * that already knows their business is not.
 */
export {
  agentWidget,
  agentWidgetCss,
  agentWidgetScript,
  DEFAULT_SUGGESTIONS,
  type AgentWidgetOptions,
} from "./agent-widget.ts";

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

// The site-generation brief. Exported here rather than reachable only by deep
// path — a builder that can only be imported from `src/site-prompt.ts` is one
// nothing outside this package tests.
export {
  SITE_SYSTEM_PROMPT,
  SITE_VERTICALS,
  buildSitePrompt,
  isSiteVertical,
  type BrandSeed,
  type SiteImage,
  type SitePromptInput,
  type SiteQAPair,
  type SiteVertical,
} from "./site-prompt.ts";
export * from "./from-facts.ts";
