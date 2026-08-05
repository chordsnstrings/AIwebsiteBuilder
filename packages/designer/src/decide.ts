// The Designer's decision, and the fallback that runs when the model is absent
// or proposes something it may not have.
//
// ⛔ The model PROPOSES. The catalogue and the diversity guard DISPOSE. A
// proposal that fails either is not negotiated with — it is replaced by a
// deterministic choice from what was actually open. This is the difference
// between a design agent and a design suggestion.

import {
  assertDiverse,
  assertInCatalogue,
  foldBudget,
  loadCatalogue,
  openOptions,
  verticalRules,
} from "./catalogue.ts";
import {
  DesignCatalogueError,
  DesignRepetitionError,
  type DesignManifest,
  type DesignerInput,
  type Density,
  type HeroArchetype,
  type MotionVocabulary,
  type TypePairing,
} from "./types.ts";

/** What a model is asked to return. Deliberately tiny. */
export interface DesignProposal {
  heroArchetype: string;
  typePairingId: string;
  motion: string;
  parallax: boolean;
  density: string;
  sectionOrder: string[];
  rationale: string;
}

export interface DesignerDeps {
  /** Absent means the deterministic chooser decides alone, which is a valid
   *  configuration and the one an eval run uses. */
  propose?: (input: DesignerInput, options: ReturnType<typeof openOptions>) => Promise<DesignProposal>;
}

const DEFAULT_SECTIONS = ["proof", "services", "work", "about", "contact"];

/**
 * A stable index derived from the business id. Two businesses in one vertical
 * land on different starting points without anything random — the same business
 * must always produce the same design, or a rebuild silently redesigns a live
 * site.
 */
function seedIndex(businessId: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < businessId.length; i++) {
    h ^= businessId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return modulo === 0 ? 0 : Math.abs(h) % modulo;
}

/**
 * Choose deterministically from what is open. Used when there is no model, and
 * as the fallback when the model proposes something it may not have — which is
 * a routine outcome, not an error.
 */
export function chooseDeterministic(input: DesignerInput): Omit<DesignManifest, "catalogueVersion" | "palette"> {
  const history = input.history ?? [];
  const options = openOptions(input.vertical, history, { hasPhotography: input.imageCount > 0 });
  const rules = verticalRules(input.vertical);

  if (options.archetypes.length === 0) {
    throw new DesignCatalogueError(
      `No hero archetype is open for ${input.vertical} with ${input.imageCount} photographs. ` +
        "Either the vertical's archetype list is too narrow or the business has no usable imagery.",
    );
  }

  // A trade that publishes real figures gets the ledger where it is available —
  // the price list IS the page for those businesses.
  const preferLedger = input.publishesPrices && options.archetypes.includes("ledger");
  const archetypeChoices = preferLedger ? (["ledger"] as HeroArchetype[]) : options.archetypes;
  const used = new Set(history.slice(0, loadCatalogue().data.diversity.window).map((h) => `${h.heroArchetype}|${h.typePairingId}`));

  // Walk the open combinations from the business's own seed offset, and take
  // the first that is not already spent. Deterministic and repetition-free.
  const pairings = options.pairings.length > 0 ? options.pairings : [];
  const aStart = seedIndex(input.businessId, archetypeChoices.length);
  const pStart = seedIndex(`${input.businessId}:type`, Math.max(pairings.length, 1));

  let picked: { a: HeroArchetype; p: TypePairing } | undefined;
  outer: for (let ai = 0; ai < archetypeChoices.length; ai++) {
    const a = archetypeChoices[(aStart + ai) % archetypeChoices.length]!;
    for (let pi = 0; pi < pairings.length; pi++) {
      const p = pairings[(pStart + pi) % pairings.length]!;
      if (!used.has(`${a}|${p.id}`)) {
        picked = { a, p };
        break outer;
      }
    }
  }
  if (picked === undefined) {
    // Every open combination is spent. Widening the catalogue is the fix; a
    // silent repeat is not.
    throw new DesignRepetitionError(
      `Every archetype × type-pairing combination open to ${input.vertical} has been used within the ` +
        "diversity window. Add pairings or archetypes to config/design-catalogue.yaml.",
      { heroArchetype: archetypeChoices[0] ?? "?", typePairing: pairings[0]?.id ?? "?" },
    );
  }

  const motion = options.motion[seedIndex(`${input.businessId}:motion`, options.motion.length)] as MotionVocabulary;
  const density = options.density[seedIndex(`${input.businessId}:density`, options.density.length)] as Density;
  const motionRow = loadCatalogue().data.motion_vocabularies[motion];
  const parallax =
    motionRow?.parallax_allowed === true && rules.forbid?.includes("photographic_motion") !== true && input.imageCount >= 3;

  // Rotate the section order too. Two sites with the same archetype still read
  // differently if the page tells its story in a different order.
  const rot = seedIndex(`${input.businessId}:order`, DEFAULT_SECTIONS.length);
  const sectionOrder = [...DEFAULT_SECTIONS.slice(rot), ...DEFAULT_SECTIONS.slice(0, rot)];

  return {
    businessId: input.businessId,
    vertical: input.vertical,
    heroArchetype: picked.a,
    typePairing: picked.p,
    motion,
    parallax,
    density,
    sectionOrder,
    rationale:
      `Chosen deterministically from what the catalogue leaves open for ${input.vertical}: ` +
      `${picked.a} hero, ${picked.p.display} over ${picked.p.text}, ${motion} motion, ${density} density.`,
  };
}

