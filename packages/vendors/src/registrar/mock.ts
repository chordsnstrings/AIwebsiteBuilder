// Stateful in-memory DomainRegistrar simulator. Availability is deterministic
// (a domain containing "taken"/"unavailable" is not free, and anything already
// registered here is not free either) so tests never depend on a dice roll.
//
// requestTransferOut() deliberately sits OUTSIDE every guard in this class: it
// ignores the outage switch, the credit balance and the registration state.
// Holding a customer's domain hostage is not a failure mode this system is
// allowed to have, so there is no code path that can produce it.
import { BaseMockVendor, seedHex } from "../health.ts";
import type { DomainRegistrar, DomainRegistration, DomainStatus, TransferOutAuth } from "./types.ts";

const RESERVED_MARKERS = ["taken", "unavailable"];
const DAY_MS = 24 * 60 * 60 * 1000;

function normalise(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

export class MockDomainRegistrar extends BaseMockVendor implements DomainRegistrar {
  /** Days of prepaid reseller credit left; a probe alarms when this hits zero. */
  creditBalanceDays = 45;

  private readonly registrations = new Map<string, DomainRegistration>();
  private readonly transfersOut = new Map<string, TransferOutAuth>();
  /** Fixed clock: registration dates must be reproducible. */
  private clock = new Date("2026-01-01T00:00:00Z");

  setCreditBalanceDays(days: number): void {
    this.creditBalanceDays = days;
  }

  setClock(now: Date): void {
    this.clock = now;
  }

  async checkAvailability(domain: string): Promise<boolean> {
    this.assertUp("checkAvailability");
    const d = normalise(domain);
    if (d === "" || !d.includes(".")) throw new Error(`invalid domain '${domain}'`);
    if (this.registrations.has(d)) return false;
    return !RESERVED_MARKERS.some((marker) => d.includes(marker));
  }

  async register(domain: string, years: number): Promise<DomainRegistration> {
    this.assertUp("register");
    if (years < 1) throw new Error("registration term must be at least one year");
    if (this.creditBalanceDays <= 0) throw new Error("reseller credit exhausted — cannot register");
    const d = normalise(domain);
    if (!(await this.checkAvailability(d))) throw new Error(`domain '${d}' is not available`);
    const registeredAt = this.clock.toISOString();
    const expiresAt = new Date(this.clock.getTime() + years * 365 * DAY_MS).toISOString();
    const registration: DomainRegistration = { domain: d, status: "registered", years, registeredAt, expiresAt };
    this.registrations.set(d, registration);
    return { ...registration };
  }

  async status(domain: string): Promise<DomainStatus> {
    this.assertUp("status");
    const d = normalise(domain);
    if (this.transfersOut.has(d)) return "transfer_pending";
    const registration = this.registrations.get(d);
    if (!registration) return "available";
    return new Date(registration.expiresAt).getTime() <= this.clock.getTime() ? "expired" : "registered";
  }

  /**
   * ALWAYS succeeds. No outage guard, no credit check, no lock check. If the
   * customer wants their domain elsewhere they get the auth code, full stop.
   */
  async requestTransferOut(domain: string): Promise<TransferOutAuth> {
    const d = normalise(domain);
    const existing = this.transfersOut.get(d);
    if (existing) return { ...existing };
    const auth: TransferOutAuth = {
      domain: d,
      authCode: `ADW-${seedHex(12, "transfer", this.vendorId, d).toUpperCase()}`,
      unlocked: true,
    };
    this.transfersOut.set(d, auth);
    return { ...auth };
  }

  registeredDomains(): string[] {
    return [...this.registrations.keys()].sort();
  }

  protected override async probeOperation(): Promise<string> {
    if (this.creditBalanceDays <= 0) throw new Error("reseller credit exhausted (0 days)");
    const available = await this.checkAvailability("adw-sentinel-probe.example");
    if (!available) throw new Error("probe domain unexpectedly unavailable");
    return `availability ok, credit ${this.creditBalanceDays}d`;
  }
}
