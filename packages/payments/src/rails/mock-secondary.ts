// Secondary mock rail — the live-and-tested fallback (spec §14, registry rails
// primary/fallback). Same facilitator invariants as the primary; kept warm so a
// primary-rail incident never halts onboarding. Differs only in id and the set
// of markets it covers.
import { MockRailBase } from "./mock-base.ts";
import type { BusinessType, RailId } from "./types.ts";

export class MockSecondaryRail extends MockRailBase {
  readonly id: RailId = "secondary";

  override supports(country: string, _entity: BusinessType): boolean {
    // Fallback focuses on markets where a second live rail is required.
    return ["US", "GB", "AE"].includes(country);
  }
}
