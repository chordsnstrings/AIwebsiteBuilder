// A complete stub activity set for exercising workflow DEFINITIONS.
//
// The definitions name their steps as strings and the engine resolves them at
// run time, so every test harness previously re-listed the whole set by hand.
// Adding a step to a workflow then broke every unrelated test at once, which
// taught the wrong lesson: the failure looked like the test's fault rather than
// a missing implementation.
//
// So there is one default set here, on the happy path, and a test overrides only
// the activity whose behaviour it is actually asserting. Two consequences worth
// keeping: adding a step is a one-line change in one place, and a test that
// forgets to override something still runs rather than throwing.
//
// ⛔ This is for definition tests only. It says nothing about whether the
// PRODUCTION activities exist — apps/worker/activities.test.ts owns that, by
// reading the activity names straight out of the definition source.
import type { Engine } from "./engine/index.ts";

export type ActivityFn = (input: unknown) => Promise<unknown>;

/** Happy-path returns for every activity the v3 definitions name. */
export function defaultStubActivities(): Record<string, ActivityFn> {
  return {
    // --- Pipeline A: lead ---------------------------------------------------
    // ⛔ `valid`, not `unknown`. A stub returning unknown would exercise the
    // allowed-through path only, and the suppression branch would go untested.
    verify_recipient: async () => ({ verdict: "valid" }),
    score_lead: async () => ({ icpScore: 78, previewWorthy: true }),
    grade_site: async () => ({ transactabilityGap: true, auditId: "audit-1", topDefects: ["no_schema"] }),
    classify_vertical: async () => ({ escalate: false, vertical: "roofing", manifestId: "manifest-1" }),
    // ⛔ SMB on the happy path, so the default exercises the preview branch.
    // The enterprise branch is asserted by overriding this in its own test —
    // a stub that returned enterprise here would silently stop testing the
    // whole of A4/A5/A6.
    resolve_acquisition_track: async () => ({ segment: "smb_local", speculativePreview: true }),
    open_enterprise_opportunity: async () => ({ opened: true, opportunityId: "opp-1", created: true }),
    extract_knowledge_base: async () => ({ kbId: "kb-1", factCount: 42 }),
    generate_qa_pack: async () => ({ packId: "pack-1", pairCount: 160, thin: false }),
    generate_preview: async () => ({ generated: true, agentBound: true }),
    send_outreach: async () => ({ sent: true }),
    mark_engaged: async () => null,
    mark_parked: async () => null,
    mark_exhausted: async () => null,
    mark_rejected: async () => null,
    raise_lead_exception: async () => null,

    // --- Pipeline C: build --------------------------------------------------
    assemble_and_render: async () => ({ artefactKey: "art/1" }),
    reviewer_gate: async () => ({ pass: true, hardFail: false }),
    patch_build: async () => null,
    ux_review: async () => ({ verdict: "accept" }),
    ip_screen: async () => ({ verdict: "pass" }),
    deploy_build: async () => ({ buildId: "build-1", url: "https://example.test" }),
    raise_build_exception: async () => null,

    // --- Pipeline C: revision ----------------------------------------------
    structure_change_request: async () => ({ requestedChanges: ["make the header blue"], injectionSuspected: false }),
    apply_revision: async () => ({ artefactKey: "art/rev-1" }),
    deploy_revision: async () => ({ buildId: "build-rev-1", url: "https://example.test/rev" }),
    raise_revision_exception: async () => null,

    // --- Pipeline C: onboarding --------------------------------------------
    record_payment: async () => null,
    create_customer: async () => ({ customerId: "cust-1" }),
    extract_knowledge_base_deep: async () => ({ kbId: "kb-deep-1" }),
    generate_qa_pack_deep: async () => ({ packId: "pack-deep-1", thin: false }),
    run_full_build: async () => ({ buildId: "build-1" }),
    activate_agent: async () => ({ activated: true }),
    // Default is a PASS so unrelated tests reach delivery; the tests that care
    // about the gate override this with a failing verdict.
    agent_eval_gate: async () => ({ verdict: "pass", passed: 30, total: 30, bookingSkipped: false }),
    deploy_customer_site: async () => ({ url: "https://cust.example.test" }),
    snapshot_dns: async () => ({ snapshotId: "snap-1" }),
    cutover_dns: async () => ({ status: "completed", mailRecordsChanged: false }),
    register_domain: async () => ({ domain: "example.test" }),
    verify_ssl: async () => ({ ok: true }),
    integration_verify: async () => ({ ok: true }),
    send_delivery_email: async () => ({ sent: true }),
    provision_dashboard: async () => null,
    raise_onboarding_exception: async () => null,

    // --- Subscription, payments, loops -------------------------------------
    renew_subscription: async () => null,
    start_dunning: async () => null,
    cancel_at_period_end: async () => null,
    process_refund: async () => null,
    payments_prescreen: async () => ({ offered: true }),
    create_connected_account: async () => ({ accountId: "acct-1" }),
    payments_integration_test: async () => ({ passed: true }),
    raise_payments_exception: async () => null,
    evaluate_fleet_health: async () => ({ evaluated: true }),
    run_nightly_evals: async () => ({ started: true }),
  };
}

/**
 * Register the default set, with overrides applied on top. Returns the call log
 * so a test can assert ORDER — which is the property most of these workflows
 * actually guarantee (reviewer before UX, eval gate before delivery).
 */
export function registerStubActivities(
  engine: Engine,
  overrides: Record<string, ActivityFn> = {},
): { calls: string[] } {
  const calls: string[] = [];
  const set = { ...defaultStubActivities(), ...overrides };
  for (const [name, fn] of Object.entries(set)) {
    engine.registerActivity(name, async (input: unknown) => {
      calls.push(name);
      return fn(input);
    });
  }
  return { calls };
}
