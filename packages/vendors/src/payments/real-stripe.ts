// REAL Stripe payment rail — the live counterpart to @adw/payments'
// MockStripeRail.
//
// ---------------------------------------------------------------------------
// WHY THIS LIVES IN packages/vendors AND NOT packages/payments
// ---------------------------------------------------------------------------
// packages/vendors is the vendor-SDK / external-I/O boundary the lint rule
// `adw/no-vendor-sdk-outside-adapters` enforces, and it is where the credential
// resolver lives. @adw/payments depends on @adw/vendors, not the other way
// round, so the adapter is exported from here and payments consumes it:
//
//     import { StripeRail } from "@adw/vendors";
//     const rail: PaymentRail = new StripeRail({ secretKey });
//
// It satisfies @adw/payments' `PaymentRail` structurally (see ./rail-types.ts).
// Moving this file into packages/payments would put raw HTTP inside the domain
// package and invert the dependency; do not do it.
//
// ---------------------------------------------------------------------------
// THE FOUR INVARIANTS ARE ENFORCED HERE, NOT ASSUMED
// ---------------------------------------------------------------------------
// (1) charge_type is direct only. `requestedChargeType != 'direct'` is refused
//     before any network call, and the account is opened with controller
//     parameters that produce a direct-charge account — never `type=express`
//     or `type=custom`.
// (2) ADW never initiates a sub-merchant payout. There is no payout method on
//     this class (conformanceCheck asserts the absence by name), and every
//     outgoing form body is screened for the parameters that would turn a
//     direct charge into a destination charge or a transfer.
// (3) The statement descriptor is the MERCHANT's name, sent on account creation
//     and verified in Stripe's response.
// (4) controller[requirement_collection]=stripe is sent AND the response is
//     re-checked; a Stripe account that came back any other way is rejected
//     rather than quietly used.
//
// Every mutating call carries an Idempotency-Key. Retrying a checkout must not
// charge a buyer twice.
//
// Vault: stripe/secret_key (+ optional stripe/webhook_secret).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { RealVendorBase } from "../real-base.ts";
import { globalFetch, readBody, VendorHttpError, rfc3986, type FetchLike } from "../http.ts";
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
} from "./rail-types.ts";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * Form parameters that would move money on a sub-merchant's behalf or make ADW
 * the settlement point. Screened out of every request body (invariant 2).
 */
const FORBIDDEN_PARAMS = [
  "transfer_data",
  "on_behalf_of",
  "transfer_group",
  "source_transaction",
  "destination",
];

/** Markets the primary card rail can open accounts in. */
const SUPPORTED_COUNTRIES = ["US", "GB", "IE", "CA", "AU", "NZ", "AE"];

export interface StripeRailConfig {
  secretKey: string;
  /** Endpoint-signing secret (`whsec_...`) for normalizeWebhook(). */
  webhookSecret?: string;
  /** Stripe API version pin. Unset means the account's default version. */
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** The envelope @adw/payments already passes to normalizeWebhook(). */
export interface StripeWebhookEnvelope {
  body: string;
  /** The raw `Stripe-Signature` header value. */
  signature: string;
}

type Form = Record<string, string | number | undefined>;

export class StripeRail extends RealVendorBase implements PaymentRail {
  readonly id: RailId = "stripe";

  /** accountId → statement descriptor, so checkout need not re-read the account. */
  private readonly descriptors = new Map<string, string>();

  constructor(private readonly cfg: StripeRailConfig) {
    super("stripe");
  }

  supports(country: string, _entity: BusinessType): boolean {
    return SUPPORTED_COUNTRIES.includes(country);
  }

