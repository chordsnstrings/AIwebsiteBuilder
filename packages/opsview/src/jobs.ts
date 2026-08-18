// Is the recurring work actually running?
//
// ⛔ The writer and the reader live in the same file on purpose. The defect
// this replaces was a scheduler that stamped one timestamp in a `finally`
// block, so a job failing on every tick looked exactly as fresh as a job
// succeeding on every tick. Splitting "record a run" from "judge a run" across
// two packages is how that returns.
//
// The state vocabulary is deliberately the same four words `watchBoard` uses
// for customer watches — `never_run | ok | stale | failing`. An operator should
// only ever have to learn it once, and none of the four can be reached by a job
// that has stopped working.

import type { Db } from "@adw/db";

/** Consecutive failures before a job reads as failing rather than merely late. */
export const FAILING_AFTER = 2;
/** How many of its own cadences a job may miss before its success goes stale. */
export const STALE_CADENCES = 3;

export type JobState = "never_run" | "ok" | "stale" | "failing";

export interface JobRow {
  name: string;
  intervalMs: number;
  state: JobState;
  lastRunAt: Date | null;
  /** ⛔ Health is computed from THIS and nothing else. */
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastDurationMs: number | null;
  runsTotal: number;
  failuresTotal: number;
  consecutiveFailures: number;
  /** When the next run is due, from the last run plus the job's own cadence. */
  nextDueAt: Date | null;
  /** How far past due, in whole cadences. Null when it has never run. */
  cadencesLate: number | null;
}

/**
 * Declare a job before it has ever run.
 *
 * ⛔ Called at boot for every job in the roster, so a job that has never
 * executed once has a row with null timestamps rather than no row at all.
 * Without this, "never ran" and "not deployed" are the same absence, and the
 * console would render the most alarming state in the system as a blank space.
 */
export async function registerJob(db: Db, name: string, intervalMs: number): Promise<void> {
  await db.query(
    `INSERT INTO job_heartbeats (job_name, interval_ms)
     VALUES ($1, $2)
     ON CONFLICT (job_name) DO UPDATE SET interval_ms = EXCLUDED.interval_ms`,
    [name, Math.max(1, Math.round(intervalMs))],
  );
}

export interface JobRunRecord {
  name: string;
  /**
   * ⛔ Required, and not defaulted. Staleness is measured in multiples of this
   * number, so a writer that invents one (say 1ms, for a job that was never
   * registered) paints a healthy job red on its first tick. The caller is the
   * scheduler and always knows the real cadence — so it passes it.
   */
  intervalMs: number;
  ok: boolean;
  startedAt: Date;
  durationMs: number;
  error?: string | undefined;
  leader?: boolean | undefined;
}

/**
 * Record one execution.
 *
 * ⛔ `last_success_at` moves only when `ok`. That single condition is the whole
 * reason this table exists; everything the console paints green is downstream
 * of it.
 */
export async function recordJobRun(db: Db, run: JobRunRecord): Promise<void> {
  const duration = Math.max(0, Math.round(run.durationMs));
  await db.query(
    `INSERT INTO job_heartbeats (
       job_name, interval_ms, last_run_at, last_success_at, last_failure_at,
       last_error, last_duration_ms, runs_total, failures_total, consecutive_failures, last_leader)
     VALUES ($1, $7::bigint, $2::timestamptz,
             CASE WHEN $3::boolean THEN $2::timestamptz ELSE NULL END,
             CASE WHEN $3::boolean THEN NULL ELSE $2::timestamptz END,
             $4::text, $5::integer, 1,
             CASE WHEN $3::boolean THEN 0 ELSE 1 END,
             CASE WHEN $3::boolean THEN 0 ELSE 1 END, $6::boolean)
     ON CONFLICT (job_name) DO UPDATE SET
       last_run_at          = EXCLUDED.last_run_at,
       last_success_at      = CASE WHEN $3::boolean THEN EXCLUDED.last_run_at ELSE job_heartbeats.last_success_at END,
       last_failure_at      = CASE WHEN $3::boolean THEN job_heartbeats.last_failure_at ELSE EXCLUDED.last_run_at END,
       -- ⛔ The error text is kept until a success clears it. An error that
       -- disappears on the next tick is an error nobody ever reads.
       last_error           = CASE WHEN $3 THEN NULL ELSE EXCLUDED.last_error END,
       last_duration_ms     = EXCLUDED.last_duration_ms,
       runs_total           = job_heartbeats.runs_total + 1,
       failures_total       = job_heartbeats.failures_total + CASE WHEN $3 THEN 0 ELSE 1 END,
       consecutive_failures = CASE WHEN $3 THEN 0 ELSE job_heartbeats.consecutive_failures + 1 END,
       last_leader          = EXCLUDED.last_leader`,
    [
      run.name, run.startedAt, run.ok, run.error ?? null, duration, run.leader ?? true,
      Math.max(1, Math.round(run.intervalMs)),
    ],
  );
  // History, for the operator who asks why a job is amber. Successes are kept
  // too, briefly, because "it ran but took 40 seconds" is the shape of the
  // failure that precedes an outage.
  await db.query(
    "INSERT INTO job_runs (job_name, started_at, ok, duration_ms, error) VALUES ($1,$2,$3,$4,$5)",
    [run.name, run.startedAt, run.ok, duration, run.error ?? null],
  );
}

