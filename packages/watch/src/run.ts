// Subscribing, running and reporting.
//
// ⛔ The load-bearing distinction in this file is `last_run_at` versus
// `last_ok_at`. A watch that ran and failed has a fresh run time and a stale
// value. Reporting on the run time is how "we are watching this for you"
// survives the watching having stopped — the failure this whole family exists
// to avoid, restated one level up.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { watchById, watchFor, watchVersion, type Watch, type WatchSource } from "./catalogue.ts";
import { detectChanges, valueHash } from "./detect.ts";

const HOUR_MS = 3_600_000;
/** Failures in a row before a subscription reads as failing rather than late. */
const FAILING_AFTER = 3;
/** Missed cadences before the value on the board is no longer current. */
const STALE_CADENCES = 3;

export interface CollectorInput {
  subject: string;
  params: Record<string, unknown>;
  watch: Watch;
}

export type CollectorResult = { ok: true; value: unknown } | { ok: false; error: string };
export type Collector = (input: CollectorInput) => Promise<CollectorResult>;
export type Collectors = Partial<Record<WatchSource, Collector>>;

export interface SubscribeInput {
  customerId: string;
  vertical: string;
  watchId: string;
  subject: string;
  params?: Record<string, unknown> | undefined;
}

export type SubscribeResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; reason: "unknown_watch" | "no_collector"; detail: string };

/**
 * ⛔ Refuses a watch whose source has no collector on this deployment, instead
 * of accepting it and never running it. A subscription that cannot run looks
 * identical on every board to one that runs and finds nothing.
 */
