// Template-family tests (spec §59). The families are data, so these tests check
// the data's shape, the taxonomy mapping, that layout variants genuinely differ,
// and that every shipped fixture clears the reviewer gate and the a11y floor.
import { describe, expect, it } from "vitest";
import { reviewBuild } from "@adw/reviewer-gates";
import {
  AA_CONTRAST_MIN,
  FAMILIES,
  LAYOUT_SECTIONS,
  RENDER_FIXTURES,
  SNAPSHOT_VERSION,
  TemplateVariantError,
  buildArtifactFromHtml,
  familyForCategory,
  fixtureFamily,
  pairContrast,
  renderAllFixtures,
  renderFixture,
  renderSite,
  snapshotManifest,
  validateSlots,
  weightKb,
  type LayoutId,
} from "./src/index.ts";

const business = {
  name: "Bright Plumbing",
  category: "plumber",
  city: "Denver",
  phone: "+13035551234",
  rating: 4.8,
  reviewCount: 120,
};
const copy = {
  headline: "Bright Plumbing — trusted plumber in Denver",
  services: [
    { title: "Leak repair", blurb: "Fast, reliable leak detection and repair for homes and businesses across Denver." },
    { title: "Water heaters", blurb: "Installation and servicing of tanked and tankless water heaters, done right." },
    { title: "Drain cleaning", blurb: "Professional drain and sewer cleaning that clears the problem for good." },
  ],
  about:
    "Bright Plumbing has served the Denver metro for over a decade with dependable, on-time plumbing work backed by a satisfaction guarantee. Family-owned and fully local.",
  cta: "Get a free quote",
};

function renderWithLayout(familyId: string, layout: LayoutId): string {
  const familyDef = FAMILIES[familyId]!;
  return renderSite({
    family: familyId,
    familyDef,
    layout,
    colorSystem: familyDef.tokens.colorSystems[0]!.id,
    typePairing: familyDef.tokens.typePairings[0]!.id,
    business,
    copy,
    locale: "en-US",
    mode: "preview",
    legalEntity: "ADW Foundry Ltd",
    legalAddress: "123 Example St, Toronto",
    labelVersion: "label-v1",
    claimToken: "tok",
    formAction: "https://app.adwsites.com/form",
  });
}

/** The `<section class="...">` names in document order. */
function sectionOrder(html: string): string[] {
  return [...html.matchAll(/<section class="([a-z-]+)"/g)].map((m) => m[1]!);
}

