// Vendor resolution hub. For any vendor, pick the real adapter when a credential
// exists in the vault (and no flag forces mock), otherwise the mock. This single
// switch is the whole demo↔live boundary: the system runs keyless on mocks and
// flips vendor-by-vendor as credentials are deposited through the Settings/Vault
// surface.
import type { SecretsBackend } from "@adw/vault";

export type VendorMode = "real" | "mock";

export interface ResolveOptions {
  vault: SecretsBackend;
  vendorId: string;
  keyName: string;
  forceMock?: boolean; // feature-flag override
}

export async function resolveMode(opts: ResolveOptions): Promise<VendorMode> {
  if (opts.forceMock) return "mock";
  const has = await opts.vault.has(opts.vendorId, opts.keyName);
  return has ? "real" : "mock";
}

/** Pick between two implementations by vault credential presence. */
export async function pick<T>(opts: ResolveOptions, real: () => T, mock: () => T): Promise<T> {
  const mode = await resolveMode(opts);
  return mode === "real" ? real() : mock();
}
