// Manifest assembly and the escalation rules.
//
// The manifest is the contract between the Architect and the build pipeline, and
// it is IMMUTABLE for the build that used it — the database enforces that with a
// trigger. A change is a new manifest and a new build, never an edit to the
// record a build was reviewed against.
import type { Db } from "@adw/db";
import { assertInCatalogue, bookingCoverageTooHigh, isProhibited, loadPlaybooks, verticalPlaybook } from "./playbook.ts";
import { classifyDeterministic, detectModifiers, isRegulatedTrade } from "./deterministic.ts";
import type {
  ArchitectDeps,
  ArchitectInput,
  ArchitectOutcome,
  DeliveryManifest,
  EscalationReason,
  Modifier,
  VerticalCode,
} from "./types.ts";

/**
 * Assemble the manifest from the vertical's baseline plus the modifiers'
 * effects. Deterministic: same vertical + same modifiers → same manifest.
 */
export function buildManifest(
  businessId: string,
  vertical: VerticalCode,
  confidence: number,
  modifiers: Modifier[],
  unresolved: string[] = [],
): DeliveryManifest {
  const { version } = loadPlaybooks();
  const playbook = verticalPlaybook(vertical);
  if (playbook === undefined) {
    throw new Error(`no playbook for vertical ${vertical}`);
  }

  let siteModules = [...(playbook.site_modules ?? [])];
  const agentCapabilities = new Set(playbook.agent_capabilities ?? []);
  const dashboardPanels = new Set(playbook.dashboard_panels ?? []);
  const integrations = [...(playbook.integrations ?? [])];
  const excluded: { feature: string; reason: string }[] = [];
  const questions = [...unresolved];

  if (modifiers.includes("emergency_service")) {
    if (!siteModules.includes("emergency")) siteModules.push("emergency");
    agentCapabilities.add("urgency_triage");
  }

  if (modifiers.includes("multi_location")) {
    if (!siteModules.includes("location_picker")) siteModules.push("location_picker");
  }

  if (modifiers.includes("no_published_pricing")) {
    // ⛔ The pricing module is REMOVED, not merely left empty. Shipping an empty
    // pricing page is an invitation for the agent to fill it, and the agent may
    // never estimate a price the business does not publish.
    siteModules = siteModules.filter((m) => m !== "pricing");
    excluded.push({
      feature: "pricing",
      reason: "This business publishes no prices. Quote request only; the agent never estimates.",
    });
  }

  if (modifiers.includes("b2b_serving")) {
    dashboardPanels.add("b2b_leads");
  }

  if (modifiers.includes("thin_content")) {
    // Not enough published content to build a pack from. Onboarding has to ask.
    excluded.push({
      feature: "extracted_qa_pack",
      reason: "Under 5 pages or 400 words published; the pack falls back to the vertical template",
    });
    for (const q of ["What services do you offer?", "Which areas do you cover?", "What are your opening hours?"]) {
      if (!questions.includes(q)) questions.push(q);
    }
  }

  if (playbook.photo_triage === false) {
    excluded.push({ feature: "photo_triage", reason: `Not offered for ${playbook.label}` });
  }

  const manifest: DeliveryManifest = {
    businessId,
    vertical,
    confidence,
    modifiers,
    siteModules,
    agentCapabilities: [...agentCapabilities].sort(),
    integrations,
    dashboardPanels: [...dashboardPanels].sort(),
    excluded,
    unresolved: questions,
    playbookVersion: version,
  };

  // ⛔ Every id must exist in the catalogue. Checked here rather than at the
  // call site so there is exactly one path to a manifest.
  assertInCatalogue(manifest);
  return manifest;
}

const escalate = (
  reason: EscalationReason,
  detail: string,
  confidence: number,
  vertical?: VerticalCode,
): ArchitectOutcome => ({
  escalate: true,
  reason,
  detail,
  confidence,
  ...(vertical === undefined ? {} : { vertical }),
});

/**
 * Classify a business and produce its manifest, or escalate.
 *
 * ⛔ Escalates rather than guessing. 📏 Target escalation rate under 6% — above
 * that the playbooks are too narrow, which is a config review rather than more
 * escalation.
 */
