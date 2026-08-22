// The complete customer journey, driven end to end against an empty database.
//
// One process on purpose: the mock transport is an in-process singleton, and
// reading the ACTUAL emails out of it — not the ledger rows about them — is the
// point of the exercise. Everything else is the production wiring: the real
// sourcing function, the real intent outbox drained by the real dispatcher job,
// the real engine replaying the real workflows, the real API routes for the
// human moments (claim, pack approval), the real gate in front of every send.
import { createDb, migrate } from "@adw/db";
import { seedRegistry, setChampion, type RoleId } from "@adw/registry";
import { config } from "@adw/config";
import { LocalKeyWrapper, LocalPgBackend } from "@adw/vault";
import { Engine } from "@adw/workflows";
import {
  buildWorkflow,
  leadWorkflow,
  onboardingWorkflow,
  revisionWorkflow,
  subscriptionWorkflow,
  paymentsOnboardingWorkflow,
  deliverabilityLoopWorkflow,
  evalLoopWorkflow,
} from "@adw/workflows";
import { remainingSendCapacity, sourceLeads } from "@adw/provenance";
import {
  getEmailTransport,
  resolveCompanyRegistry,
  resolveEmailVerifier,
  resolveLeadSource,
  resolveObjectStore,
} from "@adw/vendors";
import { registerActivities } from "./src/activities.ts";
import { intentDispatcherJob, workflowTimerJob } from "./src/jobs.ts";
import { createApp } from "../api/src/app.ts";
import type { SessionUser } from "@adw/auth";

const url = process.env.DATABASE_ADMIN_URL!;
const db = await createDb({ backend: "pg", url });
const step = (n: string) => console.log(`\n═══ ${n} ═══`);

// ---------------------------------------------------------------------------
step("0 · bootstrap: schema, champions, fleet — nothing else");
await migrate(db);
await seedRegistry(db);
for (const [role, r] of Object.entries(config.registry().data.roles)) {
  const has = await db.maybeOne("SELECT champion FROM registry_roles WHERE role=$1 AND champion IS NOT NULL", [role]);
  if (!has) {
    const run = await db.one<{ id: string }>(
      "INSERT INTO eval_runs (role, suite, candidate, metric, metric_value) VALUES ($1,$2,$3,$4,0.9) RETURNING id",
      [role, r.eval_suite, r.candidates[0], r.selection_metric],
    );
    await setChampion(db, role as RoleId, r.candidates[0]!, run.id, 0.9);
  }
}
for (const d of ["outreach-a.example", "outreach-b.example"]) {
  await db.query(
    `INSERT INTO sending_assets (kind, provider, identifier, domain_class, pool, health, daily_cap, warmup_started, first_send_at)
     VALUES ('domain','google_workspace',$1,'burner','cold','healthy',2000, now()-interval '30 days', now()-interval '30 days')
     ON CONFLICT (identifier) DO NOTHING`,
    [`@${d}`],
  );
  for (let i = 1; i <= 3; i++) {
    await db.query(
      `INSERT INTO sending_assets (kind, provider, identifier, domain_class, pool, health, daily_cap, warmup_started, first_send_at)
       VALUES ('mailbox','google_workspace',$1,'burner','cold','healthy',40, now()-interval '30 days', now()-interval '30 days')
       ON CONFLICT (identifier) DO NOTHING`,
      [`hello${i}@${d}`],
    );
  }
}
console.log("bootstrapped");

// The production engine + activity registry + workflows, exactly as worker.ts wires them.
const vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
const engine = new Engine({ db });
for (const wf of [leadWorkflow, buildWorkflow, onboardingWorkflow, revisionWorkflow, subscriptionWorkflow,
                  paymentsOnboardingWorkflow, deliverabilityLoopWorkflow, evalLoopWorkflow]) {
  engine.registerWorkflow(wf as never);
}
// ⛔ Pinned to a Tuesday afternoon, through the activities' own injectable
// clock. Run on the real clock this drive proved something better first: on a
// Saturday the gate refuses every cold send in every market — weekends are
// outside the send window — so an autonomous run today lawfully sends nothing.
// The pin simulates a weekday; every gate rule still evaluates against it.
const PINNED = new Date("2026-08-25T13:00:00Z"); // Tue 14:00 London, 09:00 New York
registerActivities(engine, { db, vault, forceMock: true, publicBase: "https://p.adwpreview.com", now: () => PINNED });

const dispatcher = intentDispatcherJob(engine, db);
const timers = workflowTimerJob(engine);
const drain = async (): Promise<void> => {
  // A few rounds: one workflow's step enqueues the intent the next round starts.
  for (let i = 0; i < 6; i++) {
    await dispatcher.run({ db, now: new Date() } as never);
    await timers.run({ db, now: new Date() } as never);
  }
};
const transport = getEmailTransport("google_workspace") as unknown as {
  sentMessages(): readonly { to: string; subject: string; body: string }[];
};
const brandTransport = getEmailTransport("aws_ses") as unknown as {
  sentMessages(): readonly { to: string; subject: string; body: string }[];
};

