// The Designer exists because of two measured failures, and these tests are
// mostly about whether those failures can recur.
//
// One: a dictated hero produced nine identical sites across nine trades.
// Two: handing the choice to the model in prose moved the sameness down a
// level — layout varied, and four of six landed on the same typeface.
//
// So the interesting assertions are not "does it return a manifest". They are
// "can two customers in one trade get the same site" and "can the model give
// itself something the vertical forbids".
import { describe, expect, it } from "vitest";
import {
  DesignCatalogueError,
  DesignRepetitionError,
  assertDiverse,
  assertInCatalogue,
  allowedPairings,
  chooseDeterministic,
  decideDesign,
  foldBudget,
  loadCatalogue,
  openOptions,
  renderDesignBrief,
  type DesignerInput,
  type DesignProposal,
} from "./src/index.ts";

const input = (over: Partial<DesignerInput> = {}): DesignerInput => ({
  businessId: "biz-0001",
  vertical: "roofing",
  businessName: "Ridgeline Roofing",
  about: "Storm damage and full replacements, Boise.",
  brandPrimary: "#C8102E",
  imageCount: 3,
  publishesPrices: false,
  ...over,
});

describe("the catalogue", () => {
  it("loads and stamps a content hash so a manifest can be read back against it", () => {
    const { data, version } = loadCatalogue();
    expect(version).toMatch(/^design@[0-9a-f]{7}$/);
    expect(Object.keys(data.hero_archetypes).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(data.verticals)).toContain("lawyer");
  });

  it("gives every vertical at least two archetypes and two type classes", () => {
    // One of either is a template with extra steps.
    const { data } = loadCatalogue();
    for (const [name, row] of Object.entries(data.verticals)) {
      expect(row.archetypes.length, `${name} archetypes`).toBeGreaterThanOrEqual(2);
      expect(row.type_classes.length, `${name} type classes`).toBeGreaterThanOrEqual(2);
    }
  });

  it("states a fold budget for every archetype", () => {
    // The fold requirement failed twice by ~20px when it was left to intuition.
    // A number per archetype makes it arithmetic.
    const { data } = loadCatalogue();
    for (const id of Object.keys(data.hero_archetypes)) {
      expect(foldBudget(id as never)).toBeGreaterThan(300);
      expect(foldBudget(id as never)).toBeLessThan(800);
    }
  });
});

describe("what a vertical may have", () => {
  it("⛔ refuses an archetype the vertical does not permit", () => {
    expect(() =>
      assertInCatalogue({
        vertical: "lawyer",
        heroArchetype: "split",
        typePairing: allowedPairings("lawyer")[0]!,
        motion: "still",
        density: "airy",
        parallax: false,
      }),
    ).toThrow(DesignCatalogueError);
  });

  it("⛔ refuses parallax where the vertical forbids photographic motion", () => {
    // Pest control is bought with embarrassment. Discretion is the product, and
    // no argument from the model overrides that.
    const pairing = allowedPairings("pest_control")[0]!;
    expect(() =>
      assertInCatalogue({
        vertical: "pest_control",
        heroArchetype: "stage",
        typePairing: pairing,
        motion: "measured",
        density: "airy",
        parallax: true,
      }),
    ).toThrow(/forbids photographic motion/);
  });

  it("⛔ refuses parallax under a motion vocabulary that does not allow it", () => {
    expect(() =>
      assertInCatalogue({
        vertical: "landscaping",
        heroArchetype: "split",
        typePairing: allowedPairings("landscaping")[0]!,
        motion: "measured",
        density: "airy",
        parallax: true,
      }),
    ).toThrow(/does not permit it/);
  });

  it("refuses a type pairing from a class the vertical may not use", () => {
    const loud = allowedPairings("auto_repair").find((p) => p.id === "archivo_inter")!;
    expect(() =>
      assertInCatalogue({
        vertical: "lawyer",
        heroArchetype: "typographic",
        typePairing: loud,
        motion: "still",
        density: "airy",
        parallax: false,
      }),
    ).toThrow(/is not in the classes/);
  });

  it("names an unknown vertical rather than falling back to a default", () => {
    expect(() => openOptions("submarine_repair", [], { hasPhotography: true })).toThrow(/No design rules/);
  });
});

describe("photography drives what is reachable", () => {
  it("drops archetypes that need a photograph when there are none", () => {
    const withNone = openOptions("roofing", [], { hasPhotography: false });
    expect(withNone.archetypes).not.toContain("split");
    expect(withNone.archetypes).not.toContain("frame");
    // Something must remain, or a business without photography cannot be built.
    expect(withNone.archetypes.length).toBeGreaterThan(0);
  });

  it("chooses a photography-free hero for a business with no images", () => {
    const m = chooseDeterministic(input({ imageCount: 0 }));
    expect(["stage", "typographic", "ledger"]).toContain(m.heroArchetype);
    expect(m.parallax).toBe(false);
  });
});

