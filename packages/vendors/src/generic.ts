// The long tail. Most of the ~66 vendors in the register need nothing more from
// a demo run than "is it up?" — Stripe, Postgres, Redis, Temporal, Twilio,
// Langfuse and the model rails all get probed but have no simulated behaviour
// worth modelling here. This mock gives every one of them a working health
// surface and a chaos switch, so probe coverage can be 100% without inventing
// fake business logic for vendors that do not need it.
import { BaseMockVendor } from "./health.ts";

export class GenericVendorMock extends BaseMockVendor {
  private calls = 0;

  callCount(): number {
    return this.calls;
  }

  protected override async probeOperation(): Promise<string> {
    this.calls += 1;
    return `${this.vendorId} round trip ok`;
  }
}
