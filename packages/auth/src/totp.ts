// RFC 6238 TOTP on node:crypto HMAC — mandatory for the superadmin operator.
// ~40 lines, no dependency, verified against the RFC test vectors in the tests.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  periodSec?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

/** Generate the TOTP code for a secret at a given unix time (seconds). */
export function totp(secret: string, unixSeconds: number, opts: TotpOptions = {}): string {
  const digits = opts.digits ?? 6;
  const period = opts.periodSec ?? 30;
  const algorithm = opts.algorithm ?? "sha1";
  const counter = Math.floor(unixSeconds / period);

  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac(algorithm, base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

/**
 * Verify a submitted code, allowing a ±1 step window for clock drift.
 * Constant-time comparison; never short-circuits on the first matching step.
 */
export function verifyTotp(
  secret: string,
  submitted: string,
  unixSeconds: number,
  opts: TotpOptions & { window?: number } = {},
): boolean {
  const window = opts.window ?? 1;
  const period = opts.periodSec ?? 30;
  let ok = false;
  for (let step = -window; step <= window; step++) {
    const expected = totp(secret, unixSeconds + step * period, opts);
    const a = Buffer.from(expected);
    const b = Buffer.from(submitted.padEnd(expected.length, "\0").slice(0, expected.length));
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

/** otpauth:// URI for enrolment (rendered as a QR in the ops Settings page). */
export function otpauthUri(secret: string, account: string, issuer = "ADW"): string {
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`;
}