export async function subscribeWatch(
  db: Db,
  input: SubscribeInput,
  collectors: Collectors = {},
): Promise<SubscribeResult> {
  const watch = watchFor(input.vertical, input.watchId);
  if (watch === undefined) {
    return { ok: false, reason: "unknown_watch", detail: `no watch "${input.watchId}" for "${input.vertical}"` };
  }
  if (collectors[watch.source] === undefined) {
    return { ok: false, reason: "no_collector", detail: `no collector for source "${watch.source}"` };
  }
  const existing = await db.maybeOne<{ id: string }>(
    "SELECT id FROM watch_subscriptions WHERE customer_id = $1 AND watch_id = $2 AND subject = $3",
    [input.customerId, input.watchId, input.subject],
  );
  if (existing !== null) {
    await db.query("UPDATE watch_subscriptions SET active = TRUE, params = $2 WHERE id = $1", [
      existing.id, JSON.stringify(input.params ?? {}),
    ]);
    return { ok: true, id: existing.id, created: false };
  }
  const row = await db.one<{ id: string }>(
    `INSERT INTO watch_subscriptions (customer_id, watch_id, subject, params)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.customerId, input.watchId, input.subject, JSON.stringify(input.params ?? {})],
  );
  await emit({
    eventType: "watch.subscribed",
    subject: { kind: "watch", id: row.id },
    payload: { watchId: input.watchId, source: watch.source, configVersion: watchVersion() },
  });
  return { ok: true, id: row.id, created: true };
}

export async function pauseWatch(db: Db, subscriptionId: string): Promise<boolean> {
  const res = await db.query("UPDATE watch_subscriptions SET active = FALSE WHERE id = $1 AND active = TRUE", [subscriptionId]);
  return (res.rowCount ?? 0) > 0;
}

export interface WatchRunResult {
  ran: number;
  ok: number;
  failed: number;
  findings: number;
  /** Subscriptions skipped because this deployment has no collector for them.
   *  ⛔ Counted and returned rather than silently passed over. */
  uncollectable: number;
}

/**
 * Run every subscription whose cadence has elapsed.
 *
 * A failed collection writes a FAILED observation. It does not copy the last
 * value forward, and it does not update `last_ok_at` — so the board can tell
 * "unchanged" from "we could not see".
 */
export async function runDueWatches(
  db: Db,
  collectors: Collectors,
  now: Date = new Date(),
  opts: { customerId?: string | undefined; limit?: number } = {},
): Promise<WatchRunResult> {
  const rows = await db.query<{
    id: string; customer_id: string; watch_id: string; subject: string;
    params: Record<string, unknown>; last_run_at: Date | null; consecutive_failures: number;
  }>(
    `SELECT id, customer_id, watch_id, subject, params, last_run_at, consecutive_failures
       FROM watch_subscriptions
      WHERE active = TRUE AND (last_run_at IS NULL OR last_run_at <= $1)
        AND ($2::uuid IS NULL OR customer_id = $2)
      ORDER BY last_run_at ASC NULLS FIRST
      LIMIT $3`,
    // Coarse filter: nothing runs more often than hourly, so the exact cadence
    // is applied per row below against its own watch definition.
    [new Date(now.getTime() - HOUR_MS), opts.customerId ?? null, opts.limit ?? 500],
  );

  const result: WatchRunResult = { ran: 0, ok: 0, failed: 0, findings: 0, uncollectable: 0 };

  for (const sub of rows.rows) {
    const watch = watchById(sub.watch_id);
    if (watch === undefined) continue;
    if (sub.last_run_at !== null && new Date(sub.last_run_at).getTime() + watch.cadenceHours * HOUR_MS > now.getTime()) {
      continue;
    }
    const collector = collectors[watch.source];
    if (collector === undefined) {
      result.uncollectable += 1;
      continue;
    }

    let outcome: CollectorResult;
    try {
      outcome = await collector({ subject: sub.subject, params: sub.params ?? {}, watch });
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    result.ran += 1;

    if (!outcome.ok) {
      result.failed += 1;
      await db.tx(async (tx) => {
        await tx.query(
          "INSERT INTO watch_observations (subscription_id, observed_at, ok, error) VALUES ($1,$2,FALSE,$3)",
          [sub.id, now, outcome.ok ? null : outcome.error],
        );
        await tx.query(
          `UPDATE watch_subscriptions
              SET last_run_at = $2, consecutive_failures = consecutive_failures + 1, last_error = $3
            WHERE id = $1`,
          [sub.id, now, outcome.ok ? null : outcome.error],
        );
      });
      continue;
    }

    result.ok += 1;
    // The previous SUCCESSFUL observation, which is the only sensible baseline.
    const previous = await db.maybeOne<{ value: unknown; value_hash: string }>(
      `SELECT value, value_hash FROM watch_observations
        WHERE subscription_id = $1 AND ok = TRUE ORDER BY observed_at DESC LIMIT 1`,
      [sub.id],
    );
    const hash = valueHash(outcome.value);

    await db.tx(async (tx) => {
      await tx.query(
        "INSERT INTO watch_observations (subscription_id, observed_at, ok, value, value_hash) VALUES ($1,$2,TRUE,$3,$4)",
        [sub.id, now, JSON.stringify(outcome.value), hash],
      );
      await tx.query(
        `UPDATE watch_subscriptions
            SET last_run_at = $2, last_ok_at = $2, consecutive_failures = 0, last_error = NULL
          WHERE id = $1`,
        [sub.id, now],
      );
    });

    // ⛔ No baseline, no finding. A watcher that reports on first sight reports
    // the entire world as new on the day the customer switches it on.
    if (previous === null) continue;

    const findings = detectChanges(watch, previous.value, outcome.value);
    for (const finding of findings) {
      const dedupeWindowMs = Math.max(24, watch.cadenceHours * 3) * HOUR_MS;
      const recent = await db.maybeOne(
        `SELECT 1 AS x FROM watch_findings
          WHERE subscription_id = $1 AND finding_key = $2 AND found_at > $3 LIMIT 1`,
        [sub.id, finding.key, new Date(now.getTime() - dedupeWindowMs)],
      );
      if (recent !== null) continue;

      await db.query(
        `INSERT INTO watch_findings
           (subscription_id, customer_id, watch_id, kind, summary, detail, severity, from_hash, to_hash, finding_key, found_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          sub.id, sub.customer_id, sub.watch_id, finding.kind, finding.summary,
          JSON.stringify(finding.detail), watch.severity, previous.value_hash, hash, finding.key, now,
        ],
      );
      result.findings += 1;
      await emit({
        eventType: "watch.finding",
        subject: { kind: "watch", id: sub.id },
        payload: { watchId: sub.watch_id, kind: finding.kind, severity: watch.severity },
      });
    }
  }
  return result;
}

export type WatchState = "never_run" | "ok" | "stale" | "failing";

export interface WatchBoardRow {
  subscriptionId: string;
  watchId: string;
  label: string;
  subject: string;
  state: WatchState;
  lastRunAt: Date | null;
  /** ⛔ Named `valueAsOf`, never `updatedAt`. The board's job is to make the
   *  age of the number impossible to misread as "now". */
  valueAsOf: Date | null;
  value: unknown;
  consecutiveFailures: number;
  lastError: string | null;
  openFindings: number;
}

/**
 * What is actually being watched, and how long ago each was last SEEN.
 *
 * ⛔ There is no state here that a never-run or long-failing subscription can
 * reach that reads as healthy. `never_run` is its own word rather than a green
 * tick with a null date beside it.
 */
