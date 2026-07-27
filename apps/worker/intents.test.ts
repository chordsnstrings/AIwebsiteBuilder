// The workflow outbox is the pipeline's ignition. Before it existed the API
// recorded that a preview was claimed and a revision requested, and no workflow
// ever started — a failure that looks like "the system is quiet" rather than
// like an error.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import {
  Engine,
  MAX_INTENT_ATTEMPTS,
  enqueueIntent,
  executionId,
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