describe("template families are data, not three copies of a renderer", () => {
  it("ships exactly three families, each with 6 colour systems and 4 type pairings", () => {
    expect(Object.keys(FAMILIES).sort()).toEqual(["food_hospitality", "personal_services", "trades"]);
    for (const [id, fam] of Object.entries(FAMILIES)) {
      expect(fam.id, `${id}.id`).toBe(id);
      expect(fam.label.length).toBeGreaterThan(0);
      expect(fam.tokens.colorSystems, `${id} colour systems`).toHaveLength(6);
      expect(fam.tokens.typePairings, `${id} type pairings`).toHaveLength(4);
      // Ids are unique within the family — the renderer resolves variants by id.
      expect(new Set(fam.tokens.colorSystems.map((c) => c.id)).size).toBe(6);
      expect(new Set(fam.tokens.typePairings.map((t) => t.id)).size).toBe(4);
      // Copy guidance covers every slot the model is allowed to fill.
      expect(Object.keys(fam.copyGuidance).sort()).toEqual(["about", "cta", "headline", "service_blurb"]);
      expect(fam.layouts.length).toBeGreaterThanOrEqual(2);
      expect(fam.sectionOrder).toEqual([...LAYOUT_SECTIONS[fam.layouts[0]!]]);
    }
  });

  it("every colour token is a 6-digit hex and every type pairing names two stacks", () => {
    for (const fam of Object.values(FAMILIES)) {
      for (const cs of fam.tokens.colorSystems) {
        for (const token of [cs.primary, cs.accent, cs.surface, cs.text]) {
          expect(token, `${fam.id}/${cs.id}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
      for (const tp of fam.tokens.typePairings) {
        expect(tp.headingStack.length).toBeGreaterThan(0);
        expect(tp.bodyStack.length).toBeGreaterThan(0);
        expect(tp.scale).toBeGreaterThan(1);
      }
    }
  });

  it("maps trade categories to families through config/taxonomy.yaml", () => {
    expect(familyForCategory("plumber").id).toBe("trades");
    expect(familyForCategory("cafe").id).toBe("food_hospitality");
    expect(familyForCategory("electrician").id).toBe("trades");
    expect(familyForCategory("salon").id).toBe("personal_services");
    expect(familyForCategory("bakery").id).toBe("food_hospitality");
    // Taxonomy families with no shipped template route through the explicit table.
    expect(familyForCategory("auto_repair").id).toBe("trades");
    expect(familyForCategory("florist").id).toBe("personal_services");
    // Unknown categories still render something rather than throwing mid-build.
    expect(familyForCategory("not_a_real_category").id).toBe("trades");
  });
});

describe("layout variants differ materially", () => {
  it("renders a different section order and different markup per layout", () => {
    const services = renderWithLayout("trades", "hero-services-about-contact");
    const gallery = renderWithLayout("trades", "hero-gallery-contact");
    const menu = renderWithLayout("food_hospitality", "hero-menu-about-contact");

    expect(sectionOrder(services)).toEqual(["services", "about", "contact"]);
    expect(sectionOrder(gallery)).toEqual(["gallery", "contact"]);
    expect(sectionOrder(menu)).toEqual(["menu", "about", "contact"]);

    // Different markup, not just different classes on the same elements.
    expect(services).toContain('<div class="card">');
    expect(services).not.toContain("<figure>");
    expect(gallery).toContain("<figure>");
    expect(gallery).toContain("<figcaption>");
    expect(gallery).not.toContain('<div class="card">');
    expect(menu).toContain("<dl>");
    expect(menu).toContain("<dt>");
    expect(menu).not.toContain("<figure>");

    // Three genuinely distinct documents.
    expect(new Set([services, gallery, menu]).size).toBe(3);
  });

  it("keeps every copy slot even when a layout drops the About section", () => {
    const gallery = renderWithLayout("trades", "hero-gallery-contact");
    expect(sectionOrder(gallery)).not.toContain("about");
    // About copy rides in the hero instead — no layout silently discards a slot.
    expect(gallery).toContain('<p class="hero-about">');
    expect(gallery).toContain("served the Denver metro for over a decade");
  });

  it("injects the chosen colour system as CSS custom properties", () => {
    const fam = FAMILIES.trades!;
    const cs = fam.tokens.colorSystems[2]!;
    const tp = fam.tokens.typePairings[1]!;
    const html = renderSite({
      family: "trades",
      familyDef: fam,
      layout: "hero-services-about-contact",
      colorSystem: cs.id,
      typePairing: tp.id,
      business,
      copy,
      locale: "en-US",
      mode: "full",
      legalEntity: "ADW Foundry Ltd",
      legalAddress: "123 Example St, Toronto",
      labelVersion: "label-v1",
      formAction: "https://app.adwsites.com/form",
    });
    expect(html).toContain(`--adw-primary:${cs.primary}`);
    expect(html).toContain(`--adw-accent:${cs.accent}`);
    expect(html).toContain(`--adw-surface:${cs.surface}`);
    expect(html).toContain(`--adw-text:${cs.text}`);
    expect(html).toContain(`--adw-heading:${tp.headingStack}`);
    expect(html).toContain("--adw-scale:" + tp.scale);
    // Still self-contained: no external font or stylesheet request.
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
    expect(html).not.toMatch(/@import/);
  });

  it("refuses a variant the family does not offer instead of guessing", () => {
    const fam = FAMILIES.trades!;
    const base = {
      family: "trades",
      familyDef: fam,
      business,
      copy,
      locale: "en-US",
      mode: "full" as const,
      legalEntity: "ADW Foundry Ltd",
      legalAddress: "123 Example St, Toronto",
      labelVersion: "label-v1",
      formAction: "https://app.adwsites.com/form",
    };
    expect(() => renderSite({ ...base, layout: "hero-menu-about-contact" })).toThrow(TemplateVariantError);
    expect(() => renderSite({ ...base, colorSystem: "not-a-colour" })).toThrow(TemplateVariantError);
    expect(() => renderSite({ ...base, typePairing: "not-a-pairing" })).toThrow(TemplateVariantError);
  });
});

describe("render fixtures", () => {
  it("ships 20 fixtures spanning 3 families x layouts x 3 locales", () => {
    expect(RENDER_FIXTURES).toHaveLength(20);
    expect(new Set(RENDER_FIXTURES.map((f) => f.id)).size).toBe(20);
    expect(new Set(RENDER_FIXTURES.map((f) => f.familyId))).toEqual(
      new Set(["trades", "personal_services", "food_hospitality"]),
    );
    expect(new Set(RENDER_FIXTURES.map((f) => f.locale))).toEqual(new Set(["en-US", "en-GB", "en-AU"]));
    // Every layout offered by every family is exercised by at least one fixture.
    const covered = new Set(RENDER_FIXTURES.map((f) => `${f.familyId}:${f.layout}`));
    for (const fam of Object.values(FAMILIES)) {
      for (const layout of fam.layouts) expect(covered.has(`${fam.id}:${layout}`), `${fam.id}:${layout}`).toBe(true);
    }
    // Both build modes are covered.
    expect(new Set(RENDER_FIXTURES.map((f) => f.mode))).toEqual(new Set(["preview", "full"]));
  });

  it("every fixture holds the copy-slot ranges from config/templates.yaml", () => {
    for (const f of RENDER_FIXTURES) expect(() => validateSlots(f.copy), f.id).not.toThrow();
  });

  it("every fixture passes the reviewer gate", () => {
    for (const f of RENDER_FIXTURES) {
      const outcome = reviewBuild(buildArtifactFromHtml(renderFixture(f)));
      expect(outcome.failures, `${f.id} soft gates`).toEqual([]);
      expect(outcome.hardFailures, `${f.id} hard gates`).toEqual([]);
      expect(outcome.pass, f.id).toBe(true);
      expect(outcome.hardFail, f.id).toBe(false);
    }
  });

  it("every fixture is under 50KB so it loads in under a second on 3G", () => {
    for (const f of RENDER_FIXTURES) {
      expect(weightKb(renderFixture(f)), f.id).toBeLessThan(50);
    }
  });

  it("every fixture meets its a11y baseline", () => {
    for (const f of RENDER_FIXTURES) {
      expect(f.a11y.axeCriticalMax).toBe(0);
      expect(f.a11y.axeSeriousMax).toBe(0);
      expect(f.a11y.minContrastPairs.length).toBeGreaterThan(0);

      const cs = fixtureFamily(f).tokens.colorSystems.find((c) => c.id === f.colorSystem);
      expect(cs, `${f.id} colour system ${f.colorSystem}`).toBeDefined();
      for (const pair of f.a11y.minContrastPairs) {
        expect(pairContrast(cs!, pair), `${f.id} ${pair}`).toBeGreaterThanOrEqual(AA_CONTRAST_MIN);
      }

      // The gate's axe budget is the fixture's declared ceiling, not a looser one.
      const artifact = buildArtifactFromHtml(renderFixture(f));
      expect(artifact.axeCritical).toBeLessThanOrEqual(f.a11y.axeCriticalMax);
      expect(artifact.axeSerious).toBeLessThanOrEqual(f.a11y.axeSeriousMax);
    }
  });
});

describe("visual regression by content hash", () => {
  it("renderAllFixtures is deterministic across runs", () => {
    const first = renderAllFixtures();
    const second = renderAllFixtures();
    expect(first).toHaveLength(20);
    expect(first.map((s) => s.id)).toEqual(second.map((s) => s.id));
    expect(first.map((s) => s.contentHash)).toEqual(second.map((s) => s.contentHash));
    expect(snapshotManifest().suiteHash).toBe(snapshotManifest().suiteHash);
  });

  it("gives every fixture a distinct sha256 so any template change shows up", () => {
    const snaps = renderAllFixtures();
    expect(new Set(snaps.map((s) => s.contentHash)).size).toBe(snaps.length);
    for (const s of snaps) {
      expect(s.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.weightKb).toBeGreaterThan(0);
      expect(s.html).toContain("<!doctype html>");
    }
    expect(SNAPSHOT_VERSION).toMatch(/^site-templates-snapshot-v\d+$/);
  });
});
