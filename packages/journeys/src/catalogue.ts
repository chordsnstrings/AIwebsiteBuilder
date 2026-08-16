// Loading and validating config/clocks.yaml and config/journeys.yaml.
//
// ⛔ The validation here FAILS rather than warns. A journey whose steps are not
// in increasing order sends two messages on the same day; a `save` journey with
// two steps is a second message to someone who has already told you they are
// leaving. Both are silent in production and obvious at load time, so they are
// caught at load time.

import { config } from "@adw/config";
import { primaryArchetype } from "@adw/taxonomy";

export interface Clock {
  id: string;
  label: string;
  /** Documentary: what date the caller is expected to supply. */
  anchor: string;
  /** Days from the anchor. Negative means "before" — you are reminded BEFORE a
   *  deadline and AFTER an event, and one signed number covers both. */
  offsetDays: number;
  /** ⛔ From config only. A caller cannot declare a licence renewal non-statutory. */
  statutory: boolean;
  /** Owner-queue rank, 1 most urgent. */
  severity: number;
  /** Present only where the next occurrence is knowable from this one. */
  recurDays?: number;
}

export interface JourneyStep {
  /** Days from the START of the run. Strictly increasing across the journey. */
  afterDays: number;
  template: string;
  purpose: string;
}

export interface Journey {
  id: string;
  label: string;
  kind: string;
  steps: JourneyStep[];
  stopOn: string[];
}

interface RawClock {
  id?: string;
  label?: string;
  anchor?: string;
  offset_days?: number;
  statutory?: boolean;
  severity?: number;
  recur_days?: number;
}

interface RawJourney {
  label?: string;
  kind?: string;
  steps?: { after_days?: number; template?: string; purpose?: string }[];
  stop_on?: string[];
}

interface Loaded {
  clockVersion: string;
  journeyVersion: string;
  clocksByArchetype: Record<string, Clock[]>;
  journeys: Record<string, Journey>;
  journeysByArchetype: Record<string, string[]>;
}

let cache: Loaded | null = null;

export function clearJourneyCache(): void {
  cache = null;
}

function build(): Loaded {
  const clocksFile = config.clocks();
  const journeysFile = config.journeys();

  const rawClocks = ((clocksFile.data as Record<string, unknown>)["archetype_clocks"] ?? {}) as Record<string, RawClock[]>;
  const clocksByArchetype: Record<string, Clock[]> = {};
  for (const [code, rows] of Object.entries(rawClocks)) {
    clocksByArchetype[code] = (rows ?? []).map((c) => {
      if (c.id === undefined || c.offset_days === undefined) {
        throw new Error(`clocks.yaml: archetype ${code} has a clock with no id or no offset_days`);
      }
      return {
        id: c.id,
        label: c.label ?? c.id,
        anchor: c.anchor ?? "unspecified",
        offsetDays: c.offset_days,
        statutory: c.statutory === true,
        severity: c.severity ?? 4,
        ...(c.recur_days === undefined ? {} : { recurDays: c.recur_days }),
      };
    });
  }

  const rawJourneys = ((journeysFile.data as Record<string, unknown>)["journeys"] ?? {}) as Record<string, RawJourney>;
  const journeys: Record<string, Journey> = {};
  for (const [id, j] of Object.entries(rawJourneys)) {
    const steps: JourneyStep[] = (j.steps ?? []).map((s) => ({
      afterDays: s.after_days ?? 0,
      template: s.template ?? id,
      purpose: s.purpose ?? "",
    }));
    if (steps.length === 0) throw new Error(`journeys.yaml: "${id}" has no steps`);
    // ⛔ Strictly increasing. Per-step deltas are how you end up with two steps
    // on the same day after somebody edits the middle one.
    for (let i = 1; i < steps.length; i++) {
      if (steps[i]!.afterDays <= steps[i - 1]!.afterDays) {
        throw new Error(`journeys.yaml: "${id}" step ${i} (after_days ${steps[i]!.afterDays}) does not come after step ${i - 1}`);
      }
    }
    const kind = j.kind ?? "care";
    // ⛔ The retention rule, enforced at load rather than trusted in prose: one
    // save message maximum. A second message to someone who has already said
    // they are leaving is not retention.
    if (kind === "save" && steps.length !== 1) {
      throw new Error(`journeys.yaml: "${id}" is kind: save and must have exactly one step, not ${steps.length}`);
    }
    journeys[id] = { id, label: j.label ?? id, kind, steps, stopOn: j.stop_on ?? [] };
  }

  const rawSelection = ((journeysFile.data as Record<string, unknown>)["archetype_journeys"] ?? {}) as Record<string, string[]>;
  const journeysByArchetype: Record<string, string[]> = {};
  for (const [code, ids] of Object.entries(rawSelection)) {
    for (const id of ids ?? []) {
      // ⛔ A selection naming a journey that does not exist is a typo that
      // silently removes a whole sequence from an archetype.
      if (journeys[id] === undefined) {
        throw new Error(`journeys.yaml: archetype ${code} selects unknown journey "${id}"`);
      }
    }
    journeysByArchetype[code] = [...(ids ?? [])];
  }

  return {
    clockVersion: clocksFile.version,
    journeyVersion: journeysFile.version,
    clocksByArchetype,
    journeys,
    journeysByArchetype,
  };
}

function loaded(): Loaded {
  if (cache === null) cache = build();
  return cache;
}

export function clockVersion(): string {
  return loaded().clockVersion;
}

export function journeyVersion(): string {
  return loaded().journeyVersion;
}

export function clocksFor(vertical: string): Clock[] {
  const code = primaryArchetype(vertical);
  if (code === undefined) return [];
  return loaded().clocksByArchetype[code] ?? [];
}

export function clockFor(vertical: string, kind: string): Clock | undefined {
  return clocksFor(vertical).find((c) => c.id === kind);
}

export function journeysFor(vertical: string): Journey[] {
  const code = primaryArchetype(vertical);
  if (code === undefined) return [];
  const ids = loaded().journeysByArchetype[code] ?? [];
  return ids.map((id) => loaded().journeys[id]!).filter((j) => j !== undefined);
}

export function journeyFor(vertical: string, journeyId: string): Journey | undefined {
  return journeysFor(vertical).find((j) => j.id === journeyId);
}

/** Every journey defined, regardless of archetype. Used by the stop-event
 *  handler, which must be able to stop a run whose archetype has since changed. */
export function allJourneys(): Journey[] {
  return Object.values(loaded().journeys);
}
