// Choosing a signature scheme by provider, and refusing when there isn't one.
//
// ⛔ There is no default-allow branch here. The previous route verified every
// provider against a shared secret in an `x-adw-signature` header — a scheme
// this codebase invented and no vendor sends — so every genuine SNS bounce and
// every genuine Stripe event was answered 401 while the tests, which called the
// effects module directly, stayed green. The bounce detector existed and could
// not be reached.
//
// Which means the failure mode to design against is not "an attacker gets in".
// It is "we believe we are verifying and are in fact discarding". So an
// unrecognised provider is an explicit refusal with a reason, never a fallback.

import { verifySns, verifyStripe, verifySharedSecret, type WebhookVerdict } from "@adw/vendors";

/** Providers whose real signature scheme is implemented. */
const SNS_BACKED = new Set(["aws_ses", "aws_sns", "ses"]);
const STRIPE_BACKED = new Set(["stripe"]);
/** Our own simulators, which sign with a secret because we chose it. */
const SIMULATED = new Set(["mock", "sim", "demo"]);

export interface WebhookAuthDeps {
  /** Fake clock for tests; seconds since epoch. */
  nowSeconds?: () => number;
  /** Injected so a test never reaches the network for a certificate. */
  fetchImpl?: Parameters<typeof verifySns>[1] extends { fetchImpl?: infer F } ? F : never;
  allowedTopicArns?: string[];
  /**
   * Whether this process is running against simulators.
   *
   * ⛔ Load-bearing. The shared-secret path exists so the mock rail can post
   * feedback to a real endpoint in demo mode. Left ungated it becomes a second
   * way into a live deployment: anyone holding `ADW_WEBHOOK_SECRET` could sign
   * a "hard bounce" for any address and have it suppressed. In live mode the
   * only accepted signature is the one the vendor actually produces.
   */
  simulated?: boolean;
}

export interface RawWebhook {
  provider: string;
  raw: string;
  header(name: string): string | undefined;
}

/**
 * Authenticate one inbound webhook.
 *
 * Returns the verdict rather than throwing, because the caller needs to
 * distinguish "reject with 401" from "confirm this subscription" — an SNS
 * subscription that is never confirmed delivers nothing, forever, with no error
 * anywhere.
 */
export async function authenticateWebhook(req: RawWebhook, deps: WebhookAuthDeps = {}): Promise<WebhookVerdict> {
  const provider = req.provider.toLowerCase();

  if (SNS_BACKED.has(provider)) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(req.raw) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "SNS payload is not JSON" };
    }
    // In demo mode there is no Amazon and no certificate to fetch. The
    // simulator signs with our secret instead, and says so by using our header
    // — it never claims to be SNS.
    if (msg["SignatureVersion"] === undefined && req.header("x-adw-signature") !== undefined) {
      return simulatorVerdict(req, deps);
    }
    return verifySns(msg, {
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.allowedTopicArns === undefined ? {} : { allowedTopicArns: deps.allowedTopicArns }),
    });
  }

  if (STRIPE_BACKED.has(provider)) {
    const header = req.header("stripe-signature");
    if (header === undefined) {
      // Same demo accommodation, same rule: the simulator must not pretend.
      if (req.header("x-adw-signature") !== undefined) return simulatorVerdict(req, deps);
      return { ok: false, reason: "missing Stripe-Signature" };
    }
    const secret = process.env["STRIPE_WEBHOOK_SECRET"];
    if (secret === undefined || secret.length === 0) {
      // ⛔ Fails closed. A missing secret in production means unverified events,
      // and accepting them would be strictly worse than dropping them.
      return { ok: false, reason: "STRIPE_WEBHOOK_SECRET is not configured" };
    }
    const now = deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    return verifyStripe(req.raw, header, secret, now);
  }

  if (SIMULATED.has(provider)) return simulatorVerdict(req, deps);

  return {
    ok: false,
    reason:
      `no signature scheme is implemented for provider "${req.provider}". Add one in ` +
      "packages/vendors/src/webhook-auth.ts — an unverified webhook is an open write to the suppression ledger.",
  };
}

function simulatorVerdict(req: RawWebhook, deps: WebhookAuthDeps): WebhookVerdict {
  if (deps.simulated !== true) {
    return {
      ok: false,
      reason:
        `provider "${req.provider}" presented a shared-secret signature, which is only accepted ` +
        "against simulators. In live mode the vendor's own scheme is the only one that authenticates.",
    };
  }
  const secret = process.env["ADW_WEBHOOK_SECRET"] ?? "demo-webhook-secret";
  return verifySharedSecret(req.raw, req.header("x-adw-signature") ?? "", secret);
}
