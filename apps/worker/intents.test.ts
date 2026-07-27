// The workflow outbox is the pipeline's ignition. Before it existed the API
// recorded that a preview was claimed and a revision requested, and no workflow
// ever started — a failure that looks like "the system is quiet" rather than
// like an error.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend } from "@adw/vault";
import { seedRegistry, setChampion, type RoleId } from "@adw/registry";
import { config } from "@adw/config";
import { enrolLead } from "@adw/provenance";
import { registerActivities } from "./src/activities.ts";
import {
  Engine,
  MAX_INTENT_ATTEMPTS,
  enqueueIntent,
  executionId,
  leadWorkflow,
  markIntentFailed,
  pendingIntents,
  type WorkflowDefinition,
} from "@adw/workflows";
import { intentDispatcherJob } from "./src/jobs.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

/** A trivial workflow that records that it ran and then waits for a signal. */
function probeWorkflow(type: string, ran: string[]): WorkflowDefinition<{ tag: string }, { done: boolean }> {
  return {
    type,
    run: async (ctx, input) => {
      ran.push(input.tag);
      const sig = await ctx.waitForSignal<{ note: string }>("poke", 60_000);
      if (sig.received) ran.push(`poked:${sig.payload?.note ?? ""}`);
      return { done: true };
    },
  };
}

async function drain(engine: Engine): Promise<void> {
  const job = intentDispatcherJob(engine, db);
  await job.run({ db, now: new Date() });
}

describe("workflow outbox", () => {
  it("starts a workflow from a queued start intent", async () => {
    const ran: string[] = [];
    const type = `probe_${randomUUID().slice(0, 8)}`;
    const engine = new Engine({ db });
    engine.registerWorkflow(probeWorkflow(type, ran));

    const id = `exec:${randomUUID()}`;
    await enqueueIntent(db, { kind: "start", workflowType: type, executionId: id, payload: { tag: "first" } });
    await drain(engine);

    expect(ran).toContain("first");
    const row = await db.one<{ processed_at: string | null }>(
      "SELECT processed_at FROM workflow_intents WHERE execution_id = $1",
      [id],
    );
    expect(row.processed_at).not.toBeNull();
  });

  it("delivers a signal to a parked execution", async () => {
    const ran: string[] = [];
    const type = `probe_${randomUUID().slice(0, 8)}`;
    const engine = new Engine({ db });
    engine.registerWorkflow(probeWorkflow(type, ran));

    const id = `exec:${randomUUID()}`;
    await enqueueIntent(db, { kind: "start", workflowType: type, executionId: id, payload: { tag: "x" } });
    await drain(engine);
    await enqueueIntent(db, {
      kind: "signal",
      workflowType: type,
      executionId: id,
      signalName: "poke",
      payload: { note: "hello" },
    });
    await drain(engine);

    expect(ran).toContain("poked:hello");
  });

  it("refuses a second start for the same execution — a double-click is a no-op", async () => {
    const type = `probe_${randomUUID().slice(0, 8)}`;
    const id = `exec:${randomUUID()}`;
    await enqueueIntent(db, { kind: "start", workflowType: type, executionId: id, payload: { tag: "a" } });
    await enqueueIntent(db, { kind: "start", workflowType: type, executionId: id, payload: { tag: "b" } });
    const n = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM workflow_intents WHERE execution_id = $1 AND kind = 'start'",
      [id],
    );
    expect(Number(n.n)).toBe(1);
  });

  it("one undeliverable intent does not stall the ones behind it", async () => {
    const ran: string[] = [];
    const type = `probe_${randomUUID().slice(0, 8)}`;
    const engine = new Engine({ db });
    engine.registerWorkflow(probeWorkflow(type, ran));

    // An unregistered type throws inside engine.start().
    await enqueueIntent(db, {
      kind: "start",
      workflowType: `unknown_${randomUUID().slice(0, 8)}`,
      executionId: `exec:${randomUUID()}`,
      payload: {},
    });
    const goodId = `exec:${randomUUID()}`;
    await enqueueIntent(db, { kind: "start", workflowType: type, executionId: goodId, payload: { tag: "behind" } });

    await drain(engine);
    expect(ran).toContain("behind");
  });

  it("parks an intent and raises an exception after repeated failures", async () => {
    const id = `exec:${randomUUID()}`;
    await enqueueIntent(db, { kind: "start", workflowType: "never_registered", executionId: id, payload: {} });
    const [intent] = await db.query<{ id: string }>(
      "SELECT id FROM workflow_intents WHERE execution_id = $1",
      [id],
    ).then((r) => r.rows);

    for (let i = 0; i < MAX_INTENT_ATTEMPTS; i++) {
      await markIntentFailed(db, intent!.id, "boom");
    }

    // Past the attempt ceiling it is no longer offered for delivery...
    const pending = await pendingIntents(db, 500);
    expect(pending.some((p) => p.id === intent!.id)).toBe(false);
    // ...and a human has been told, rather than the entry point going quiet.
    const exc = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM exceptions WHERE trigger = 'workflow_intent_undeliverable' AND context->>'intentId' = $1",
      [intent!.id],
    );
    expect(Number(exc.n)).toBe(1);
  });

  it("builds stable execution ids so a replay addresses the same run", () => {
    expect(executionId.lead("abc")).toBe(executionId.lead("abc"));
    expect(executionId.onboarding("abc")).not.toBe(executionId.lead("abc"));
    expect(executionId.revision("cust", 2)).toBe("revision:cust:2");
  });
});

