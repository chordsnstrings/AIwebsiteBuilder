// A small, dependency-free scheduler.
//
// Every job is isolated: one throwing does not stop the loop or its siblings,
// and a job that overruns its interval never runs concurrently with itself
// (which would double-fire timers or double-charge). Jobs are leader-gated by a
// Postgres advisory lock so running two worker replicas is safe — the spare sits
// idle and takes over if the leader dies, rather than duplicating side effects.
import type { Db } from "@adw/db";

export interface Job {
  name: string;
  intervalMs: number;
  /** Skip the leader lock — only for jobs with no side effects. */
  everyReplica?: boolean;
  run(ctx: JobContext): Promise<void>;
}

export interface JobContext {
  db: Db;
  now: Date;
}

export interface JobStats {
  name: string;
  runs: number;
  failures: number;
  lastRunAt: Date | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

const LEADER_LOCK_KEY = 918_273_645;

export interface SchedulerOptions {
  db: Db;
  jobs: Job[];
  /** Injectable for tests; defaults to real time. */
  now?: () => Date;
  onLog?: (line: string) => void;
}

export class Scheduler {
  private readonly db: Db;
  private readonly jobs: Job[];
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();
  private readonly stats = new Map<string, JobStats>();
  private isLeader = false;
  private stopped = false;

  constructor(opts: SchedulerOptions) {
    this.db = opts.db;
    this.jobs = opts.jobs;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.onLog ?? ((l) => console.log(l));
    for (const job of this.jobs) {
      this.stats.set(job.name, {
        name: job.name,
        runs: 0,
        failures: 0,
        lastRunAt: null,
        lastError: null,
        lastDurationMs: null,
      });
    }
  }

  /**
   * Try to become the leader. A session-scoped advisory lock is released
   * automatically if this process dies, so failover needs no dead-man logic.
   */
  async acquireLeadership(): Promise<boolean> {
    if (this.db.backend !== "pg") {
      this.isLeader = true;
      return true;
    }
    const row = await this.db.one<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
      LEADER_LOCK_KEY,
    ]);
    this.isLeader = row.locked;
    return this.isLeader;
  }

  leader(): boolean {
    return this.isLeader;
  }

  /** Run one job now, guarding against overlap and swallowing its failure. */
  async runJob(job: Job): Promise<void> {
    if (this.stopped) return;
    if (this.running.has(job.name)) {
      this.log(`[worker] skip ${job.name} — previous run still in flight`);
      return;
    }
    if (!job.everyReplica && !this.isLeader) return;

    this.running.add(job.name);
    const started = Date.now();
    const stat = this.stats.get(job.name)!;
    try {
      await job.run({ db: this.db, now: this.now() });
      stat.runs++;
      stat.lastError = null;
    } catch (err) {
      stat.failures++;
      stat.lastError = err instanceof Error ? err.message : String(err);
      // A failing job must never take the process down; the Sentinel and the
      // exception queue are how a human finds out.
      this.log(`[worker] ${job.name} FAILED: ${stat.lastError}`);
    } finally {
      stat.lastRunAt = this.now();
      stat.lastDurationMs = Date.now() - started;
      this.running.delete(job.name);
    }
  }

  /** Start every job on its own interval. Returns immediately. */
  start(): void {
    for (const job of this.jobs) {
      // Fire once on boot so a restart does not wait a full interval.
      void this.runJob(job);
      const timer = setInterval(() => void this.runJob(job), job.intervalMs);
      // Do not hold the event loop open on a timer alone.
      timer.unref?.();
      this.timers.set(job.name, timer);
    }
    this.log(`[worker] started ${this.jobs.length} jobs (leader=${this.isLeader})`);
  }

  /** Stop scheduling and wait for in-flight jobs to settle. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.db.backend === "pg" && this.isLeader) {
      await this.db.query("SELECT pg_advisory_unlock($1)", [LEADER_LOCK_KEY]).catch(() => {});
    }
    this.log("[worker] stopped");
  }

  snapshot(): JobStats[] {
    return [...this.stats.values()];
  }
}
