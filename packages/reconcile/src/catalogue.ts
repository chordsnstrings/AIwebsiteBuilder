// Loading config/reconciliations.yaml.

import { config } from "@adw/config";
import { primaryArchetype } from "@adw/taxonomy";

export type MatchStrategy = "reference" | "amount_date" | "sum_to_one";
export const MATCH_STRATEGIES: readonly MatchStrategy[] = ["reference", "amount_date", "sum_to_one"];

export interface ReconType {
  id: string;
  label: string;
  oursLabel: string;
  theirsLabel: string;
  matchBy: MatchStrategy[];
  /** ⛔ Integer minor units. Money is never a float in this system, and a
   *  reconciliation is the one place a floating-point penny is guaranteed to be
   *  noticed. */
  toleranceCents: number;
  dateWindowDays: number;
  /** How many of ours a single one of theirs may aggregate. */
  sumMax: number;
  statutory: boolean;
}

interface Loaded {
  version: string;
  types: Record<string, ReconType>;
  byArchetype: Record<string, string[]>;
}

let cache: Loaded | null = null;
export function clearReconCache(): void {
  cache = null;
}

function build(): Loaded {
  const file = config.reconciliations();
  const data = file.data as Record<string, unknown>;
  const raw = (data["reconciliations"] ?? {}) as Record<string, Record<string, unknown>>;
  const types: Record<string, ReconType> = {};

  for (const [id, r] of Object.entries(raw)) {
    const matchBy = r["match_by"];
    if (!Array.isArray(matchBy) || matchBy.length === 0) {
      throw new Error(`reconciliations.yaml: "${id}" needs at least one match_by strategy`);
    }
    for (const s of matchBy) {
      if (!(MATCH_STRATEGIES as readonly string[]).includes(String(s))) {
        throw new Error(`reconciliations.yaml: "${id}" names strategy "${String(s)}", which the matcher does not implement`);
      }
    }
    const tolerance = r["tolerance_cents"];
    // ⛔ Integers only. A tolerance of 0.5 would silently truncate and a
    // tolerance expressed in pounds would be a hundredfold too generous.
    if (typeof tolerance !== "number" || !Number.isInteger(tolerance) || tolerance < 0) {
      throw new Error(`reconciliations.yaml: "${id}" tolerance_cents must be a non-negative integer of minor units`);
    }
    const sumMax = r["sum_max"];
    if (matchBy.includes("sum_to_one") && (typeof sumMax !== "number" || sumMax < 2)) {
      throw new Error(`reconciliations.yaml: "${id}" uses sum_to_one and needs a sum_max of at least 2`);
    }
    types[id] = {
      id,
      label: typeof r["label"] === "string" ? r["label"] : id,
      oursLabel: typeof r["ours"] === "string" ? r["ours"] : "Ours",
      theirsLabel: typeof r["theirs"] === "string" ? r["theirs"] : "Theirs",
      matchBy: matchBy.map(String) as MatchStrategy[],
      toleranceCents: tolerance,
      dateWindowDays: typeof r["date_window_days"] === "number" ? r["date_window_days"] : 0,
      sumMax: typeof sumMax === "number" ? sumMax : 0,
      statutory: r["statutory"] === true,
    };
  }

  const selection = (data["archetype_reconciliations"] ?? {}) as Record<string, string[]>;
  const byArchetype: Record<string, string[]> = {};
  for (const [code, ids] of Object.entries(selection)) {
    for (const id of ids ?? []) {
      if (types[id] === undefined) {
        throw new Error(`reconciliations.yaml: archetype ${code} selects unknown reconciliation "${id}"`);
      }
    }
    byArchetype[code] = [...(ids ?? [])];
  }
  return { version: file.version, types, byArchetype };
}

function loaded(): Loaded {
  if (cache === null) cache = build();
  return cache;
}

export function reconVersion(): string {
  return loaded().version;
}

export function reconTypesFor(vertical: string): ReconType[] {
  const code = primaryArchetype(vertical);
  if (code === undefined) return [];
  return (loaded().byArchetype[code] ?? []).map((id) => loaded().types[id]!).filter((t) => t !== undefined);
}

export function reconTypeFor(vertical: string, id: string): ReconType | undefined {
  return reconTypesFor(vertical).find((t) => t.id === id);
}

export function reconTypeById(id: string): ReconType | undefined {
  return loaded().types[id];
}

export function allReconTypes(): ReconType[] {
  return Object.values(loaded().types);
}