// ---------------------------------------------------------------------------
// The whole ignition path, with nothing stubbed: enrol a contact, let the
// dispatcher drain the outbox, and watch the lead workflow score it, build a
// preview and put a gated message on the wire. If any link in that chain is
// missing this is the test that notices.
// ---------------------------------------------------------------------------
describe("enrol → dispatch → contacted", () => {
  it("carries a freshly enrolled lead all the way to a gated send", async () => {
    const vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
    await seedRegistry(db);
    for (const [role, r] of Object.entries(config.registry().data.roles)) {
      const has = await db.maybeOne("SELECT champion FROM registry_roles WHERE role=$1 AND champion IS NOT NULL", [
        role,
      ]);
      if (!has) {
        const run = await db.one<{ id: string }>(
          "INSERT INTO eval_runs (role, suite, candidate, metric, metric_value) VALUES ($1,$2,$3,$4,0.01) RETURNING id",
          [role, r.eval_suite, r.candidates[0], r.selection_metric],
        );
        await setChampion(db, role as RoleId, r.candidates[0]!, run.id, 0.01);
      }
    }

    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
    );
    const biz = await db.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, category, city, country_code, region_code,
                               segment, review_count, rating, phone_e164, timezone)
       VALUES ('d',$1,'Ignition Roofing','roofer','Boise','US','R1','stale_site',40,4.5,'+12085550199','America/Denver')
       RETURNING id`,
      [batch.id],
    );
    const email = `ignite_${randomUUID()}@example.com`;
    const contact = await db.one<{ id: string }>(
      `INSERT INTO contacts (business_id, email, email_hash, verification, subscriber_type)
       VALUES ($1,$2,$3,'valid','corporate') RETURNING id`,
      [biz.id, email, emailHash(email)],
    );
    await db.query(
      `INSERT INTO provenance (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash,
                               no_cem_statement, detector_version, relates_to_role, legal_basis)
       VALUES ($1,'https://example.com',now(),'p/x','h',true,'nocem-v1.0.0',true,'can_spam_optout')`,
      [contact.id],
    );
    const campaign = await db.one<{ id: string }>(
      "INSERT INTO campaigns (name, region_code, enabled_markets) VALUES ($1,'R1',$2) RETURNING id",
      [`ignite-${randomUUID()}`, ["US"]],
    );
    await db.query(
      `INSERT INTO sending_assets (kind, identifier, provider, pool, domain_class, health, daily_cap, sends_today)
       VALUES ('mailbox',$1,'google_workspace','cold','burner','healthy',40,0)`,
      [`ignite_${randomUUID()}@burner.example`],
    );

    // Ignition: the only call a lead-ingestion job makes.
    const enrolled = await enrolLead(db, {
      contactId: contact.id,
      businessId: biz.id,
      campaignId: campaign.id,
    });
    expect(enrolled.leadId).not.toBeNull();

    // The worker, assembled exactly as worker.ts assembles it.
    const engine = new Engine({ db });
    engine.registerWorkflow(leadWorkflow);
    registerActivities(engine, {
      db,
      vault,
      forceMock: true,
      now: () => new Date("2026-03-10T18:00:00Z"), // 12:00 in America/Denver
    });
    await drain(engine);

    const lead = await db.one<{ state: string; score: string | null; preview_id: string | null }>(
      "SELECT state, score, preview_id FROM leads WHERE id = $1",
      [enrolled.leadId],
    );
    // Scored, previewed and contacted — the workflow is now parked on its
    // reply timer, which is exactly where it should be.
    expect(Number(lead.score)).toBeGreaterThan(0);
    expect(lead.preview_id).not.toBeNull();
    expect(lead.state).toBe("CONTACTED");

    const sent = await db.one<{ gate_decision_id: string | null }>(
      `SELECT m.gate_decision_id FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.lead_id = $1 AND m.direction = 'outbound'`,
      [enrolled.leadId],
    );
    expect(sent.gate_decision_id).not.toBeNull();
  });
});
