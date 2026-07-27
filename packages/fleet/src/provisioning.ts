// Mailbox provisioning + DNS readiness gate (spec §40). A newly provisioned
// mailbox starts in 'warming' with the day-1 cap. Nothing sends from an asset
// until all five DNS assertions (SPF, DKIM, DMARC, PTR, TLS) pass — a partial
// pass is a fail, deterministically.
import type { Db } from "@adw/db";
import { warmupCap } from "./warmup.ts";

export type Provider = "google" | "microsoft" | "smtp_vendor" | "ses";
export type DomainClass = "burner" | "brand";

export interface ProvisionOpts {
  provider: Provider;
  pool: string;
  domainClass: DomainClass;
  /** Optional explicit identifier; a unique one is generated when omitted. */
  identifier?: string;
}

export interface ProvisionedAsset {
  id: string;
  identifier: string;
  provider: Provider;
  pool: string;
  domain_class: DomainClass;
  health: string;
  daily_cap: number;
}

/**
 * Provision a mailbox: a 'warming' sending_assets row with the day-1 warm-up cap
 * and warmup_started set to now. Sends are still gated on assertDnsReady.
 */
export async function provisionMailbox(db: Db, opts: ProvisionOpts, now: Date = new Date()): Promise<ProvisionedAsset> {
  const identifier =
    opts.identifier ?? `mb-${Math.random().toString(36).slice(2, 10)}@${opts.pool}.adw-send.com`;
  const cap = warmupCap(1);
  return db.one<ProvisionedAsset>(
    `INSERT INTO sending_assets (kind, provider, identifier, domain_class, pool, health, daily_cap, warmup_started)
     VALUES ('mailbox', $1, $2, $3, $4, 'warming', $5, $6)
     RETURNING id, identifier, provider, pool, domain_class, health, daily_cap`,
    [opts.provider, identifier, opts.domainClass, opts.pool, cap, now],
  );
}

export interface DnsAssertions {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  ptr: boolean;
  tls: boolean;
}

export interface DnsReadiness {
  ok: boolean;
  missing: string[];
}

/**
 * DNS readiness check (spec §40): an asset may only send once SPF, DKIM, DMARC,
 * PTR and TLS all pass. Returns ok only when all five are true, plus the list of
 * failing assertions for diagnostics.
 */
export function assertDnsReady(assertions: DnsAssertions): DnsReadiness {
  const required: (keyof DnsAssertions)[] = ["spf", "dkim", "dmarc", "ptr", "tls"];
  const missing = required.filter((k) => !assertions[k]);
  return { ok: missing.length === 0, missing };
}
