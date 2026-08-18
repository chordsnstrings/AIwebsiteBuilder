// The CompanyRegistry capability — classifying a UK/IE business as a
// registered company or a sole trader.
//
// ⛔ WHY THIS EXISTS. Under PECR a corporate subscriber may be mailed on
// legitimate interest; a sole trader is treated as an individual and may not.
// `resolveLegalBasis` therefore returns null for anything that is not
// `corporate` in GB/IE, and the gate denies on NO_LEGAL_BASIS.
//
// There was no implementation of this capability at all. Every production path
// passed a stub returning "unknown", so every GB and IE contact was classified
// as unmailable at ingest and denied forever — 1,465 businesses, roughly a
// third of the database, permanently undeliverable with nothing reporting why.

import type { SubscriberType } from "@adw/compliance";

/**
 * A classification and the evidence behind it.
 *
 * ⛔ The reference is not decoration. "corporate" is the answer that unlocks
 * mailing a person, and a row asserting it with nothing recording WHY is an
 * assertion nobody can defend — to the ICO, to the recipient, or to the next
 * engineer. `contacts.registry_ref` exists for exactly this and was NULL on
 * every row in the database.
 */
export interface Classification {
  readonly subscriberType: SubscriberType;
  /** e.g. `suffix:ltd`, or `companies_house:12345678` once a real lookup runs. */
  readonly ref: string | null;
}

export interface CompanyRegistry {
  readonly vendorId: string;
  /**
   * Classify a trading name.
   *
   * ⛔ MUST return "corporate" only on positive evidence. "unknown" is the
   * correct answer for anything unproven, and it denies — that asymmetry is
   * the whole safety property, and an implementation that guesses "corporate"
   * to unblock volume is mailing sole traders without consent.
   */
  classify(businessName: string, countryCode: string): Promise<Classification>;
}
