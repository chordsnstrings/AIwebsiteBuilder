// The Vertical Architect (spec §20, §37, §43; HANDOVER A2→A3).
//
// The agent that decides WHAT A GIVEN BUSINESS ACTUALLY GETS. Without it, every
// customer receives the same generic bundle — which is how you end up selling a
// website again — or a human configures each one, which is how you stop being
// autonomous.
//
// ⛔ The playbook is CONFIGURATION under version control. This package
// classifies against it and detects modifiers. It never invents: a capability
// proposed that is not in the catalogue is a config PR, not a runtime decision,
// and reaching for one fails the build.

export type VerticalCode = string;

/** Modifiers reshape the vertical's baseline. Detected, never assumed. */
export type Modifier =
  | "emergency_service"
  | "multi_location"
  | "franchise"
  | "regulated_trade"
  | "no_published_pricing"
  | "appointment_based"
  | "seasonal"
  | "b2b_serving"
  | "thin_content";

export interface SiteAudit {
  hasWebsite: boolean;
  reachable?: boolean;
  https?: boolean;
  pricingFound: boolean;
  bookingFound: boolean;
  bookingProvider?: string;
  hasServiceSchema: boolean;
  llmsTxt?: boolean;
  pageCount: number;
  wordCount: number;
  platform?: string;
  /** FALSE means they are already machine-readable AND bookable — the 11.6%. */
  transactabilityGap: boolean;
  topDefects: string[];
}

export interface GbpRecord {
  categories?: string[];
  locationCount?: number;
  attributes?: string[];
  serviceArea?: string[];
}

export interface ReviewSample {
  texts: string[];
  /** Review counts by month, for seasonality. Sparse is fine. */
  monthlyVolume?: number[];
}

export interface ArchitectInput {
  businessId: string;
  name: string;
  category: string;
  city?: string;
  siteAudit: SiteAudit;
  gbp?: GbpRecord;
  reviews?: ReviewSample;
  /** Free text from the site. Untrusted — used for modifier detection only. */
  siteText?: string;
  /** Present when a franchise register lookup matched. */
  franchiseMatch?: boolean;
  /** Present when a regulated trade's registration could be verified. */
  registrationVerified?: boolean;
}

export interface DeliveryManifest {
  id?: string;
  businessId: string;
  customerId?: string;
  vertical: VerticalCode;
  confidence: number;
  modifiers: Modifier[];
  siteModules: string[];
  agentCapabilities: string[];
  integrations: string[];
  dashboardPanels: string[];
  /** What was deliberately left out and why. A manifest listing only what is
   *  included cannot be reviewed. */
  excluded: { feature: string; reason: string }[];
  /** Questions onboarding must ask. */
  unresolved: string[];
  playbookVersion: string;
}

export type EscalationReason =
  | "low_confidence"
  | "franchise"
  | "prohibited_vertical"
  | "conflicting_signals"
  | "regulated_trade_unverified"
  | "already_transactable"
  | "booking_coverage_too_high";

export type ArchitectOutcome =
  | { escalate: false; manifest: DeliveryManifest }
  | { escalate: true; reason: EscalationReason; detail: string; confidence: number; vertical?: VerticalCode };

/** A module the model proposed that does not exist. ⛔ Fails the build. */
export class ManifestCatalogueError extends Error {}

/** Optional model assistance. The deterministic classifier is the default. */
export interface ClassifierFn {
  (input: ArchitectInput): Promise<{ vertical: VerticalCode; confidence: number }>;
}

export interface ArchitectDeps {
  classify?: ClassifierFn;
}
