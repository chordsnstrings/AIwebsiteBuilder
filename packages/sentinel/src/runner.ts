// The probe runner. PROBE_CATALOGUE says WHICH vendors are probed and how
// often; this file turns that into runnable probes and executes them. The
// surface a probe measures comes from @adw/vendors — the mock simulator in demo
// mode, the real adapter once a credential lands in the vault — so the Sentinel
// never learns anything vendor-specific. Adding a vendor to the register and
// the catalogue is enough to get it probed.
import type { Db } from "@adw/db";
import { getVendorMock } from "@adw/vendors";
import { PROBE_CATALOGUE, makeProbe, runProbe, type Probe, type ProbeResult } from "./probes.ts";

export interface ProbeRunSummary {
  total: number;
  passed: number;
  failed: number;
  results: ProbeResult[];
}

export interface ProbeCoverage {
  covered: string[];
  missing: string[];
}

/** Probe name for a vendor family — the vendor id is already its own column. */
export function probeNameForFamily(family: string): string {
  return `${family}_round_trip`;
}

/** One live probe per vendor in the catalogue, sorted for a stable run order. */
export function buildProbeCatalogue(): Probe[] {
  return Object.entries(PROBE_CATALOGUE)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendorId, spec]) => makeProbe(getVendorMock(vendorId), probeNameForFamily(spec.family), spec.intervalMs));
}

/**
 * Run every probe and persist each result. Probes run sequentially: a probe
 * sweep is a health check, not a load test, and a stampede would itself look
 * like an outage.
 */
export async function runAllProbes(db: Db, probes: Probe[] = buildProbeCatalogue()): Promise<ProbeRunSummary> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    results.push(await runProbe(db, probe));
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

/**
 * The nightly "100% of T0/T1 vendors have a live probe" check (spec §72). A
 * vendor the register depends on but nothing measures is an outage you find out
 * about from a customer.
 */
export function probeCoverage(db: Db, vendorIds: string[]): ProbeCoverage {
  void db; // Coverage is decided by the live catalogue, not by probe history.
  const live = new Set(buildProbeCatalogue().map((p) => p.vendorId));
  const covered: string[] = [];
  const missing: string[] = [];
  for (const vendorId of vendorIds) {
    if (live.has(vendorId)) covered.push(vendorId);
    else missing.push(vendorId);
  }
  return { covered, missing };
}
