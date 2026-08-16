// Which acquisition motion a business gets, and what that motion refuses.
//
// ⛔ The refusals resolve from `segmentOf(vertical)`, which resolves from the
// canonical taxonomy — so a cluster added to config/verticals.yaml as
// `enterprise_global` is protected on the day it is added, with no second file
// to remember. Before this, "enterprise" existed in the taxonomy as a label and
// nothing anywhere read it.

import { config } from "@adw/config";
import { segmentOf, type Segment } from "@adw/taxonomy";

export type PricingModel = "published_band" | "quoted";
export type ApprovalAuthority = "owner" | "named_signatory";

export interface TrackStage {
  key: string;
  label: string;
  gate?: string;
  terminal: boolean;
}

export interface Gate {
  id: string;
  label: string;
  /** Evidence keys that must be present and non-empty on the opportunity. */
  requires: string[];
}

export interface Track {
  segment: Segment;
  label: string;
  /** ⛔ False for enterprise. Building an unofficial copy of a bank's website
   *  under their name and emailing the link is passing off. */
  speculativePreview: boolean;
  /** ⛔ False for enterprise. Nobody at a 40,000-person company can approve on
   *  the organisation's behalf over a magic link. */
  selfServeClaim: boolean;
  pricingModel: PricingModel;
  /** ⛔ True for enterprise in EVERY market, not only where a jurisdiction
   *  happens to demand it. */
  requiresRoleRelevance: boolean;
  requiresSecurityReview: boolean;
  requiresWrittenAgreement: boolean;
  approvalAuthority: ApprovalAuthority;
  outreachArtefact: "preview" | "business_case";
  stages: TrackStage[];
}

interface Loaded {
  version: string;
  tracks: Record<string, Track>;
  gates: Record<string, Gate>;
}

let cache: Loaded | null = null;
export function clearTrackCache(): void {
  cache = null;
}

const SEGMENTS: readonly Segment[] = ["smb_local", "enterprise_global"];

function build(): Loaded {
  const file = config.segments();
  const data = file.data as Record<string, unknown>;
  const rawGates = (data["gates"] ?? {}) as Record<string, { label?: string; requires?: string[] }>;
  const gates: Record<string, Gate> = {};
  for (const [id, g] of Object.entries(rawGates)) {
    if (!Array.isArray(g.requires) || g.requires.length === 0) {
      // ⛔ A gate with no requirements is a gate that always opens, and it looks
      // exactly like a gate on every board.
      throw new Error(`segments.yaml: gate "${id}" requires nothing — a gate that always opens is not a gate`);
    }
    gates[id] = { id, label: g.label ?? id, requires: [...g.requires] };
  }

  const rawSegments = (data["segments"] ?? {}) as Record<string, Record<string, unknown>>;
  const tracks: Record<string, Track> = {};
  for (const [segment, t] of Object.entries(rawSegments)) {
    if (!(SEGMENTS as readonly string[]).includes(segment)) {
      throw new Error(`segments.yaml: "${segment}" is not a segment in the taxonomy`);
    }
    const stages = ((t["stages"] ?? []) as { key?: string; label?: string; gate?: string; terminal?: boolean }[]).map(
      (s) => {
        if (typeof s.key !== "string") throw new Error(`segments.yaml: ${segment} has a stage with no key`);
        if (s.gate !== undefined && gates[s.gate] === undefined) {
          throw new Error(`segments.yaml: ${segment} stage "${s.key}" names unknown gate "${s.gate}"`);
        }
        return {
          key: s.key,
          label: s.label ?? s.key,
          terminal: s.terminal === true,
          ...(s.gate === undefined ? {} : { gate: s.gate }),
        };
      },
    );
    if (stages.length === 0) throw new Error(`segments.yaml: ${segment} has no stages`);

    const speculativePreview = t["speculative_preview"] === true;
    // ⛔ The one combination this file exists to make impossible. A future edit
    // that flips the enterprise flag "to test something" fails the build rather
    // than shipping a copy of a hospital's website to a hospital.
    if (segment === "enterprise_global" && speculativePreview) {
      throw new Error(
        "segments.yaml: enterprise_global may not enable speculative_preview. " +
          "Hosting an unofficial copy of an enterprise's website under their name is passing off.",
      );
    }
    const pricingModel = t["pricing_model"];
    if (pricingModel !== "published_band" && pricingModel !== "quoted") {
      throw new Error(`segments.yaml: ${segment} pricing_model must be published_band or quoted`);
    }
    if (segment === "enterprise_global" && pricingModel !== "quoted") {
      throw new Error("segments.yaml: enterprise_global must be quoted — a published SMB band disqualifies us before the first conversation");
    }

    tracks[segment] = {
      segment: segment as Segment,
      label: typeof t["label"] === "string" ? t["label"] : segment,
      speculativePreview,
      selfServeClaim: t["self_serve_claim"] === true,
      pricingModel,
      requiresRoleRelevance: t["requires_role_relevance"] === true,
      requiresSecurityReview: t["requires_security_review"] === true,
      requiresWrittenAgreement: t["requires_written_agreement"] === true,
      approvalAuthority: t["approval_authority"] === "named_signatory" ? "named_signatory" : "owner",
      outreachArtefact: t["outreach_artefact"] === "business_case" ? "business_case" : "preview",
      stages,
    };
  }
  for (const s of SEGMENTS) {
    if (tracks[s] === undefined) throw new Error(`segments.yaml: no track for segment "${s}"`);
  }
  return { version: file.version, tracks, gates };
}

function loaded(): Loaded {
  if (cache === null) cache = build();
  return cache;
}

export function trackVersion(): string {
  return loaded().version;
}

export function trackForSegment(segment: Segment): Track {
  return loaded().tracks[segment]!;
}

/**
 * The track for a trade.
 *
 * ⛔ An UNKNOWN trade gets the enterprise track, not the SMB one. Every refusal
 * on this list is a refusal; defaulting an unclassifiable business to the
 * permissive track means the first thing an unrecognised name receives is a
 * speculative copy of its website.
 */
export function trackFor(vertical: string): Track {
  const segment = segmentOf(vertical);
  return trackForSegment(segment ?? "enterprise_global");
}

export function gateById(id: string): Gate | undefined {
  return loaded().gates[id];
}

export function allGates(): Gate[] {
  return Object.values(loaded().gates);
}

export function stagesFor(segment: Segment): TrackStage[] {
  return trackForSegment(segment).stages;
}

/**
 * May a speculative preview be built for this business?
 *
 * ⛔ The single most consequential function in this package. `false` here is
 * not "we choose not to" — it is the difference between marketing and a
 * trademark complaint with a legal department already attached.
 */
export function mayBuildSpeculativePreview(vertical: string): boolean {
  return trackFor(vertical).speculativePreview;
}

/** May this business claim and subscribe without a human on our side? */
export function maySelfServe(vertical: string): boolean {
  return trackFor(vertical).selfServeClaim;
}
