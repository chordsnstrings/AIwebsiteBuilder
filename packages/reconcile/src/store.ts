// Runs, lines and verdicts in the database.
//
// ⛔ There is no function in this file that adjusts an amount. `resolveDifference`
// records what a HUMAN decided about a difference; it does not make the
// difference go away. A reconciliation that posts its own correcting entry can
// hide the very thing it was run to find.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { reconTypeById, reconTypeFor, reconVersion, type ReconType } from "./catalogue.ts";
import { matchItems, type MatchResult, type ReconItem } from "./match.ts";

export interface OpenRunInput {
  customerId: string;
  vertical: string;
  reconType: string;
  periodStart: Date;
  periodEnd: Date;
}

export type OpenRunResult =
  | { ok: true; runId: string; created: boolean; statutory: boolean }
  | { ok: false; reason: "unknown_type" | "period_closed"; detail: string };

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * ⛔ A closed period does not reopen. Re-running it produces a NEW run over a
 * new period or fails; the signature a person put against a set of differences
 * must keep pointing at the set they saw.
 */
export async function openRun(db: Db, input: OpenRunInput): Promise<OpenRunResult> {
  const type = reconTypeFor(input.vertical, input.reconType);
  if (type === undefined) {
    return { ok: false, reason: "unknown_type", detail: `no reconciliation "${input.reconType}" for "${input.vertical}"` };
  }
  const existing = await db.maybeOne<{ id: string; state: string; statutory: boolean }>(
    `SELECT id, state, statutory FROM recon_runs
      WHERE customer_id = $1 AND recon_type = $2 AND period_start = $3 AND period_end = $4`,
    [input.customerId, input.reconType, isoDate(input.periodStart), isoDate(input.periodEnd)],
  );
  if (existing !== null) {
    if (existing.state === "closed") {
      return { ok: false, reason: "period_closed", detail: `that period was closed off; open a new one` };
    }
    return { ok: true, runId: existing.id, created: false, statutory: existing.statutory };
  }
  const row = await db.one<{ id: string }>(
    `INSERT INTO recon_runs (customer_id, recon_type, type_version, period_start, period_end, statutory)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.customerId, input.reconType, reconVersion(), isoDate(input.periodStart), isoDate(input.periodEnd), type.statutory],
  );
  await emit({
    eventType: "recon.opened",
    subject: { kind: "recon_run", id: row.id },
    payload: { reconType: input.reconType, statutory: type.statutory },
  });
  return { ok: true, runId: row.id, created: true, statutory: type.statutory };
}

export interface IngestLine {
  sourceKey: string;
  reference?: string | null;
  amountCents: number;
  occurredOn?: Date | null;
  description?: string | null;
  raw?: Record<string, unknown>;
}

/**
 * Load one side of a run.
 *
 * ⛔ Idempotent on `source_key`, so the same statement uploaded twice does not
 * double the balance — the failure mode that makes a reconciliation report a
 * discrepancy exactly equal to one side of itself.
 *
 * ⛔ Rejects a non-integer amount outright rather than rounding it. A line
 * arriving as 12.34 pounds where the column expects 1234 pence is a
 * hundredfold error, and silently flooring it produces a plausible number.
 */
export async function ingest(
  db: Db,
  runId: string,
  side: "ours" | "theirs",
  lines: IngestLine[],
): Promise<{ inserted: number; skipped: number }> {
  for (const line of lines) {
    if (!Number.isInteger(line.amountCents)) {
      throw new Error(`recon line "${line.sourceKey}" has a non-integer amount (${line.amountCents}); amounts are minor units`);
    }
  }
  let inserted = 0;
  let skipped = 0;
  await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ state: string }>("SELECT state FROM recon_runs WHERE id = $1", [runId]);
    if (run === null) throw new Error(`unknown recon run ${runId}`);
    if (run.state === "closed") throw new Error(`recon run ${runId} is closed`);
    for (const line of lines) {
      const res = await tx.query(
        `INSERT INTO recon_items (run_id, side, source_key, reference, amount_cents, occurred_on, description, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id, side, source_key) DO NOTHING`,
        [
          runId, side, line.sourceKey, line.reference ?? null, line.amountCents,
          line.occurredOn === undefined || line.occurredOn === null ? null : isoDate(line.occurredOn),
          line.description ?? null, JSON.stringify(line.raw ?? {}),
        ],
      );
      if ((res.rowCount ?? 0) > 0) inserted += 1;
      else skipped += 1;
    }
  });
  return { inserted, skipped };
}

export interface ReconSummary {
  runId: string;
  reconType: string;
  label: string;
  statutory: boolean;
  state: string;
  ours: { count: number; totalCents: number };
  theirs: { count: number; totalCents: number };
  matched: number;
  mismatched: number;
  ambiguous: number;
  unmatchedOurs: number;
  unmatchedTheirs: number;
  /** ⛔ The number the whole exercise exists to produce, stated even when it is
   *  zero. A summary that omits the difference when it is nil trains the reader
   *  to look for its presence rather than its value. */
  differenceCents: number;
  /** True only when every line on both sides has a partner within tolerance. */
  balanced: boolean;
}

/**
 * Match the run and record every verdict.
 *
 * Re-runnable while the run is open: the previous verdicts are discarded and
 * recomputed, because a verdict derived from a partial upload is not a verdict
 * anyone should keep.
 */
export async function runReconciliation(db: Db, runId: string): Promise<ReconSummary> {
  const run = await db.one<{
    id: string; customer_id: string; recon_type: string; state: string; statutory: boolean;
  }>("SELECT id, customer_id, recon_type, state, statutory FROM recon_runs WHERE id = $1", [runId]);
  if (run.state === "closed") throw new Error(`recon run ${runId} is closed`);
  const type = reconTypeById(run.recon_type);
  if (type === undefined) throw new Error(`unknown reconciliation type "${run.recon_type}"`);

  const rows = await db.query<{
    id: string; side: "ours" | "theirs"; source_key: string; reference: string | null;
    amount_cents: string; occurred_on: Date | null; description: string | null;
  }>(
    "SELECT id, side, source_key, reference, amount_cents, occurred_on, description FROM recon_items WHERE run_id = $1",
    [runId],
  );
  const items: ReconItem[] = rows.rows.map((r) => ({
    id: r.id,
    side: r.side,
    sourceKey: r.source_key,
    reference: r.reference,
    // ⛔ BIGINT comes back as a string from the driver. Number() here is safe up
    // to 2^53 minor units (£90 trillion); parseFloat on a decimal string would
    // not have been.
    amountCents: Number(r.amount_cents),
    occurredOn: r.occurred_on === null ? null : new Date(r.occurred_on),
    description: r.description,
  }));
  const ours = items.filter((i) => i.side === "ours");
  const theirs = items.filter((i) => i.side === "theirs");
  const verdicts = matchItems(type, ours, theirs);

  await db.tx(async (tx) => {
    await tx.query("DELETE FROM recon_matches WHERE run_id = $1 AND resolved_at IS NULL", [runId]);
    for (const v of verdicts) {
      await tx.query(
        `INSERT INTO recon_matches (run_id, status, strategy, ours_ids, theirs_ids, amount_ours, amount_theirs, delta_cents, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [runId, v.status, v.strategy, v.oursIds, v.theirsIds, v.amountOurs, v.amountTheirs, v.deltaCents, v.note ?? null],
      );
    }
    await tx.query("UPDATE recon_runs SET state = 'matched', matched_at = now() WHERE id = $1 AND state <> 'closed'", [runId]);
  });

  const summary = summarise(runId, type, run.statutory, "matched", ours, theirs, verdicts);
  await db.query("UPDATE recon_runs SET summary = $2 WHERE id = $1", [runId, JSON.stringify(summary)]);
  await emit({
    eventType: "recon.completed",
    subject: { kind: "recon_run", id: runId },
    payload: { reconType: run.recon_type, differenceCents: summary.differenceCents, balanced: summary.balanced },
  });
  return summary;
}

