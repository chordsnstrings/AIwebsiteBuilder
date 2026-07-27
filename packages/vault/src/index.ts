// The vault. Credentials are deposited directly by a human and stored
// envelope-encrypted. Agents and the orchestrator hold opaque CredentialRefs,
// never secret material. Resolution happens only at call time inside vendor
// adapters, through this module. A credential can be deposited and rotated but
// the vault can never mint one (spec §74.4).
import type { Db } from "@adw/db";
import { getDb } from "@adw/db";
import { fingerprint, LocalKeyWrapper, open, seal, type KeyWrapper } from "./crypto.ts";

export type CredentialRef = `cred:${string}:${string}@v${number}`;

export function makeRef(vendorId: string, keyName: string, version: number): CredentialRef {
  return `cred:${vendorId}:${keyName}@v${version}`;
}

export function parseRef(ref: CredentialRef): { vendorId: string; keyName: string; version: number } {
  const m = /^cred:([^:]+):([^@]+)@v(\d+)$/.exec(ref);
  if (!m) throw new Error(`Invalid CredentialRef: ${ref}`);
  return { vendorId: m[1]!, keyName: m[2]!, version: Number(m[3]) };
}

export interface CredentialSummary {
  vendorId: string;
  keyName: string;
  version: number;
  fingerprint: string;
  expiresAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
  ref: CredentialRef;
}

export interface SecretsBackend {
  /** Deposit a secret. Returns the ref. The plaintext never leaves this call. */
  put(vendorId: string, keyName: string, secret: string, opts?: { expiresAt?: Date }): Promise<CredentialRef>;
  /** Resolve a ref to its secret. Called only inside vendor adapters. */
  resolve(ref: CredentialRef): Promise<string>;
  /** Whether a live credential exists for this vendor+key (drives mock vs real). */
  has(vendorId: string, keyName: string): Promise<boolean>;
  /** Metadata only — never plaintext. Powers the write-only settings UI. */
  list(vendorId?: string): Promise<CredentialSummary[]>;
  /** Record a rotation request; the human completes the actual rotation. */
  requestRotation(vendorId: string, keyName: string, actor: string): Promise<void>;
}

export class LocalPgBackend implements SecretsBackend {
  constructor(
    private readonly db: Db,
    private readonly wrapper: KeyWrapper,
  ) {}

  async put(
    vendorId: string,
    keyName: string,
    secret: string,
    opts: { expiresAt?: Date } = {},
  ): Promise<CredentialRef> {
    const aad = `${vendorId}:${keyName}`;
    const sealed = seal(secret, aad, this.wrapper);
    // Store tag appended to ciphertext (GCM tag is 16 bytes).
    const stored = Buffer.concat([sealed.tag, sealed.ciphertext]);
    const prev = await this.db.maybeOne<{ version: number }>(
      "SELECT max(version) AS version FROM vault_credentials WHERE vendor_id=$1 AND key_name=$2",
      [vendorId, keyName],
    );
    const version = (prev?.version ?? 0) + 1;
    await this.db.query(
      `INSERT INTO vault_credentials
        (vendor_id, key_name, version, dek_wrapped, ciphertext, nonce, aad, fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        vendorId,
        keyName,
        version,
        sealed.dekWrapped,
        stored,
        sealed.nonce,
        aad,
        fingerprint(secret),
        opts.expiresAt ?? null,
      ],
    );
    await this.db.query(
      "INSERT INTO vault_access_log (vendor_id, key_name, action, actor) VALUES ($1,$2,'deposit',$3)",
      [vendorId, keyName, "human"],
    );
    return makeRef(vendorId, keyName, version);
  }

  async resolve(ref: CredentialRef): Promise<string> {
    const { vendorId, keyName, version } = parseRef(ref);
    const row = await this.db.maybeOne<{
      dek_wrapped: Buffer;
      ciphertext: Buffer;
      nonce: Buffer;
      aad: string;
    }>(
      "SELECT dek_wrapped, ciphertext, nonce, aad FROM vault_credentials WHERE vendor_id=$1 AND key_name=$2 AND version=$3",
      [vendorId, keyName, version],
    );
    if (!row) throw new Error(`Credential not found: ${ref}`);
    const tag = row.ciphertext.subarray(0, 16);
    const ciphertext = row.ciphertext.subarray(16);
    const secret = open(
      { dekWrapped: row.dek_wrapped, ciphertext, nonce: row.nonce, tag },
      row.aad,
      this.wrapper,
    );
    await this.db.query(
      "INSERT INTO vault_access_log (vendor_id, key_name, action, actor) VALUES ($1,$2,'resolve',$3)",
      [vendorId, keyName, "adapter"],
    );
    return secret;
  }

  async has(vendorId: string, keyName: string): Promise<boolean> {
    const row = await this.db.maybeOne(
      "SELECT 1 AS x FROM vault_credentials WHERE vendor_id=$1 AND key_name=$2",
      [vendorId, keyName],
    );
    return row !== null;
  }

  async list(vendorId?: string): Promise<CredentialSummary[]> {
    const rows = await this.db.query<{
      vendor_id: string;
      key_name: string;
      version: number;
      fingerprint: string;
      expires_at: string | null;
      rotated_at: string | null;
      created_at: string;
    }>(
      `SELECT DISTINCT ON (vendor_id, key_name)
         vendor_id, key_name, version, fingerprint, expires_at, rotated_at, created_at
       FROM vault_credentials
       ${vendorId ? "WHERE vendor_id = $1" : ""}
       ORDER BY vendor_id, key_name, version DESC`,
      vendorId ? [vendorId] : [],
    );
    return rows.rows.map((r) => ({
      vendorId: r.vendor_id,
      keyName: r.key_name,
      version: r.version,
      fingerprint: r.fingerprint,
      expiresAt: r.expires_at,
      rotatedAt: r.rotated_at,
      createdAt: r.created_at,
      ref: makeRef(r.vendor_id, r.key_name, r.version),
    }));
  }

  async requestRotation(vendorId: string, keyName: string, actor: string): Promise<void> {
    await this.db.query(
      "INSERT INTO vault_access_log (vendor_id, key_name, action, actor) VALUES ($1,$2,'rotate_request',$3)",
      [vendorId, keyName, actor],
    );
  }
}

let backend: SecretsBackend | null = null;

export async function getVault(): Promise<SecretsBackend> {
  if (!backend) {
    const db = await getDb();
    backend = new LocalPgBackend(db, new LocalKeyWrapper());
  }
  return backend;
}

export function setVaultForTesting(b: SecretsBackend | null): void {
  backend = b;
}

export { fingerprint, LocalKeyWrapper } from "./crypto.ts";
export type { KeyWrapper } from "./crypto.ts";
