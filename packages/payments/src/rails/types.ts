// Payment rail adapter surface (spec §14, payments facilitation). ADW is a
// PAYMENT FACILITATOR, never a merchant of record. The interface encodes the
// four invariants of spec §14.1 structurally so no adapter can violate them:
//   (1) every connected account is charge_type == 'direct';
//   (2) ADW never holds a balance and never initiates a sub-merchant payout —
//       there is deliberately NO payout-initiation method on this interface and
//       every checkout settles directly to the merchant (application-fee only);
//   (3) the statement descriptor shows the MERCHANT's name;
//   (4) requirement_collection stays 'stripe' (the rail collects requirements,
//       not ADW — ADW never becomes the responsible party for KYB).
// Adapters that break these fail conformanceCheck() and the payments build gate.

/** Rail identifier — e.g. the primary card rail or the live-and-tested fallback. */
export type RailId = string;

/** The only permitted connected-account charge model (invariant 1). */
export type ChargeType = "direct";

/** The only permitted requirement-collection owner (invariant 4). */
export type RequirementCollection = "stripe";

/** Legal entity classification, driven by the registry hit in pre-screen. */
export type BusinessType = "company" | "individual";

/** Where checkout funds settle. 'merchant' is the only conformant value (inv. 2). */
export type SettlementTarget = "merchant";

/** Address held for the merchant, used to prefill the connected account. */
export interface MerchantAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

/**
 * Prefill assembled from data ADW already holds. Passed to the rail to open a
 * connected account. `requestedChargeType` exists only so a conformance probe
 * can attempt a non-direct account and prove the adapter refuses it.
 */
export interface MerchantAccountPrefill {
  customerId: string;
  /** Full legal/trading name of the merchant. */
  merchantName: string;
  /** Descriptor that will appear on the buyer's statement (merchant name). */
  statementDescriptor: string;
  businessType: BusinessType;
  country: string;
  /** Merchant category code. */
  mcc: string;
  /** business_profile.url */
  url: string;
  email?: string;
  address?: MerchantAddress;
  /** Conformance-probe seam ONLY; a conformant adapter rejects anything != 'direct'. */
  requestedChargeType?: string;
}

/**
 * Result of opening a connected account. Carries the invariant-bearing fields
 * so callers and the conformance check can assert on them directly.
 */
export interface CreatedMerchantAccount {
  /** External (rail-side) account id. */
  accountId: string;
  chargeType: ChargeType;
  requirementCollection: RequirementCollection;
  statementDescriptor: string;
  businessType: BusinessType;
}

/** Live status of a connected account as reported by the rail. */
export interface AccountStatus {
  chargesEnabled: boolean;
  /** Whether the rail can pay the MERCHANT (rail -> merchant); never ADW-initiated. */
  payoutsEnabled: boolean;
  currentlyDue: string[];
  disabledReason?: string;
}

/** A checkout / charge request. Money is always integer cents. */
export interface CheckoutRequest {
  amountCents: number;
  currency: string;
  /** ADW's platform take, collected as an application fee on a direct charge. */
  applicationFeeCents?: number;
  description?: string;
  idempotencyKey?: string;
}

/**
 * A created checkout. `settlesTo: 'merchant'` and `applicationFeeOnly: true`
 * encode invariant 2: funds land in the merchant's account, ADW only ever
 * collects an application fee and never holds a balance.
 */
export interface CheckoutResult {
  ref: string;
  chargeType: ChargeType;
  statementDescriptor: string;
  settlesTo: SettlementTarget;
  applicationFeeOnly: true;
  amountCents: number;
  currency: string;
}

/** Result of reversing a charge. Refunds are buyer-facing; not a sub-merchant payout. */
export interface RefundResult {
  ref: string;
  refunded: boolean;
  amountCents: number;
}

/** Normalized, vendor-neutral payment event types. */
export type PaymentEventType =
  | "account.updated"
  | "charge.succeeded"
  | "charge.refunded"
  | "charge.dispute.created"
  | "tos.accepted"
  | "payout.paid";

