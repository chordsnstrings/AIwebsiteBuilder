// The Vendor Onboarding Orchestrator (spec §74–75). Prepares, provisions and
// monitors — never creates an account and never signs. It holds no credential
// capable of creating a vendor account and no payment method; credentials are
// deposited directly into the vault by a human, and the Orchestrator holds only
// a reference. No vendor reaches ACTIVE without a passing Sentinel probe. Its
// primary output is a DATE: earliest possible Wave-1 send, gated by X.
import type { Db } from "@adw/db";
import { config, type VendorRow } from "@adw/config";
import { emit } from "@adw/telemetry";

// The 16-state vendor lifecycle (spec §75.1).
export const VENDOR_STATES = [
  "IDENTIFIED",
  "DILIGENCE_PENDING",
  "DILIGENCE_COMPLETE",
  "APPLICATION_PREPARED",
  "AWAITING_HUMAN",
  "ACCOUNT_CREATED",
  "CREDENTIAL_VAULTED",
  "PROVISIONING",
  "VERIFYING",
  "ACTIVE",
  "EXPIRING",
  "DEGRADED",
  "SUSPENDED",
  "OFFBOARDING",
  "RETIRED",
  "REJECTED",
] as const;
export type VendorState = (typeof VENDOR_STATES)[number];

// Capabilities the Orchestrator holds (spec §74.3). Deliberately NOT expressible:
// create:account, sign:contract, mint:credential, write:config, charge:money.
export const ORCHESTRATOR_CAPABILITIES = [
  "read:vendor_registry",
  "write:vendor_state",
  "provision:scoped",
  "read:metrics",
  "write:exception",
] as const;

// Operations NEVER on any provisioning allowlist, for any vendor (spec §75.4).
export const FORBIDDEN_PROVISIONING = [
  "create_account",
  "change_billing_tier",
  "add_payment_method",
  "grant_admin_to_new_principal",
  "delete_production_data",
] as const;

/** Seed the vendor registry from config/vendors.yaml (idempotent). */
export async function seedVendors(db: Db): Promise<void> {
  const { data } = config.vendors();
  for (const v of data.vendors) {
    await db.query(
      `INSERT INTO vendors (id, name, tier, data_class, gate, category, state, diligence)
       VALUES ($1,$2,$3,$4,$5,$6,'IDENTIFIED','{}')
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, tier=EXCLUDED.tier, data_class=EXCLUDED.data_class, gate=EXCLUDED.gate, category=EXCLUDED.category`,
      [v.id, v.name, v.tier, v.data_class, v.gate, v.category],
    );
  }
}

/**
 * A scoped provisioning request. Permitted only if the operation is on the
 * vendor's allowlist AND not on the global forbidden list. Enforced in code —
 * the Orchestrator can create a DNS record in an existing zone but not create a
 * Cloudflare account.
 */
export function provisioningPermitted(vendor: VendorRow, operation: string): boolean {
  if ((FORBIDDEN_PROVISIONING as readonly string[]).includes(operation)) return false;
  return vendor.provisioning.includes(operation);
}

export function assertProvisioningPermitted(vendor: VendorRow, operation: string): void {
  if (!provisioningPermitted(vendor, operation)) {
    throw new Error(
      `Provisioning '${operation}' is not permitted for ${vendor.id} — create-capability is never on any allowlist (spec §75.4).`,
    );
  }
}

/**
 * Transition a vendor to ACTIVE. Requires a passing Sentinel probe — "the
 * account exists" and "the integration works" are different claims (spec §75).
 */
