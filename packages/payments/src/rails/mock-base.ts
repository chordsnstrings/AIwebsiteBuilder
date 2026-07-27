// Deterministic in-memory rail used by tests and local runs (spec §14). Models a
// facilitator-conformant rail: direct charges, merchant-owned settlement, signed
// webhooks. No network, no vendor SDK. Concrete rails extend this and differ only
// in id and country/entity support so the shared invariants live in one place.
import { createHmac, randomUUID } from "node:crypto";
import {
  deriveStatementDescriptor,
  type AccountStatus,
  type BusinessType,
  type CheckoutRequest,
  type CheckoutResult,
  type CreatedMerchantAccount,
  type MerchantAccountPrefill,
  type NormalizedPaymentEvent,
  type PaymentEventType,
  type PaymentRail,
  type RailId,
  type RefundResult,
} from "./types.ts";

interface MockAccount {
  id: string;
  statementDescriptor: string;
  businessType: BusinessType;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  currentlyDue: string[];
}

interface MockCharge {
  ref: string;
  accountId: string;
  amountCents: number;
  currency: string;
  refunded: boolean;
}

/** A signed webhook envelope as a rail would deliver over the wire. */
export interface SignedWebhook {
  body: string;
  signature: string;
}

/** Domain-shaped event handed to `dispatchWebhook` to sign and later normalize. */
export interface MockEvent {
  type: PaymentEventType;
  accountId?: string;
  chargeRef?: string;
  amountCents?: number;
  currency?: string;
  tosAcceptedAt?: string;
  tosAcceptedIp?: string;
}

export abstract class MockRailBase implements PaymentRail {
  abstract readonly id: RailId;
  private readonly accounts = new Map<string, MockAccount>();
  private readonly charges = new Map<string, MockCharge>();
  private readonly secret: string;

  constructor(secret?: string) {
    this.secret = secret ?? `whsec_mock_${this.constructorName()}`;
  }

  private constructorName(): string {
    return this.constructor.name;
  }

  abstract supports(country: string, entity: BusinessType): boolean;

  private nextId(prefix: string): string {
    // Random suffix: external account ids are lookup keys and must be unique
    // across processes AND across runs against a persistent test database.
    return `${prefix}_${this.id}_${randomUUID().slice(0, 12)}`;
  }

  createMerchantAccount(prefill: MerchantAccountPrefill): Promise<CreatedMerchantAccount> {
    // Invariant 1: a non-direct charge type is refused outright — ADW never opens
    // a destination/express account.
    if (prefill.requestedChargeType && prefill.requestedChargeType !== "direct") {
      return Promise.reject(
        new Error(
          `charge_type '${prefill.requestedChargeType}' refused: ADW opens only direct connected accounts (spec §14.1)`,
        ),
      );
    }
    const descriptor = prefill.statementDescriptor || deriveStatementDescriptor(prefill.merchantName);
    const account: MockAccount = {
      id: this.nextId("acct"),
      statementDescriptor: descriptor,
      businessType: prefill.businessType,
      // Fresh account: not yet onboarded. The rail (not ADW) collects requirements.
      chargesEnabled: false,
      payoutsEnabled: false,
      currentlyDue: ["business_profile.url", "tos_acceptance", "external_account"],
    };
    this.accounts.set(account.id, account);
    return Promise.resolve({
      accountId: account.id,
      chargeType: "direct",
      requirementCollection: "stripe",
      statementDescriptor: descriptor,
      businessType: prefill.businessType,
    });
  }

  /** Test seam: simulate the merchant completing rail-side onboarding. */
  onboard(accountId: string): void {
    const acct = this.require(accountId);
    acct.chargesEnabled = true;
    acct.payoutsEnabled = true;
    acct.currentlyDue = [];
  }

  getAccountStatus(accountId: string): Promise<AccountStatus> {
    const acct = this.require(accountId);
    return Promise.resolve({
      chargesEnabled: acct.chargesEnabled,
      payoutsEnabled: acct.payoutsEnabled,
      currentlyDue: [...acct.currentlyDue],
      disabledReason: acct.chargesEnabled ? undefined : "requirements.past_due",
    });
  }

  createCheckout(accountId: string, req: CheckoutRequest): Promise<CheckoutResult> {
    const acct = this.require(accountId);
    const charge: MockCharge = {
      ref: this.nextId("ch"),
      accountId,
      amountCents: req.amountCents,
      currency: req.currency,
      refunded: false,
    };
    this.charges.set(charge.ref, charge);
    // Direct charge: funds settle to the merchant's account, ADW takes only an
    // application fee. ADW never touches the balance.
    return Promise.resolve({
      ref: charge.ref,
      chargeType: "direct",
      statementDescriptor: acct.statementDescriptor,
      settlesTo: "merchant",
      applicationFeeOnly: true,
      amountCents: req.amountCents,
      currency: req.currency,
    });
  }

  refund(accountId: string, chargeRef: string): Promise<RefundResult> {
    this.require(accountId);
    const charge = this.charges.get(chargeRef);
    if (!charge || charge.accountId !== accountId) {
      return Promise.reject(new Error(`unknown charge ${chargeRef} for account ${accountId}`));
    }
    charge.refunded = true;
    return Promise.resolve({ ref: this.nextId("re"), refunded: true, amountCents: charge.amountCents });
  }

  /** Produce a signed webhook envelope for a domain event (test/dispatch helper). */
  dispatchWebhook(event: MockEvent): SignedWebhook {
    const body = JSON.stringify({ railId: this.id, ...event });
    return { body, signature: this.sign(body) };
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("hex");
  }

  normalizeWebhook(raw: unknown): NormalizedPaymentEvent {
    const env = raw as Partial<SignedWebhook>;
    const body = typeof env.body === "string" ? env.body : "";
    const signatureValid = typeof env.signature === "string" && env.signature === this.sign(body);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    return {
      type: (parsed.type as PaymentEventType) ?? "account.updated",
      railId: this.id,
      signatureValid,
      accountId: parsed.accountId as string | undefined,
      chargeRef: parsed.chargeRef as string | undefined,
      amountCents: parsed.amountCents as number | undefined,
      currency: parsed.currency as string | undefined,
      tosAcceptedAt: parsed.tosAcceptedAt as string | undefined,
      tosAcceptedIp: parsed.tosAcceptedIp as string | undefined,
      raw,
    };
  }

  private require(accountId: string): MockAccount {
    const acct = this.accounts.get(accountId);
    if (!acct) throw new Error(`unknown account ${accountId}`);
    return acct;
  }
}
