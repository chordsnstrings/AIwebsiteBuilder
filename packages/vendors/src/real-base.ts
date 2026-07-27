// Health surface for REAL adapters. The Sentinel probes a capability through
// VendorHealthSurface (spec §71.3) and must not care whether it is measuring a
// mock or a live vendor — otherwise "100% of T0/T1 vendors have a live probe"
// silently becomes "100% in demo mode only". BaseMockVendor gives the mocks that
// surface; this gives it to the adapters that talk to the real thing.
//
// Two differences from BaseMockVendor, both deliberate:
//   - latency is MEASURED, not derived from a seed. A real probe's whole point
//     is the number of milliseconds the vendor actually took.
//   - there is no simulateOutage(). You cannot break Cloudflare from here, and a
//     switch that pretended you could would make a live probe lie.
import type { RoundTripResult, VendorHealthSurface } from "./health.ts";

export abstract class RealVendorBase implements VendorHealthSurface {
  readonly vendorId: string;

  constructor(vendorId: string) {
    this.vendorId = vendorId;
  }

  /**
   * The live call a probe performs. Override with the cheapest request that
   * still traverses auth and the production code path — a probe that skips
   * either is measuring nothing.
   */
  protected abstract probeOperation(): Promise<string>;

  async roundTrip(): Promise<RoundTripResult> {
    const started = Date.now();
    try {
      const detail = await this.probeOperation();
      return { ok: true, latencyMs: Date.now() - started, detail };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
