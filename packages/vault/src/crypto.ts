// Envelope encryption on node:crypto (AES-256-GCM). Each secret is encrypted
// with its own random DEK; the DEK is wrapped by the master key. Swapping to a
// real KMS later replaces only the KeyWrapper (unwrap DEKs) — ciphertext never
// needs re-encrypting. Zero native dependencies.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

export interface KeyWrapper {
  wrap(dek: Buffer): Buffer;
  unwrap(wrapped: Buffer): Buffer;
}

/**
 * Is this master key one an attacker could guess? All-zeros is the documented
 * demo key and appears in this repository, in CI config and in the test suite;
 * any single-repeated-byte key is equally weak. Exported so callers can warn
 * before they ever construct a wrapper.
 */
export function isWeakMasterKey(hex: string): boolean {
  const normalised = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalised)) return true;
  // Every byte identical (covers the all-zeros demo key and "ffff…").
  const first = normalised.slice(0, 2);
  return normalised.match(/.{2}/g)!.every((byte) => byte === first);
}

/** Environments where a weak, well-known master key is acceptable. */
function weakKeyPermitted(): boolean {
  const env = process.env.ADW_ENV ?? "production";
  return env === "local" || env === "test";
}

/** Local key wrapper using a 32-byte master key (demo). Replaceable by KMS. */
export class LocalKeyWrapper implements KeyWrapper {
  private readonly masterKey: Buffer;
  constructor(masterKeyHex?: string) {
    const hex = masterKeyHex ?? process.env.ADW_VAULT_MASTER_KEY;
    if (!hex) {
      throw new Error(
        "ADW_VAULT_MASTER_KEY is not set. Run `pnpm vault:init` (demo) or provide a KMS-backed key.",
      );
    }
    this.masterKey = Buffer.from(hex, "hex");
    if (this.masterKey.length !== 32) {
      throw new Error("ADW_VAULT_MASTER_KEY must be 32 bytes (64 hex chars)");
    }
    // Fail closed outside local/test. Encrypting real vendor credentials under a
    // key that ships in this repository would make the vault decorative — and
    // the failure would be silent, because everything else would work.
    if (isWeakMasterKey(hex) && !weakKeyPermitted()) {
      throw new Error(
        `Refusing to start: ADW_VAULT_MASTER_KEY is a well-known demo key and ADW_ENV is "${process.env.ADW_ENV ?? "production"}". ` +
          "Generate a real 32-byte key from your secrets manager. Set ADW_ENV=local only for development.",
      );
    }
  }
  wrap(dek: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.masterKey, nonce);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, ct]);
  }
  unwrap(wrapped: Buffer): Buffer {
    const nonce = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = createDecipheriv(ALGO, this.masterKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

export interface Sealed {
  dekWrapped: Buffer;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export function seal(plaintext: string, aad: string, wrapper: KeyWrapper): Sealed {
  const dek = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, dek, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { dekWrapped: wrapper.wrap(dek), ciphertext: ct, nonce, tag };
}

export function open(sealed: Sealed, aad: string, wrapper: KeyWrapper): string {
  const dek = wrapper.unwrap(sealed.dekWrapped);
  const decipher = createDecipheriv(ALGO, dek, sealed.nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}

/** Non-reversible short fingerprint of a plaintext, for display in the UI. */
export function fingerprint(plaintext: string): string {
  return "sha256:" + createHash("sha256").update(plaintext).digest("hex").slice(0, 12);
}
