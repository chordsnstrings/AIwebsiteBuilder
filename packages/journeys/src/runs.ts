// MF5 — multi-touch journeys for the customer's own contacts.
//
// ⛔ Suppression is re-checked before EVERY step, not once at the start.
// Consent at step 1 is not consent at step 3 twelve days later, and a sequence
// that only asks at enrolment is a sequence that keeps messaging people who
// unsubscribed on day two. This is the clamp that makes the rest of the family
// safe to run unattended.

import { emailHash, type Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { allJourneys, journeyFor, journeyVersion, type Journey } from "./catalogue.ts";

const DAY_MS = 86_400_000;
const MAX_FAILURES = 3;
const RETRY_MS = 60 * 60_000;

export interface StartJourneyInput {
  customerId: string;
  vertical: string;
  journeyId: string;
  subjectRef: string;
  contact: string;
}

export type StartResult =
  | { started: true; runId: string; nextStepAt: Date }
  | { started: false; reason: "unknown_journey" | "suppressed" | "already_running"; runId?: string };

/**
 * Enrol someone in a sequence.
 *
 * ⛔ Refuses a suppressed contact outright rather than enrolling them and
 * discovering it at step one. An enrolled-but-never-sent run looks identical to
 * a working one on every dashboard.
 */
export async function startJourney(
  db: Db,
  input: StartJourneyInput,
  now: Date = new Date(),
): Promise<StartResult> {
  const journey = journeyFor(input.vertical, input.journeyId);
  if (journey === undefined) return { started: false, reason: "unknown_journey" };
  if (await isSuppressed(db, input.contact)) return { started: false, reason: "suppressed" };

  const first = journey.steps[0]!;
  return db.tx(async (tx) => {
    const existing = await tx.maybeOne<{ id: string }>(
      "SELECT id FROM journey_runs WHERE customer_id = $1 AND journey_id = $2 AND subject_ref = $3 AND state = 'running'",
      [input.customerId, input.journeyId, input.subjectRef],
    );
    if (existing !== null) return { started: false as const, reason: "already_running" as const, runId: existing.id };

    const nextStepAt = new Date(now.getTime() + first.afterDays * DAY_MS);
    const row = await tx.one<{ id: string }>(
      `INSERT INTO journey_runs (customer_id, journey_id, journey_version, subject_ref, contact, next_step_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.customerId, input.journeyId, journeyVersion(), input.subjectRef, input.contact, nextStepAt, now],
    );
    await emit({
      eventType: "journey.started",
      subject: { kind: "journey_run", id: row.id },
      payload: { journeyId: input.journeyId, steps: journey.steps.length },
    });
    return { started: true as const, runId: row.id, nextStepAt };
  });
}

export interface JourneyStepDue {
  runId: string;
  customerId: string;
  vertical: string;
  journeyId: string;
  journeyLabel: string;
  journeyKind: string;
  stepIndex: number;
  /** 1-based, for humans: "step 2 of 3". */
  stepNumber: number;
  stepCount: number;
  template: string;
  purpose: string;
  subjectRef: string;
  contact: string;
}

export type JourneyDeliverFn = (s: JourneyStepDue) => Promise<{ delivered: boolean; detail?: string }>;

export interface JourneyRunResult {
  delivered: number;
  failed: number;
  completed: number;
  stopped: number;
}

/**
 * Advance every run whose next step has come due.
 *
 * The pointer only moves on a delivered step. A failed step is retried in an
 * hour, three times, and then the run stops as undeliverable — a contact that
 * keeps failing must fall out of the sequence rather than be retried until the
 * end of time.
 */
export async function runJourneys(
  db: Db,
  deliver: JourneyDeliverFn,
  now: Date = new Date(),
): Promise<JourneyRunResult> {
  const due = await db.query<{
    id: string; customer_id: string; journey_id: string; subject_ref: string;
    contact: string; step_index: number; failures: number; created_at: Date; vertical: string | null;
  }>(
    `SELECT r.id, r.customer_id, r.journey_id, r.subject_ref, r.contact,
            r.step_index, r.failures, r.created_at, b.vertical
       FROM journey_runs r
       JOIN customers c  ON c.id = r.customer_id
       JOIN businesses b ON b.id = c.business_id
      WHERE r.state = 'running' AND r.next_step_at IS NOT NULL AND r.next_step_at <= $1
      ORDER BY r.next_step_at ASC
      LIMIT 200`,
    [now],
  );

  const result: JourneyRunResult = { delivered: 0, failed: 0, completed: 0, stopped: 0 };

  for (const run of due.rows) {
    // ⛔ Before anything else, every time.
    if (await isSuppressed(db, run.contact)) {
      await stopJourney(db, run.id, "suppressed");
      result.stopped += 1;
      continue;
    }

    const vertical = run.vertical ?? "";
    const journey = journeyFor(vertical, run.journey_id);
    if (journey === undefined) {
      // The journey was removed from config, or the business changed vertical.
      // Stopping is the safe direction: continuing would send steps from a
      // sequence nobody can read any more.
      await stopJourney(db, run.id, "journey_unavailable");
      result.stopped += 1;
      continue;
    }

    const step = journey.steps[run.step_index];
    if (step === undefined) {
      await completeRun(db, run.id);
      result.completed += 1;
      continue;
    }

    const payload: JourneyStepDue = {
      runId: run.id,
      customerId: run.customer_id,
      vertical,
      journeyId: run.journey_id,
      journeyLabel: journey.label,
      journeyKind: journey.kind,
      stepIndex: run.step_index,
      stepNumber: run.step_index + 1,
      stepCount: journey.steps.length,
      template: step.template,
      purpose: step.purpose,
      subjectRef: run.subject_ref,
      contact: run.contact,
    };

    let outcome: { delivered: boolean; detail?: string };
    try {
      outcome = await deliver(payload);
    } catch (err) {
      outcome = { delivered: false, detail: String(err) };
    }

    if (!outcome.delivered) {
      const failures = run.failures + 1;
      if (failures >= MAX_FAILURES) {
        await db.query(
          "UPDATE journey_runs SET state = 'stopped', stop_reason = 'undeliverable', failures = $2, last_error = $3, next_step_at = NULL WHERE id = $1",
          [run.id, failures, outcome.detail ?? null],
        );
        result.stopped += 1;
      } else {
        await db.query(
          "UPDATE journey_runs SET failures = $2, last_error = $3, next_step_at = $4 WHERE id = $1",
          [run.id, failures, outcome.detail ?? null, new Date(now.getTime() + RETRY_MS)],
        );
        result.failed += 1;
      }
      continue;
    }

    const nextIndex = run.step_index + 1;
    const nextStep = journey.steps[nextIndex];
    // ⛔ Measured from the run's start, not from now. Computing each step from
    // "now" lets a retried step drag the whole tail of the sequence with it, so
    // a one-hour delivery hiccup silently rewrites a 21-day cadence.
    const nextAt = nextStep === undefined ? null : new Date(new Date(run.created_at).getTime() + nextStep.afterDays * DAY_MS);

    await db.tx(async (tx) => {
      await tx.query(
        `INSERT INTO journey_steps_sent (run_id, step_index, template, detail, sent_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (run_id, step_index) DO NOTHING`,
        [run.id, run.step_index, step.template, outcome.detail ?? null, now],
      );
      await tx.query(
        `UPDATE journey_runs
            SET step_index = $2, failures = 0, last_error = NULL, last_step_at = $3,
                next_step_at = $4, state = $5
          WHERE id = $1`,
        [run.id, nextIndex, now, nextAt, nextStep === undefined ? "completed" : "running"],
      );
    });

    result.delivered += 1;
    if (nextStep === undefined) result.completed += 1;
    await emit({
      eventType: "journey.step_sent",
      subject: { kind: "journey_run", id: run.id },
      payload: { journeyId: run.journey_id, step: run.step_index, template: step.template },
    });
  }

  return result;
}

async function completeRun(db: Db, runId: string): Promise<void> {
  await db.query("UPDATE journey_runs SET state = 'completed', next_step_at = NULL WHERE id = $1 AND state = 'running'", [runId]);
}

export async function stopJourney(db: Db, runId: string, reason: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE journey_runs SET state = 'stopped', stop_reason = $2, next_step_at = NULL WHERE id = $1 AND state = 'running'",
    [runId, reason],
  );
  if ((res.rowCount ?? 0) === 0) return false;
  await emit({ eventType: "journey.stopped", subject: { kind: "journey_run", id: runId }, payload: { reason } });
  return true;
}

/**
 * Something happened to the subject — they replied, they booked, they paid,
 * they left a review — so every sequence that lists it in `stop_on` ends.
 *
 * ⛔ This is the half of `stop_on` that makes it real. A stop list nothing
 * reports into is a comment: the run keeps going and step 3 asks for a review
 * from someone who left one on day two.
 */
export async function journeyEvent(
  db: Db,
  input: { customerId: string; event: string; subjectRef?: string | undefined; contact?: string | undefined },
): Promise<number> {
  // ⛔ One of the two is required. With neither, the WHERE clause degenerates to
  // "every running run for this customer" and a single stray booking silently
  // ends every sequence the business has.
  if (input.subjectRef === undefined && input.contact === undefined) {
    throw new Error("journeyEvent needs a subjectRef or a contact");
  }
  const journeyIds = allJourneys().filter((j) => j.stopOn.includes(input.event)).map((j) => j.id);
  if (journeyIds.length === 0) return 0;
  const res = await db.query(
    `UPDATE journey_runs SET state = 'stopped', stop_reason = $2, next_step_at = NULL
      WHERE customer_id = $1 AND state = 'running' AND journey_id = ANY($3::text[])
        AND ($4::text IS NULL OR subject_ref = $4)
        AND ($5::text IS NULL OR contact = $5)`,
    [input.customerId, `event:${input.event}`, journeyIds, input.subjectRef ?? null, input.contact ?? null],
  );
  return res.rowCount ?? 0;
}

export interface JourneyRunSummary {
  runId: string;
  journeyId: string;
  journeyLabel: string;
  subjectRef: string;
  state: string;
  stopReason: string | null;
  stepIndex: number;
  stepCount: number;
  nextStepAt: Date | null;
}

/** What is running, for the owner's dashboard. */
export async function activeRuns(db: Db, customerId: string, vertical: string): Promise<JourneyRunSummary[]> {
  const rows = await db.query<{
    id: string; journey_id: string; subject_ref: string; state: string;
    stop_reason: string | null; step_index: number; next_step_at: Date | null;
  }>(
    `SELECT id, journey_id, subject_ref, state, stop_reason, step_index, next_step_at
       FROM journey_runs WHERE customer_id = $1 AND state = 'running' ORDER BY next_step_at ASC`,
    [customerId],
  );
  const byId = new Map<string, Journey>(allJourneys().map((j) => [j.id, j]));
  return rows.rows.map((r) => {
    const j = journeyFor(vertical, r.journey_id) ?? byId.get(r.journey_id);
    return {
      runId: r.id,
      journeyId: r.journey_id,
      journeyLabel: j?.label ?? r.journey_id,
      subjectRef: r.subject_ref,
      state: r.state,
      stopReason: r.stop_reason,
      stepIndex: r.step_index,
      stepCount: j?.steps.length ?? 0,
      nextStepAt: r.next_step_at === null ? null : new Date(r.next_step_at),
    };
  });
}

async function isSuppressed(db: Db, contact: string): Promise<boolean> {
  const row = await db.maybeOne("SELECT 1 AS x FROM suppression WHERE email_hash = $1 LIMIT 1", [emailHash(contact)]);
  return row !== null;
}