function summarise(
  runId: string,
  type: ReconType,
  statutory: boolean,
  state: string,
  ours: ReconItem[],
  theirs: ReconItem[],
  verdicts: MatchResult[],
): ReconSummary {
  const count = (s: MatchResult["status"]): number => verdicts.filter((v) => v.status === s).length;
  const oursTotal = ours.reduce((a, i) => a + i.amountCents, 0);
  const theirsTotal = theirs.reduce((a, i) => a + i.amountCents, 0);
  return {
    runId,
    reconType: type.id,
    label: type.label,
    statutory,
    state,
    ours: { count: ours.length, totalCents: oursTotal },
    theirs: { count: theirs.length, totalCents: theirsTotal },
    matched: count("matched"),
    mismatched: count("mismatched"),
    ambiguous: count("ambiguous"),
    unmatchedOurs: count("unmatched_ours"),
    unmatchedTheirs: count("unmatched_theirs"),
    differenceCents: theirsTotal - oursTotal,
    balanced:
      count("mismatched") === 0 && count("ambiguous") === 0 &&
      count("unmatched_ours") === 0 && count("unmatched_theirs") === 0,
  };
}

export interface OpenDifference {
  id: string;
  status: string;
  strategy: string | null;
  oursIds: string[];
  theirsIds: string[];
  amountOursCents: number;
  amountTheirsCents: number;
  deltaCents: number;
  note: string | null;
}

