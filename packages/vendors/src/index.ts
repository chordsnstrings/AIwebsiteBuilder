export { resolveMode, pick, type VendorMode, type ResolveOptions } from "./hub.ts";
export type { LlmRail, LlmRequest, LlmResponse, LlmMessage } from "./llm/index.ts";
export { MockLlmRail, resolveRail, railKind } from "./llm/index.ts";
export { PRICE_CARD, priceFor, type ModelPrice } from "./llm/pricing.ts";

// --- Health surface shared by every vendor mock -----------------------------
export {
  BaseMockVendor,
  VendorOutageError,
  seedBytes,
  seedHex,
  seedInt,
  seedUnit,
  sha256Hex,
  type MockVendor,
  type RoundTripResult,
  type VendorHealthSurface,
} from "./health.ts";

// --- EmailTransport ---------------------------------------------------------
export type {
  EmailEvent,
  EmailEventType,
  EmailMessage,
  EmailRates,
  EmailTransport,
  SendResult,
  SentMessage,
} from "./email/types.ts";
export { MockEmailTransport, PROBE_HEADER } from "./email/mock.ts";

// --- SiteHost ---------------------------------------------------------------
export type { DeployResult, SiteHost } from "./hosting/types.ts";
export { ENTRY_FILE, MockSiteHost } from "./hosting/mock.ts";

// --- DnsProvider ------------------------------------------------------------
export type { DnsProvider, DnsRecord, DnsRecordType } from "./dns/types.ts";
export { MockDnsProvider } from "./dns/mock.ts";

// --- ObjectStore ------------------------------------------------------------
export type { ObjectStore, PutResult } from "./storage/types.ts";
export { MockObjectStore } from "./storage/mock.ts";

// --- DomainRegistrar --------------------------------------------------------
export type { DomainRegistrar, DomainRegistration, DomainStatus, TransferOutAuth } from "./registrar/types.ts";
export { MockDomainRegistrar } from "./registrar/mock.ts";

// --- LeadSource -------------------------------------------------------------
export type { BusinessRecord, LeadBatch, LeadSource } from "./leaddata/types.ts";
export { MockLeadSource } from "./leaddata/mock.ts";

// --- EmailVerifier ----------------------------------------------------------
export type { EmailVerifier, VerificationVerdict } from "./verification/types.ts";
export { MockEmailVerifier } from "./verification/mock.ts";

// --- Browser ----------------------------------------------------------------
export type { Browser, RenderResult } from "./browser/types.ts";
export { MockBrowser } from "./browser/mock.ts";

// --- Alerting ---------------------------------------------------------------
// Exported as VendorAlertChannel: @adw/sentinel owns the routing-side type of
// the same name and the two are deliberately different shapes.
export type {
  AlertChannel as VendorAlertChannel,
  AlertChannelKind,
  AlertDelivery,
  AlertSeverity,
  HeartbeatReceiver,
} from "./alerting/types.ts";
export { MockAlertChannel, MockHeartbeatReceiver } from "./alerting/mock.ts";

// --- Composites, long tail and the registry ---------------------------------
export { MockCloudflare } from "./cloudflare.ts";
export { GenericVendorMock } from "./generic.ts";
export {
  EMAIL_VENDOR_IDS,
  LEAD_DATA_VENDOR_IDS,
  getAlertChannel,
  getBrowser,
  getCloudflare,
  getDnsProvider,
  getEmailTransport,
  getEmailVerifier,
  getHeartbeatReceiver,
  getLeadSource,
  getObjectStore,
  getRegistrar,
  getSiteHost,
  getVendorMock,
  resetVendorMocks,
  simulateOutage,
  specialisedVendorIds,
  vendorMocks,
  type VendorMockSuite,
} from "./registry.ts";
