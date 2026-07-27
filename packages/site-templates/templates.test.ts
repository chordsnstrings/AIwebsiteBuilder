import { describe, expect, it } from "vitest";
import { renderSite, renderLlmsTxt, validateSlots, weightKb, SlotViolationError } from "./src/index.ts";

const business = { name: "Sunrise Cafe", category: "cafe", city: "Austin", phone: "+15125550100", rating: 4.6, reviewCount: 88 };
const copy = {
  headline: "Sunrise Cafe — fresh coffee and breakfast in Austin",
  services: [
    { title: "Espresso bar", blurb: "Locally roasted beans pulled to order by baristas who care about the craft." },
    { title: "All-day breakfast", blurb: "Hearty breakfast plates and pastries made fresh in-house every morning." },
    { title: "Catering", blurb: "Coffee and breakfast catering for offices and events across Austin." },
  ],
  about: "Sunrise Cafe is a neighbourhood spot serving carefully sourced coffee and honest breakfast in the heart of Austin. Come as you are.",
  cta: "See our menu",
};

const opts = {
  family: "food_hospitality",
  business,
  copy,
  locale: "en-US",
  mode: "preview" as const,
  legalEntity: "ADW Foundry Ltd",
  legalAddress: "123 Example St, Toronto",
  labelVersion: "label-v1",
  claimToken: "tok",
  formAction: "https://app.adwsites.com/form",
};

describe("SSG renderer", () => {
  it("renders a self-contained preview under 50KB (loads fast on 3G)", () => {
    const html = renderSite(opts);
    expect(weightKb(html)).toBeLessThan(50);
    // No external requests: no http(s) src/href to a CDN/script host.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
  });

  it("carries every required preview element (spec §13)", () => {
    const html = renderSite(opts);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain("Unofficial preview created by");
    expect(html).toContain("data-label-version");
    expect(html).toContain("Text me updates about my website");
    expect(html).toContain("This isn't for me");
    expect(html).toContain("money-back guarantee");
    expect(html).toContain('type="checkbox" name="sms_consent"');
    // consent checkbox is unchecked by default (no `checked` attribute on it)
    expect(html).not.toMatch(/name="sms_consent"[^>]*checked/);
  });

  it("omits the preview banner and noindex on a full build", () => {
    const html = renderSite({ ...opts, mode: "full" });
    expect(html).not.toContain("noindex");
    expect(html).not.toContain("This isn't for me");
  });

  it("includes valid LocalBusiness schema and content that renders without JS", () => {
    const html = renderSite(opts);
    expect(html).toContain('"@type":"LocalBusiness"');
    // Static text present without any script execution.
    const stripped = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    expect(stripped).toContain("Sunrise Cafe");
    expect(stripped).toContain("Espresso bar");
  });

  it("enforces copy-slot character ranges before render", () => {
    expect(() => validateSlots({ ...copy, headline: "too short" })).toThrow(SlotViolationError);
  });

  it("renders an llms.txt companion", () => {
    const txt = renderLlmsTxt(business, copy);
    expect(txt).toContain("# Sunrise Cafe");
    expect(txt).toContain("Espresso bar");
  });
});
