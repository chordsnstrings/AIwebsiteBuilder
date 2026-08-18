import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { Engine, TestClock, type WorkflowContext } from "./src/engine/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

describe("durable workflow engine", () => {
  it("runs a simple activity workflow to completion", async () => {
    const clock = new TestClock(0);
    const engine = new Engine({ db, clock, owner: "test:workflows:engine" });
    engine.registerActivity("double", async (n) => (n as number) * 2);
    engine.registerWorkflow({
      type: "simple",
      run: async (ctx: WorkflowContext, input: number) => {
        const a = await ctx.activity<number, number>("double", input);
        const b = await ctx.activity<number, number>("double", a);
        return b;
      },
    });
    const id = `simple-${Date.now()}`;
    await engine.start("simple", id, 5);
    expect(await engine.result<number>(id)).toBe(20);
  });

  it("runs a 180-day cooldown workflow in milliseconds via time-skip", async () => {
    const clock = new TestClock(0);
    const engine = new Engine({ db, clock, owner: "test:workflows:engine" });
    const seen: string[] = [];
    engine.registerActivity("mark", async (s) => {
      seen.push(s as string);
      return null;
    });
    engine.registerWorkflow({
      type: "cooldown",
      run: async (ctx: WorkflowContext) => {
        await ctx.activity("mark", "before");
        await ctx.sleep("cooldown", 180 * DAY);
        await ctx.activity("mark", "after");
        return "done";
      },
    });
    const id = `cooldown-${Date.now()}`;
    await engine.start("cooldown", id, null);
    // Suspended on the 180-day timer.
    expect((await engine.getStatus(id))!.status).toBe("running");
    expect(seen).toEqual(["before"]);

    // Not yet due at 179 days.
    clock.advance(179 * DAY);
    await engine.fireDueTimers();
    expect((await engine.getStatus(id))!.status).toBe("running");

    // Cross the 180-day boundary.
    clock.advance(2 * DAY);
    await engine.fireDueTimers();
    expect(await engine.result<string>(id)).toBe("done");
    expect(seen).toEqual(["before", "after"]);
  });

  it("does not re-run journaled activities on resume (durability)", async () => {
    const clock = new TestClock(0);
    const engine = new Engine({ db, clock, owner: "test:workflows:engine" });
    let runs = 0;
    engine.registerActivity("countOnce", async () => {
      runs++;
      return runs;
    });
    engine.registerWorkflow({
      type: "resume",
      run: async (ctx: WorkflowContext) => {
        const n = await ctx.activity<null, number>("countOnce", null);
        await ctx.sleep("wait", DAY);
        return n;
      },
    });
    const id = `resume-${Date.now()}`;
    await engine.start("resume", id, null);
    expect(runs).toBe(1);
    // Resume after the timer — the activity must NOT run again.
    clock.advance(2 * DAY);
    await engine.fireDueTimers();
    expect(runs).toBe(1);
    expect(await engine.result<number>(id)).toBe(1);
  });

  it("resumes on a signal and returns its payload", async () => {
    const clock = new TestClock(0);
    const engine = new Engine({ db, clock, owner: "test:workflows:engine" });
    engine.registerWorkflow({
      type: "await_reply",
      run: async (ctx: WorkflowContext) => {
        const sig = await ctx.waitForSignal<{ intent: number }>("reply");
        return sig.payload?.intent ?? -1;
      },
    });
    const id = `sig-${Date.now()}`;
    await engine.start("await_reply", id, null);
    expect((await engine.getStatus(id))!.status).toBe("running");
    await engine.signal(id, "reply", { intent: 85 });
    expect(await engine.result<number>(id)).toBe(85);
  });

  it("times out a signal wait after the durable timeout", async () => {
    const clock = new TestClock(0);
    const engine = new Engine({ db, clock, owner: "test:workflows:engine" });
    engine.registerWorkflow({
      type: "await_timeout",
      run: async (ctx: WorkflowContext) => {
        const sig = await ctx.waitForSignal<unknown>("reply", 30 * DAY);
        return sig.received ? "got" : "timeout";
      },
    });
    const id = `sigto-${Date.now()}`;
    await engine.start("await_timeout", id, null);
    clock.advance(31 * DAY);
    await engine.fireDueTimers();
    expect(await engine.result<string>(id)).toBe("timeout");
  });
});
