// Loading config/asset-kinds.yaml.
//
// ⛔ Two rules are enforced at LOAD, not at use, because both of them are things
// a well-meaning edit to a YAML file would introduce and no test elsewhere
// would notice:
//
//   1. A generated asset may not be placed in a slot a reader takes as evidence
//      of work actually done. An AI render of a finished roof in a roofer's
//      gallery is a false statement about a job they did.
//   2. No asset kind may depict people. A generated photograph of "our team" is
//      a picture of people who do not exist presented as a business's staff.
//
// Both are the kind of thing that gets asked for, so both are structurally
// impossible rather than discouraged.

import { config } from "@adw/config";
import { primaryArchetype } from "@adw/taxonomy";
import { costCeilingCents, type MediaKind } from "@adw/vendors";

export interface AssetKind {
  id: string;
  label: string;
  kind: MediaKind;
  /** Where the renderer may place it. Always a decorative slot. */
  slot: string;
  size?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  maxPerMonth: number;
  /** Prepended to every prompt. The caller's words come after it. */
  subject: string;
}

interface Loaded {
  version: string;
  decorativeSlots: Set<string>;
  kinds: Record<string, AssetKind>;
  byArchetype: Record<string, string[]>;
}

let cache: Loaded | null = null;
export function clearAssetCache(): void {
  cache = null;
}

function build(): Loaded {
  const file = config.assetKinds();
  const data = file.data as Record<string, unknown>;
  const decorative = new Set<string>((data["decorative_slots"] as string[] | undefined) ?? []);
  if (decorative.size === 0) throw new Error("asset-kinds.yaml: decorative_slots is empty — nothing could be placed anywhere");

  const raw = (data["asset_kinds"] ?? {}) as Record<string, Record<string, unknown>>;
  const kinds: Record<string, AssetKind> = {};
  for (const [id, a] of Object.entries(raw)) {
    const kind = a["kind"];
    if (kind !== "image" && kind !== "video") {
      throw new Error(`asset-kinds.yaml: "${id}" kind must be image or video`);
    }
    const slot = a["slot"];
    if (typeof slot !== "string" || !decorative.has(slot)) {
      // ⛔ Rule 1.
      throw new Error(
        `asset-kinds.yaml: "${id}" targets slot "${String(slot)}", which is not decorative. ` +
          `A generated asset may not sit anywhere a reader will take as evidence of work done.`,
      );
    }
    // ⛔ Rule 2. `people: true` is not a supported configuration; it is a
    // configuration this system refuses to load.
    if (a["people"] !== false) {
      throw new Error(`asset-kinds.yaml: "${id}" must set people: false — generated depictions of a business's staff are never permitted`);
    }
    const subject = a["subject"];
    if (typeof subject !== "string" || subject.trim().length === 0) {
      throw new Error(`asset-kinds.yaml: "${id}" needs a subject — an unconstrained prompt is how a decorative slot becomes a documentary one`);
    }
    const maxPerMonth = a["max_per_month"];
    if (typeof maxPerMonth !== "number" || maxPerMonth <= 0) {
      throw new Error(`asset-kinds.yaml: "${id}" needs a positive max_per_month`);
    }
    kinds[id] = {
      id,
      label: typeof a["label"] === "string" ? a["label"] : id,
      kind,
      slot,
      maxPerMonth,
      // ⛔ The constraint is APPENDED here rather than trusted to the YAML.
      // `people: false` is a config assertion the model never sees; a kind
      // whose subject text forgot to say it would generate people anyway and
      // the flag would sit there being true about nothing.
      subject: withHardConstraints(subject.trim()),
      ...(typeof a["size"] === "string" ? { size: a["size"] } : {}),
      ...(typeof a["duration_seconds"] === "number" ? { durationSeconds: a["duration_seconds"] } : {}),
      ...(typeof a["aspect_ratio"] === "string" ? { aspectRatio: a["aspect_ratio"] } : {}),
    };
  }

  const selection = (data["archetype_assets"] ?? {}) as Record<string, string[]>;
  const byArchetype: Record<string, string[]> = {};
  for (const [code, ids] of Object.entries(selection)) {
    for (const id of ids ?? []) {
      if (kinds[id] === undefined) throw new Error(`asset-kinds.yaml: archetype ${code} selects unknown asset kind "${id}"`);
    }
    byArchetype[code] = [...(ids ?? [])];
  }
  return { version: file.version, decorativeSlots: decorative, kinds, byArchetype };
}

/**
 * The three things no generated asset may contain, added to every prompt.
 *
 * ⛔ Not a suggestion in the YAML. Every one of these has a corresponding rule
 * elsewhere — the loader's `people: false`, the brief checker's logo and
 * credential patterns — and this is the half of each that reaches the model.
 */
const HARD_CONSTRAINTS = "no people, no logos or brand marks, no text or signage";

function withHardConstraints(subject: string): string {
  return subject.toLowerCase().includes("no people") ? subject : `${subject}, ${HARD_CONSTRAINTS}`;
}

function loaded(): Loaded {
  if (cache === null) cache = build();
  return cache;
}

export function assetConfigVersion(): string {
  return loaded().version;
}

export function assetKindsFor(vertical: string): AssetKind[] {
  const code = primaryArchetype(vertical);
  if (code === undefined) return [];
  return (loaded().byArchetype[code] ?? []).map((id) => loaded().kinds[id]!).filter((k) => k !== undefined);
}

export function assetKindFor(vertical: string, id: string): AssetKind | undefined {
  return assetKindsFor(vertical).find((k) => k.id === id);
}

export function assetKindById(id: string): AssetKind | undefined {
  return loaded().kinds[id];
}

export function allAssetKinds(): AssetKind[] {
  return Object.values(loaded().kinds);
}

/** ⛔ Asked by the site renderer before it places anything. */
export function isDecorativeSlot(slot: string): boolean {
  return loaded().decorativeSlots.has(slot);
}

export function estimateCostCents(kind: AssetKind, model: string): number {
  return costCeilingCents(model);
}
