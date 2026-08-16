// Authenticating inbound webhooks, per provider, the way the provider actually
// signs them.
//
// ⛔ This replaces a shared-secret HMAC in an `x-adw-signature` header. That
// scheme was internally consistent, verified in tests, and documented as
// "signature-verified" — and no vendor on earth sends that header. Every real
// SNS bounce notification and every real Stripe event was answered with 401,
// while the effects module behind it passed its own tests by being called
// directly. The endpoint reported success and detected nothing.
//
// The lesson generalises: a signature check you invented is a signature check
// that only ever authenticates you.
//
// Two schemes are implemented because two vendors matter:
//
//   AWS SNS     RSA-SHA1 (v1) or RSA-SHA256 (v2) over a canonical field list,
//               against a certificate fetched from a URL IN THE MESSAGE. That
//               last part is the whole security problem — see `assertSigningUrl`.
//   Stripe      HMAC-SHA256 over `<timestamp>.<raw body>`, with a tolerance
//               window so a captured request cannot be replayed forever.

import { createHmac, createVerify, timingSafeEqual } from "node:crypto";
import { globalFetch, type FetchLike } from "./http.ts";

export type WebhookVerdict =
  | { ok: true; kind: "event" }
  /** SNS asks us to confirm a subscription by fetching a URL it supplies. */
  | { ok: true; kind: "subscription_confirmation"; subscribeUrl: string }
  | { ok: false; reason: string };

/**
 * Hosts a signing certificate may be fetched from.
 *
 * ⛔ Without this the scheme is worse than no scheme. An attacker posts a
 * message they signed themselves and sets `SigningCertURL` to their own server;
 * verification passes against their certificate and they can suppress any
 * contact or forge any delivery event. The URL is attacker-controlled input
 * that the algorithm asks you to trust, so the allowlist IS the control.
 */
const SNS_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/** Fields SNS signs, in order, per message type. Order is part of the string. */
const SNS_SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

export interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  Token?: string;
  SubscribeURL?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
}

/**
 * The exact bytes SNS signed: `Field\nValue\n` for each present signed field.
 *
 * ⛔ A field absent from the message is SKIPPED, not emitted empty. `Subject` is
 * optional on a Notification, and emitting `Subject\n\n` for a message that had
 * none produces a different string and a verification failure on perfectly good
 * traffic — which would look exactly like an attack.
 */
export function snsStringToSign(msg: SnsEnvelope): string {
  const fields = SNS_SIGNED_FIELDS[msg.Type ?? ""];
  if (fields === undefined) throw new Error(`unknown SNS message type "${msg.Type}"`);
  let out = "";
  for (const f of fields) {
    const value = (msg as Record<string, unknown>)[f];
    if (value === undefined || value === null) continue;
    out += `${f}\n${String(value)}\n`;
  }
  return out;
}

/** ⛔ The certificate URL must be HTTPS and on an Amazon SNS host. */
export function assertSigningUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SigningCertURL is not a URL");
  }
  if (parsed.protocol !== "https:") throw new Error("SigningCertURL is not https");
  if (!SNS_CERT_HOST.test(parsed.hostname)) {
    throw new Error(`SigningCertURL host "${parsed.hostname}" is not an SNS certificate host`);
  }
  return parsed;
}

/**
 * Certificates change rarely and a bounce storm is exactly when you do not want
 * one outbound fetch per notification. Cached by URL, with a ceiling so a
 * malformed-but-allowlisted URL cannot grow the map without bound.
 */
const certCache = new Map<string, string>();
const CERT_CACHE_MAX = 32;

export async function fetchSigningCert(url: string, fetchImpl: FetchLike = globalFetch): Promise<string> {
  const cached = certCache.get(url);
  if (cached !== undefined) return cached;
  const parsed = assertSigningUrl(url);
  const res = await fetchImpl(parsed.toString(), { method: "GET" });
  if (res.status !== 200) throw new Error(`signing certificate fetch returned ${res.status}`);
  const pem = await res.text();
  if (!pem.includes("BEGIN CERTIFICATE")) throw new Error("signing certificate is not PEM");
  if (certCache.size >= CERT_CACHE_MAX) certCache.clear();
  certCache.set(url, pem);
  return pem;
}