/** Trim run history. Failures are kept longer than successes because only they are evidence. */
export async function pruneJobRuns(db: Db, now: Date): Promise<number> {
  const res = await db.query(
    `DELETE FROM job_runs
      WHERE (ok = true  AND finished_at < $1::timestamptz - interval '2 days')
         OR (ok = false AND finished_at < $1::timestamptz - interval '30 days')`,
    [now],
  );
  return res.rowCount ?? 0;
}

interface HeartbeatDbRow {
  job_name: string;
  interval_ms: string | number;
  last_run_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  last_duration_ms: number | null;
  runs_total: string | number;
  failures_total: string | number;
  consecutive_failures: number;
}

/**
 * The board.
 *
 * ⛔ Freshness is judged against each job's OWN cadence. A blanket timeout
 * would call the 24-hour retention job dead every morning and would call the
 * 10-second timer job healthy an hour after it stopped — which is exactly
 * backwards, since the timer job stopping stalls every workflow in the system.
 */
export async function jobBoard(db: Db, now: Date): Promise<JobRow[]> {
  const rows = await db.query<HeartbeatDbRow>(
    `SELECT job_name, interval_ms, last_run_at, last_success_at, last_error,
            last_duration_ms, runs_total, failures_total, consecutive_failures
       FROM job_heartbeats ORDER BY job_name`,
  );
  return rows.rows.map((r) => {
    const intervalMs = Number(r.interval_ms);
    const lastSuccess = r.last_success_at === null ? null : new Date(r.last_success_at);
    const lastRun = r.last_run_at === null ? null : new Date(r.last_run_at);
    const sinceSuccess = lastSuccess === null ? null : now.getTime() - lastSuccess.getTime();

    let state: JobState;
    if (r.consecutive_failures >= FAILING_AFTER) state = "failing";
    else if (lastSuccess === null) state = "never_run";
    else if (sinceSuccess! > STALE_CADENCES * intervalMs) state = "stale";
    else state = "ok";

    return {
      name: r.job_name,
      intervalMs,
      state,
      lastRunAt: lastRun,
      lastSuccessAt: lastSuccess,
      lastError: r.last_error,
      lastDurationMs: r.last_duration_ms,
      runsTotal: Number(r.runs_total),
      failuresTotal: Number(r.failures_total),
      consecutiveFailures: r.consecutive_failures,
      nextDueAt: lastRun === null ? null : new Date(lastRun.getTime() + intervalMs),
      cadencesLate: sinceSuccess === null ? null : Math.max(0, Math.floor(sinceSuccess / intervalMs)),
    };
  });
}

export interface JobFailure {
  jobName: string;
  finishedAt: Date;
  error: string;
  durationMs: number;
}

/** Recent failures across all jobs — what an operator reads after seeing red. */
export async function recentJobFailures(db: Db, limit = 20): Promise<JobFailure[]> {
  const rows = await db.query<{ job_name: string; finished_at: Date; error: string | null; duration_ms: number }>(
    "SELECT job_name, finished_at, error, duration_ms FROM job_runs WHERE ok = false ORDER BY finished_at DESC LIMIT $1",
    [limit],
  );
  return rows.rows.map((r) => ({
    jobName: r.job_name,
    finishedAt: new Date(r.finished_at),
    error: r.error ?? "(no message)",
    durationMs: r.duration_ms,
  }));
}
