// Resolve a non-LLM capability to a live adapter. The exact counterpart of
// llm/resolve.ts: each capability is constructed against the real vendor ONLY
// when its credential exists in the vault; otherwise the process-wide mock from
// registry.ts is returned unchanged.
//
// This is the whole demo↔live boundary for hosting, DNS, storage, email, the
// registrar and payments. Nothing else in the repo branches on "are we live?" —
// a caller asks for a SiteHost and gets one that either deploys to Cloudflare or
// deploys into memory, with the same interface either way.
//
// ---------------------------------------------------------------------------
// VAULT KEYS — the exact (vendorId, keyName) pairs a human deposits
// ---------------------------------------------------------------------------
//  SiteHost (Cloudflare Pages)   cloudflare / api_token            [required]
//                                cloudflare / account_id           [required]
//                                cloudflare / pages_project        [optional, default "adw-sites"]
//  DnsProvider (Cloudflare DNS)  cloudflare / api_token            [required]
//                                cloudflare / zone_id              [required]
//  ObjectStore (Cloudflare R2)   cloudflare / r2_access_key_id     [required]
//                                cloudflare / r2_secret_access_key [required]
//                                cloudflare / account_id           [required]
//                                cloudflare / r2_bucket            [optional, default "adw-artifacts"]
//  EmailTransport (SES)          aws_ses / access_key_id           [required]
//                                aws_ses / secret_access_key       [required]
//                                aws_ses / region                  [optional, default "us-east-1"]
//                                aws_ses / configuration_set       [optional]
//  DomainRegistrar (reseller)    registrar_reseller / api_key      [required]
//                                registrar_reseller / api_user     [required]
//                                registrar_reseller / username     [required]
//                                registrar_reseller / client_ip    [optional, default "127.0.0.1"]
//  PaymentRail (Stripe)          stripe / secret_key               [required]
//                                stripe / webhook_secret           [optional]
//
// Any REQUIRED key missing ⇒ the mock (or null, for payments). A half-deposited
// credential set must not produce a half-live vendor.
import type { SecretsBackend } from "@adw/vault";
import { getDnsProvider, getEmailTransport, getObjectStore, getRegistrar, getSiteHost } from "./registry.ts";
import { CloudflarePagesHost } from "./hosting/real.ts";
import { CloudflareDns } from "./dns/real.ts";
import { R2ObjectStore } from "./storage/real.ts";
import { SesEmailTransport } from "./email/real.ts";
import { NamecheapBackend, ResellerRegistrar } from "./registrar/real.ts";
import { StripeRail } from "./payments/real-stripe.ts";
import type { SiteHost } from "./hosting/types.ts";
import type { DnsProvider } from "./dns/types.ts";
import type { ObjectStore } from "./storage/types.ts";
import type { EmailTransport } from "./email/types.ts";
import type { DomainRegistrar } from "./registrar/types.ts";

export interface ResolveVendorDeps {
  vault: SecretsBackend;
  /** Feature-flag override: stay on mocks even when credentials exist. */
  forceMock?: boolean;
}

/** Vendor ids as they appear in config/vendors.yaml and in the vault. */
export const VENDOR_IDS = {
  cloudflare: "cloudflare",
  ses: "aws_ses",
  registrar: "registrar_reseller",
  stripe: "stripe",
} as const;

/** Machine-readable form of the table above; the Settings UI renders from it. */
export const VENDOR_CREDENTIAL_KEYS = {
  siteHost: { vendorId: "cloudflare", required: ["api_token", "account_id"], optional: ["pages_project"] },
  dns: { vendorId: "cloudflare", required: ["api_token", "zone_id"], optional: [] },
  objectStore: {
    vendorId: "cloudflare",
    required: ["r2_access_key_id", "r2_secret_access_key", "account_id"],
    optional: ["r2_bucket"],
  },
  email: { vendorId: "aws_ses", required: ["access_key_id", "secret_access_key"], optional: ["region", "configuration_set"] },
  registrar: { vendorId: "registrar_reseller", required: ["api_key", "api_user", "username"], optional: ["client_ip"] },
  payments: { vendorId: "stripe", required: ["secret_key"], optional: ["webhook_secret"] },
} as const;

// --- resolvers --------------------------------------------------------------

export async function resolveSiteHost(deps: ResolveVendorDeps): Promise<SiteHost> {
  const cfg = await readAll(deps, VENDOR_CREDENTIAL_KEYS.siteHost);
  if (!cfg) return getSiteHost();
  return new CloudflarePagesHost({
    apiToken: cfg["api_token"] ?? "",
    accountId: cfg["account_id"] ?? "",
    projectName: cfg["pages_project"] ?? "adw-sites",
  });
}

