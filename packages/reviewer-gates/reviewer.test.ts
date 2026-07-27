// The reviewer is tested against synthetic HTML on purpose: it must be able to
// judge ANY document, not only ones our own template renderer produced. The
// integration direction (real rendered fixtures pass the gate) is tested in
// packages/site-templates, which keeps the dependency one-way.
import { describe, expect, it } from "vitest";
import { reviewBuild, type BuildArtifact } from "./src/index.ts";

const SCHEMA = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Bright Plumbing",
  telephone: "+13035551234",
});

/** A minimal, well-formed document that should satisfy every gate. */
function cleanHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Bright Plumbing — plumber in Denver</title>
<script type="application/ld+json">${SCHEMA}</script>
</head><body>
<h1>Bright Plumbing — trusted plumber in Denver</h1>
<p>Fast, reliable leak detection and repair for homes and businesses across the Denver metro area. We show up on time and stand behind our work.</p>
<h2>Services</h2>
<ul><li>Leak repair</li><li>Water heaters</li><li>Drain cleaning</li></ul>
<a href="https://www.google.com/maps">Find us</a>
</body></html>`;
}

function artifact(html: string, over: Partial<BuildArtifact> = {}): BuildArtifact {
  return {
    html,
    lighthouse: { perf: 96, a11y: 98, bestPractices: 100, seo: 100, cls: 0.01 },
    pageWeightKb: Buffer.byteLength(html) / 1024,
    axeCritical: 0,
    axeSerious: 0,
    brokenLinks: 0,
    formPostArrives: true,
    mobileOverflowPx: 0,
    llmsTxtPresent: true,
    spellingErrors: 0,
    customerDomains: [],
    duplicateParagraphCount24h: 0,
    ipVerdict: "pass",
    ...over,
  };
}

describe("reviewer gate — a clean build passes", () => {
  it("passes every gate and records NUMERIC results, not booleans", () => {
    const outcome = reviewBuild(artifact(cleanHtml()));
    expect(outcome.pass).toBe(true);
    expect(outcome.hardFail).toBe(false);
    expect(typeof outcome.results.lighthouse_perf).toBe("number");
    expect(outcome.results.lighthouse_perf).toBe(96);
    expect(outcome.results.schema_valid).toBe(true);
  });
});

describe("reviewer gate — soft gates request a patch, they do not halt", () => {
  const softCases: [string, Partial<BuildArtifact>, string][] = [
    ["low performance", { lighthouse: { perf: 40, a11y: 98, bestPractices: 100, seo: 100, cls: 0.01 } }, "GATE_PERFORMANCE"],
    ["low accessibility", { lighthouse: { perf: 96, a11y: 60, bestPractices: 100, seo: 100, cls: 0.01 } }, "GATE_A11Y"],
    ["high CLS", { lighthouse: { perf: 96, a11y: 98, bestPractices: 100, seo: 100, cls: 0.4 } }, "GATE_CLS"],
    ["axe violations", { axeCritical: 2 }, "GATE_AXE"],
    ["broken links", { brokenLinks: 3 }, "GATE_LINKS"],
    ["form does not arrive", { formPostArrives: false }, "GATE_FORM"],
    ["mobile overflow", { mobileOverflowPx: 40 }, "GATE_MOBILE"],
    ["missing llms.txt", { llmsTxtPresent: false }, "GATE_LLMS_TXT"],
    ["spelling errors", { spellingErrors: 5 }, "GATE_SPELLING"],
    ["page too heavy", { pageWeightKb: 5000 }, "GATE_WEIGHT"],
  ];

  for (const [name, over, code] of softCases) {
    it(`flags ${name} as a patchable failure`, () => {
      const outcome = reviewBuild(artifact(cleanHtml(), over));
      expect(outcome.pass).toBe(false);
      expect(outcome.failures).toContain(code);
      expect(outcome.hardFail).toBe(false);
    });
  }

  it("flags a missing LocalBusiness schema", () => {
    const outcome = reviewBuild(artifact(cleanHtml().replace(/<script[\s\S]*?<\/script>/, "")));
    expect(outcome.failures).toContain("GATE_SCHEMA");
  });

  it("flags a document whose content requires JavaScript to read", () => {
    const jsOnly = `<!doctype html><html lang="en"><head><title>x</title>