  async createMerchantAccount(prefill: MerchantAccountPrefill): Promise<CreatedMerchantAccount> {
    // Invariant 1, enforced before any network call: ADW opens direct connected
    // accounts and nothing else.
    if (prefill.requestedChargeType !== undefined && prefill.requestedChargeType !== "direct") {
      throw new Error(
        `charge_type '${prefill.requestedChargeType}' refused: ADW opens only direct connected accounts (spec §14.1)`,
      );
    }
    const descriptor = prefill.statementDescriptor || deriveStatementDescriptor(prefill.merchantName);

    const form: Form = {
      country: prefill.country,
      email: prefill.email,
      business_type: prefill.businessType,
      // Direct-charge controller shape: the connected account pays Stripe's
      // fees and owns its dashboard; Stripe (not ADW) collects requirements.
      "controller[fees][payer]": "account",
      "controller[losses][payments]": "stripe",
      "controller[stripe_dashboard][type]": "full",
      "controller[requirement_collection]": "stripe",
      "business_profile[mcc]": prefill.mcc,
      "business_profile[url]": prefill.url,
      "business_profile[name]": prefill.merchantName,
      // Invariant 3: the buyer's statement shows the merchant, not ADW.
      "settings[payments][statement_descriptor]": descriptor,
    };
    const addressPrefix = prefill.businessType === "company" ? "company" : "individual";
    if (prefill.address) {
      form[`${addressPrefix}[address][line1]`] = prefill.address.line1;
      form[`${addressPrefix}[address][line2]`] = prefill.address.line2;
      form[`${addressPrefix}[address][city]`] = prefill.address.city;
      form[`${addressPrefix}[address][state]`] = prefill.address.state;
      form[`${addressPrefix}[address][postal_code]`] = prefill.address.postalCode;
      form[`${addressPrefix}[address][country]`] = prefill.address.country;
    }

    const account = await this.post<StripeAccount>("/accounts", form, {
      idempotencyKey: idempotencyKey("acct", prefill.customerId, prefill.merchantName, prefill.country),
    });

    // Invariant 4, verified on the way back: never trust that the request landed
    // the way it was written.
    const collection = account.controller?.requirement_collection;
    if (collection !== "stripe") {
      throw new Error(
        `stripe returned requirement_collection '${collection ?? "unset"}' for ${account.id}; ` +
          "ADW must never be the requirement-collection owner (spec §14.1 inv. 4)",
      );
    }
    // Invariant 3, verified on the way back. Stripe normalises case/spacing, so
    // compare normalised and keep the merchant-facing value we were given.
    const echoed = account.settings?.payments?.statement_descriptor;
    if (echoed !== undefined && normaliseDescriptor(echoed) !== normaliseDescriptor(descriptor)) {
      throw new Error(
        `stripe set statement_descriptor '${echoed}' but the merchant's descriptor is '${descriptor}' (spec §14.1 inv. 3)`,
      );
    }
    this.descriptors.set(account.id, descriptor);

    return {
      accountId: account.id,
      chargeType: "direct",
      requirementCollection: "stripe",
      statementDescriptor: descriptor,
      businessType: prefill.businessType,
    };
  }

  async getAccountStatus(accountId: string): Promise<AccountStatus> {
    const account = await this.get<StripeAccount>(`/accounts/${rfc3986(accountId)}`);
    const disabledReason = account.requirements?.disabled_reason ?? undefined;
    return {
      chargesEnabled: account.charges_enabled === true,
      // Stripe → merchant payouts. ADW neither initiates nor sees these.
      payoutsEnabled: account.payouts_enabled === true,
      currentlyDue: account.requirements?.currently_due ?? [],
      ...(disabledReason !== undefined ? { disabledReason } : {}),
    };
  }

  /**
   * A DIRECT charge: created on the connected account (Stripe-Account header),
   * settling into the merchant's balance, with ADW taking only an application
   * fee. No transfer_data, no on_behalf_of — see FORBIDDEN_PARAMS.
   */
  async createCheckout(accountId: string, req: CheckoutRequest): Promise<CheckoutResult> {
    const form: Form = {
      amount: req.amountCents,
      currency: req.currency,
      description: req.description,
      "automatic_payment_methods[enabled]": "true",
      application_fee_amount: req.applicationFeeCents,
    };
    const intent = await this.post<StripePaymentIntent>("/payment_intents", form, {
      idempotencyKey:
        req.idempotencyKey ??
        idempotencyKey("pi", accountId, String(req.amountCents), req.currency, req.description ?? ""),
      stripeAccount: accountId,
    });
    return {
      ref: intent.id,
      chargeType: "direct",
      statementDescriptor: await this.descriptorFor(accountId),
      settlesTo: "merchant",
      applicationFeeOnly: true,
      amountCents: req.amountCents,
      currency: req.currency,
    };
  }

