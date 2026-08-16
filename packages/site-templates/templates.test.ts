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

describe("⛔ a generated image is not a photograph", () => {
  const base = {
    vertical: "plumber",
    business: { name: "Test Co", city: "London", phone: "+44 20 7946 0000", email: "a@b.example", areaServed: ["London"] },
    services: [{ name: "A service", description: "Something they do" }],
    facts: [], qa: [{ question: "Q?", answer: "A." }], refusalText: "I can't answer that.",
    brand: { extracted: false }, pages: ["index.html"],
  };

  it("describes it in its own section, never among the photographs", async () => {
    const { buildSitePrompt } = await import("./src/index.ts");
    const out = buildSitePrompt({
      ...base,
      images: [
        { path: "img/job.jpg", width: 1200, height: 800, description: "a finished bathroom" },
        { path: "img/hero.png", width: 2048, height: 1152, description: "blue gradient",
          provenance: "ai_generated" as const, slot: "hero_background" },
      ],
    } as Parameters<typeof buildSitePrompt>[0]);
    const photographs = out.user.slice(out.user.indexOf("## Photographs on disk"), out.user.indexOf("## AI-generated"));
    expect(photographs).toContain("img/job.jpg");
    expect(photographs, "a generated image was listed among the photographs").not.toContain("img/hero.png");
    expect(out.user).toMatch(/NEVER place one in a gallery/);
  });

  it("⛔ refuses the build when a generated image targets a non-decorative slot", async () => {
    // By the time a page has shipped it is on the internet under a real
    // business's name, so this fails the build rather than the review.
    const { buildSitePrompt } = await import("./src/index.ts");
    expect(() =>
      buildSitePrompt({
        ...base,
        images: [{ path: "img/x.png", width: 800, height: 600, description: "a finished roof",
          provenance: "ai_generated" as const, slot: "gallery" }],
      } as Parameters<typeof buildSitePrompt>[0]),
    ).toThrow(/not decorative/);
  });
});