export async function resolveDns(deps: ResolveVendorDeps): Promise<DnsProvider> {
  const cfg = await readAll(deps, VENDOR_CREDENTIAL_KEYS.dns);
  if (!cfg) return getDnsProvider();
  return new CloudflareDns({ apiToken: cfg["api_token"] ?? "", zoneId: cfg["zone_id"] ?? "" });
}

export async function resolveObjectStore(deps: ResolveVendorDeps): Promise<ObjectStore> {
  const cfg = await readAll(deps, VENDOR_CREDENTIAL_KEYS.objectStore);
  if (!cfg) return getObjectStore();
  return new R2ObjectStore({
    accountId: cfg["account_id"] ?? "",
    accessKeyId: cfg["r2_access_key_id"] ?? "",
    secretAccessKey: cfg["r2_secret_access_key"] ?? "",
    bucket: cfg["r2_bucket"] ?? "adw-artifacts",
  });
}

/**
 * Only the brand rail (aws_ses) has a real adapter today. The cold fleet
 * (google_workspace, microsoft_365, cold_smtp) is SMTP and stays on the
 * simulator until its transports are built — asking for one of those returns the
 * mock even if SES credentials are present, rather than silently sending cold
 * mail down the brand rail and burning its reputation.
 */
export async function resolveEmailTransport(vendorId: string, deps: ResolveVendorDeps): Promise<EmailTransport> {
  if (vendorId !== VENDOR_IDS.ses) return getEmailTransport(vendorId);
  const cfg = await readAll(deps, VENDOR_CREDENTIAL_KEYS.email);
  if (!cfg) return getEmailTransport(vendorId);
  const configurationSetName = cfg["configuration_set"];
  return new SesEmailTransport({
    region: cfg["region"] ?? "us-east-1",
    accessKeyId: cfg["access_key_id"] ?? "",
    secretAccessKey: cfg["secret_access_key"] ?? "",
    ...(configurationSetName !== undefined ? { configurationSetName } : {}),
  });
}

export async function resolveRegistrar(deps: ResolveVendorDeps): Promise<DomainRegistrar> {
  const cfg = await readAll(deps, VENDOR_CREDENTIAL_KEYS.registrar);
  if (!cfg) return getRegistrar();
  // NamecheapBackend is the reference reseller; swap this one line to change it.
  return new ResellerRegistrar(
    new NamecheapBackend({
      apiUser: cfg["api_user"] ?? "",
      apiKey: cfg["api_key"] ?? "",
      username: cfg["username"] ?? "",
      clientIp: cfg["client_ip"] ?? "127.0.0.1",
    }),
  );
}

/**
 * The payment rail. Returns null rather than a mock: @adw/payments owns
 * MockStripeRail and vendors must not depend on payments (dependency runs
 * payments → vendors). A null answer means "no credential — use your mock".
 */
export async function resolvePaymentRail(deps: ResolveVendorDeps): Promise<StripeRail | null> {
  const cfg = await readAll(deps, VENDOR_CREDENTIAL_KEYS.payments);
  if (!cfg) return null;
  const webhookSecret = cfg["webhook_secret"];
  return new StripeRail({
    secretKey: cfg["secret_key"] ?? "",
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
  });
}

// --- vault plumbing ---------------------------------------------------------

interface KeySpec {
  readonly vendorId: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/**
 * Read a whole credential set, or nothing. Returns null when forceMock is set or
 * any REQUIRED key is absent; optional keys are simply omitted from the result.
 */
async function readAll(deps: ResolveVendorDeps, spec: KeySpec): Promise<Record<string, string> | null> {
  if (deps.forceMock) return null;
  for (const keyName of spec.required) {
    if (!(await deps.vault.has(spec.vendorId, keyName))) return null;
  }
  const out: Record<string, string> = {};
  for (const keyName of spec.required) {
    out[keyName] = await readSecret(deps.vault, spec.vendorId, keyName);
  }
  for (const keyName of spec.optional) {
    if (await deps.vault.has(spec.vendorId, keyName)) {
      out[keyName] = await readSecret(deps.vault, spec.vendorId, keyName);
    }
  }
  return out;
}

/** Resolve the newest version of a credential. Mirrors llm/resolve.ts. */
async function readSecret(vault: SecretsBackend, vendorId: string, keyName: string): Promise<string> {
  const summaries = await vault.list(vendorId);
  const match = summaries.find((c) => c.keyName === keyName);
  return vault.resolve(`cred:${vendorId}:${keyName}@v${match?.version ?? 1}`);
}