function paletteFor(input: DesignerInput): DesignManifest["palette"] {
  const seeded = input.brandPrimary !== undefined && input.brandPrimary.trim().length > 0;
  return {
    strategy: seeded ? "brand_derived" : "register_default",
    ...(seeded ? { seed: input.brandPrimary } : {}),
    // Naming where the accent may appear is the intent behind the §3 area cap.
    accentUsage: ["primary action", "one rule or underline", "focus ring"],
  };
}

/**
 * Decide the design.
 *
 * Order matters: propose → catalogue → diversity → fall back. A proposal is
 * never partially accepted; if any part of it is not allowed the whole thing is
 * replaced, because a manifest half-chosen by a model and half-patched by code
 * is a design nobody decided.
 */
export async function decideDesign(input: DesignerInput, deps: DesignerDeps = {}): Promise<DesignManifest> {
  const { version } = loadCatalogue();
  const history = input.history ?? [];
  const palette = paletteFor(input);

  if (deps.propose !== undefined) {
    const options = openOptions(input.vertical, history, { hasPhotography: input.imageCount > 0 });
    try {
      const proposal = await deps.propose(input, options);
      const pairing = options.pairings.find((p) => p.id === proposal.typePairingId);
      if (pairing === undefined) throw new DesignCatalogueError(`proposed type pairing "${proposal.typePairingId}" is not open`);
      const candidate: DesignManifest = {
        businessId: input.businessId,
        vertical: input.vertical,
        heroArchetype: proposal.heroArchetype as HeroArchetype,
        typePairing: pairing,
        motion: proposal.motion as MotionVocabulary,
        parallax: proposal.parallax,
        density: proposal.density as Density,
        sectionOrder: proposal.sectionOrder.length > 0 ? proposal.sectionOrder : DEFAULT_SECTIONS,
        rationale: proposal.rationale,
        palette,
        catalogueVersion: version,
      };
      assertInCatalogue(candidate);
      assertDiverse(candidate, history);
      return candidate;
    } catch (err) {
      if (!(err instanceof DesignCatalogueError) && !(err instanceof DesignRepetitionError)) throw err;
      // Fall through. The proposal was outside what this vertical may have, or
      // repeated a recent one; the deterministic chooser picks from what is
      // genuinely open rather than negotiating with the model.
    }
  }

  const chosen = chooseDeterministic(input);
  const manifest: DesignManifest = { ...chosen, palette, catalogueVersion: version };
  assertInCatalogue(manifest);
  assertDiverse(manifest, history);
  return manifest;
}

/** The manifest rendered into the block the builder receives. */
export function renderDesignBrief(m: DesignManifest): string {
  const cat = loadCatalogue().data;
  const arch = cat.hero_archetypes[m.heroArchetype];
  const motion = cat.motion_vocabularies[m.motion];
  const lines = [
    "## The design decision — already made",
    "",
    "A Designer chose this before you were called. ⛔ It is not a suggestion and",
    "not a starting point: implement it. If you believe something here is wrong,",
    "say so in a CSS comment and implement it anyway — the decision is reviewable,",
    "and a builder quietly overriding it is how a catalogue stops meaning anything.",
    "",
    `- **Hero archetype:** ${arch?.label ?? m.heroArchetype} — ${arch?.description ?? ""}`,
    `- **Fold budget:** the hero may occupy at most **${foldBudget(m.heroArchetype)}px** before the`,
    "  answer region begins, so that a tapped question answers above 1000px.",
    `- **Type:** ${m.typePairing.display} for display, ${m.typePairing.text} for text.` +
      (m.typePairing.note === undefined ? "" : ` (${m.typePairing.note})`),
    `- **Motion:** ${motion?.label ?? m.motion} — ${motion?.description ?? ""}`,
    `- **Parallax:** ${m.parallax ? "yes, on one photographic band below the fold" : "no"}`,
    `- **Density:** ${m.density} — ${cat.density[m.density] ?? ""}`,
    `- **Section order below the hero:** ${m.sectionOrder.join(" → ")}`,
    `- **Palette:** ${m.palette.strategy === "brand_derived"
      ? `derive from the brand seed ${m.palette.seed}`
      : "register default — no brand colour could be extracted, and the stylesheet must say so"}`,
    `- **Accent appears on:** ${m.palette.accentUsage.join(", ")} — nowhere else.`,
    "",
    `Rationale on record: ${m.rationale}`,
  ];
  return lines.join("\n");
}