/** Test seam only — the cache is process-lifetime otherwise. */
export function clearCertCache(): void {
  certCache.clear();
}

export interface SnsVerifyOptions {
  fetchImpl?: FetchLike;
  /** Topic ARNs this deployment accepts. Empty means any, which is only
   *  acceptable in demo mode — a valid signature from SOMEONE ELSE'S topic is
   *  still a valid signature. */
  allowedTopicArns?: string[];
}

export async function verifySns(msg: SnsEnvelope, opts: SnsVerifyOptions = {}): Promise<WebhookVerdict> {
  if (msg.Signature === undefined || msg.SigningCertURL === undefined) {
    return { ok: false, reason: "SNS message is unsigned" };
  }
  const allowed = opts.allowedTopicArns ?? [];
  if (allowed.length > 0 && (msg.TopicArn === undefined || !allowed.includes(msg.TopicArn))) {
    return { ok: false, reason: `SNS topic ${msg.TopicArn ?? "(none)"} is not one of ours` };
  }
  // SignatureVersion 1 is RSA-SHA1; 2 is RSA-SHA256. Both are live in the wild.
  const algo = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  let pem: string;
  let payload: string;
  try {
    payload = snsStringToSign(msg);
    pem = await fetchSigningCert(msg.SigningCertURL, opts.fetchImpl);
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err) };
  }
  const verifier = createVerify(algo);
  verifier.update(payload, "utf8");
  let valid = false;
  try {
    valid = verifier.verify(pem, msg.Signature, "base64");
  } catch {
    return { ok: false, reason: "signature could not be checked against the certificate" };
  }
  if (!valid) return { ok: false, reason: "SNS signature does not match" };

  if (msg.Type === "SubscriptionConfirmation") {
    if (msg.SubscribeURL === undefined) return { ok: false, reason: "SubscriptionConfirmation without SubscribeURL" };
    // ⛔ The confirmation URL is checked against the same allowlist. Confirming
    // a subscription is what wires a topic to this endpoint permanently.
    try {
      assertSigningUrl(msg.SubscribeURL);
    } catch {
      return { ok: false, reason: "SubscribeURL is not an SNS host" };
    }
    return { ok: true, kind: "subscription_confirmation", subscribeUrl: msg.SubscribeURL };
  }
  return { ok: true, kind: "event" };
}

/** Five minutes, matching Stripe's own recommendation. */
export const STRIPE_TOLERANCE_SECONDS = 300;

/**
 * Stripe's `Stripe-Signature`: `t=<unix>,v1=<hex>,v1=<hex>`.
 *
 * Multiple `v1` values appear during a secret rotation and ANY may match. The
 * timestamp is inside the signed payload, so an attacker cannot replay an old
 * body with a fresh timestamp — which is the entire reason it is signed rather
 * than merely sent.
 */
export function verifyStripe(raw: string, header: string, secret: string, nowSeconds: number): WebhookVerdict {
  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const idx = piece.indexOf("=");
    if (idx < 0) continue;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const t = parts.get("t")?.[0];
  const sigs = parts.get("v1") ?? [];
  if (t === undefined || sigs.length === 0) return { ok: false, reason: "malformed Stripe-Signature" };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: "Stripe-Signature timestamp is not a number" };
  if (Math.abs(nowSeconds - ts) > STRIPE_TOLERANCE_SECONDS) {
    return { ok: false, reason: `Stripe-Signature timestamp is ${Math.round(Math.abs(nowSeconds - ts))}s outside tolerance` };
  }
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const matched = sigs.some((s) => {
    const b = Buffer.from(s, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
  return matched ? { ok: true, kind: "event" } : { ok: false, reason: "Stripe signature does not match" };
}

/**
 * The shared-secret scheme, kept for our OWN simulators and for any provider
 * that genuinely lets you choose a secret.
 *
 * ⛔ It is not a fallback. A provider whose scheme is unimplemented must be
 * rejected, not waved through on a header it never sends — an unknown provider
 * that omits `x-adw-signature` would otherwise be compared against an empty
 * string and, if the comparison were ever loosened, admitted.
 */
export function verifySharedSecret(raw: string, signature: string, secret: string): WebhookVerdict {
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { ok: true, kind: "event" } : { ok: false, reason: "shared-secret signature does not match" };
}
