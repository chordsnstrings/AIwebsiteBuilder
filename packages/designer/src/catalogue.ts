// Reading config/design-catalogue.yaml, and the two guards that make the
// Designer's freedom safe.
//
// `assertInCatalogue` is the same shape as the Architect's: a token the model
// invented fails the build rather than being silently dropped or silently kept.
//
// `assertDiverse` is the one that exists because of a measured failure. Told in
// prose to be different, the model varied layout and then put FOUR OF SIX sites
// in the same typeface. A model asked to avoid an attractor still walks to it.
// So the check is arithmetic over stored history, not a request in a prompt.

import { config } from "@adw/config";
import {
  DesignCatalogueError,
  DesignRepetitionError,
  type DesignManifest,
  type Density,
  type HeroArchetype,
  type MotionVocabulary,
  type TypePairing,
} from "./types.ts";

interface ArchetypeRow {
  label: string;
  description: string;
  needs_photography: boolean;
  fold_budget_px: number;
}
interface MotionRow {
  label: string;
  description: string;
  parallax_allowed: boolean;
  entrance: string;
}
interface VerticalRow {
  archetypes: string[];
  type_classes: string[];
  motion: string[];
  density: string[];
  forbid?: string[];
}
export interface Catalogue {
  version: number;
  hero_archetypes: Record<string, ArchetypeRow>;
  type_pairings: Record<string, TypePairing[]>;
  motion_vocabularies: Record<string, MotionRow>;
  density: Record<string, string>;
  verticals: Record<string, VerticalRow>;
  diversity: { window: number; distinct_on: string[]; min_history: number };
}

export interface LoadedCatalogue {
  data: Catalogue;
  version: string;
}

export function loadCatalogue(): LoadedCatalogue {
  const { data, version } = config.designCatalogue();
  return { data: data as Catalogue, version };
}

export function verticalRules(vertical: string): VerticalRow {
  const row = loadCatalogue().data.verticals[vertical];
  if (row === undefined) {
    throw new DesignCatalogueError(
      `No design rules for vertical "${vertical}". Adding one is a pull request against ` +
        "config/design-catalogue.yaml, not a runtime decision.",
    );
  }
  return row;
}

/** Every pairing this vertical is allowed to choose from, flattened. */
export function allowedPairings(vertical: string): TypePairing[] {
  const cat = loadCatalogue().data;
  const rules = verticalRules(vertical);
  const out: TypePairing[] = [];
  for (const cls of rules.type_classes) {
    const rows = cat.type_pairings[cls];
    if (rows === undefined) {
      throw new DesignCatalogueError(`Vertical "${vertical}" names type class "${cls}", which the catalogue does not define`);
    }
    out.push(...rows);
  }
  return out;
}

export function archetype(id: string): ArchetypeRow {
  const row = loadCatalogue().data.hero_archetypes[id];
  if (row === undefined) throw new DesignCatalogueError(`Unknown hero archetype "${id}"`);
  return row;
}

/** How much vertical space the hero may take before the answer must appear.
 *  Stated in pixels so the fold requirement is arithmetic, not intuition. */
export function foldBudget(id: HeroArchetype): number {
  return archetype(id).fold_budget_px;
}

/**
 * ⛔ Every token must exist in the catalogue AND be permitted for this vertical.
 *
 * Permission is the half that matters. `photographic` motion is a real
 * vocabulary and a real disaster on a pest-control site, where discretion is
 * the product — so the vertical forbids it and no argument from the model
 * overrides that.
 */