<script type="application/ld+json">${SCHEMA}</script></head><body><div id="root"></div></body></html>`;
    const outcome = reviewBuild(artifact(jsOnly));
    expect(outcome.failures).toContain("GATE_NO_JS");
  });
});

describe("reviewer gate — hard fails halt the build (injection signatures)", () => {
  it("hard-fails an off-allowlist script origin", () => {
    const html = cleanHtml().replace("</body>", `<script src="https://evil.example/x.js"></script></body>`);
    const outcome = reviewBuild(artifact(html));
    expect(outcome.hardFail).toBe(true);
    expect(outcome.hardFailures).toContain("GATE_SCRIPT_ORIGIN");
  });

  it("hard-fails an outbound link outside the allowlist", () => {
    const html = cleanHtml().replace("</body>", `<a href="https://attacker.example/pwn">click</a></body>`);
    const outcome = reviewBuild(artifact(html));
    expect(outcome.hardFailures).toContain("GATE_LINK_ALLOWLIST");
  });

  it("allows an outbound link to the customer's own declared domain", () => {
    const html = cleanHtml().replace("</body>", `<a href="https://brightplumbing.com/quote">quote</a></body>`);
    const outcome = reviewBuild(artifact(html, { customerDomains: ["https://brightplumbing.com"] }));
    expect(outcome.hardFailures).not.toContain("GATE_LINK_ALLOWLIST");
  });

  it("hard-fails a hidden off-viewport link farm", () => {
    const html = cleanHtml().replace(
      "</body>",
      `<div style="position:absolute;left:-9999px"><a href="https://spam.example/a">buy</a></div></body>`,
    );
    const outcome = reviewBuild(artifact(html));
    expect(outcome.hardFailures).toContain("GATE_HIDDEN_CONTENT");
  });

  it("hard-fails display:none hidden text", () => {
    const html = cleanHtml().replace("</body>", `<p style="display:none">keyword stuffing</p></body>`);
    const outcome = reviewBuild(artifact(html));
    expect(outcome.hardFailures).toContain("GATE_HIDDEN_CONTENT");
  });

  it("hard-fails the fleet-wide duplicate-content cap (halt builds)", () => {
    const outcome = reviewBuild(artifact(cleanHtml(), { duplicateParagraphCount24h: 45 }));
    expect(outcome.hardFail).toBe(true);
    expect(outcome.hardFailures).toContain("GATE_DUPLICATE_CONTENT");
  });

  it("hard-fails an IP/claims flag", () => {
    const outcome = reviewBuild(artifact(cleanHtml(), { ipVerdict: "flag" }));
    expect(outcome.hardFail).toBe(true);
    expect(outcome.hardFailures).toContain("GATE_IP_CLAIMS");
  });
});

describe("reviewer gate — a sabotaged build is rejected on multiple gates at once", () => {
  it("reports every distinct failure, not just the first", () => {
    const sabotaged = cleanHtml().replace(
      "</body>",
      `<script src="https://evil.example/x.js"></script>
       <div style="position:absolute;left:-9999px"><a href="https://spam.example/a">buy</a></div>
       <a href="https://attacker.example/pwn">click</a></body>`,
    );
    const outcome = reviewBuild(
      artifact(sabotaged, {
        lighthouse: { perf: 40, a11y: 55, bestPractices: 70, seo: 60, cls: 0.5 },
        ipVerdict: "flag",
        brokenLinks: 4,
      }),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.hardFail).toBe(true);
    const all = [...outcome.failures, ...outcome.hardFailures];
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const code of ["GATE_SCRIPT_ORIGIN", "GATE_HIDDEN_CONTENT", "GATE_LINK_ALLOWLIST", "GATE_IP_CLAIMS"]) {
      expect(outcome.hardFailures).toContain(code);
    }
    for (const code of ["GATE_PERFORMANCE", "GATE_A11Y", "GATE_LINKS"]) {
      expect(outcome.failures).toContain(code);
    }
  });
});
