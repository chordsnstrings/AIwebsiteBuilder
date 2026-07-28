// Reading config/playbooks.yaml. The catalogue this package classifies against.
//
// Everything here is a lookup, not a judgement. The point of pulling it into one
// file is that the catalogue check has exactly one implementation: if a module
// id can reach a manifest without passing through `assertInCatalogue`, the
// guarantee is gone.
import { config } from "@adw/config";
import { ManifestCatalogueError, type VerticalCode } from "./types.ts";

export interface VerticalPlaybook {
  label: string;
  booking_coverage: number;
  booking_model: string;
  photo_triage: boolean;
  pricing: string;
  event_triggers: string[];
  integrations: string[];
  site_modules: string[];
  agent_capabilities: string[];
  dashboard_panels: string[];
  refusals: { id: string; matches: string[]; reason: string }[];
}

export interface ModifierRule {
  detect?: string[];
  detect_field?: string;
  effects: Record<string, unknown>;
}

export interface Playbooks {
  version: number;
  max_booking_coverage: number;
  universal_refusals: { id: string; matches: string[]; reason: string }[];
  verticals: Record<string, VerticalPlaybook>;
  prohibited: Record<string, { label: string; booking_coverage: number; reason: string }>;
  modifiers: Record<string, ModifierRule>;
  escalation: { min_confidence: number; target_rate_max: number };
  retrieval: Record<string, number>;
  agent_eval: Record<string, number | string>;
}

export interface LoadedPlaybooks {
  data: Playbooks;
  /** Content-hashed. Stamped onto every manifest so a stored one can be read
   *  back against the catalogue as it stood when the build was reviewed. */
  version: string;
}

export function loadPlaybooks(): LoadedPlaybooks {
  const { data, version } = config.playbooks();
  return { data: data as Playbooks, version };
}

export function verticalPlaybook(vertical: VerticalCode): VerticalPlaybook | undefined {
  return loadPlaybooks().data.verticals[vertical];
}

/** Every module, capability, integration and panel any vertical may offer. */
export function catalogue(): {
  modules: Set<string>;
  capabilities: Set<string>;
  integrations: Set<string>;
  panels: Set<string>;
} {
  const { data } = loadPlaybooks();
  const modules = new Set<string>();
  const capabilities = new Set<string>();
  const integrations = new Set<string>();
  const panels = new Set<string>();
  for (const v of Object.values(data.verticals)) {
    for (const m of v.site_modules ?? []) modules.add(m);
    for (const c of v.agent_capabilities ?? []) capabilities.add(c);
    for (const i of v.integrations ?? []) integrations.add(i);
    for (const p of v.dashboard_panels ?? []) panels.add(p);
  }
  // Modifier effects may ADD modules and capabilities; those are still part of
  // the catalogue, because they are declared in the same version-controlled file.
  for (const rule of Object.values(data.modifiers ?? {})) {
    const effects = rule.effects as Record<string, unknown>;
    for (const m of (effects["adds_modules"] as string[] | undefined) ?? []) modules.add(m);
    for (const c of (effects["agent_capabilities"] as string[] | undefined) ?? []) capabilities.add(c);
    for (const p of (effects["adds_panels"] as string[] | undefined) ?? []) panels.add(p);
  }
  return { modules, capabilities, integrations, panels };
}

/**
 * ⛔ The catalogue check. A module id that is not in the playbook FAILS THE
 * BUILD — not a warning, not a filter. Silently dropping it would ship a
 * manifest that says less than the build actually did, and silently keeping it
 * would ship a module that does not exist.
 */
export function assertInCatalogue(manifest: {
  siteModules: string[];
  agentCapabilities: string[];
  integrations: string[];
  dashboardPanels: string[];
}): void {
  const cat = catalogue();
  const unknown: string[] = [];
  for (const m of manifest.siteModules) if (!cat.modules.has(m)) unknown.push(`site_module:${m}`);
  for (const c of manifest.agentCapabilities) if (!cat.capabilities.has(c)) unknown.push(`agent_capability:${c}`);
  for (const i of manifest.integrations) if (!cat.integrations.has(i)) unknown.push(`integration:${i}`);
  for (const p of manifest.dashboardPanels) if (!cat.panels.has(p)) unknown.push(`dashboard_panel:${p}`);
  if (unknown.length > 0) {
    throw new ManifestCatalogueError(
      `manifest names ${unknown.length} item(s) absent from the playbook catalogue: ${unknown.join(", ")}. ` +
        "Adding one is a config pull request, not a runtime decision.",
    );
  }
}

/** Verticals we refuse outright, with the measured reason. */
export function isProhibited(vertical: VerticalCode): { prohibited: boolean; reason?: string } {
  const row = loadPlaybooks().data.prohibited?.[vertical];
  return row === undefined ? { prohibited: false } : { prohibited: true, reason: row.reason };
}

/**
 * ⛔ Never launch into a vertical whose booking coverage already exceeds the
 * cap. Vertical SaaS owns booking there and the gap we sell against does not
 * exist — the playbook file is the record of that measurement.
 */
export function bookingCoverageTooHigh(vertical: VerticalCode): boolean {
  const { data } = loadPlaybooks();
  const row = data.verticals[vertical];
  if (row === undefined) return false;
  return row.booking_coverage > data.max_booking_coverage;
}