/** A webhook after signature verification and vendor-shape normalization. */
export interface NormalizedPaymentEvent {
  type: PaymentEventType;
  railId: RailId;
  /** True only if the transport signature verified against the rail secret. */
  signatureValid: boolean;
  accountId?: string;
  chargeRef?: string;
  amountCents?: number;
  currency?: string;
  /** Populated for `tos.accepted` — the genuine acceptance timestamp/ip. */
  tosAcceptedAt?: string;
  tosAcceptedIp?: string;
  raw: unknown;
}

/**
 * The rail adapter contract. Note what is ABSENT: there is no method to initiate
 * a payout to a sub-merchant, because ADW must never do so (invariant 2).
 */
export interface PaymentRail {
  readonly id: RailId;
  /** Whether this rail can open an account for (country, entity type). */
  supports(country: string, entity: BusinessType): boolean;
  createMerchantAccount(prefill: MerchantAccountPrefill): Promise<CreatedMerchantAccount>;
  getAccountStatus(accountId: string): Promise<AccountStatus>;
  createCheckout(accountId: string, req: CheckoutRequest): Promise<CheckoutResult>;
  /** Reverse a charge (buyer refund). Present so the integration gate can prove the path. */
  refund(accountId: string, chargeRef: string): Promise<RefundResult>;
  normalizeWebhook(raw: unknown): NormalizedPaymentEvent;
}

/** Result of a conformance probe over an adapter. */
export interface ConformanceResult {
  ok: boolean;
  /** Machine codes for each violated invariant. Empty when ok. */
  failures: string[];
}

/** Statement-descriptor rules: <=22 chars, restricted charset, never empty. */
export function deriveStatementDescriptor(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.slice(0, 22) || "MERCHANT";
}

/**
 * Assert an adapter honours the four invariants of spec §14.1. Deterministic,
 * no network. Returns machine failure codes rather than throwing so a caller can
 * halt payments and open an exception. A conformant rail returns { ok: true }.
 */
export async function conformanceCheck(rail: PaymentRail): Promise<ConformanceResult> {
  const failures: string[] = [];
  const prefill: MerchantAccountPrefill = {
    customerId: "conformance-probe",
    merchantName: "Conformance Probe Ltd",
    statementDescriptor: deriveStatementDescriptor("Conformance Probe Ltd"),
    businessType: "company",
    country: "US",
    mcc: "5045",
    url: "https://conformance.example",
  };

  // Invariant 1 — a normally-created account must be charge_type 'direct'.
  const created = await rail.createMerchantAccount(prefill);
  if (created.chargeType !== "direct") failures.push("INV1_charge_type_not_direct");
  // Invariant 4 — requirement collection stays 'stripe'.
  if (created.requirementCollection !== "stripe") failures.push("INV4_requirement_collection_not_stripe");
  // Invariant 3 — statement descriptor shows the merchant name.
  if (created.statementDescriptor !== prefill.statementDescriptor) failures.push("INV3_descriptor_not_merchant");

  // Invariant 2 — no way to hold a balance or initiate a sub-merchant payout.
  for (const forbidden of ["initiatePayout", "createPayout", "payout", "sendFunds", "transfer"]) {
    if (forbidden in (rail as unknown as Record<string, unknown>)) {
      failures.push(`INV2_exposes_payout_method:${forbidden}`);
    }
  }
  // Invariant 2 — checkout settles directly to the merchant (app-fee only).
  const checkout = await rail.createCheckout(created.accountId, {
    amountCents: 100,
    currency: "usd",
    applicationFeeCents: 5,
  });
  if (checkout.settlesTo !== "merchant") failures.push("INV2_checkout_not_direct_settlement");
  if (checkout.applicationFeeOnly !== true) failures.push("INV2_checkout_holds_balance");
  if (checkout.chargeType !== "direct") failures.push("INV1_checkout_charge_type_not_direct");

  // Invariant 1 (explicit refusal) — a destination/non-direct request is rejected.
  let rejected = false;
  try {
    await rail.createMerchantAccount({ ...prefill, requestedChargeType: "destination" });
  } catch {
    rejected = true;
  }
  if (!rejected) failures.push("INV1_accepts_destination_charge");

  return { ok: failures.length === 0, failures };
}