describe("⛔ two customers in one trade must not get the same site", () => {
  it("never repeats an archetype × pairing inside the diversity window", () => {
    const seen = new Set<string>();
    const history: { heroArchetype: string; typePairingId: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const m = chooseDeterministic(input({ businessId: `roofer-${i}`, history: [...history] }));
      const combo = `${m.heroArchetype}|${m.typePairing.id}`;
      expect(seen.has(combo), `repeat at #${i}: ${combo}`).toBe(false);
      seen.add(combo);
      history.unshift({ heroArchetype: m.heroArchetype, typePairingId: m.typePairing.id });
    }
    expect(seen.size).toBe(8);
  });

  it("rejects a repeat outright rather than nudging it", () => {
    const pairing = allowedPairings("hvac")[0]!;
    expect(() =>
      assertDiverse({ heroArchetype: "stage", typePairing: pairing }, [
        { heroArchetype: "stage", typePairingId: pairing.id },
      ]),
    ).toThrow(DesignRepetitionError);
  });

  it("⛔ leaves every vertical more combinations than the diversity window", () => {
    // The exhaustion branch exists, and with this catalogue it cannot fire —
    // which is the point. If a vertical ever has fewer archetype × pairing
    // combinations than the window, the ninth customer in that trade becomes
    // unbuildable and the failure lands on a real onboarding rather than here.
    const { data } = loadCatalogue();
    const window = data.diversity.window;
    for (const [name, row] of Object.entries(data.verticals)) {
      // Worst case: the business has no photography, so archetypes needing it
      // are already gone before the diversity guard even looks.
      const reachable = row.archetypes.filter((a) => data.hero_archetypes[a]?.needs_photography !== true);
      const combos = reachable.length * allowedPairings(name).length;
      expect(combos, `${name}: ${combos} combinations against a window of ${window}`).toBeGreaterThan(window);
    }
  });

  it("gives the same business the same design every time", async () => {
    // ⛔ A rebuild must never silently redesign a live site.
    const a = await decideDesign(input({ businessId: "stable-1" }));
    const b = await decideDesign(input({ businessId: "stable-1" }));
    expect(b.heroArchetype).toBe(a.heroArchetype);
    expect(b.typePairing.id).toBe(a.typePairing.id);
    expect(b.motion).toBe(a.motion);
    expect(b.sectionOrder).toEqual(a.sectionOrder);
  });

  it("varies the section order between businesses, not just the surface", () => {
    const orders = new Set<string>();
    for (let i = 0; i < 6; i++) orders.add(chooseDeterministic(input({ businessId: `b-${i}` })).sectionOrder.join(","));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("the model proposes, the catalogue disposes", () => {
  const proposal = (over: Partial<DesignProposal> = {}): DesignProposal => ({
    heroArchetype: "ledger",
    typePairingId: "archivo_inter",
    motion: "mechanical",
    parallax: false,
    density: "dense",
    sectionOrder: ["services", "proof", "about", "contact"],
    rationale: "A garage that publishes prices should lead with the menu.",
    ...over,
  });

  it("accepts a proposal that is inside the catalogue", async () => {
    const m = await decideDesign(input({ vertical: "auto_repair", publishesPrices: true }), {
      propose: async () => proposal(),
    });
    expect(m.heroArchetype).toBe("ledger");
    expect(m.typePairing.id).toBe("archivo_inter");
    expect(m.rationale).toMatch(/publishes prices/);
  });

  it("⛔ falls back to a deterministic choice when the proposal is not allowed", async () => {
    // Not negotiated with, not partially applied. A manifest half-chosen by a
    // model and half-patched by code is a design nobody decided.
    const m = await decideDesign(input({ vertical: "lawyer" }), {
      propose: async () => proposal({ heroArchetype: "split", typePairingId: "oswald_inter" }),
    });
    expect(loadCatalogue().data.verticals["lawyer"]!.archetypes).toContain(m.heroArchetype);
    expect(m.rationale).toMatch(/Chosen deterministically/);
  });

  it("falls back when the proposal repeats a recent design", async () => {
    const pairing = allowedPairings("hvac").find((p) => p.id === "manrope_inter") ?? allowedPairings("hvac")[0]!;
    const history = [{ heroArchetype: "stage", typePairingId: pairing.id }];
    const m = await decideDesign(input({ vertical: "hvac", history }), {
      propose: async () => proposal({ heroArchetype: "stage", typePairingId: pairing.id, motion: "measured", density: "airy" }),
    });
    expect(`${m.heroArchetype}|${m.typePairing.id}`).not.toBe(`stage|${pairing.id}`);
  });

  it("lets a thrown error from the model surface rather than swallowing it", async () => {
    await expect(
      decideDesign(input(), {
        propose: async () => {
          throw new Error("gateway exploded");
        },
      }),
    ).rejects.toThrow(/gateway exploded/);
  });
});

describe("the brief handed to the builder", () => {
  it("states the fold budget as a number, not a hope", async () => {
    const m = await decideDesign(input());
    const brief = renderDesignBrief(m);
    expect(brief).toMatch(/at most \*\*\d{3}px\*\*/);
    expect(brief).toMatch(/answer region begins/);
  });

  it("says plainly when there is no brand colour to derive from", async () => {
    const m = await decideDesign(input({ brandPrimary: undefined }));
    expect(m.palette.strategy).toBe("register_default");
    expect(renderDesignBrief(m)).toMatch(/no brand colour could be extracted/);
  });

  it("tells the builder to implement rather than reinterpret", async () => {
    const brief = renderDesignBrief(await decideDesign(input()));
    expect(brief).toMatch(/not a suggestion/i);
    expect(brief).toMatch(/implement it anyway/i);
  });
});