  /** Buyer refund on the connected account. Not a sub-merchant payout. */
  async refund(accountId: string, chargeRef: string): Promise<RefundResult> {
    const form: Form = chargeRef.startsWith("pi_") ? { payment_intent: chargeRef } : { charge: chargeRef };
    const refund = await this.post<StripeRefund>("/refunds", form, {
      idempotencyKey: idempotencyKey("re", accountId, chargeRef),
      stripeAccount: accountId,
    });
    return {
      ref: refund.id,
      refunded: refund.status === "succeeded" || refund.status === "pending",
      amountCents: refund.amount ?? 0,
    };
  }

  /**
   * Verify the `Stripe-Signature` header and normalise the event. Synchronous by
   * contract, which is fine — signature verification is a local HMAC.
   */
  normalizeWebhook(raw: unknown): NormalizedPaymentEvent {
    const env = raw as Partial<StripeWebhookEnvelope> | undefined;
    const body = typeof env?.body === "string" ? env.body : "";
    const signatureValid = this.verifySignature(body, typeof env?.signature === "string" ? env.signature : "");

    let event: StripeEvent = {};
    try {
      event = body.length > 0 ? (JSON.parse(body) as StripeEvent) : {};
    } catch {
      event = {};
    }
    const object = (event.data?.object ?? {}) as StripeEventObject;
    const tosDate = object.tos_acceptance?.date;
    const type = mapEventType(event.type ?? "", tosDate !== undefined);

    return {
      type,
      railId: this.id,
      signatureValid,
      accountId: event.account ?? (event.type?.startsWith("account.") === true ? object.id : undefined),
      chargeRef: object.payment_intent ?? (event.type?.startsWith("charge.") === true ? object.id : undefined),
      amountCents: object.amount ?? object.amount_refunded,
      currency: object.currency,
      tosAcceptedAt: tosDate === undefined ? undefined : new Date(tosDate * 1000).toISOString(),
      tosAcceptedIp: object.tos_acceptance?.ip,
      raw,
    };
  }

  // --- internals -----------------------------------------------------------

  private async descriptorFor(accountId: string): Promise<string> {
    const cached = this.descriptors.get(accountId);
    if (cached !== undefined) return cached;
    const account = await this.get<StripeAccount>(`/accounts/${rfc3986(accountId)}`);
    const descriptor =
      account.settings?.payments?.statement_descriptor ??
      deriveStatementDescriptor(account.business_profile?.name ?? "MERCHANT");
    this.descriptors.set(accountId, descriptor);
    return descriptor;
  }

  private verifySignature(body: string, header: string): boolean {
    const secret = this.cfg.webhookSecret;
    if (secret === undefined || header === "") return false;
    const parts = new Map<string, string[]>();
    for (const piece of header.split(",")) {
      const [k, v] = piece.split("=");
      if (k === undefined || v === undefined) continue;
      const bucket = parts.get(k.trim()) ?? [];
      bucket.push(v.trim());
      parts.set(k.trim(), bucket);
    }
    const timestamp = parts.get("t")?.[0];
    const provided = parts.get("v1") ?? [];
    if (timestamp === undefined || provided.length === 0) return false;
    const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
    return provided.some((candidate) => constantTimeEquals(candidate, expected));
  }

  private get<T>(path: string, stripeAccount?: string): Promise<T> {
    return this.request<T>("GET", path, undefined, { stripeAccount });
  }

  /**
   * Every mutating call goes through here, so every mutating call carries an
   * Idempotency-Key — it is a required argument, not an option.
   */
  private post<T>(
    path: string,
    form: Form,
    opts: { idempotencyKey: string; stripeAccount?: string },
  ): Promise<T> {
    assertNoSubMerchantPayout(path, form);
    return this.request<T>("POST", path, encodeForm(form), opts);
  }

