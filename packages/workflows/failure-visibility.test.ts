// ⛔ A workflow that died used to write `status='failed'` to its own row and
// stop. Nothing raised, nothing emitted, nothing paged. 28 revision workflows
// sat dead for hours — every customer who asked for a change to their site got
// an "ok, queued" and then silence — and the only way to find out was to query
// the table by hand.
//
// A workflow is the unit of work for everything this system promises. When one
// dies the promise it carried dies with it, so the death has to reach a person.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import { Engine, TestClock, normaliseError, type WorkflowContext } from "./src/engine/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });

interface ExceptionRow {
  id: string;
  severity: number;
  system_action: string | null;
  recommendation: string | null;
  raised_at: Date;
  context: { workflowType?: string; error?: string; occurrences?: number; executionIds?: string[]; firstAt?: string; lastAt?: string };
}

/** Open `workflow_failed` exceptions for one workflow type. */
async function raised(type: string): Promise<ExceptionRow[]> {
  const rows = await db.query<ExceptionRow>(
    `SELECT id, severity, system_action, recommendation, raised_at, context
       FROM exceptions
      WHERE trigger = 'workflow_failed' AND status = 'open' AND context->>'workflowType' = $1`,
    [type],
  );
  return rows.rows;
}

/** An engine whose only workflow throws the message it is given. */
function thrower(type: string, clock: TestClock): Engine {
  const engine = new Engine({ db, clock });
  engine.registerWorkflow({
    type,
    run: async (_ctx: WorkflowContext, input: unknown) => {
      throw new Error((input as { message: string }).message);
    },
  });
  return engine;
}

