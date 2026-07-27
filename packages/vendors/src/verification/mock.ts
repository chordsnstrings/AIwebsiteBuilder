// Deterministic EmailVerifier simulator. The verdict is a pure function of the
// address: anything containing "invalid" is invalid, anything containing
// "risky" is risky, a malformed address is invalid, everything else is valid.
// During an outage it answers "unknown" rather than throwing, because the
// caller must be able to tell "we don't know" apart from "it's fine".
import { BaseMockVendor } from "../health.ts";
import type { EmailVerifier, VerificationVerdict } from "./types.ts";

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class MockEmailVerifier extends BaseMockVendor implements EmailVerifier {
  private readonly counts: Record<VerificationVerdict, number> = { valid: 0, risky: 0, invalid: 0, unknown: 0 };

  async verify(email: string): Promise<VerificationVerdict> {
    const verdict = this.verdictFor(email);
    this.counts[verdict] += 1;
    return verdict;
  }

  private verdictFor(email: string): VerificationVerdict {
    if (this.down) return "unknown";
    const address = email.trim().toLowerCase();
    if (!SHAPE.test(address)) return "invalid";
    if (address.includes("invalid")) return "invalid";
    if (address.includes("risky")) return "risky";
    return "valid";
  }

  tally(): Record<VerificationVerdict, number> {
    return { ...this.counts };
  }

  protected override async probeOperation(): Promise<string> {
    const verdict = await this.verify("sentinel-probe@example.com");
    if (verdict !== "valid") throw new Error(`probe address returned '${verdict}'`);
    return "verdict valid";
  }
}
