import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { Engine, TestClock, type WorkflowContext } from "@adw/workflows";
import { Scheduler, type Job } from "./src/scheduler.ts";
import { heartbeatJob, previewExpiryJob, probeJobs, workflowTimerJob } from "./src/jobs.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

function counterJob(name: string, counter: { n: number }, opts: Partial<Job> = {}): Job {
  return {
    name,
    intervalMs: 60_000,
    async run() {
      counter.n++;
    },
    ...opts,
  };
}

describe("scheduler isolation", () => {
  it("a throwing job does not stop its siblings and is recorded, not rethrown", async () => {
    const good = { n: 0 };
    const boom: Job = {
      name: "boom",
      intervalMs: 60_000,
      async run() {
        throw new Error("job exploded");
      },
    };
    const goodJob = counterJob("good", good);
    const s = new Scheduler({ db, jobs: [boom, goodJob], onLog: () => {} });
    await s.acquireLeadership();
    await s.runJob(boom);
    await s.runJob(goodJob);
    const stats = s.snapshot();
    expect(stats.find((x) => x.name === "boom")!.failures).toBe(1);
    expect(stats.find((x) => x.name === "boom")!.lastError).toMatch(/exploded/);
    expect(good.n).toBe(1);
    await s.stop(100);
  });

  it("never runs a job concurrently with itself", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const slow: Job = {
      name: "slow",
      intervalMs: 60_000,
      async run() {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 60));
        inFlight--;
      },
    };
    const s = new Scheduler({ db, jobs: [slow], onLog: () => {} });
    await s.acquireLeadership();
    // Fire three overlapping runs; only the first should execute.
    await Promise.all([s.runJob(slow), s.runJob(slow), s.runJob(slow)]);
    expect(maxConcurrent).toBe(1);
    await s.stop(200);
  });

  it("a non-leader replica performs no side effects", async () => {
    const counter = { n: 0 };
    const job = counterJob("leader_only", counter);
    const standby = new Scheduler({ db, jobs: [job], onLog: () => {} });
    // Deliberately do NOT acquire leadership.
    await standby.runJob(job);
    expect(counter.n).toBe(0);
    await standby.stop(100);
  });

  it("a job marked everyReplica runs without leadership", async () => {
    const counter = { n: 0 };
    const job = counterJob("all_replicas", counter, { everyReplica: true });
    const standby = new Scheduler({ db, jobs: [job], onLog: () => {} });
    await standby.runJob(job);
    expect(counter.n).toBe(1);
    await standby.stop(100);
  });

  it("records duration and run counts for observability", async () => {
    const counter = { n: 0 };
    const job = counterJob("tracked", counter);
    const s = new Scheduler({ db, jobs: [job], onLog: () => {} });
    await s.acquireLeadership();
    await s.runJob(job);
    const stat = s.snapshot().find((x) => x.name === "tracked")!;
    expect(stat.runs).toBe(1);
    expect(stat.lastRunAt).not.toBeNull();
    expect(stat.lastDurationMs).toBeGreaterThanOrEqual(0);
    await s.stop(100);
  });
});

describe("the jobs actually advance the system", () => {
  it("workflow timers fire, so a sleeping workflow resumes", async () => {
    const clock = new TestClock(0);
    const engine = new Engine({ db, clock });
    const marks: string[] = [];
    engine.registerActivity("mark", async (s) => {
      marks.push(s as string);
      return null;
    });
    engine.registerWorkflow({
      type: "worker_sleep_test",
      run: async (ctx: WorkflowContext) => {
        await ctx.activity("mark", "before");
        await ctx.sleep("wait", 24 * 3600 * 1000);
        await ctx.activity("mark", "after");
        return "done";
      },
    });
    const id = `wk-${Date.now()}`;
    await engine.start("worker_sleep_test", id, null);
    expect(marks).toEqual(["before"]);

    // Advance past the timer, then let the JOB (not the test) fire it.
    clock.advance(2 * 24 * 3600 * 1000);
    const job = workflowTimerJob(engine);
    const s = new Scheduler({ db, jobs: [job], onLog: () => {} });
    await s.acquireLeadership();
    await s.runJob(job);
    expect(marks).toEqual(["before", "after"]);
    await s.stop(100);
  });

  it("the heartbeat job writes a beat (the dead man's switch depends on it)", async () => {
    const before = await db.one<{ n: string }>("SELECT count(*) AS n FROM heartbeats WHERE source='sentinel'");
    const job = heartbeatJob();
    const s = new Scheduler({ db, jobs: [job], onLog: () => {} });
    await s.acquireLeadership();
    await s.runJob(job);
    const after = await db.one<{ n: string }>("SELECT count(*) AS n FROM heartbeats WHERE source='sentinel'");
    expect(Number(after.n)).toBe(Number(before.n) + 1);
    await s.stop(100);
  });

  it("probe jobs cover the whole catalogue, bucketed by interval", () => {
    const jobs = probeJobs();
    expect(jobs.length).toBeGreaterThan(0);
    // Distinct intervals, and every job has a positive one.
    const intervals = jobs.map((j) => j.intervalMs);
    expect(new Set(intervals).size).toBe(intervals.length);
    for (const j of jobs) expect(j.intervalMs).toBeGreaterThan(0);
  });

  it("preview expiry takes down an unclaimed, expired preview", async () => {
    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id",
    );
    const biz = await db.one<{ id: string }>(
      "INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment) VALUES ('d',$1,'Expiring Co','US','R1','no_site') RETURNING id",
      [batch.id],
    );
    const expired = await db.one<{ id: string }>(
      `INSERT INTO previews (business_id, r2_key, deploy_url, claim_token, label_version, generated_at, expires_at)
       VALUES ($1,'r2/x','https://p.example',$2,'v1', now() - interval '40 days', now() - interval '10 days') RETURNING id`,
      [biz.id, `expire-${Date.now()}`],
    );
    const live = await db.one<{ id: string }>(
      `INSERT INTO previews (business_id, r2_key, deploy_url, claim_token, label_version, expires_at)
       VALUES ($1,'r2/y','https://p.example',$2,'v1', now() + interval '10 days') RETURNING id`,
      [biz.id, `live-${Date.now()}`],
    );

    const job = previewExpiryJob();
    const s = new Scheduler({ db, jobs: [job], onLog: () => {} });
    await s.acquireLeadership();
    await s.runJob(job);

    const gone = await db.one<{ takedown_at: string | null; takedown_reason: string | null }>(
      "SELECT takedown_at, takedown_reason FROM previews WHERE id = $1",
      [expired.id],
    );
    const still = await db.one<{ takedown_at: string | null }>("SELECT takedown_at FROM previews WHERE id = $1", [live.id]);
    expect(gone.takedown_at).not.toBeNull();
    expect(gone.takedown_reason).toBe("expired");
    expect(still.takedown_at).toBeNull();
    await s.stop(100);
  });
});
