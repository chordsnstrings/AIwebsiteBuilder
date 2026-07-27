// STRUCTURAL MIRROR of packages/payments/src/rails/types.ts.
//
// It is redeclared here rather than imported for the same reason
// VendorHealthSurface is redeclared in ../health.ts: the dependency direction is
// payments → vendors, so vendors must not import @adw/payments (and does not
// have it as a dependency). TypeScript is structural, so `StripeRail` in this
// package satisfies `PaymentRail` from @adw/payments without either side
// importing the other.
//
// KEEP IN SYNC. If packages/payments/src/rails/types.ts changes shape, this file
// changes with it or @adw/payments will stop accepting StripeRail.
//
// The four facilitation invariants of spec §14.1 are encoded in the shape:
//   (1) every connected account is charge_type 'direct';
//   (2) there is deliberately NO payout-initiation method — ADW never holds a
//       balance and never initiates a sub-merchant payout;
//   (3) the statement descriptor shows the MERCHANT's name;
//   (4) requirement_collection stays 'stripe'.

export type RailId = string;
export type ChargeType = "direct";
export type RequirementCollection = "stripe";
export type BusinessType = "company" | "individual";
export type SettlementTarget = "merchant";

export interface MerchantAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface MerchantAccountPrefill {
  customerId: string;
  merchantName: string;
  statementDescriptor: string;
  businessType: BusinessType;
  country: string;
  mcc: string;
  url: string;
  email?: string;
  address?: MerchantAddress;
  /** Conformance-probe seam ONLY; a conformant adapter rejects anything != 'direct'. */
  requestedChargeType?: string;
}

export interface CreatedMerchantAccount {
  accountId: string;
  chargeType: ChargeType;
  requirementCollection: RequirementCollection;
  statementDescriptor: string;
  businessType: BusinessType;
}

export interface AccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  currentlyDue: string[];
  disabledReason?: string;
}

export interface CheckoutRequest {
  amountCents: number;
  currency: string;
  applicationFeeCents?: number;
  description?: string;
  idempotencyKey?: string;
}

export interface CheckoutResult {
  ref: string;
  chargeType: ChargeType;
  statementDescriptor: string;
  settlesTo: SettlementTarget;
  applicationFeeOnly: true;
  amountCents: number;
  currency: string;
}

export interface RefundResult {
  ref: string;
  refunded: boolean;
  amountCents: number;
}

export type PaymentEventType =
  | "account.updated"
  | "charge.succeeded"
  | "charge.refunded"
  | "charge.dispute.created"
  | "tos.accepted"
  | "payout.paid";

export interface NormalizedPaymentEvent {
  type: PaymentEventType;
  railId: RailId;
  signatureValid: boolean;
  accountId?: string;
  chargeRef?: string;
  amountCents?: number;
  currency?: string;
  tosAcceptedAt?: string;
  tosAcceptedIp?: string;
  raw: unknown;
}

export interface PaymentRail {
  readonly id: RailId;
  supports(country: string, entity: BusinessType): boolean;
  createMerchantAccount(prefill: MerchantAccountPrefill): Promise<CreatedMerchantAccount>;
  getAccountStatus(accountId: string): Promise<AccountStatus>;
  createCheckout(accountId: string, req: CheckoutRequest): Promise<CheckoutResult>;
  refund(accountId: string, chargeRef: string): Promise<RefundResult>;
  normalizeWebhook(raw: unknown): NormalizedPaymentEvent;
}

/** Statement-descriptor rules: <=22 chars, restricted charset, never empty. */
export function deriveStatementDescriptor(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned.slice(0, 22) || "MERCHANT";
}
