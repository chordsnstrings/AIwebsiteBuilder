// Primary mock card rail (spec §14). Facilitator-conformant: direct charges,
// requirement_collection 'stripe', statement descriptor = merchant name, signed
// webhooks. Simulates charges_enabled after onboarding. No vendor SDK is imported
// (that would violate adw/no-vendor-sdk-outside-adapters) — this is a stand-in.
import { MockRailBase } from "./mock-base.ts";
import type { BusinessType, RailId } from "./types.ts";

export class MockStripeRail extends MockRailBase {
  readonly id: RailId = "stripe";

  /** Broad card support; the merchant's rail collects requirements per country. */
  override supports(country: string, _entity: BusinessType): boolean {
    // The primary rail supports the core facilitation markets.
    return ["US", "GB", "IE", "CA", "AU", "NZ", "AE"].includes(country);
  }
}
