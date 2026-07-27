import { describe, expect, it } from "vitest";
import { renderSite, buildArtifactFromHtml } from "@adw/site-templates";
import { reviewBuild } from "./src/index.ts";

const business = { name: "Bright Plumbing", category: "plumber", city: "Denver", phone: "+13035551234", rating: 4.8, reviewCount: 120 };
const copy = {
  headline: "Bright Plumbing — trusted plumber in Denver",
  services: [
    { title: "Leak repair", blurb: "Fast, reliable leak detection and repair for homes and businesses across Denver." },
    { title: "Water heaters", blurb: "Installation and servicing of tanked and tankless water heaters, done right." },
    { title: "Drain cleaning", blurb: "Professional drain and sewer cleaning that clears the problem for good." },
  ],
  about: "Bright Plumbing has served the Denver metro for over a decade with dependable, on-time plumbing work backed by a satisfaction guarantee. Family-owned and fully local.",
  cta: "Get a free quote",
};

function renderDemo(mode: "preview" | "full") {
  return renderSite({
    family: "trades",
    business,
    copy,
    locale: "en-US",
    mode,
    legalEntity: "ADW Foundry Ltd",
    legalAddress: "123 Example St, Toronto",
    labelVersion: "label-v1",
    claimToken: "tok123",
    formAction: "https://app.adwsites.com/form",
  });
}

describe("reviewer gate — a clean build passes", () => {
  it("a well-formed preview passes every gate", () => {
    const html = renderDemo("preview");
    const outcome = reviewBuild(buildArtifactFromHtml(html));
    expect(outcome.pass).toBe(true);
    expect(outcome.hardFail).toBe(false);
    // Numeric results stored, not booleans, for drift detection.
    expect(typeof outcome.results.lighthouse_perf).toBe("number");
    expect(outcome.results.schema_valid).toBe(true);
  });
});

describe("reviewer gate — a sabotaged build is rejected on multiple gates", () => {
  it("rejects a build with an off-origin script, a link-farm link, hidden text, and low performance", () => {
    const cleanHtml = renderDemo("full");
    // Sabotage: inject an off-allowlist script, a hidden link farm, and an
    // outbound link to an attacker domain.
    const sabotaged = cleanHtml.replace(
      "</body>",
      `<script src="https://evil.example/x.js"></script>
       <div style="position:absolute;left:-9999px"><a href="https://spam.example/a">buy</a></div>
       <a href="https://attacker.example/pwn">click</a></body>`,
    );
    const outcome = reviewBuild(
      buildArtifactFromHtml(sabotaged, { lighthouse: { perf: 40 }, ipVerdict: "flag" }),
    );
    expect(outcome.pass).toBe(false);
    // At least three distinct gates fail (spec P5 gate).
    const allFailures = [...outcome.failures, ...outcome.hardFailures];
    expect(allFailures.length).toBeGreaterThanOrEqual(3);
    expect(outcome.hardFail).toBe(true);
    expect(outcome.hardFailures).toContain("GATE_SCRIPT_ORIGIN");
    expect(outcome.hardFailures).toContain("GATE_HIDDEN_CONTENT");
    expect(outcome.hardFailures).toContain("GATE_IP_CLAIMS");
  });

  it("hard-fails on the duplicate-content cap (halt builds)", () => {
    const html = renderDemo("full");
    const outcome = reviewBuild(buildArtifactFromHtml(html, { duplicateParagraphCount24h: 45 }));
    expect(outcome.hardFail).toBe(true);
    expect(outcome.hardFailures).toContain("GATE_DUPLICATE_CONTENT");
  });
});
