// One-click unsubscribe (RFC 8058, CAN-SPAM §316.5, Gmail/Yahoo bulk-sender
// requirements). The Compliance Gate refuses to let a cold message through
// without `List-Unsubscribe` and `List-Unsubscribe-Post` headers — this module
// is what makes the URL in those headers mean something.
//
// Design constraints that are not negotiable:
//   • The link must work forever. A recipient who unsubscribes eighteen months
//     after the send must still be suppressed, so tokens carry no expiry.
//   • No session, no login, no confirmation step. RFC 8058 mailbox providers
//     POST the URL unattended; anything that returns non-2xx or demands a
//     second click is treated as a broken unsubscribe by Gmail.
//   • Forging a token can only ever *add* suppression, which is the safe
//     direction — but tokens are still signed so the address space cannot be
//     enumerated by walking contact ids.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubscribeToken {
  /** contacts.id — the row whose email_hash gets suppressed. */
  contactId: string;
  /** Campaign the message belonged to; recorded for reporting, not for scope. */
  campaignId?: string;
}

/** Token version prefix, so the signing scheme can be rotated without breaking old links. */
const VERSION = "u1";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function b64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function b64urlDecode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Mint an opaque unsubscribe token. The payload is readable by anyone holding
 * the link (it is a contact id, not a secret); the signature is what stops it
 * being fabricated.
 */
export function mintUnsubscribeToken(token: UnsubscribeToken, secret: string): string {
  const body = `${VERSION}.${b64urlEncode(JSON.stringify(token))}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify and decode a token. Returns null for anything that does not verify —
 * the route must treat that as "not found", never as "unsubscribe everyone".
 */
export function verifyUnsubscribeToken(raw: string, secret: string): UnsubscribeToken | null {
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [version, encoded, signature] = parts as [string, string, string];
  if (version !== VERSION) return null;

  const expected = sign(`${version}.${encoded}`, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const json = b64urlDecode(encoded);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate["contactId"] !== "string" || candidate["contactId"].length === 0) return null;
  const campaignId = candidate["campaignId"];
  return {
    contactId: candidate["contactId"],
    ...(typeof campaignId === "string" ? { campaignId } : {}),
  };
}

/**
 * The URL that goes in the headers and in the plain-text footer. `base` must be
 * an origin on the email_links allowlist (config/allowlists.yaml) — the same URL
 * is used for the human link and the machine POST, per RFC 8058 §3.
 */
export function unsubscribeUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/u/${token}`;
}

/**
 * The two headers the gate's `one_click_unsubscribe` obligation checks for.
 * `List-Unsubscribe-Post` is a fixed literal — a mailbox provider matches it
 * byte-for-byte, and a paraphrase silently disables one-click.
 */
export function unsubscribeHeaders(url: string): {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": string;
} {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * The signing secret. Distinct from the session and webhook secrets so that a
 * leak of one does not let an attacker mint the others. Falls back only outside
 * production — the same posture as the vault master key.
 */
export function unsubscribeSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env["ADW_UNSUBSCRIBE_SECRET"];
  if (secret && secret.length >= 16) return secret;
  const mode = env["ADW_ENV"] ?? "production";
  if (mode === "local" || mode === "test") return "local-unsubscribe-secret";
  throw new Error(
    "Refusing to start: ADW_UNSUBSCRIBE_SECRET is unset or too short. " +
      "Every cold email carries an unsubscribe link signed with it; without a stable " +
      "secret, previously-sent links stop verifying and unsubscribes silently fail.",
  );
}
