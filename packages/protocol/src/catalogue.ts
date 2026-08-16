// Loading config/protocols.yaml, and refusing to load a broken one.
//
// ⛔ This loader is strict in a way the others are not. Elsewhere an unknown key
// is a shrug; here an interlock name that does not resolve means a safety
// constraint silently does not apply, and the failure is invisible until the
// day it matters. So the load fails loudly instead.

import { config } from "@adw/config";
import { ProtocolCatalogueError, type Protocol, type ProtocolCatalogue, type Severity } from "./types.ts";

interface RawProtocol {
  id?: string;
  label?: string;
  severity?: number;
  safety_critical?: boolean;
  verticals?: string[];
  detection?: string;
  triggers?: string[];
  interlocks?: string[];
  capture?: string;
  stays_human?: string;
  escalation?: { after_minutes?: number; notify?: string }[];
}

let cached: ProtocolCatalogue | null = null;

export function loadProtocols(): ProtocolCatalogue {
  if (cached !== null) return cached;
  const { data, version } = config.protocols();
  const raw = data as {
    interlocks?: Record<string, string>;
    notify_roles?: Record<string, string>;
    protocols?: RawProtocol[];
  };

  const interlocks = raw.interlocks ?? {};
  const notifyRoles = raw.notify_roles ?? {};
  const bad: string[] = [];
  const seen = new Set<string>();
  const protocols: Protocol[] = [];

  for (const p of raw.protocols ?? []) {
    if (p.id === undefined || p.id.length === 0) {
      bad.push("a protocol with no id");
      continue;
    }
    if (seen.has(p.id)) bad.push(`duplicate protocol id "${p.id}"`);
    seen.add(p.id);

    for (const name of p.interlocks ?? []) {
      // ⛔ The check this loader exists for.
      if (!(name in interlocks)) bad.push(`${p.id} names interlock "${name}", which the catalogue does not define`);
    }
    for (const step of p.escalation ?? []) {
      if (step.notify !== undefined && !(step.notify in notifyRoles)) {
        bad.push(`${p.id} escalates to "${step.notify}", which is not a notify role`);
      }
    }

    const detection = p.detection === "automatic" ? "automatic" : "manual";
    const patterns = p.triggers ?? [];
    // ⛔ Automatic detection with no patterns is a protocol that claims to watch
    // for something and does not. Caught here rather than discovered in an
    // incident review.
    if (detection === "automatic" && patterns.length === 0) {
      bad.push(`${p.id} is marked automatic but has no trigger patterns`);
    }
    if (detection === "manual" && patterns.length > 0) {
      bad.push(`${p.id} is marked manual but carries trigger patterns — one of the two is wrong`);
    }

    let triggers: RegExp[];
    try {
      triggers = patterns.map((s) => new RegExp(s, "i"));
    } catch (err) {
      bad.push(`${p.id} has an invalid trigger pattern: ${String(err)}`);
      triggers = [];
    }

    const severity = (p.severity === 1 || p.severity === 2 || p.severity === 3 ? p.severity : 3) as Severity;
    // A safety-critical protocol at anything other than severity 1 would page
    // late. The two fields have to agree.
    if (p.safety_critical === true && severity !== 1) {
      bad.push(`${p.id} is safety_critical but severity ${severity}`);
    }

    protocols.push({
      id: p.id,
      label: p.label ?? p.id,
      severity,
      safetyCritical: p.safety_critical === true,
      verticals: p.verticals ?? [],
      detection,
      triggers,
      interlocks: p.interlocks ?? [],
      capture: p.capture ?? "",
      ...(p.stays_human === undefined || p.stays_human.length === 0 ? {} : { staysHuman: p.stays_human }),
      escalation: (p.escalation ?? []).map((s) => ({
        afterMinutes: s.after_minutes ?? 0,
        notify: s.notify ?? "owner",
      })),
    });
  }

  if (bad.length > 0) {
    throw new ProtocolCatalogueError(
      `config/protocols.yaml is not loadable — ${bad.length} problem(s):\n  ${bad.join("\n  ")}\n` +
        "A protocol that does not load is a protocol that does not fire, so this fails the process rather than degrading.",
    );
  }

  cached = { version, interlocks, notifyRoles, protocols };
  return cached;
}

/** Test seam. */
export function clearProtocolCache(): void {
  cached = null;
}

/** Protocols that apply to a vertical, most severe first. */
export function protocolsFor(vertical: string): Protocol[] {
  return loadProtocols()
    .protocols.filter((p) => p.verticals.includes("*") || p.verticals.includes(vertical))
    .sort((a, b) => a.severity - b.severity);
}

export function protocolById(id: string): Protocol | undefined {
  return loadProtocols().protocols.find((p) => p.id === id);
}

/** The human-readable text of an interlock, for the incident record and the UI. */
export function interlockText(name: string): string {
  const text = loadProtocols().interlocks[name];
  if (text === undefined) throw new ProtocolCatalogueError(`Unknown interlock "${name}"`);
  return text;
}
