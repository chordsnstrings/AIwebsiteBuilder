// REAL SiteHost against Cloudflare Pages (API v4). This is the adapter that
// makes "deposit a Cloudflare token and the site actually goes live" true; with
// no token in the vault the resolver never constructs it and MockSiteHost is
// used instead.
//
// The mock's contract is the spec, not a convenience: deployment is
// CONTENT-ADDRESSED. sha256 over the canonicalised file set IS the version, so
// redeploying byte-identical content is a no-op and rollback is repointing at a
// hash that is still on the vendor's side. This adapter preserves both:
//   - the hash is carried to Cloudflare as the deployment's commit message, so
//     idempotency survives a process restart (we can read back what is live);
//   - deploy() returns `created: false` without uploading anything when the live
//     deployment already carries the same hash.
//
// Vault: cloudflare/api_token, cloudflare/account_id, cloudflare/pages_project.
import { sha256Hex } from "../health.ts";
import { RealVendorBase } from "../real-base.ts";
import { assertOk, globalFetch, readBody, VendorHttpError, type FetchLike } from "../http.ts";
import type { DeployResult, SiteHost } from "./types.ts";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Prefix that tags a deployment with the content hash it was built from. */
export const CONTENT_MARKER = "adw-content:";

export interface CloudflarePagesConfig {
  apiToken: string;
  accountId: string;
  projectName: string;
  /** Override for tests and for Cloudflare's regional API hosts. */
  baseUrl?: string;
  /** Injectable HTTP seam; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/** The envelope every Cloudflare v4 endpoint returns. */
interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: T;
}

interface CfDeployment {
  id: string;
  url?: string;
  deployment_trigger?: { metadata?: { commit_message?: string } };
}