export async function watchBoard(db: Db, customerId: string, now: Date = new Date()): Promise<WatchBoardRow[]> {
  const rows = await db.query<{
    id: string; watch_id: string; subject: string; last_run_at: Date | null;
    last_ok_at: Date | null; consecutive_failures: number; last_error: string | null;
    value: unknown; open_findings: string;
  }>(
    `SELECT s.id, s.watch_id, s.subject, s.last_run_at, s.last_ok_at,
            s.consecutive_failures, s.last_error,
            (SELECT o.value FROM watch_observations o
              WHERE o.subscription_id = s.id AND o.ok = TRUE
              ORDER BY o.observed_at DESC LIMIT 1) AS value,
            (SELECT count(*) FROM watch_findings f
              WHERE f.subscription_id = s.id AND f.acknowledged_at IS NULL AND f.dismissed_at IS NULL) AS open_findings
       FROM watch_subscriptions s
      WHERE s.customer_id = $1 AND s.active = TRUE
      ORDER BY s.watch_id`,
    [customerId],
  );

  return rows.rows.map((r) => {
    const watch = watchById(r.watch_id);
    const lastOk = r.last_ok_at === null ? null : new Date(r.last_ok_at);
    const cadenceMs = (watch?.cadenceHours ?? 24) * HOUR_MS;
    let state: WatchState;
    if (lastOk === null) state = "never_run";
    else if (r.consecutive_failures >= FAILING_AFTER) state = "failing";
    else if (now.getTime() - lastOk.getTime() > STALE_CADENCES * cadenceMs) state = "stale";
    else state = "ok";
    return {
      subscriptionId: r.id,
      watchId: r.watch_id,
      label: watch?.label ?? r.watch_id,
      subject: r.subject,
      state,
      lastRunAt: r.last_run_at === null ? null : new Date(r.last_run_at),
      valueAsOf: lastOk,
      // ⛔ Withheld once the reading is stale or failing. A number on a screen
      // with a quiet "as of" caption beside it gets read as current; a number
      // that is not there does not.
      value: state === "ok" ? r.value : null,
      consecutiveFailures: r.consecutive_failures,
      lastError: r.last_error,
      openFindings: Number(r.open_findings),
    };
  });
}

export interface WatchFinding {
  id: string;
  watchId: string;
  label: string;
  subject: string;
  kind: string;
  summary: string;
  detail: unknown;
  severity: number;
  foundAt: Date;
}

export async function openFindings(db: Db, customerId: string, limit = 100): Promise<WatchFinding[]> {
  const rows = await db.query<{
    id: string; watch_id: string; subject: string; kind: string; summary: string;
    detail: unknown; severity: number; found_at: Date;
  }>(
    `SELECT f.id, f.watch_id, s.subject, f.kind, f.summary, f.detail, f.severity, f.found_at
       FROM watch_findings f
       JOIN watch_subscriptions s ON s.id = f.subscription_id
      WHERE f.customer_id = $1 AND f.acknowledged_at IS NULL AND f.dismissed_at IS NULL
      ORDER BY f.severity ASC, f.found_at DESC
      LIMIT $2`,
    [customerId, limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    watchId: r.watch_id,
    label: watchById(r.watch_id)?.label ?? r.watch_id,
    subject: r.subject,
    kind: r.kind,
    summary: r.summary,
    detail: r.detail,
    severity: r.severity,
    foundAt: new Date(r.found_at),
  }));
}

export async function acknowledgeFinding(db: Db, id: string, by: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE watch_findings SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL AND dismissed_at IS NULL",
    [id, by],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function dismissFinding(db: Db, id: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE watch_findings SET dismissed_at = now() WHERE id = $1 AND dismissed_at IS NULL",
    [id],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Observations are the bulkiest thing this family writes — one row per
 * subscription per cadence, forever. The findings are the product; the
 * observations are the working.
 *
 * ⛔ Never deletes the most recent successful observation for a subscription,
 * whatever its age. That row is the baseline the next comparison is made
 * against, and pruning it turns the next run into a first run: no finding, and
 * a board that quietly resets.
 */
export async function pruneObservations(db: Db, keepDays = 90, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  const res = await db.query(
    `DELETE FROM watch_observations o
      WHERE o.observed_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT k.id FROM watch_observations k
             WHERE k.subscription_id = o.subscription_id AND k.ok = TRUE
             ORDER BY k.observed_at DESC LIMIT 1
          ) newest WHERE newest.id = o.id
        )`,
    [cutoff],
  );
  return res.rowCount ?? 0;
}
