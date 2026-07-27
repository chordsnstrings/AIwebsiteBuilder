// REAL ObjectStore against Cloudflare R2 over its S3-compatible endpoint,
// signed with the hand-rolled SigV4 in ../aws-sigv4.ts. R2 is S3 on the wire but
// region-less: it wants the literal region "auto" and service "s3".
//
// R2 uses its own access key pair, NOT the Cloudflare API token, which is why
// the vault carries cloudflare/r2_access_key_id + cloudflare/r2_secret_access_key
// alongside cloudflare/api_token.
//
// Vault: cloudflare/account_id, cloudflare/r2_access_key_id,
//        cloudflare/r2_secret_access_key, cloudflare/r2_bucket.
import { sha256Hex } from "../health.ts";
import { RealVendorBase } from "../real-base.ts";
import { assertOk, globalFetch, rfc3986, type FetchLike } from "../http.ts";
import { signRequestV4, withoutHostHeader, type SigV4Credentials } from "../aws-sigv4.ts";
import type { ObjectStore, PutResult } from "./types.ts";

/** R2 is region-less; SigV4 still requires a region string. */
export const R2_REGION = "auto";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Override the `https://{accountId}.r2.cloudflarestorage.com` endpoint. */
  endpoint?: string;
  fetchImpl?: FetchLike;
  /** Signing instant override. Tests pin it; production reads the clock. */
  now?: () => Date;
}

export class R2ObjectStore extends RealVendorBase implements ObjectStore {
  constructor(private readonly cfg: R2Config) {
    super("cloudflare");
  }

  async put(key: string, data: Buffer): Promise<PutResult> {
    if (key.trim() === "") throw new Error("object key is required");
    const res = await this.send("PUT", this.objectUrl(key), data, {
      "content-type": "application/octet-stream",
      "content-length": String(data.length),
    });
    await assertOk(this.vendorId, res);
    // R2 echoes the MD5 etag; the caller's contract is a content hash it can
    // compare, so fall back to sha256 of what we actually wrote.
    const etag = (res.headers.get("etag") ?? "").replace(/^(W\/)?"|"$/g, "");
    return { key, etag: etag.length > 0 ? etag : sha256Hex(data), size: data.length };
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send("GET", this.objectUrl(key), "");
    if (res.status === 404) return null;
    await assertOk(this.vendorId, res);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * S3 DELETE is unconditionally 204, so it cannot answer "did this exist?".
   * The ObjectStore contract does answer that, so probe with HEAD first. Two
   * round trips is the price of an honest boolean.
   */
  async delete(key: string): Promise<boolean> {
    const head = await this.send("HEAD", this.objectUrl(key), "");
    if (head.status === 404) return false;
    await assertOk(this.vendorId, head);
    const res = await this.send("DELETE", this.objectUrl(key), "");
    if (res.status === 404) return false;
    await assertOk(this.vendorId, res);
    return true;
  }

  /** ListObjectsV2, following continuation tokens. Keys come back sorted. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    // Bounded so a pathological bucket cannot spin forever.
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${this.endpoint()}/${rfc3986(this.cfg.bucket)}`);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", "1000");
      if (token !== undefined) url.searchParams.set("continuation-token", token);

      const res = await this.send("GET", url.toString(), "");
      await assertOk(this.vendorId, res);
      const xml = await res.text();
      for (const key of xmlAll(xml, "Key")) keys.push(key);
      const truncated = xmlFirst(xml, "IsTruncated") === "true";
      token = truncated ? xmlFirst(xml, "NextContinuationToken") : undefined;
      if (token === undefined) break;
    }
    return keys.sort();
  }

  // --- internals -----------------------------------------------------------

  private endpoint(): string {
    return this.cfg.endpoint ?? `https://${this.cfg.accountId}.r2.cloudflarestorage.com`;
  }

  private objectUrl(key: string): string {
    const path = key.split("/").map(rfc3986).join("/");
    return `${this.endpoint()}/${rfc3986(this.cfg.bucket)}/${path}`;
  }

  private credentials(): SigV4Credentials {
    return { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey };
  }

  private send(
    method: string,
    url: string,
    body: string | Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const signed = signRequestV4(
      { method, url, region: R2_REGION, service: "s3", headers, body, now: this.cfg.now?.() },
      this.credentials(),
    );
    const send = this.cfg.fetchImpl ?? globalFetch;
    // A GET/HEAD/DELETE carries no body; passing "" would still be signed as the
    // empty payload, which is what the signature above already assumes.
    const hasBody = method === "PUT" || method === "POST";
    return send(url, {
      method,
      headers: withoutHostHeader(signed.headers),
      body: hasBody ? body : undefined,
    });
  }

  /** A signed list against an unlikely prefix: cheap, and it exercises auth. */
  protected override async probeOperation(): Promise<string> {
    const keys = await this.list("__adw_probe__/");
    return `r2 list ok (${keys.length} keys under probe prefix)`;
  }
}

/** Every text value of a repeated XML element. S3 list responses are flat. */
function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let m = re.exec(xml);
  while (m !== null) {
    out.push(decodeXml(m[1] ?? ""));
    m = re.exec(xml);
  }
  return out;
}

function xmlFirst(xml: string, tag: string): string | undefined {
  return xmlAll(xml, tag)[0];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