export async function activateVendor(
  db: Db,
  vendorId: string,
  probePassed: boolean,
): Promise<{ activated: boolean; reason?: string }> {
  if (!probePassed) {
    await db.query("UPDATE vendors SET state='VERIFYING' WHERE id=$1", [vendorId]);
    return { activated: false, reason: "no passing Sentinel probe" };
  }
  // A CUST/PAY vendor cannot reach ACTIVE with an incomplete diligence file.
  const v = await db.one<{ data_class: string; diligence: Record<string, unknown> }>(
    "SELECT data_class, diligence FROM vendors WHERE id=$1",
    [vendorId],
  );
  if ((v.data_class === "CUST" || v.data_class === "PAY") && !diligenceComplete(v.diligence)) {
    return { activated: false, reason: "CUST/PAY vendor with incomplete diligence" };
  }
  await db.query("UPDATE vendors SET state='ACTIVE', probe_status='passing', probe_last_ok=now() WHERE id=$1", [vendorId]);
  await emit({ eventType: "asset.provisioned", subject: { kind: "vendor", id: vendorId }, payload: { state: "ACTIVE" } });
  return { activated: true };
}

// The nine diligence questions (spec §12.5). Complete = all answered.
export function diligenceComplete(diligence: Record<string, unknown>): boolean {
  for (let q = 1; q <= 9; q++) {
    if (!diligence[`q${q}`]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Monitoring watches (spec §75.5). Credential/cert expiry, contract renewals
// before the notice period closes, credit balances, plan limits, and the three
// notices nobody builds for: subprocessor / price-change / deprecation.
// ---------------------------------------------------------------------------
export interface WatchFinding {
  vendorId: string;
  kind: string;
  urgency: "warning" | "escalation";
  detail: string;
}

export async function runWatches(db: Db, now = new Date()): Promise<WatchFinding[]> {
  const findings: WatchFinding[] = [];
  const vendors = await db.query<{
    id: string;
    renewal_at: string | null;
    notice_period_days: number | null;
    balance_days: number | null;
  }>("SELECT id, renewal_at, notice_period_days, balance_days FROM vendors");
  for (const v of vendors.rows) {
    if (v.renewal_at) {
      const daysToRenewal = (new Date(v.renewal_at).getTime() - now.getTime()) / (24 * 3600 * 1000);
      const notice = v.notice_period_days ?? 30;
      if (daysToRenewal <= notice) {
        findings.push({ vendorId: v.id, kind: "contract_renewal", urgency: "escalation", detail: `renewal in ${Math.round(daysToRenewal)}d, inside notice period` });
      } else if (daysToRenewal <= 90) {
        findings.push({ vendorId: v.id, kind: "contract_renewal", urgency: "warning", detail: `renewal in ${Math.round(daysToRenewal)}d` });
      }
    }
    if (v.balance_days !== null) {
      if (v.balance_days < 7) findings.push({ vendorId: v.id, kind: "credit_balance", urgency: "escalation", detail: `${v.balance_days} days of balance left` });
      else if (v.balance_days < 30) findings.push({ vendorId: v.id, kind: "credit_balance", urgency: "warning", detail: `${v.balance_days} days of balance left` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Dependency graph → the earliest possible Wave-1 send date (spec §75.2). Five
// long poles; the 21-day mailbox warm-up is never compressible.
// ---------------------------------------------------------------------------
export interface LongPole {
  name: string;
  leadDays: number;
  compressible: boolean;
}

export const LONG_POLES: LongPole[] = [
  { name: "counsel_review", leadDays: 21, compressible: true },
  { name: "registrar_reseller_approval", leadDays: 21, compressible: false },
  { name: "ses_production_access", leadDays: 10, compressible: false },
  { name: "stripe_connect_approval", leadDays: 14, compressible: false },
  { name: "mailbox_warmup", leadDays: 21, compressible: false }, // hard floor
];

/** Earliest Wave-1 send date given a start date: the longest pole gates it. */
export function earliestWave1Send(startDate: Date): { date: Date; gatedBy: string } {
  const gate = LONG_POLES.reduce((a, b) => (b.leadDays > a.leadDays ? b : a));
  const date = new Date(startDate.getTime() + gate.leadDays * 24 * 3600 * 1000);
  return { date, gatedBy: gate.name };
}