function guessContentType(path: string): string {
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export class CloudflarePagesHost extends RealVendorBase implements SiteHost {
  /** url → content hash we last observed live. A cache, never the source of truth. */
  private readonly liveHash = new Map<string, string>();
  /** content hash → Cloudflare deployment id, so rollback can find the target. */
  private readonly deploymentIds = new Map<string, string>();

  constructor(private readonly cfg: CloudflarePagesConfig) {
    super("cloudflare");
  }

  /**
   * The version identity of a file set: order-independent, whitespace-exact.
   * Same canonicalisation as MockSiteHost.contentHash, widened to a full sha256
   * because this hash is also the deployment's identity on the vendor side.
   */
  static contentHash(files: Record<string, string>): string {
    const canonical = Object.keys(files)
      .sort()
      .map((k) => `${k} ${files[k] ?? ""}`)
      .join("");
    return sha256Hex(`site ${canonical}`);
  }

  async deploy(artifactKey: string, files: Record<string, string>): Promise<DeployResult> {
    if (Object.keys(files).length === 0) throw new Error("deploy requires at least one file");
    const contentHash = CloudflarePagesHost.contentHash(files);

    // 1. Process-local answer: we already know this exact content is live.
    const cachedUrl = this.urlForCachedHash(contentHash);
    if (cachedUrl !== null) return { url: cachedUrl, contentHash, created: false };

    // 2. Vendor-side answer: the newest deployment already carries this hash.
    const latest = await this.latestDeployment();
    if (latest && this.hashOf(latest) === contentHash) {
      const url = latest.url ?? this.projectUrl();
      this.remember(url, contentHash, latest.id);
      return { url, contentHash, created: false };
    }

    // 3. Nothing live matches — upload. The boundary is derived from the content
    //    hash so an identical bundle produces a byte-identical request.
    const boundary = `----adw${contentHash.slice(0, 24)}`;
    const body = this.multipartBody(boundary, artifactKey, files, contentHash);
    const res = await this.http(`${this.projectPath()}/deployments`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const deployment = await this.unwrap<CfDeployment>(res);
    const url = deployment.url ?? this.projectUrl();
    this.remember(url, contentHash, deployment.id);
    return { url, contentHash, created: true };
  }

  /** Fetch the deployed document. A 404 is "nothing there", not an error. */
  async fetch(url: string): Promise<string | null> {
    const send = this.cfg.fetchImpl ?? globalFetch;
    const res = await send(url, { method: "GET" });
    if (res.status === 404) return null;
    await assertOk(this.vendorId, res);
    return res.text();
  }

  /**
   * Repoint the URL at a hash that is still on Cloudflare's side. Nothing is
   * rebuilt — this is why content addressing is worth the bookkeeping.
   */
  async rollback(url: string, hash: string): Promise<void> {
    const deploymentId = this.deploymentIds.get(hash) ?? (await this.findDeploymentByHash(hash));
    if (deploymentId === undefined) throw new Error(`unknown content hash ${hash}`);
    const res = await this.http(`${this.projectPath()}/deployments/${deploymentId}/rollback`, {
      method: "POST",
    });
    await this.unwrap<CfDeployment>(res);
    this.remember(url, hash, deploymentId);
  }

  /** The content hash currently live at a URL, as far as this process knows. */
  liveContentHash(url: string): string | null {
    return this.liveHash.get(url) ?? null;
  }

  // --- internals -----------------------------------------------------------

  private projectPath(): string {
    return `/accounts/${this.cfg.accountId}/pages/projects/${this.cfg.projectName}`;
  }

  private projectUrl(): string {
    return `https://${this.cfg.projectName}.pages.dev`;
  }

  private urlForCachedHash(contentHash: string): string | null {
    for (const [url, hash] of this.liveHash) {
      if (hash === contentHash) return url;
    }
    return null;
  }

  private remember(url: string, contentHash: string, deploymentId: string): void {
    this.liveHash.set(url, contentHash);
    this.deploymentIds.set(contentHash, deploymentId);
  }

  private hashOf(deployment: CfDeployment): string | null {
    const message = deployment.deployment_trigger?.metadata?.commit_message ?? "";
    return message.startsWith(CONTENT_MARKER) ? message.slice(CONTENT_MARKER.length) : null;
  }

  private async latestDeployment(): Promise<CfDeployment | null> {
    const res = await this.http(`${this.projectPath()}/deployments?per_page=1`, { method: "GET" });
    const list = await this.unwrap<CfDeployment[]>(res);
    return list[0] ?? null;
  }

  private async findDeploymentByHash(hash: string): Promise<string | undefined> {
    const res = await this.http(`${this.projectPath()}/deployments?per_page=25`, { method: "GET" });
    const list = await this.unwrap<CfDeployment[]>(res);
    return list.find((d) => this.hashOf(d) === hash)?.id;
  }

  /**
   * Direct-upload multipart body. The `manifest` part maps each path to its own
   * sha256 (Cloudflare's dedupe unit) and the bundle hash rides in
   * `commit_message` so a later deploy can recognise identical content.
   */
  private multipartBody(
    boundary: string,
    artifactKey: string,
    files: Record<string, string>,
    contentHash: string,
  ): string {
    const paths = Object.keys(files).sort();
    const manifest: Record<string, string> = {};
    for (const path of paths) manifest[`/${path}`] = sha256Hex(files[path] ?? "");

    const parts: string[] = [];
    const field = (name: string, value: string): void => {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    };
    field("manifest", JSON.stringify(manifest));
    field("branch", "main");
    field("commit_message", `${CONTENT_MARKER}${contentHash}`);
    field("commit_dirty", "false");
    field("artifact_key", artifactKey);
    for (const path of paths) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${path}"\r\n` +
          `Content-Type: ${guessContentType(path)}\r\n\r\n` +
          `${files[path] ?? ""}\r\n`,
      );
    }
    parts.push(`--${boundary}--\r\n`);
    return parts.join("");
  }

  private http(path: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
    const send = this.cfg.fetchImpl ?? globalFetch;
    return send(`${this.cfg.baseUrl ?? CLOUDFLARE_API_BASE}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${this.cfg.apiToken}`, ...(init.headers ?? {}) },
      body: init.body,
    });
  }

  /**
   * Cloudflare answers 200 with `success: false` for some failures, so a status
   * check alone is not enough — both are treated as the same error.
   */
  private async unwrap<T>(res: Awaited<ReturnType<FetchLike>>): Promise<T> {
    const { text, json } = await readBody(res);
    if (!res.ok) throw new VendorHttpError(this.vendorId, res.status, text);
    const env = json as CfEnvelope<T> | undefined;
    if (!env?.success) {
      const detail = env?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? text;
      throw new VendorHttpError(this.vendorId, res.status, detail);
    }
    return env.result as T;
  }

  /** Cheapest call that still proves the token, the account and the project. */
  protected override async probeOperation(): Promise<string> {
    const res = await this.http(this.projectPath(), { method: "GET" });
    const project = await this.unwrap<{ name?: string }>(res);
    return `pages project ${project.name ?? this.cfg.projectName} reachable`;
  }
}
