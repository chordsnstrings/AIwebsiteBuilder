// Cloudflare is one credential wearing three hats: Pages (SiteHost), DNS
// (DnsProvider) and R2 (ObjectStore). The register carries a single vendor id,
// so the mock is a composite: one outage switch flips all three legs, and the
// probe exercises every leg because a partial Cloudflare failure is exactly the
// kind of thing a single-leg probe would miss.
import { BaseMockVendor, type RoundTripResult } from "./health.ts";
import { MockSiteHost } from "./hosting/mock.ts";
import { MockDnsProvider } from "./dns/mock.ts";
import { MockObjectStore } from "./storage/mock.ts";

export class MockCloudflare extends BaseMockVendor {
  readonly sites: MockSiteHost;
  readonly dns: MockDnsProvider;
  readonly objects: MockObjectStore;

  constructor(vendorId = "cloudflare") {
    super(vendorId);
    this.sites = new MockSiteHost(vendorId);
    this.dns = new MockDnsProvider(vendorId);
    this.objects = new MockObjectStore(vendorId);
  }

  override simulateOutage(on: boolean): void {
    super.simulateOutage(on);
    this.sites.simulateOutage(on);
    this.dns.simulateOutage(on);
    this.objects.simulateOutage(on);
  }

  /** Break exactly one leg — the partial-degradation case. */
  simulateLegOutage(leg: "pages" | "dns" | "r2", on: boolean): void {
    if (leg === "pages") this.sites.simulateOutage(on);
    if (leg === "dns") this.dns.simulateOutage(on);
    if (leg === "r2") this.objects.simulateOutage(on);
  }

  protected override async probeOperation(): Promise<string> {
    const legs: [string, RoundTripResult][] = [
      ["pages", await this.sites.roundTrip()],
      ["dns", await this.dns.roundTrip()],
      ["r2", await this.objects.roundTrip()],
    ];
    const failed = legs.filter(([, result]) => !result.ok);
    if (failed.length > 0) {
      throw new Error(`cloudflare legs failed: ${failed.map(([name, r]) => `${name} (${r.detail ?? "no detail"})`).join("; ")}`);
    }
    return `pages+dns+r2 ok`;
  }
}
