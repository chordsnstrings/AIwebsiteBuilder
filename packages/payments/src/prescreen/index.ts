// Payments pre-screen (spec §14.2.2). A COMMERCIAL filter, not KYB: decide
// whether to OFFER payments to a customer and which entity type to open. It never
// makes a KYB/identity judgement (the rail does that during onboarding). A
// prohibited category is declined SILENTLY — no reason is surfaced to the
// customer (spec §14.2.2 / §26). Deterministic; the config hash is auditable.
import { config } from "@adw/config";
import { emit } from "@adw/telemetry";
import type { Db } from "@adw/db";
import type { BusinessType } from "../rails/types.ts";

export interface PreScreenInput {
  customerId: string;
  /** The business category (taxonomy code) held for this customer. */
  category: string;
  /** True when the business was matched in an official company registry. */
  registryHit: boolean;
  countryCode: string;
  /** UAE licensing signal; required to offer payments in AE. */
  licensed?: boolean;
}

export interface PreScreenResult {
  offered: boolean;
  /** Present only when offered — routes the connected-account entity type. */
  businessType?: BusinessType;
}

/**
 * Decide whether to offer payments and route the entity type. Prohibited
 * categories and unlicensed AE businesses are declined silently (no reason).
 */
export async function preScreen(db: Db, input: PreScreenInput): Promise<PreScreenResult> {
  // Context only — never fatal if the customer row is absent (pure filter).
  const ctx = await db.maybeOne<{ region_code: string }>(
    "SELECT region_code FROM customers WHERE id = $1",
    [input.customerId],
  );

  const prohibited = config.prohibited().data.prohibited;

  // Commercial decline #1 — prohibited category. Silent: no reason returned.
  if (prohibited.includes(input.category)) {
    await emit({
      eventType: "payments.prescreen.declined",
      subject: { kind: "customer", id: input.customerId },
      region: ctx?.region_code,
      // Reason is internal telemetry only; the customer is told nothing.
      payload: { silent: true },
    });
    return { offered: false };
  }

  // Commercial decline #2 — UAE requires a trade licence to be offered payments.
  if (input.countryCode === "AE" && input.licensed !== true) {
    await emit({
      eventType: "payments.prescreen.declined",
      subject: { kind: "customer", id: input.customerId },
      region: ctx?.region_code,
      payload: { silent: true },
    });
    return { offered: false };
  }

  // Entity-type routing: a registry match opens a company account, else individual.
  const businessType: BusinessType = input.registryHit ? "company" : "individual";
  await emit({
    eventType: "payments.prescreen.offered",
    subject: { kind: "customer", id: input.customerId },
    region: ctx?.region_code,
    payload: { businessType },
  });
  return { offered: true, businessType };
}
