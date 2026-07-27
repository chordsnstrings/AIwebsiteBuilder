import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { config } from "@adw/config";
import { resetVendorMocks, simulateOutage } from "@adw/vendors";
import {
  PROBE_CATALOGUE,
  SIGNAL_RULES,
  alarmingSignals,
  buildProbeCatalogue,
  evaluateSignals,
  healthyWindow,
  probeCoverage,
  runAllProbes,
  type SignalWindow,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

// The vendors the go-live critical path depends on. Every one of them must have
// a live probe — this list is what the nightly coverage check asserts against.
const T0_VENDORS = [
  "stripe",
  "secondary_processor",
  "cloudflare",
  "registrar_reseller",
  "aws_ses",
  "google_workspace",
  "microsoft_365",
  "modelark",
  "google_ai",
  "anthropic",
  "postgres",
  "temporal",
  "lead_data_primary",
  "email_verification",
];

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});
beforeEach(() => {
  resetVendorMocks();
});

async function countProbeRows(names: string[]): Promise<number> {
  const row = await db.one<{ n: string }>("SELECT count(*) AS n FROM probe_results WHERE probe_name = ANY($1)", [names]);
  return Number(row.n);
}

describe("probe runner (Layer 1)", () => {
  it("builds exactly one probe per vendor in the catalogue", () => {
    const probes = buildProbeCatalogue();
    const catalogueIds = Object.keys(PROBE_CATALOGUE).sort();
    expect(probes.map((p) => p.vendorId)).toEqual(catalogueIds);
    for (const probe of probes) {
      const spec = PROBE_CATALOGUE[probe.vendorId]!;
      expect(probe.intervalMs).toBe(spec.intervalMs);
      expect(probe.name).toBe(`${spec.family}_round_trip`);
    }
  });

  it("runs every probe, persists a probe_results row each, and all pass in demo mode", async () => {
    const probes = buildProbeCatalogue();
    const names = [...new Set(probes.map((p) => p.name))];
    const before = await countProbeRows(names);

    const summary = await runAllProbes(db);

    expect(summary.total).toBe(probes.length);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(probes.length);
    expect(await countProbeRows(names)).toBe(before + probes.length);

    // Each vendor's own row landed, with its detail.
    for (const result of summary.results) {
      const row = await db.maybeOne<{ passed: boolean; detail: string | null }>(
        "SELECT passed, detail FROM probe_results WHERE vendor_id=$1 AND probe_name=$2 ORDER BY ran_at DESC LIMIT 1",
        [result.vendorId, result.probeName],
      );
      expect(row, `no persisted row for ${result.vendorId}`).not.toBeNull();
      expect(row!.passed).toBe(true);
    }
  });

  it("chaos: simulateOutage('aws_ses') fails only that probe", async () => {
    simulateOutage("aws_ses", true);
    const summary = await runAllProbes(db);

    const failed = summary.results.filter((r) => !r.passed);
    expect(failed.map((r) => r.vendorId)).toEqual(["aws_ses"]);
    expect(failed[0]!.detail).toMatch(/outage/i);
    expect(summary.passed).toBe(summary.total - 1);

    // And it recovers once the vendor comes back.
    simulateOutage("aws_ses", false);
    const recovered = await runAllProbes(db);
    expect(recovered.failed).toBe(0);
  });

  it("breaking one Cloudflare leg fails the composite probe", async () => {
    const { getCloudflare } = await import("@adw/vendors");
    getCloudflare().simulateLegOutage("r2", true);
    const summary = await runAllProbes(db);
    const cf = summary.results.find((r) => r.vendorId === "cloudflare");
    expect(cf?.passed).toBe(false);
    expect(cf?.detail).toMatch(/r2/);
    expect(summary.failed).toBe(1);
  });
});

describe("probe coverage (nightly gate)", () => {
  it("reports zero missing for the T0 vendor list", () => {
    const coverage = probeCoverage(db, T0_VENDORS);
    expect(coverage.missing).toEqual([]);
    expect(coverage.covered).toEqual(T0_VENDORS);
  });

  it("covers every vendor in the catalogue", () => {
    const coverage = probeCoverage(db, Object.keys(PROBE_CATALOGUE));
    expect(coverage.missing).toEqual([]);
  });

  it("names a vendor that nothing probes", () => {
    // Uses synthetic ids so the assertion cannot rot when a real vendor gains a
    // probe — the behaviour under test is the partition, not the catalogue.
    const coverage = probeCoverage(db, ["stripe", "not_a_real_vendor_a", "not_a_real_vendor_b"]);
    expect(coverage.covered).toEqual(["stripe"]);
    expect(coverage.missing).toEqual(["not_a_real_vendor_a", "not_a_real_vendor_b"]);
  });

  it("covers EVERY T0/T1 vendor in the register (the nightly invariant)", () => {
    const t0t1 = config
      .vendors()
      .data.vendors.filter((v) => v.tier === "T0" || v.tier === "T1")
      .map((v) => v.id);
    const coverage = probeCoverage(db, t0t1);
    expect(coverage.missing, `unmonitored T0/T1 vendors: ${coverage.missing.join(", ")}`).toEqual([]);
  });
});

