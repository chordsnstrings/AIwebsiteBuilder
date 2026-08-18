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

// --- Real-adapter plumbing (HTTP seam, SigV4, live health surface) ----------
export {
  assertOk,
  formEncode,
  globalFetch,
  readBody,
  rfc3986,
  VendorHttpError,
  type FetchLike,
  type HttpHeaders,
  type HttpRequestInit,
  type HttpResponse,
} from "./http.ts";
export {
  signRequestV4,
  withoutHostHeader,
  UNSIGNED_PAYLOAD,
  type SignedRequest,
  type SigV4Credentials,
  type SigV4Request,
} from "./aws-sigv4.ts";
export { RealVendorBase } from "./real-base.ts";

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
export { SesEmailTransport, type SesConfig } from "./email/real.ts";

// --- SiteHost ---------------------------------------------------------------
export type { DeployResult, SiteHost } from "./hosting/types.ts";
export { ENTRY_FILE, MockSiteHost } from "./hosting/mock.ts";
export {
  CloudflarePagesHost,
  CLOUDFLARE_API_BASE,
  CONTENT_MARKER,
  type CloudflarePagesConfig,
} from "./hosting/real.ts";

// --- DnsProvider ------------------------------------------------------------
export type { DnsProvider, DnsRecord, DnsRecordType } from "./dns/types.ts";
export { MockDnsProvider } from "./dns/mock.ts";
export { CloudflareDns, type CloudflareDnsConfig } from "./dns/real.ts";

// --- ObjectStore ------------------------------------------------------------
export type { ObjectStore, PutResult } from "./storage/types.ts";
export { MockObjectStore } from "./storage/mock.ts";
export { R2ObjectStore, R2_REGION, type R2Config } from "./storage/real.ts";

// --- DomainRegistrar --------------------------------------------------------
export type { DomainRegistrar, DomainRegistration, DomainStatus, TransferOutAuth } from "./registrar/types.ts";
export { MockDomainRegistrar } from "./registrar/mock.ts";
export {
  AUTH_CODE_DISPATCHED,
  MANUAL_TRANSFER_PREFIX,
  NAMECHEAP_API_BASE,
  NamecheapBackend,
  ResellerRegistrar,
  normaliseDomain,
  type ManualTransferOut,
  type NamecheapConfig,
  type RegistrantContact,
  type RegistrarBackend,
} from "./registrar/real.ts";

// --- LeadSource -------------------------------------------------------------
export type { BusinessRecord, LeadBatch, LeadSource } from "./leaddata/types.ts";
export { MockLeadSource } from "./leaddata/mock.ts";

// --- EmailVerifier ----------------------------------------------------------
export type { EmailVerifier, VerificationVerdict } from "./verification/types.ts";
export { MockEmailVerifier } from "./verification/mock.ts";
export {
  domainOf,
  isDisposable,
  isRoleAccount,
  verifyLocally,
  type LocalCheck,
  type LocalVerifierOptions,
} from "./verification/local.ts";
export { HttpEmailVerifier, LayeredEmailVerifier, type HttpVerifierConfig } from "./verification/real.ts";

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

// --- PaymentRail ------------------------------------------------------------
// The real Stripe rail lives here (the vendor-I/O boundary) and satisfies
// @adw/payments' PaymentRail structurally; payments imports it from @adw/vendors.
export { StripeRail, STRIPE_API_BASE, type StripeRailConfig, type StripeWebhookEnvelope } from "./payments/real-stripe.ts";
export {
  deriveStatementDescriptor,
  type AccountStatus,
  type BusinessType,
  type ChargeType,
  type CheckoutRequest,
  type CheckoutResult,
  type CreatedMerchantAccount,
  type MerchantAccountPrefill,
  type MerchantAddress,
  type NormalizedPaymentEvent,
  type PaymentEventType,
  type PaymentRail,
  type RailId,
  type RefundResult,
  type RequirementCollection,
  type SettlementTarget,
} from "./payments/rail-types.ts";

// --- Real-vs-mock resolution for the non-LLM capabilities --------------------
export {
  resolveDns,
  resolveEmailTransport,
  resolveEmailVerifier,
  resolveCompanyRegistry,
  resolveLeadSource,
  resolveMediaGenerator,
  resolveObjectStore,
  resolvePaymentRail,
  resolveRegistrar,
  resolveSiteHost,
  VENDOR_CREDENTIAL_KEYS,
  VENDOR_IDS,
  type ResolveVendorDeps,
} from "./resolve-vendors.ts";

// --- Webhook authentication -------------------------------------------------
// ⛔ Per-provider, because a scheme you invented only authenticates you.
export {
  assertSigningUrl,
  clearCertCache,
  fetchSigningCert,
  snsStringToSign,
  verifySharedSecret,
  verifySns,
  verifyStripe,
  STRIPE_TOLERANCE_SECONDS,
  type SnsEnvelope,
  type SnsVerifyOptions,
  type WebhookVerdict,
} from "./webhook-auth.ts";

// Image and video generation (MF13). ⛔ The one capability where a call costs
// money per asset rather than per token, and where the cost is not recoverable.
export {
  costCeilingCents,
  DEFAULT_MEDIA_MODELS,
  MEDIA_COST_CEILING_CENTS,
  UNKNOWN_MODEL_CEILING_CENTS,
  type MediaGenerator,
  type MediaKind,
  type MediaRequest,
  type MediaResult,
} from "./media/types.ts";
export { ModelArkMediaGenerator, type ModelArkMediaConfig } from "./media/real.ts";
export { MockMediaGenerator, getMediaGenerator, resetMediaGenerator } from "./media/mock.ts";

export { SuffixCompanyRegistry, suffixEvidence } from "./registry-lookup/suffix.ts";
export type { CompanyRegistry } from "./registry-lookup/types.ts";