export async function classify(input: ArchitectInput, deps: ArchitectDeps = {}): Promise<ArchitectOutcome> {
  const { data } = loadPlaybooks();
  const floor = data.escalation.min_confidence;

  // ⛔ Already machine-readable AND bookable — the 11.6%. There is nothing to
  // sell them, and reaching here at all means the A1 score threshold let through
  // something it should have excluded.
  if (!input.siteAudit.transactabilityGap) {
    return escalate(
      "already_transactable",
      "Business is already machine-readable and bookable; upstream scoring should have excluded it",
      1,
    );
  }

  const result = deps.classify ? await deps.classify(input) : classifyDeterministic(input);
  const deterministic = classifyDeterministic(input);
  const vertical = result.vertical;
  const confidence = result.confidence;

  const prohibited = isProhibited(vertical);
  if (prohibited.prohibited) {
    return escalate("prohibited_vertical", prohibited.reason ?? "prohibited", confidence, vertical);
  }

  if (bookingCoverageTooHigh(vertical)) {
    return escalate(
      "booking_coverage_too_high",
      `Booking coverage in ${vertical} exceeds the cap; vertical SaaS already owns it`,
      confidence,
      vertical,
    );
  }

  if (verticalPlaybook(vertical) === undefined) {
    return escalate("low_confidence", `no playbook for "${vertical}"`, confidence, vertical);
  }

  const modifiers = detectModifiers(input);

  // ⛔ Franchise. Brand assets and copy are centrally controlled, so anything we
  // generate is a trademark problem rather than a service.
  if (modifiers.includes("franchise")) {
    return escalate("franchise", "Brand assets and copy are centrally controlled", confidence, vertical);
  }

  if (deterministic.conflicting === true) {
    return escalate(
      "conflicting_signals",
      "Signals point at two verticals with no dominant one",
      confidence,
      vertical,
    );
  }

  if (confidence < floor) {
    return escalate("low_confidence", `confidence ${confidence} below floor ${floor}`, confidence, vertical);
  }

  // A regulated trade whose registration we could not verify. The refusal set
  // is hard here and the IP screen becomes mandatory — but if we cannot even
  // establish they are registered, a human decides whether to proceed.
  if (isRegulatedTrade(input, vertical) && input.registrationVerified === false) {
    return escalate(
      "regulated_trade_unverified",
      `${vertical} is a regulated trade and its registration could not be verified`,
      confidence,
      vertical,
    );
  }

  return { escalate: false, manifest: buildManifest(input.businessId, vertical, confidence, modifiers) };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function persistManifest(db: Db, manifest: DeliveryManifest): Promise<string> {
  // Re-asserted on the way to storage. A manifest is data and could have been
  // assembled anywhere; this is the last point before a build reads it.
  assertInCatalogue(manifest);
  const row = await db.one<{ id: string }>(
    `INSERT INTO delivery_manifests (business_id, customer_id, vertical, confidence, modifiers,
                                     site_modules, agent_capabilities, integrations, dashboard_panels,
                                     excluded, unresolved, playbook_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      manifest.businessId,
      manifest.customerId ?? null,
      manifest.vertical,
      manifest.confidence,
      manifest.modifiers,
      JSON.stringify(manifest.siteModules),
      JSON.stringify(manifest.agentCapabilities),
      JSON.stringify(manifest.integrations),
      JSON.stringify(manifest.dashboardPanels),
      JSON.stringify(manifest.excluded),
      JSON.stringify(manifest.unresolved),
      manifest.playbookVersion,
    ],
  );
  return row.id;
}

export async function loadManifest(db: Db, id: string): Promise<DeliveryManifest | null> {
  const row = await db.maybeOne<{
    id: string;
    business_id: string;
    customer_id: string | null;
    vertical: string;
    confidence: string;
    modifiers: string[];
    site_modules: string[];
    agent_capabilities: string[];
    integrations: string[];
    dashboard_panels: string[];
    excluded: { feature: string; reason: string }[];
    unresolved: string[];
    playbook_version: string;
  }>(
    `SELECT id, business_id, customer_id, vertical, confidence, modifiers, site_modules,
            agent_capabilities, integrations, dashboard_panels, excluded, unresolved, playbook_version
       FROM delivery_manifests WHERE id = $1`,
    [id],
  );
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    ...(row.customer_id === null ? {} : { customerId: row.customer_id }),
    vertical: row.vertical,
    confidence: Number(row.confidence),
    modifiers: row.modifiers as Modifier[],
    siteModules: row.site_modules,
    agentCapabilities: row.agent_capabilities,
    integrations: row.integrations,
    dashboardPanels: row.dashboard_panels,
    excluded: row.excluded,
    unresolved: row.unresolved,
    playbookVersion: row.playbook_version,
  };
}