describe("⛔ a dead workflow reaches a person", () => {
  it("raises an exception, not just a failed row", async () => {
    const type = `fv-basic-${randomUUID().slice(0, 8)}`;
    const engine = thrower(type, new TestClock(0));
    const id = `${type}-1`;
    await engine.start(type, id, { message: "the activity blew up" });

    const row = await db.one<{ status: string; error: string }>(
      "SELECT status, error FROM workflow_executions WHERE id = $1", [id],
    );
    expect(row.status).toBe("failed");

    const items = await raised(type);
    expect(items.length, "the execution died and nothing was raised").toBe(1);
    const [item] = items;
    expect(item!.context.error).toContain("the activity blew up");
    expect(item!.context.executionIds).toContain(id);
    // ⛔ The operator needs to know what to DO, not merely that something broke.
    expect(item!.recommendation).toBeTruthy();
    expect(item!.system_action).toBeTruthy();
  });

  it("⛔ collapses a broken activity into ONE queue item, not one per execution", async () => {
    // A single broken activity fails every execution that reaches it. 500
    // identical rows would bury the queue so completely that the operator
    // learns nothing — the same outcome as reporting nothing at all.
    const type = `fv-storm-${randomUUID().slice(0, 8)}`;
    const engine = thrower(type, new TestClock(0));
    for (let i = 0; i < 5; i++) {
      await engine.start(type, `${type}-${i}`, { message: "the same broken activity" });
    }
    const items = await raised(type);
    expect(items.length, "one exception per failed execution floods the queue").toBe(1);
    expect(items[0]!.context.occurrences).toBe(5);
    expect(items[0]!.context.executionIds?.length).toBe(5);
  });

  it("⛔ groups by cause, so two different bugs stay two items", async () => {
    // The opposite failure: deduplicating so aggressively that a second, real
    // bug hides behind the first one and never gets looked at.
    const type = `fv-two-${randomUUID().slice(0, 8)}`;
    const engine = thrower(type, new TestClock(0));
    await engine.start(type, `${type}-a`, { message: "cannot reach the deploy target" });
    await engine.start(type, `${type}-b`, { message: "reviewer gate returned nothing" });
    expect((await raised(type)).length).toBe(2);
  });

  it("keeps the age of the FIRST occurrence", async () => {
    // The console ranks by age. Refreshing raised_at on every recurrence would
    // make a bug that has been breaking for a week read as brand new, and it
    // would sort below things that matter less.
    const type = `fv-age-${randomUUID().slice(0, 8)}`;
    const clock = new TestClock(0);
    const engine = thrower(type, clock);
    await engine.start(type, `${type}-1`, { message: "persistent breakage" });
    const first = (await raised(type))[0]!.raised_at.getTime();
    await engine.start(type, `${type}-2`, { message: "persistent breakage" });
    const after = (await raised(type))[0]!;
    expect(after.raised_at.getTime()).toBe(first);
    // …while still recording that it is ongoing.
    expect(after.context.lastAt).toBeTruthy();
    expect(after.context.occurrences).toBe(2);
  });

  it("⛔ the execution is still marked failed even if raising the exception cannot be done", async () => {
    // A failure in reporting the failure must not leave the execution 'running'
    // — the engine would replay it forever, and the original error would be
    // replaced by an infinite loop that is much harder to diagnose.
    const type = `fv-report-${randomUUID().slice(0, 8)}`;
    const clock = new TestClock(0);
    const engine = new Engine({ db, clock });
    engine.registerWorkflow({ type, run: async () => { throw new Error("boom"); } });
    const original = db.query.bind(db);
    let sabotaged = false;
    // Break only the exceptions write, leaving the status update working.
    (db as unknown as { query: typeof db.query }).query = (async (sql: string, params?: unknown[]) => {
      if (/exceptions/i.test(sql)) { sabotaged = true; throw new Error("exceptions table unavailable"); }
      return original(sql, params);
    }) as typeof db.query;
    try {
      await engine.start(type, `${type}-1`, {});
    } finally {
      (db as unknown as { query: typeof db.query }).query = original;
    }
    expect(sabotaged).toBe(true);
    const row = await db.one<{ status: string }>(
      "SELECT status FROM workflow_executions WHERE id = $1", [`${type}-1`],
    );
    expect(row.status, "stuck 'running' — the engine would replay it forever").toBe("failed");
  });

  it("does not raise anything for a workflow that succeeds", async () => {
    const type = `fv-ok-${randomUUID().slice(0, 8)}`;
    const engine = new Engine({ db, clock: new TestClock(0) });
    engine.registerWorkflow({ type, run: async () => ({ fine: true }) });
    await engine.start(type, `${type}-1`, {});
    expect(await raised(type)).toHaveLength(0);
  });

  it("does not raise anything for a workflow that is merely suspended", async () => {
    // Waiting 180 days on a durable timer is the normal, healthy state of most
    // lead workflows. Treating a suspension as a death would raise an exception
    // for every single one of them.
    const type = `fv-sleep-${randomUUID().slice(0, 8)}`;
    const engine = new Engine({ db, clock: new TestClock(0) });
    engine.registerWorkflow({
      type,
      run: async (ctx: WorkflowContext) => { await ctx.sleep("wait", 90 * 24 * 60 * 60_000); return null; },
    });
    await engine.start(type, `${type}-1`, {});
    const row = await db.one<{ status: string }>(
      "SELECT status FROM workflow_executions WHERE id = $1", [`${type}-1`],
    );
    expect(row.status).toBe("running");
    expect(await raised(type)).toHaveLength(0);
  });
});

describe("normaliseError", () => {
  it("⛔ strips per-execution identifiers so one bug groups as one bug", () => {
    const a = normaliseError("deploy failed for build 0e9b2c14-5f2a-4b77-9c31-2f8d6a1e4b02 after 3 tries");
    const b = normaliseError("deploy failed for build 7a1c9d33-88fe-4a02-b6d5-19cc7e4f0a11 after 9 tries");
    expect(a).toBe(b);
  });

  it("⛔ keeps genuinely different causes apart", () => {
    expect(normaliseError("reviewer gate returned nothing"))
      .not.toBe(normaliseError("cannot reach the deploy target"));
  });

  it("is bounded, so a huge error cannot bloat every exception row", () => {
    expect(normaliseError("x".repeat(5000)).length).toBeLessThanOrEqual(200);
  });
});
