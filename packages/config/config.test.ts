import { describe, expect, it } from "vitest";
import { config } from "./src/index.ts";

describe("config loaders", () => {
  it("loads and validates jurisdictions with a version hash", () => {
    const { data, version } = config.jurisdictions();
    expect(version).toMatch(/^jurisdictions@[0-9a-f]{7}$/);
    expect(data.countries.US!.enabled).toBe(true);
    expect(data.countries.DE!.enabled).toBe(false);
    expect(data.countries.GB!.subscriber_type_required).toBe(true);
  });
  it("loads thresholds (spec §69.2 values)", () => {
    const { data } = config.thresholds();
    expect(data.deliverability.complaint_rate.halt).toBe(0.002);
    expect(data.build.lighthouse.perf).toBe(85);
    expect(data.control.provider_concentration_max).toBe(0.6);
  });
  it("loads pricing with discount floors", () => {
    const { data } = config.pricing();
    expect(data.R1!.build_fee_cents).toBe(34900);
    expect(data.R4!.billing_interval_allowed).toEqual(["year"]);
  });
  it("loads registry with all pinned rails", () => {
    const { data } = config.registry();
    expect(data.rails.pinned.ceo).toContain("opus");
    expect(data.roles.ceo!.pinned).toBe(true);
    expect(Object.keys(data.roles).length).toBeGreaterThanOrEqual(16);
  });
  it("loads allowlists with a CSP template", () => {
    const { data } = config.allowlists();
    expect(data.csp_template).toContain("default-src 'self'");
  });
});
