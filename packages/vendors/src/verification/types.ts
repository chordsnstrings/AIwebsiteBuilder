// The EmailVerifier capability. Four verdicts, and "unknown" is a real answer:
// when the verifier is unreachable it must NOT default to "valid", because a
// false valid is what burns a sending domain.
export type VerificationVerdict = "valid" | "risky" | "invalid" | "unknown";

export interface EmailVerifier {
  readonly vendorId: string;
  verify(email: string): Promise<VerificationVerdict>;
}
