// @adw/payments — payments facilitation (spec §14). ADW is a facilitator, never
// the merchant of record. The four invariants of §14.1 are enforced in code
// (conformanceCheck, the direct-only rail surface, the integration gate) and at
// the DB layer (charge_type CHECK, tos_acceptance single-writer trigger):
//   1. every connected account is charge_type == 'direct';
//   2. ADW never holds a balance / never initiates a sub-merchant payout;
//   3. the statement descriptor shows the MERCHANT's name;
//   4. requirement_collection stays 'stripe'.

// --- Rail adapter interface + conformance -----------------------------------
export type {
  RailId,
  ChargeType,
  RequirementCollection,
  BusinessType,
  SettlementTarget,
  MerchantAddress,
  MerchantAccountPrefill,
  CreatedMerchantAccount,
  AccountStatus,
  CheckoutRequest,
  CheckoutResult,
  RefundResult,
  PaymentEventType,
  NormalizedPaymentEvent,
  PaymentRail,
  ConformanceResult,
} from "./rails/types.ts";
export { conformanceCheck, deriveStatementDescriptor } from "./rails/types.ts";
export { MockRailBase } from "./rails/mock-base.ts";
export type { SignedWebhook, MockEvent } from "./rails/mock-base.ts";
export { MockStripeRail } from "./rails/mock-stripe.ts";
export { MockSecondaryRail } from "./rails/mock-secondary.ts";

// --- Pre-screen (commercial filter) -----------------------------------------
export { preScreen } from "./prescreen/index.ts";
export type { PreScreenInput, PreScreenResult } from "./prescreen/index.ts";

// --- Onboarding --------------------------------------------------------------
export { buildPrefill, createAccount } from "./onboarding/prefill.ts";
export type { CustomerRecord, CreateAccountResult } from "./onboarding/prefill.ts";
// The single blessed writer of tos_acceptance.
export { acceptTos, handleAcceptanceWebhook } from "./onboarding/tos-webhook.ts";
export type { TosAcceptance, AcceptanceWebhookResult } from "./onboarding/tos-webhook.ts";

// --- Integration test / build gate ------------------------------------------
export { runIntegrationTest } from "./gates/integration.ts";
export type { IntegrationCheck, IntegrationTestResult } from "./gates/integration.ts";

// --- Risk monitoring ---------------------------------------------------------
export { monitorRisk, runRiskMonitoring } from "./risk/index.ts";
export type { RiskMetrics, RiskAction, RiskActionKind, RiskMonitorOutcome } from "./risk/index.ts";