  private async request<T>(
    method: string,
    path: string,
    body: string | undefined,
    opts: { idempotencyKey?: string; stripeAccount?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.cfg.secretKey}` };
    if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
    if (opts.idempotencyKey !== undefined) headers["idempotency-key"] = opts.idempotencyKey;
    if (opts.stripeAccount !== undefined) headers["stripe-account"] = opts.stripeAccount;
    if (this.cfg.apiVersion !== undefined) headers["stripe-version"] = this.cfg.apiVersion;

    const send = this.cfg.fetchImpl ?? globalFetch;
    const res = await send(`${this.cfg.baseUrl ?? STRIPE_API_BASE}${path}`, { method, headers, body });
    const { text, json } = await readBody(res);
    if (!res.ok) {
      const message = (json as { error?: { message?: string } } | undefined)?.error?.message;
      throw new VendorHttpError(this.vendorId, res.status, message ?? text);
    }
    return json as T;
  }

  /** Read-only account fetch: proves the key without creating anything. */
  protected override async probeOperation(): Promise<string> {
    const account = await this.get<StripeAccount>("/account");
    return `stripe account ${account.id} reachable`;
  }
}

// --- helpers ----------------------------------------------------------------

interface StripeAccount {
  id: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  controller?: { requirement_collection?: string };
  business_profile?: { name?: string };
  settings?: { payments?: { statement_descriptor?: string } };
  requirements?: { currently_due?: string[]; disabled_reason?: string | null };
}

interface StripePaymentIntent {
  id: string;
}

interface StripeRefund {
  id: string;
  amount?: number;
  status?: string;
}

interface StripeEventObject {
  id?: string;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  payment_intent?: string;
  tos_acceptance?: { date?: number; ip?: string };
}

interface StripeEvent {
  type?: string;
  account?: string;
  data?: { object?: StripeEventObject };
}

const EVENT_MAP: Record<string, PaymentEventType> = {
  "account.updated": "account.updated",
  "account.application.authorized": "account.updated",
  "charge.succeeded": "charge.succeeded",
  "payment_intent.succeeded": "charge.succeeded",
  "charge.refunded": "charge.refunded",
  "charge.dispute.created": "charge.dispute.created",
  "payout.paid": "payout.paid",
};

/**
 * An `account.updated` carrying a tos_acceptance date IS the ToS acceptance
 * event — Stripe has no dedicated type, and payments needs the genuine
 * timestamp/IP rather than a value ADW made up.
 */
function mapEventType(stripeType: string, hasTosAcceptance: boolean): PaymentEventType {
  if (hasTosAcceptance && stripeType.startsWith("account.")) return "tos.accepted";
  return EVENT_MAP[stripeType] ?? "account.updated";
}

function normaliseDescriptor(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function encodeForm(form: Form): string {
  return Object.entries(form)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(String(v))}`)
    .join("&");
}

/**
 * Invariant 2, enforced on the wire. Even if a future edit adds a parameter that
 * would settle funds through ADW or move a sub-merchant's balance, the request
 * never leaves the process.
 */
function assertNoSubMerchantPayout(path: string, form: Form): void {
  if (/^\/(payouts|transfers)\b/.test(path)) {
    throw new Error(`stripe ${path} refused: ADW never initiates a sub-merchant payout (spec §14.1 inv. 2)`);
  }
  // Screen the parameter names before encoding, so a nested key such as
  // `transfer_data[destination]` is caught by both of its tokens.
  for (const key of Object.keys(form)) {
    for (const token of key.split(/[[\]]/).filter((t) => t !== "")) {
      if (FORBIDDEN_PARAMS.includes(token)) {
        throw new Error(
          `stripe request to ${path} carried '${key}': that converts a direct charge into a ` +
            "destination/transfer flow, which ADW must never do (spec §14.1 inv. 2)",
        );
      }
    }
  }
}

/** Deterministic, collision-resistant idempotency key from the call's identity. */
function idempotencyKey(prefix: string, ...parts: string[]): string {
  return `adw-${prefix}-${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
