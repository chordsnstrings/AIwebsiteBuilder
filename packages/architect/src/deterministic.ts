// Deterministic classification and modifier detection.
//
// Modifiers reshape what a customer receives, so they are CODE rather than model
// output: the same business must produce the same manifest every time, and a
// manifest that varies between runs cannot be reviewed or reproduced.
//
// Classification is deterministic too, and confidence is the routing signal
// rather than a truth claim — an unmapped category lands below the escalation
// floor by construction, because an unclassifiable business produces a bad
// preview and refusing is the cheaper outcome.
import { config } from "@adw/config";
import { loadPlaybooks } from "./playbook.ts";
import type { ArchitectInput, Modifier, VerticalCode } from "./types.ts";

/**
 * Vendor category → playbook vertical. Kept here rather than in the playbook
 * because it is a mapping of someone else's taxonomy onto ours, and it changes
 * when a data vendor changes their categories rather than when the product does.
 */
const CATEGORY_TO_VERTICAL: Record<string, VerticalCode> = {
  roofer: "roofing",
  roofing: "roofing",
  roofing_contractor: "roofing",
  plumber: "plumber",
  plumbing: "plumber",
  electrician: "electrician",
  electrical_contractor: "electrician",
  hvac: "hvac",
  hvac_contractor: "hvac",
  heating: "hvac",
  landscaper: "landscaping",
  landscaping: "landscaping",
  gardener: "landscaping",
  pest_control: "pest_control",
  exterminator: "pest_control",
  accountant: "accountant",
  accounting: "accountant",
  bookkeeper: "accountant",
  lawyer: "lawyer",
  solicitor: "lawyer",
  attorney: "lawyer",
  law_firm: "lawyer",
  auto_repair: "auto_repair",
  mechanic: "auto_repair",
  body_shop: "auto_repair",
  cleaner: "cleaning",
  cleaning: "cleaning",
  cleaning_service: "cleaning",
  // Prohibited, but mapped so the Architect refuses EXPLICITLY rather than
  // falling through to "unclassifiable" and giving the wrong reason.
  dentist: "dentist",
  dental: "dentist",
  hair_salon: "hair_salon",
  salon: "hair_salon",
  barber: "hair_salon",
};

function normalise(category: string): string {
  return category.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Which trade family the taxonomy puts this category in, if any. */
function taxonomyFamily(category: string): string | undefined {
  const data = config.taxonomy().data as { families: Record<string, { categories: string[] }> };
  const key = normalise(category);
  for (const [family, row] of Object.entries(data.families ?? {})) {
    if (row.categories.includes(key)) return family;
  }
  return undefined;
}

export interface Classification {
  vertical: VerticalCode;
  confidence: number;
  /** Set when the signals point at more than one vertical with no clear winner. */
  conflicting?: boolean;
}

/**
 * Classify. Confidence is deliberately conservative:
 *   • a direct category match with a live site is strong evidence
 *   • a direct match with no site is weaker — the category is all we have
 *   • no mapping at all lands below the escalation floor by construction
 */
export function classifyDeterministic(input: ArchitectInput): Classification {
  const direct = CATEGORY_TO_VERTICAL[normalise(input.category)];
  if (direct !== undefined) {
    const conflicting = detectConflictingSignals(input, direct);
    return {
      vertical: direct,
      confidence: conflicting ? 0.55 : input.siteAudit.hasWebsite ? 0.92 : 0.81,
      ...(conflicting ? { conflicting: true } : {}),
    };
  }

  // No direct mapping. A family match tells us the shape but not the vertical,
  // and the playbooks are per-vertical — so this is not enough to build on.
  const family = taxonomyFamily(input.category);
  return { vertical: family === undefined ? "unknown" : `unmapped_${family}`, confidence: 0.4 };
}

/**
 * A business whose category says one thing and whose content says another.
 * Two verticals with no dominant one is an escalation, not a coin flip.
 */
function detectConflictingSignals(input: ArchitectInput, chosen: VerticalCode): boolean {
  const text = `${input.siteText ?? ""} ${(input.reviews?.texts ?? []).join(" ")}`.toLowerCase();
  if (text.trim().length === 0) return false;
  const hits = new Set<VerticalCode>();
  const cues: Record<VerticalCode, RegExp> = {
    roofing: /\broof(ing|s|er)?\b/,
    plumber: /\bplumb(ing|er)\b|\bboiler\b|\bdrain\b/,
    electrician: /\belectric(al|ian)\b|\brewir/,
    hvac: /\bhvac\b|\bair con|\bheat pump\b/,
    landscaping: /\blandscap|\bgarden(ing|er)\b/,
    pest_control: /\bpest\b|\bexterminat/,
    accountant: /\baccount(ing|ant)\b|\bbookkeep/,
    lawyer: /\bsolicitor\b|\blaw firm\b|\battorney\b/,
    auto_repair: /\bmot\b|\bcar repair\b|\bgarage servicing\b/,
    cleaning: /\bcleaning service\b|\bdomestic clean/,
  };
  for (const [vertical, re] of Object.entries(cues)) if (re.test(text)) hits.add(vertical);
  // The chosen vertical appearing alongside one other is normal cross-selling.
  // Two OTHER verticals with equal footing is genuine ambiguity.
  hits.delete(chosen);
  return hits.size >= 2;
}

/**
 * Detect modifiers. Deterministic and order-independent, driven by the detect
 * rules in the playbook plus the fields the audit already measured.
 */
export function detectModifiers(input: ArchitectInput): Modifier[] {
  const { data } = loadPlaybooks();
  const text = `${input.siteText ?? ""} ${(input.reviews?.texts ?? []).join(" ")} ${input.category}`.toLowerCase();
  const found = new Set<Modifier>();

  // Text-cue modifiers come from the playbook so the cues stay reviewable.
  for (const [name, rule] of Object.entries(data.modifiers ?? {})) {
    const cues = rule.detect;
    if (cues === undefined) continue;
    if (cues.some((c) => text.includes(c.toLowerCase()))) found.add(name as Modifier);
  }

  // Field-driven modifiers. These read measurements rather than prose, which is
  // why they are the reliable ones.
  if (!input.siteAudit.pricingFound) found.add("no_published_pricing");
  if (input.siteAudit.bookingFound) found.add("appointment_based");
  if (input.siteAudit.pageCount < 5 || input.siteAudit.wordCount < 400) found.add("thin_content");
  if ((input.gbp?.locationCount ?? 1) > 1) found.add("multi_location");
  if (input.franchiseMatch === true) found.add("franchise");

  const volume = input.reviews?.monthlyVolume ?? [];
  if (volume.length >= 6) {
    const max = Math.max(...volume);
    const min = Math.min(...volume);
    // Guard the divide: a business with a zero month is seasonal by definition,
    // not a division by zero.
    if (min === 0 ? max > 0 : max / min > 2) found.add("seasonal");
  }

  return [...found].sort();
}

/** Trades where a false certification claim is a regulatory problem. */
const REGULATED = /gas|electric|asbestos|medical|legal|financial|dental|pharma/i;

export function isRegulatedTrade(input: ArchitectInput, vertical: VerticalCode): boolean {
  return (
    REGULATED.test(vertical) ||
    REGULATED.test(input.category) ||
    ["plumber", "electrician", "hvac", "lawyer", "accountant"].includes(vertical)
  );
}