/** Everything still needing a person, largest difference first. */
export async function openDifferences(db: Db, runId: string): Promise<OpenDifference[]> {
  const rows = await db.query<{
    id: string; status: string; strategy: string | null; ours_ids: string[]; theirs_ids: string[];
    amount_ours: string; amount_theirs: string; delta_cents: string; note: string | null;
  }>(
    `SELECT id, status, strategy, ours_ids, theirs_ids, amount_ours, amount_theirs, delta_cents, note
       FROM recon_matches
      WHERE run_id = $1 AND status <> 'matched' AND resolved_at IS NULL
      ORDER BY abs(delta_cents) DESC, id`,
    [runId],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    status: r.status,
    strategy: r.strategy,
    oursIds: r.ours_ids,
    theirsIds: r.theirs_ids,
    amountOursCents: Number(r.amount_ours),
    amountTheirsCents: Number(r.amount_theirs),
    deltaCents: Number(r.delta_cents),
    note: r.note,
  }));
}

/**
 * ⛔ Records what a person decided. It does NOT alter an amount, create a
 * balancing line, or mark the run balanced. The difference stays exactly where
 * it was, with a name and an explanation beside it.
 */
export async function resolveDifference(
  db: Db,
  matchId: string,
  by: string,
  resolution: string,
): Promise<boolean> {
  if (resolution.trim().length === 0) return false;
  const res = await db.query(
    "UPDATE recon_matches SET resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1 AND resolved_at IS NULL",
    [matchId, by, resolution.trim()],
  );
  return (res.rowCount ?? 0) > 0;
}

export type CloseResult =
  | { ok: true }
  | { ok: false; reason: "not_matched" | "unresolved" | "already_closed"; outstanding?: number };

/**
 * Sign the run off.
 *
 * ⛔ Refuses while anything is still unexplained. A reconciliation closed over
 * open differences is a reconciliation that recorded a signature against a
 * question — and for the statutory ones (a client account, a deposit register)
 * that signature is the regulatory artefact.
 */
export async function closeRun(db: Db, runId: string, by: string): Promise<CloseResult> {
  const run = await db.one<{ state: string }>("SELECT state FROM recon_runs WHERE id = $1", [runId]);
  if (run.state === "closed") return { ok: false, reason: "already_closed" };
  if (run.state !== "matched") return { ok: false, reason: "not_matched" };
  const outstanding = await db.one<{ n: string }>(
    "SELECT count(*) AS n FROM recon_matches WHERE run_id = $1 AND status <> 'matched' AND resolved_at IS NULL",
    [runId],
  );
  if (Number(outstanding.n) > 0) return { ok: false, reason: "unresolved", outstanding: Number(outstanding.n) };
  await db.query("UPDATE recon_runs SET state = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1", [runId, by]);
  await emit({ eventType: "recon.closed", subject: { kind: "recon_run", id: runId }, payload: { by } });
  return { ok: true };
}

export interface RunListRow {
  runId: string;
  reconType: string;
  label: string;
  statutory: boolean;
  state: string;
  periodStart: Date;
  periodEnd: Date;
  outstanding: number;
  differenceCents: number;
}

export async function runsFor(db: Db, customerId: string, limit = 50): Promise<RunListRow[]> {
  const rows = await db.query<{
    id: string; recon_type: string; statutory: boolean; state: string;
    period_start: Date; period_end: Date; summary: { differenceCents?: number } | null; outstanding: string;
  }>(
    `SELECT r.id, r.recon_type, r.statutory, r.state, r.period_start, r.period_end, r.summary,
            (SELECT count(*) FROM recon_matches m
              WHERE m.run_id = r.id AND m.status <> 'matched' AND m.resolved_at IS NULL) AS outstanding
       FROM recon_runs r
      WHERE r.customer_id = $1
      ORDER BY r.statutory DESC, r.period_end DESC
      LIMIT $2`,
    [customerId, limit],
  );
  return rows.rows.map((r) => ({
    runId: r.id,
    reconType: r.recon_type,
    label: reconTypeById(r.recon_type)?.label ?? r.recon_type,
    statutory: r.statutory,
    state: r.state,
    periodStart: new Date(r.period_start),
    periodEnd: new Date(r.period_end),
    outstanding: Number(r.outstanding),
    differenceCents: r.summary?.differenceCents ?? 0,
  }));
}
