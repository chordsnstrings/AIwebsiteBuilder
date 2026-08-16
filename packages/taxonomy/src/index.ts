// @adw/taxonomy — resolving what a business IS.
//
// 60 clusters, 145 trades, 10 archetypes, two segments. Everything in the system
// that used to carry its own list of nine SMB trades now asks here instead.
//
// ⛔ The archetype is the load-bearing key, not the trade. The catalogue's own
// standing rule is "config, not code: 14 engines carry all 815 units", and it
// collapses 60 verticals → 10 archetypes → 14 engines to get there. Sixty
// hand-written design registers, sixty playbooks and sixty protocol scopes
// would be sixty things to keep in sync and fifty-nine chances to miss one.
//
// So: defaults resolve per ARCHETYPE, and a trade overrides only where it
// genuinely differs. `pest_control` forbids photographic motion because
// discretion is what is being bought; that is a real per-trade fact. The rest
// of `Emergency home services` shares one register.

import { config } from "@adw/config";

export type Segment = "smb_local" | "enterprise_global";
export type ArchetypeCode = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";

export interface Cluster {
  id: string;
  n: number;
  label: string;
  segment: Segment;
  /** One or more; a cluster like `automotive_services` is genuinely A/B/D. */
  archetypes: ArchetypeCode[];
  examples: string;
  trades: string[];
}

export interface Taxonomy {
  version: string;
  archetypes: Record<string, string>;
  clusters: Cluster[];
  /** Vendor category strings that share no stem with the trade id. */
  aliases: Record<string, string[]>;
}

interface RawCluster {
  id?: string;
  n?: number;
  label?: string;
  segment?: string;
  archetypes?: string[];
  examples?: string;
  trades?: string[];
}

let cached: Taxonomy | null = null;

export function loadTaxonomy(): Taxonomy {
  if (cached !== null) return cached;
  const { data, version } = config.verticals();
  const raw = data as { archetypes?: Record<string, string>; clusters?: RawCluster[]; aliases?: Record<string, string[]> };
  const clusters: Cluster[] = (raw.clusters ?? []).map((c) => ({
    id: c.id ?? "",
    n: c.n ?? 0,
    label: c.label ?? c.id ?? "",
    segment: c.segment === "enterprise_global" ? "enterprise_global" : "smb_local",
    archetypes: (c.archetypes ?? []) as ArchetypeCode[],
    examples: c.examples ?? "",
    trades: c.trades ?? [],
  }));
  cached = { version, archetypes: raw.archetypes ?? {}, clusters, aliases: raw.aliases ?? {} };
  return cached;
}

export function clearTaxonomyCache(): void {
  cached = null;
}

/** Every trade id the system recognises, in cluster order. */
export function allTrades(): string[] {
  return loadTaxonomy().clusters.flatMap((c) => c.trades);
}

export function allClusters(): Cluster[] {
  return loadTaxonomy().clusters;
}

export function clusterOf(trade: string): Cluster | undefined {
  return loadTaxonomy().clusters.find((c) => c.trades.includes(trade));
}

export function clusterById(id: string): Cluster | undefined {
  return loadTaxonomy().clusters.find((c) => c.id === id);
}

/**
 * The archetypes a trade inherits.
 *
 * ⛔ Returns `[]` for a trade nobody has heard of rather than guessing at one.
 * A guessed archetype picks the wrong design register, the wrong refusal set
 * and the wrong escalation cadence, and does all three silently.
 */
export function archetypesOf(trade: string): ArchetypeCode[] {
  return clusterOf(trade)?.archetypes ?? [];
}

/** The single archetype to key defaults off. The first is the primary. */
export function primaryArchetype(trade: string): ArchetypeCode | undefined {
  return archetypesOf(trade)[0];
}

export function segmentOf(trade: string): Segment | undefined {
  return clusterOf(trade)?.segment;
}

export function isKnownTrade(trade: string): boolean {
  return clusterOf(trade) !== undefined;
}

/** Trades sharing an archetype — how a per-archetype default finds its members. */
export function tradesWithArchetype(code: ArchetypeCode): string[] {
  return loadTaxonomy()
    .clusters.filter((c) => c.archetypes.includes(code))
    .flatMap((c) => c.trades);
}

export function tradesInSegment(segment: Segment): string[] {
  return loadTaxonomy()
    .clusters.filter((c) => c.segment === segment)
    .flatMap((c) => c.trades);
}

/**
 * Reduce a word to a stem good enough to match trade morphology.
 *
 * ⛔ Deliberately crude and deliberately NOT a real stemmer. It only has to make
 * roofer≈roofing and plumber≈plumbing agree; a Porter stemmer would also make
 * unrelated trades collide, and a wrong trade is worse than an unresolved one.
 */
function stem(word: string): string {
  return word.replace(/(ers|er|ing|ings|s)$/i, "");
}

/**
 * Best-effort mapping from whatever a lead-data vendor called the business.
 *
 * ⛔ Returns undefined rather than a guess. The Architect escalates below its
 * confidence floor precisely because an unclassifiable business produces a bad
 * preview, and a bad preview is worse than no contact — so this must be able to
 * say "I don't know" rather than reaching for the nearest trade.
 */
export function resolveTrade(category: string): string | undefined {
  const needle = category.toLowerCase().trim();
  if (needle.length === 0) return undefined;
  const slug = needle.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (isKnownTrade(slug)) return slug;

  // Explicit synonyms, checked before anything fuzzy.
  for (const [trade, names] of Object.entries(loadTaxonomy().aliases)) {
    if (names.some((n) => needle.includes(n.toLowerCase()))) return trade;
  }

  // A trade id contained in the phrase: "emergency plumber", "roofing company".
  const trades = allTrades();
  const direct = trades.find((t) => t.split("_").every((w) => needle.includes(w)));
  if (direct !== undefined) return direct;

  // Morphological variants. "roofer" and "roofing" share the stem "roof";
  // so do plumber/plumbing and landscaper/landscaping. The hand-written map
  // this replaced listed each pair by hand and was missing most of them.
  const words = needle.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const stemmed = trades.find((t) =>
    t.split("_").every((part) => words.some((w) => stem(w) === stem(part))),
  );
  if (stemmed !== undefined) return stemmed;

  // The cluster's own example list, which is where vendor category strings
  // usually come from ("locksmith", "drainage", "boutique").
  for (const c of loadTaxonomy().clusters) {
    const examples = c.examples.toLowerCase();
    if (examples.length > 0 && examples.split(/[,/]/).some((e) => e.trim().length > 2 && needle.includes(e.trim()))) {
      return c.trades[0];
    }
  }
  return undefined;
}
