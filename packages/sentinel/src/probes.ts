// Sentinel Layer 1 — deterministic active probes (spec §71.3, §72). A probe is a
// real round trip against a vendor through the SAME interface production uses, so
// it exercises the plumbing in both demo and live mode. In demo mode a probe
// runs against the vendor's mock simulator and passes meaningfully; a vendor's
// simulateOutage() makes it fail. Status pages are never a health signal.
import type { Db } from "@adw/db";

export interface ProbeResult {
  vendorId: string;
  probeName: string;
  passed: boolean;
  latencyMs: number;
  detail?: string;
}

export interface Probe {
  vendorId: string;
  name: string;
  intervalMs: number;
  run(): Promise<ProbeResult>;
}

// A vendor exposes a health surface the probe measures. In demo this is the
// mock simulator; in live mode it is the real adapter behind a credential.
export interface VendorHealthSurface {
  vendorId: string;
  roundTrip(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

export function makeProbe(surface: VendorHealthSurface, name: string, intervalMs: number): Probe {
  return {
    vendorId: surface.vendorId,
    name,
    intervalMs,
    async run(): Promise<ProbeResult> {
      try {
        const r = await surface.roundTrip();
        return { vendorId: surface.vendorId, probeName: name, passed: r.ok, latencyMs: r.latencyMs, detail: r.detail };
      } catch (err) {
        return {
          vendorId: surface.vendorId,
          probeName: name,
          passed: false,
          latencyMs: 0,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/** Run a probe and persist the result. */
export async function runProbe(db: Db, probe: Probe): Promise<ProbeResult> {
  const result = await probe.run();
  await db.query(
    "INSERT INTO probe_results (vendor_id, probe_name, passed, latency_ms, detail) VALUES ($1,$2,$3,$4,$5)",
    [result.vendorId, result.probeName, result.passed, result.latencyMs, result.detail ?? null],
  );
  return result;
}

/** The probe catalogue: interval + pass criteria per vendor family (spec §72). */
export const PROBE_CATALOGUE: Record<string, { intervalMs: number; family: string }> = {
  stripe: { intervalMs: 60_000, family: "money" },
  secondary_processor: { intervalMs: 900_000, family: "money" },
  cloudflare: { intervalMs: 300_000, family: "delivery" },
  registrar_reseller: { intervalMs: 900_000, family: "delivery" },
  aws_ses: { intervalMs: 300_000, family: "email" },
  google_workspace: { intervalMs: 900_000, family: "email" },
  microsoft_365: { intervalMs: 900_000, family: "email" },
  modelark: { intervalMs: 60_000, family: "models" },
  google_ai: { intervalMs: 300_000, family: "models" },
  anthropic: { intervalMs: 300_000, family: "models" },
  langfuse: { intervalMs: 900_000, family: "models" },
  postgres: { intervalMs: 30_000, family: "data" },
  redis: { intervalMs: 30_000, family: "data" },
  temporal: { intervalMs: 60_000, family: "data" },
  lead_data_primary: { intervalMs: 3_600_000, family: "data" },
  email_verification: { intervalMs: 3_600_000, family: "data" },
  browserless: { intervalMs: 900_000, family: "data" },
  twilio: { intervalMs: 3_600_000, family: "data" },
};
