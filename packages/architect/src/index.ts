// @adw/architect — the Vertical Architect (spec §20, §37, §43).
//
// Decides what a given business actually gets. Without it, either every
// customer receives the same generic bundle — which is how you end up selling a
// website again — or a human configures each one, which is how you stop being
// autonomous.
//
// ⛔ The playbook is configuration under version control. This package
// classifies against it and detects modifiers. It never invents.
export {
  ManifestCatalogueError,
  type ArchitectDeps,
  type ArchitectInput,
  type ArchitectOutcome,
  type ClassifierFn,
  type DeliveryManifest,
  type EscalationReason,
  type GbpRecord,
  type Modifier,
  type ReviewSample,
  type SiteAudit,
  type VerticalCode,
} from "./types.ts";

export {
  assertInCatalogue,
  bookingCoverageTooHigh,
  catalogue,
  isProhibited,
  loadPlaybooks,
  verticalPlaybook,
  type LoadedPlaybooks,
  type Playbooks,
  type VerticalPlaybook,
} from "./playbook.ts";

export { classifyDeterministic, detectModifiers, isRegulatedTrade, type Classification } from "./deterministic.ts";

export { buildManifest, classify, loadManifest, persistManifest } from "./manifest.ts";