describe("passive signals (Layer 2, spec §72.6)", () => {
  function windowWith(overrides: Partial<SignalWindow>): SignalWindow {
    return { ...healthyWindow(), ...overrides };
  }

  function signal(metrics: SignalWindow, name: string) {
    const found = evaluateSignals(metrics).find((s) => s.name === name);
    expect(found, `no signal named ${name}`).toBeDefined();
    return found!;
  }

  it("raises nothing on a healthy window", () => {
    expect(alarmingSignals(healthyWindow())).toEqual([]);
  });

  it("first-pass rate alarms below 0.75 but not at it", () => {
    expect(signal(windowWith({ firstPassRateByRole: { copywriter: 0.75 } }), "first_pass_rate:copywriter").alarm).toBe(false);
    expect(signal(windowWith({ firstPassRateByRole: { copywriter: 0.74 } }), "first_pass_rate:copywriter").alarm).toBe(true);
  });

  it("evaluates first-pass rate per role", () => {
    const metrics = windowWith({ firstPassRateByRole: { copywriter: 0.9, designer: 0.5 } });
    const alarms = alarmingSignals(metrics);
    expect(alarms.map((s) => s.name)).toEqual(["first_pass_rate:designer"]);
  });

  it("inbox placement alarms below 0.70 but not at it", () => {
    expect(signal(windowWith({ inboxPlacement: 0.7 }), "inbox_placement").alarm).toBe(false);
    expect(signal(windowWith({ inboxPlacement: 0.69 }), "inbox_placement").alarm).toBe(true);
  });

  it("complaint rate alarms above 0.0010 but not at it", () => {
    expect(signal(windowWith({ complaintRate: 0.001 }), "complaint_rate").alarm).toBe(false);
    expect(signal(windowWith({ complaintRate: 0.0011 }), "complaint_rate").alarm).toBe(true);
  });

  it("ANY silent failure is an alarm", () => {
    expect(signal(windowWith({ silentFailureCount: 0 }), "silent_failures").alarm).toBe(false);
    const one = signal(windowWith({ silentFailureCount: 1 }), "silent_failures");
    expect(one.alarm).toBe(true);
    expect(one.severity).toBe(1);
  });

  it("preview render success alarms below 0.97 but not at it", () => {
    expect(signal(windowWith({ previewRenderSuccess: 0.97 }), "preview_render_success").alarm).toBe(false);
    expect(signal(windowWith({ previewRenderSuccess: 0.96 }), "preview_render_success").alarm).toBe(true);
  });

  it("form submission arrival alarms below 0.99 but not at it", () => {
    expect(signal(windowWith({ formSubmissionArrival: 0.99 }), "form_submission_arrival").alarm).toBe(false);
    expect(signal(windowWith({ formSubmissionArrival: 0.98 }), "form_submission_arrival").alarm).toBe(true);
  });

  it("provider concentration alarms above 0.60 but not at it", () => {
    expect(signal(windowWith({ providerConcentration: 0.6 }), "provider_concentration").alarm).toBe(false);
    expect(signal(windowWith({ providerConcentration: 0.61 }), "provider_concentration").alarm).toBe(true);
  });

  it("carries the threshold and value on every signal and sorts alarms by severity", () => {
    const metrics = windowWith({
      firstPassRateByRole: { copywriter: 0.1 },
      providerConcentration: 0.95,
      silentFailureCount: 2,
    });
    const alarms = alarmingSignals(metrics);
    expect(alarms[0]!.name).toBe("silent_failures");
    expect(alarms.map((s) => s.severity)).toEqual([...alarms.map((s) => s.severity)].sort());

    const concentration = signal(metrics, "provider_concentration");
    expect(concentration.value).toBe(0.95);
    expect(concentration.threshold).toBe(SIGNAL_RULES.provider_concentration.threshold);
  });
});
