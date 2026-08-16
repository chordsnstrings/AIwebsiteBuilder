// Loading config/watches.yaml.
//
// ⛔ The rule set is CLOSED and the loader rejects anything outside it. A
// materiality rule the detector does not implement would load happily, match
// nothing, and produce a watch that runs on schedule and never once reports —
// the exact shape of a component that succeeds at doing nothing.

import { config } from "@adw/config";
import { primaryArchetype } from "@adw/taxonomy";

export type WatchRule =
  | { kind: "any_change" }
  | { kind: "numeric_drop"; field: string; by?: number; pct?: number }
  | { kind: "numeric_rise"; field: string; by?: number; pct?: number }
  | { kind: "new_items" }
  | { kind: "removed_items" }
  | { kind: "text_appeared"; terms: string[] };

export const RULE_KINDS = [
  "any_change", "numeric_drop", "numeric_rise", "new_items", "removed_items", "text_appeared",
] as const;

/** The collectors a deployment must supply. A watch whose source has no
 *  collector is refused at subscribe time rather than silently never running. */
export type WatchSource =
  | "reviews" | "listing" | "serp" | "web_page" | "feed"
  | "register" | "index" | "weather" | "marketplace" | "uptime";

export const WATCH_SOURCES: readonly WatchSource[] = [
  "reviews", "listing", "serp", "web_page", "feed",
  "register", "index", "weather", "marketplace", "uptime",
];

export interface Watch {
  id: string;
  label: string;
  source: WatchSource;
  cadenceHours: number;
  severity: number;
  rule: WatchRule;
}

interface Loaded {
  version: string;
  watches: Record<string, Watch>;
  byArchetype: Record<string, string[]>;
}

let cache: Loaded | null = null;

export function clearWatchCache(): void {
  cache = null;
}

function parseRule(watchId: string, raw: Record<string, unknown> | undefined): WatchRule {
  const kind = raw?.["kind"];
  if (typeof kind !== "string" || !(RULE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`watches.yaml: "${watchId}" has rule kind ${String(kind)}, which the detector does not implement`);
  }
  switch (kind) {
    case "any_change":
    case "new_items":
    case "removed_items":
      return { kind };
    case "numeric_drop":
    case "numeric_rise": {
      const field = raw?.["field"];
      const by = raw?.["by"];
      const pct = raw?.["pct"];
      if (typeof field !== "string") throw new Error(`watches.yaml: "${watchId}" ${kind} needs a field`);
      // ⛔ A threshold rule with no threshold is `any_change` wearing a hat: it
      // would fire on every rounding difference.
      if (typeof by !== "number" && typeof pct !== "number") {
        throw new Error(`watches.yaml: "${watchId}" ${kind} needs a "by" or a "pct"`);
      }
      return {
        kind,
        field,
        ...(typeof by === "number" ? { by } : {}),
        ...(typeof pct === "number" ? { pct } : {}),
      };
    }
    default: {
      const terms = raw?.["terms"];
      if (!Array.isArray(terms) || terms.length === 0) {
        throw new Error(`watches.yaml: "${watchId}" text_appeared needs terms`);
      }
      return { kind: "text_appeared", terms: terms.map(String) };
    }
  }
}

function build(): Loaded {
  const file = config.watches();
  const data = file.data as Record<string, unknown>;
  const rawWatches = (data["watches"] ?? {}) as Record<string, Record<string, unknown>>;
  const watches: Record<string, Watch> = {};
  for (const [id, w] of Object.entries(rawWatches)) {
    const source = w["source"];
    if (typeof source !== "string" || !(WATCH_SOURCES as readonly string[]).includes(source)) {
      throw new Error(`watches.yaml: "${id}" has source ${String(source)}, which no collector kind covers`);
    }
    const cadence = w["cadence_hours"];
    if (typeof cadence !== "number" || cadence <= 0) {
      throw new Error(`watches.yaml: "${id}" needs a positive cadence_hours`);
    }
    watches[id] = {
      id,
      label: typeof w["label"] === "string" ? w["label"] : id,
      source: source as WatchSource,
      cadenceHours: cadence,
      severity: typeof w["severity"] === "number" ? w["severity"] : 4,
      rule: parseRule(id, w["rule"] as Record<string, unknown> | undefined),
    };
  }

  const rawSelection = (data["archetype_watches"] ?? {}) as Record<string, string[]>;
  const byArchetype: Record<string, string[]> = {};
  for (const [code, ids] of Object.entries(rawSelection)) {
    for (const id of ids ?? []) {
      if (watches[id] === undefined) {
        throw new Error(`watches.yaml: archetype ${code} selects unknown watch "${id}"`);
      }
    }
    byArchetype[code] = [...(ids ?? [])];
  }
  return { version: file.version, watches, byArchetype };
}

function loaded(): Loaded {
  if (cache === null) cache = build();
  return cache;
}

export function watchVersion(): string {
  return loaded().version;
}

export function watchesFor(vertical: string): Watch[] {
  const code = primaryArchetype(vertical);
  if (code === undefined) return [];
  return (loaded().byArchetype[code] ?? []).map((id) => loaded().watches[id]!).filter((w) => w !== undefined);
}

export function watchFor(vertical: string, watchId: string): Watch | undefined {
  return watchesFor(vertical).find((w) => w.id === watchId);
}

export function watchById(watchId: string): Watch | undefined {
  return loaded().watches[watchId];
}

export function allWatches(): Watch[] {
  return Object.values(loaded().watches);
}
