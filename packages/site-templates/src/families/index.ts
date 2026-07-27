// Family registry + taxonomy mapping (spec §41.1, §59). `config/taxonomy.yaml`
// owns the category → family mapping; this module resolves it. Taxonomy families
// with no shipped template (automotive, professional services, retail) route to
// the nearest shipped family via an explicit, reviewable table — never silently.
import { config } from "@adw/config";
import { trades } from "./trades.ts";
import { personalServices } from "./personal-services.ts";
import { foodHospitality } from "./food-hospitality.ts";
import type { TemplateFamily } from "./types.ts";

export * from "./types.ts";
export * from "./contrast.ts";
export { trades } from "./trades.ts";
export { personalServices } from "./personal-services.ts";
export { foodHospitality } from "./food-hospitality.ts";

/** Every shipped template family, keyed by the id used in config/templates.yaml. */
export const FAMILIES: Record<string, TemplateFamily> = {
  trades,
  personal_services: personalServices,
  food_hospitality: foodHospitality,
};

/**
 * Taxonomy families without their own shipped template, mapped to the shipped
 * family whose layouts and copy guidance fit best. Explicit so the mapping shows
 * up in review rather than being a fallback nobody reads.
 */
export const FAMILY_FALLBACKS: Record<string, string> = {
  automotive: "trades",
  professional_services: "personal_services",
  retail: "personal_services",
};

/** Used when a business record carries a category the taxonomy does not know. */
export const DEFAULT_FAMILY_ID = "trades";

interface TaxonomyShape {
  families?: Record<string, { label?: string; categories?: string[] }>;
}

/** The taxonomy family id for a normalised trade category, or undefined. */
export function taxonomyFamilyForCategory(category: string): string | undefined {
  const taxonomy = config.taxonomy().data as TaxonomyShape;
  const families = taxonomy.families ?? {};
  const needle = category.trim().toLowerCase();
  for (const [id, row] of Object.entries(families)) {
    if ((row.categories ?? []).some((c) => c.toLowerCase() === needle)) return id;
  }
  return undefined;
}

/** Resolve the template family a business category renders with (spec §41.1). */
export function familyForCategory(category: string): TemplateFamily {
  const taxonomyId = taxonomyFamilyForCategory(category);
  const shippedId = taxonomyId
    ? (FAMILIES[taxonomyId] ? taxonomyId : FAMILY_FALLBACKS[taxonomyId]) ?? DEFAULT_FAMILY_ID
    : DEFAULT_FAMILY_ID;
  return FAMILIES[shippedId] ?? trades;
}

/** Lookup by family id; throws rather than guessing (a wrong family is a wrong site). */
export function familyById(id: string): TemplateFamily {
  const fam = FAMILIES[id];
  if (!fam) throw new Error(`unknown template family: ${id}`);
  return fam;
}
