// Connected-account onboarding (spec §14.2.3). ADW assembles a prefill from data
// it already holds and opens a DIRECT connected account. It never writes
// tos_acceptance here (that is exclusively the acceptance-webhook handler's job,
// see tos-webhook.ts) and never sets requirement_collection to anything but
// 'stripe' (invariant 4).
import { emit } from "@adw/telemetry";
import type { Db } from "@adw/db";
import {
  deriveStatementDescriptor,
  type BusinessType,
  type MerchantAccountPrefill,
  type MerchantAddress,
  type PaymentRail,
} from "../rails/types.ts";

/** The subset of held customer data used to open a connected account. */
export interface CustomerRecord {
  id: string;
  legalName: string;
  url: string;
  mcc: string;
  countryCode: string;
  businessType: BusinessType;
  email?: string;
  address?: MerchantAddress;
}

export interface CreateAccountResult {
  /** merchant_accounts.id (our UUID primary key). */
  accountId: string;
  /** The rail-side external account id. */
  externalAccountId: string;
  statementDescriptor: string;
  businessType: BusinessType;
}

/**
 * Assemble the account prefill from held data: business_profile.url, mcc, name,
 * address, and the statement descriptor derived from the merchant's name
 * (invariant 3 — the descriptor shows the merchant, not ADW).
 */
export function buildPrefill(customer: CustomerRecord): MerchantAccountPrefill {
  return {
    customerId: customer.id,
    merchantName: customer.legalName,
    statementDescriptor: deriveStatementDescriptor(customer.legalName),
    businessType: customer.businessType,
    country: customer.countryCode,
    mcc: customer.mcc,
    url: customer.url,
    email: customer.email,
    address: customer.address,
  };
}

/**
 * Open a connected account on `rail` and persist a merchant_accounts row with
 * charge_type='direct' and requirement_collection='stripe'. The DB CHECK
 * constraint on charge_type is a second line of defence against a broken rail.
 */
export async function createAccount(
  db: Db,
  rail: PaymentRail,
  customerId: string,
  prefill: MerchantAccountPrefill,
): Promise<CreateAccountResult> {
  const created = await rail.createMerchantAccount(prefill);
  const status = await rail.getAccountStatus(created.accountId);

  const row = await db.one<{ id: string }>(
    `INSERT INTO merchant_accounts
       (customer_id, rail_id, external_account_id, business_type, charge_type,
        requirement_collection, charges_enabled, payouts_enabled, statement_descriptor,
        state, currently_due)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      customerId,
      rail.id,
      created.accountId,
      created.businessType,
      created.chargeType, // 'direct'; DB CHECK rejects anything else
      created.requirementCollection, // 'stripe'
      status.chargesEnabled,
      status.payoutsEnabled,
      created.statementDescriptor,
      "ONBOARDING",
      JSON.stringify(status.currentlyDue),
    ],
  );

  await emit({
    eventType: "payments.account.created",
    subject: { kind: "merchant_account", id: row.id },
    payload: { railId: rail.id, businessType: created.businessType },
  });

  return {
    accountId: row.id,
    externalAccountId: created.accountId,
    statementDescriptor: created.statementDescriptor,
    businessType: created.businessType,
  };
}