// ---------------------------------------------------------------------------
step("1+2 · the machine fetches customers and works them until one clears the gate");
// The production sourcing job runs hourly, forever; a batch whose every send is
// lawfully denied (quiet hours in the Americas, no PECR basis) is an ordinary
// hour, not a failure. The drive mirrors that: keep sourcing until a send goes.
const deps = {
  verifier: await resolveEmailVerifier({ vault, forceMock: true }),
  fetcher: { fetch: async (u: string) => ({ text: `Listing for ${u}. Contact us for a quote.`, screenshot: Buffer.from("png") }) },
  store: { put: async (k: string, d: Buffer) => void (await (await resolveObjectStore({ vault, forceMock: true })).put(k, d)) },
  registry: await resolveCompanyRegistry({ vault, forceMock: true }),
};
const source = (await resolveLeadSource({ vault, forceMock: true }))!;
let sent = 0;
for (let batch = 1; batch <= 8 && sent === 0; batch++) {
  const out = await sourceLeads(db, source, deps, { query: `trades-batch-${batch}`, maxRecords: 40 });
  await drain();
  const funnel = await db.one<{ previews: string; sent: string }>(
    `SELECT (SELECT count(*) FROM previews) AS previews,
            (SELECT count(*) FROM messages WHERE sent_at IS NOT NULL) AS sent`,
  );
  sent = Number(funnel.sent);
  console.log(`batch ${batch}: ingested ${out.ingested}, previews ${funnel.previews}, sent ${funnel.sent}, capacity ${await remainingSendCapacity(db)}`);
}
if (sent === 0) throw new Error("no send cleared the gate across 8 batches");

// A lead whose cold email actually went out, with its preview.
const lead = await db.maybeOne<{ lead_id: string; claim_token: string; email: string; name: string; deploy_url: string }>(
  `SELECT l.id AS lead_id, p.claim_token, ct.email::text AS email, b.name, p.deploy_url
     FROM leads l
     JOIN previews p ON p.id = l.preview_id
     JOIN contacts ct ON ct.id = l.contact_id
     JOIN businesses b ON b.id = ct.business_id
     JOIN conversations cv ON cv.lead_id = l.id
     JOIN messages m ON m.conversation_id = cv.id AND m.sent_at IS NOT NULL
    ORDER BY m.sent_at DESC LIMIT 1`,
);
if (!lead) throw new Error("no lead completed the outreach path");
const coldMail = [...transport.sentMessages()].reverse().find((m) => m.to === lead.email);
console.log(`\n--- the cold email ${lead.email} received ---`);
console.log(`Subject: ${coldMail?.subject}\n${coldMail?.body}`);
if (!coldMail?.body.includes(lead.deploy_url)) throw new Error("cold email does not carry the preview URL");

// ---------------------------------------------------------------------------
step("3 · the customer claims their preview (public API route)");
const publicApp = createApp({ db, vault, forceMock: true });
const claim = await publicApp.request(`/previews/${lead.claim_token}/claim`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
console.log(`claim → ${claim.status}`, await claim.json());

step("4 · onboarding runs: payment → deep KB → deep pack → full build → (parks for approval)");
await drain();
const onb = await db.one<{ status: string }>(
  "SELECT status FROM workflow_executions WHERE id = $1", [`onboarding:${lead.lead_id}`],
);
// The deep pack belongs to the customer this onboarding created — and after
// the packId fix it is its own row, with the customer attached at persist.
const pack = await db.maybeOne<{ id: string; pair_count: number; approval_kind: string | null }>(
  `SELECT p.id, p.pair_count, p.approval_kind FROM qa_packs p
    WHERE p.customer_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1`,
);
if (pack?.approval_kind != null) throw new Error(`deep pack pre-approved as '${pack.approval_kind}' — the owner has not signed`);
console.log(`onboarding: ${onb.status}, deep pack ${pack?.id} with ${pack?.pair_count} pairs`);

step("5 · the owner approves their agent's answers (authenticated API route)");
const owner: SessionUser = { id: "own", email: "owner@example.com", role: "customer", customerId: null, totpEnabled: false };
const ownerApp = createApp({ db, vault, forceMock: true, authOverride: owner });
const approve = await ownerApp.request(`/agent/packs/${pack!.id}/approve`, { method: "POST", body: "{}" });
console.log(`approve → ${approve.status}`, await approve.json());

step("6 · onboarding resumes: eval gate → deploy → verify → DELIVERY EMAIL → dashboard");
await drain();
const customer = await db.one<{ id: string; contact_email: string }>(
  `SELECT id, contact_email::text AS contact_email FROM customers ORDER BY won_at DESC NULLS LAST LIMIT 1`,
);
const deploy = await db.maybeOne<{ deployed_url: string }>(
  "SELECT deployed_url FROM builds WHERE customer_id = $1 AND deployed_url IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  [customer.id],
);
const delivery = [...brandTransport.sentMessages()].reverse().find((m) => m.to === customer.contact_email);
console.log(`\n--- the delivery email ${customer.contact_email} received ---`);
console.log(delivery ? `Subject: ${delivery.subject}\n${delivery.body}` : "⛔ NO DELIVERY EMAIL");
if (!delivery) throw new Error("delivery email never sent");
if (!deploy || !delivery.body.includes(deploy.deployed_url)) {
  throw new Error(`delivery email does not carry the deployed site ${deploy?.deployed_url}`);
}

step("7 · the customer asks for their own domain; cutover completes; workflow terminates");
await engine.signal(`onboarding:${lead.lead_id}`, "cutover_approved", { domain: "example-customer.com" });
await drain();
const final = await db.one<{ status: string; result: unknown }>(
  "SELECT status, result FROM workflow_executions WHERE id = $1", [`onboarding:${lead.lead_id}`],
);
console.log(`onboarding: ${final.status} →`, JSON.stringify(final.result));

step("VERDICT");
console.log(`site deployed at: ${deploy.deployed_url}`);
console.log(`delivery email:   carries that URL — verified`);
await db.close();