export function assertInCatalogue(m: Pick<DesignManifest, "vertical" | "heroArchetype" | "typePairing" | "motion" | "density" | "parallax">): void {
  const cat = loadCatalogue().data;
  const rules = verticalRules(m.vertical);
  const bad: string[] = [];

  if (cat.hero_archetypes[m.heroArchetype] === undefined) bad.push(`hero_archetype:${m.heroArchetype}`);
  else if (!rules.archetypes.includes(m.heroArchetype)) {
    bad.push(`hero_archetype:${m.heroArchetype} is not permitted for ${m.vertical}`);
  }

  const pairings = allowedPairings(m.vertical);
  if (!pairings.some((p) => p.id === m.typePairing.id)) {
    bad.push(`type_pairing:${m.typePairing.id} is not in the classes ${m.vertical} may use`);
  }

  if (cat.motion_vocabularies[m.motion] === undefined) bad.push(`motion:${m.motion}`);
  else if (!rules.motion.includes(m.motion)) bad.push(`motion:${m.motion} is not permitted for ${m.vertical}`);

  if (cat.density[m.density] === undefined) bad.push(`density:${m.density}`);
  else if (!rules.density.includes(m.density)) bad.push(`density:${m.density} is not permitted for ${m.vertical}`);

  if (m.parallax) {
    const motionRow = cat.motion_vocabularies[m.motion];
    if (motionRow !== undefined && !motionRow.parallax_allowed) {
      bad.push(`parallax with motion vocabulary "${m.motion}", which does not permit it`);
    }
    if (rules.forbid?.includes("photographic_motion") === true) {
      bad.push(`parallax in ${m.vertical}, which forbids photographic motion`);
    }
  }

  if (bad.length > 0) {
    throw new DesignCatalogueError(
      `Design manifest names ${bad.length} thing(s) the catalogue does not allow: ${bad.join("; ")}. ` +
        "Adding one is a config pull request, not a runtime decision.",
    );
  }
}

/**
 * ⛔ Two businesses in one vertical must not receive the same combination.
 *
 * The prose version of this rule — "two sites in the same vertical must differ"
 * — produced four identical type pairings out of six. Enumerating the options
 * in config and rejecting repeats here is what actually makes it true, and it
 * is cheap: the manifest is nine fields, so comparing is a set lookup.
 */
export function assertDiverse(
  m: Pick<DesignManifest, "heroArchetype" | "typePairing">,
  history: { heroArchetype: string; typePairingId: string }[],
): void {
  const { diversity } = loadCatalogue().data;
  if (history.length < diversity.min_history) return;
  const recent = history.slice(0, diversity.window);
  const clash = recent.find(
    (h) => h.heroArchetype === m.heroArchetype && h.typePairingId === m.typePairing.id,
  );
  if (clash !== undefined) {
    throw new DesignRepetitionError(
      `A site in this vertical within the last ${diversity.window} already uses ` +
        `${m.heroArchetype} + ${m.typePairing.id}. Two customers in one trade receiving the same ` +
        "composition and the same typeface is the template showing through.",
      { heroArchetype: m.heroArchetype, typePairing: m.typePairing.id },
    );
  }
}

/**
 * The options still open after the catalogue and the history have had their
 * say. Handed to the Designer so it chooses from what is actually available
 * rather than proposing something that will be rejected.
 */
export function openOptions(
  vertical: string,
  history: { heroArchetype: string; typePairingId: string }[],
  opts: { hasPhotography: boolean },
): { archetypes: HeroArchetype[]; pairings: TypePairing[]; motion: MotionVocabulary[]; density: Density[] } {
  const cat = loadCatalogue().data;
  const rules = verticalRules(vertical);
  const recent = history.slice(0, cat.diversity.window);

  const archetypes = rules.archetypes.filter((a) => {
    const row = cat.hero_archetypes[a];
    if (row === undefined) return false;
    // ⛔ No photographs means no archetype that needs one. A "split" hero with
    // an empty right column is worse than the typographic answer.
    if (row.needs_photography && !opts.hasPhotography) return false;
    return true;
  }) as HeroArchetype[];

  const usedCombos = new Set(recent.map((h) => `${h.heroArchetype}|${h.typePairingId}`));
  const pairings = allowedPairings(vertical).filter((p) =>
    archetypes.some((a) => !usedCombos.has(`${a}|${p.id}`)),
  );

  return {
    archetypes,
    pairings,
    motion: rules.motion as MotionVocabulary[],
    density: rules.density as Density[],
  };
}
