// The paid verifier, and the composite that puts the free checks in front of it.
//
// Vendor-agnostic on purpose. ZeroBounce, MillionVerifier, NeverBounce and
// Kickbox all expose the same shape — GET with an api key and an email, JSON
// back with a status string — so the adapter is parameterised by endpoint and
// by a status map rather than written three times. `config/vendors.yaml`
// registers `email_verification` as a T0 vendor without naming which.

import { RealVendorBase } from "../real-base.ts";
import { globalFetch, type FetchLike } from "../http.ts";
import { verifyLocally, type LocalVerifierOptions } from "./local.ts";
import type { EmailVerifier, VerificationVerdict } from "./types.ts";

export interface HttpVerifierConfig {
  vendorId: string;
  apiKey: string;
  /** e.g. `https://api.zerobounce.net/v2/validate`. */
  endpoint: string;
  /** Query parameter names, since the vendors disagree about these. */
  apiKeyParam?: string;
  emailParam?: string;
  /** Field in the JSON response holding the status string. */
  statusField?: string;
  /** Vendor status → our four verdicts. Anything unmapped becomes `unknown`. */
  statusMap?: Record<string, VerificationVerdict>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * The default mapping, which covers the common vocabulary across vendors.
 *
 * ⛔ `catch-all`, `accept_all` and `unknown` map to `unknown`, never to `valid`.
 * A catch-all domain accepts mail for every local part including ones that do
 * not exist, so a "valid" from a catch-all carries no information at all — and
 * treating it as valid is precisely how a list looks clean and bounces anyway.
 */
const DEFAULT_STATUS_MAP: Record<string, VerificationVerdict> = {
  valid: "valid",
  deliverable: "valid",
  ok: "valid",
  invalid: "invalid",
  undeliverable: "invalid",
  bounced: "invalid",
  do_not_mail: "invalid",
  spamtrap: "invalid",
  abuse: "invalid",
  disposable: "invalid",
  risky: "risky",
  role: "risky",
  role_based: "risky",
  "catch-all": "unknown",
  catch_all: "unknown",
  accept_all: "unknown",
  unknown: "unknown",
};

export class HttpEmailVerifier extends RealVendorBase implements EmailVerifier {
  private readonly cfg: Required<Omit<HttpVerifierConfig, "fetchImpl" | "statusMap">> & {
    fetchImpl: FetchLike;
    statusMap: Record<string, VerificationVerdict>;
  };

  constructor(config: HttpVerifierConfig) {
    super(config.vendorId);
    this.cfg = {
      vendorId: config.vendorId,
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      apiKeyParam: config.apiKeyParam ?? "api_key",
      emailParam: config.emailParam ?? "email",
      statusField: config.statusField ?? "status",
      statusMap: { ...DEFAULT_STATUS_MAP, ...(config.statusMap ?? {}) },
      fetchImpl: config.fetchImpl ?? globalFetch,
      timeoutMs: config.timeoutMs ?? 5000,
    };
  }

  /**
   * ⛔ Every failure path returns `unknown`, never `valid` and never a throw.
   *
   * A verifier outage must not stop the send programme, and it must not silently
   * approve the list either. `unknown` is what the gate's own rule decides on,
   * so the policy for "we could not check" lives in one place instead of being
   * implied by an exception here.
   */
  async verify(email: string): Promise<VerificationVerdict> {
    const url = new URL(this.cfg.endpoint);
    url.searchParams.set(this.cfg.apiKeyParam, this.cfg.apiKey);
    url.searchParams.set(this.cfg.emailParam, email);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.cfg.fetchImpl(url.toString(), {
        method: "GET",
        signal: controller.signal,
      } as Parameters<FetchLike>[1]);
      if (res.status !== 200) return "unknown";
      const parsed: unknown = JSON.parse(await res.text());
      if (typeof parsed !== "object" || parsed === null) return "unknown";
      const status = (parsed as Record<string, unknown>)[this.cfg.statusField];
      if (typeof status !== "string") return "unknown";
      return this.cfg.statusMap[status.toLowerCase().trim()] ?? "unknown";
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  }

  protected override async probeOperation(): Promise<string> {
    // A known-invalid address is the right probe: it traverses auth and the
    // production path, and a vendor answering "valid" for it is broken in the
    // one direction that costs us a domain.
    const verdict = await this.verify("definitely-not-a-mailbox@adw-probe.invalid");
    if (verdict === "valid") throw new Error("verifier called a reserved invalid address valid");
    return `verdict ${verdict}`;
  }
}

/**
 * Free checks first, paid vendor second.
 *
 * ⛔ The order is the point, and it is not only about money. The local checks
 * settle the cases a vendor is worst at — a role account is `risky` by
 * definition, not by probability, and several vendors happily return `valid`
 * for `info@`. Asking the vendor first and trusting it would import that
 * mistake at 0.7 cents an address.
 */
export class LayeredEmailVerifier implements EmailVerifier {
  readonly vendorId: string;

  constructor(
    private readonly remote: EmailVerifier | null,
    private readonly localOpts: LocalVerifierOptions = {},
  ) {
    this.vendorId = remote?.vendorId ?? "local_only";
  }

  async verify(email: string): Promise<VerificationVerdict> {
    const local = await verifyLocally(email, this.localOpts);
    // Anything the free checks can settle is settled. `unknown` from the local
    // pass means "nothing is structurally wrong", which is exactly the case
    // worth paying for.
    if (local.verdict !== "unknown") return local.verdict;
    if (this.remote === null) return "unknown";
    return this.remote.verify(email);
  }
}
