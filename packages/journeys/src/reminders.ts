// MF4 — the dates a business has to keep.
//
// A reminder is an anchor date plus an offset from config/clocks.yaml. Nothing
// here sends anything: a due reminder becomes a work item in the owner's queue,
// because the gate is the sole route to transport and a business messaging its
// own client on its own sending identity is not built yet. What IS built is the
// part that was missing entirely — the date existing, surviving a restart, and
// arriving.

import { emailHash, type Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { clockFor, clockVersion } from "./catalogue.ts";

export interface ScheduleReminderInput {
  customerId: string;
  vertical: string;
  /** A clock id from config/clocks.yaml for this vertical's archetype. */
  kind: string;
  /** Who or what it is about: a patient ref, a property, an invoice number. */
  subjectRef: string;
  contact?: string | undefined;
  /** The fact the date derives from — a certificate expiry, a last visit. */
  anchorAt: Date;
  sourceCaseId?: string | undefined;
  /** ⛔ Required to move an existing STATUTORY reminder. An automatic
   *  re-anchor without one is refused rather than applied. */
  override?: { actor: string; reason: string } | undefined;
}

export type ScheduleResult =
  | { ok: true; id: string; dueAt: Date; statutory: boolean; created: boolean; moved: boolean }
  | { ok: false; reason: "unknown_clock" | "statutory_locked"; detail: string; id?: string; dueAt?: Date };

const DAY_MS = 86_400_000;

function computeDue(anchorAt: Date, offsetDays: number): Date {
  return new Date(anchorAt.getTime() + offsetDays * DAY_MS);
}

/**
 * Put a date on the calendar.
 *
 * Idempotent on (customer, kind, subject): calling it again with the same
 * anchor returns the same row. Calling it with a NEW anchor moves the pending
 * reminder rather than leaving two standing — a tenant told their gas safety
 * certificate expires on two different days trusts neither date.
 *
 * ⛔ Unless the clock is statutory. Then the move is refused without an explicit
 * human override, and the override is recorded on the row. This is the whole
 * point of the `statutory` flag: a recall can slip a fortnight, a licence
 * renewal date is a fact about the law and nothing automatic may quietly
 * rewrite it.
 */
export async function scheduleReminder(
  db: Db,
  input: ScheduleReminderInput,
  now: Date = new Date(),
): Promise<ScheduleResult> {
  const clock = clockFor(input.vertical, input.kind);
  if (clock === undefined) {
    return { ok: false, reason: "unknown_clock", detail: `no clock "${input.kind}" for vertical "${input.vertical}"` };
  }
  const dueAt = computeDue(input.anchorAt, clock.offsetDays);

  return db.tx(async (tx) => {
    const existing = await tx.maybeOne<{ id: string; due_at: Date; statutory: boolean }>(
      `SELECT id, due_at, statutory FROM reminders
        WHERE customer_id = $1 AND kind = $2 AND subject_ref = $3
          AND fired_at IS NULL AND cancelled_at IS NULL
        FOR UPDATE`,
      [input.customerId, input.kind, input.subjectRef],
    );

    if (existing !== null) {
      const sameDay = Math.abs(new Date(existing.due_at).getTime() - dueAt.getTime()) < 60_000;
      if (sameDay) {
        return { ok: true as const, id: existing.id, dueAt: new Date(existing.due_at), statutory: existing.statutory, created: false, moved: false };
      }
      if (existing.statutory && input.override === undefined) {
        return {
          ok: false as const,
          reason: "statutory_locked" as const,
          detail: `"${input.kind}" is statutory; moving it needs a named actor and a reason`,
          id: existing.id,
          dueAt: new Date(existing.due_at),
        };
      }
      await tx.query(
        `UPDATE reminders SET anchor_at = $2, due_at = $3, contact = COALESCE($4, contact),
                moved_at = $5, moved_by = $6, moved_reason = $7
          WHERE id = $1`,
        [
          existing.id, input.anchorAt, dueAt, input.contact ?? null, now,
          input.override?.actor ?? null, input.override?.reason ?? null,
        ],
      );
      await emit({
        eventType: "reminder.moved",
        subject: { kind: "reminder", id: existing.id },
        payload: { kind: input.kind, from: existing.due_at, to: dueAt, statutory: existing.statutory, by: input.override?.actor ?? "system" },
      });
      return { ok: true as const, id: existing.id, dueAt, statutory: existing.statutory, created: false, moved: true };
    }

    const row = await tx.one<{ id: string }>(
      `INSERT INTO reminders (customer_id, kind, subject_ref, contact, anchor_at, due_at, statutory, source_case_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        input.customerId, input.kind, input.subjectRef, input.contact ?? null,
        input.anchorAt, dueAt,
        // ⛔ From the clock definition, never from the caller.
        clock.statutory,
        input.sourceCaseId ?? null,
      ],
    );
    await emit({
      eventType: "reminder.scheduled",
      subject: { kind: "reminder", id: row.id },
      payload: { kind: input.kind, dueAt, statutory: clock.statutory, configVersion: clockVersion() },
    });
    return { ok: true as const, id: row.id, dueAt, statutory: clock.statutory, created: true, moved: false };
  });
}

export interface ReminderDue {
  id: string;
  customerId: string;
  vertical: string;
  kind: string;
  label: string;
  subjectRef: string;
  contact: string | null;
  dueAt: Date;
  statutory: boolean;
  severity: number;
  daysLate: number;
  sourceCaseId: string | null;
  /** ⛔ Reported, never acted on here. An unsubscribe from a business's
   *  marketing must not suppress "your gas safety certificate expires in 28
   *  days" — that is the landlord's legal obligation, not a newsletter. The
   *  consumer decides; this makes sure it can. */
  contactSuppressed: boolean;
}

const SEVERITY_FALLBACK = 4;

export async function dueReminders(db: Db, now: Date = new Date(), limit = 200): Promise<ReminderDue[]> {
  const rows = await db.query<{
    id: string; customer_id: string; vertical: string | null; kind: string;
    subject_ref: string; contact: string | null; due_at: Date; statutory: boolean;
    source_case_id: string | null;
  }>(
    `SELECT r.id, r.customer_id, b.vertical, r.kind, r.subject_ref, r.contact,
            r.due_at, r.statutory, r.source_case_id
       FROM reminders r
       JOIN customers c  ON c.id = r.customer_id
       JOIN businesses b ON b.id = c.business_id
      WHERE r.fired_at IS NULL AND r.cancelled_at IS NULL AND r.due_at <= $1
      ORDER BY r.statutory DESC, r.due_at ASC
      LIMIT $2`,
    [now, limit],
  );

  const out: ReminderDue[] = [];
  for (const r of rows.rows) {
    const vertical = r.vertical ?? "";
    const clock = clockFor(vertical, r.kind);
    out.push({
      id: r.id,
      customerId: r.customer_id,
      vertical,
      kind: r.kind,
      label: clock?.label ?? r.kind,
      subjectRef: r.subject_ref,
      contact: r.contact,
      dueAt: new Date(r.due_at),
      statutory: r.statutory,
      severity: clock?.severity ?? SEVERITY_FALLBACK,
      daysLate: Math.floor((now.getTime() - new Date(r.due_at).getTime()) / DAY_MS),
      sourceCaseId: r.source_case_id,
      contactSuppressed: r.contact === null ? false : await isSuppressed(db, r.contact),
    });
  }
  // Most urgent first: statutory before not, then severity, then oldest.
  return out.sort((a, b) =>
    Number(b.statutory) - Number(a.statutory) ||
    a.severity - b.severity ||
    a.dueAt.getTime() - b.dueAt.getTime());
}

async function isSuppressed(db: Db, contact: string): Promise<boolean> {
  const row = await db.maybeOne("SELECT 1 AS x FROM suppression WHERE email_hash = $1 LIMIT 1", [emailHash(contact)]);
  return row !== null;
}

export type ReminderDeliverFn = (r: ReminderDue) => Promise<{ delivered: boolean; detail?: string }>;

export interface ReminderRunResult {
  fired: number;
  delivered: number;
  failed: number;
  recurred: number;
}

/**
 * Fire everything that has come due.
 *
 * ⛔ A reminder is marked fired whether or not delivery succeeded. Retrying the
 * same reminder forever stalls every later one behind an unreachable contact,
 * and the failure is recorded on the row so it is visible rather than retried
 * into silence.
 */
export async function runReminders(
  db: Db,
  deliver: ReminderDeliverFn,
  now: Date = new Date(),
): Promise<ReminderRunResult> {
  const due = await dueReminders(db, now);
  const result: ReminderRunResult = { fired: 0, delivered: 0, failed: 0, recurred: 0 };

  for (const reminder of due) {
    let outcome: { delivered: boolean; detail?: string };
    try {
      outcome = await deliver(reminder);
    } catch (err) {
      outcome = { delivered: false, detail: String(err) };
    }
    await db.query("UPDATE reminders SET fired_at = $2, delivered = $3 WHERE id = $1 AND fired_at IS NULL", [
      reminder.id, now, outcome.delivered,
    ]);
    result.fired += 1;
    if (outcome.delivered) result.delivered += 1;
    else result.failed += 1;

    // The next occurrence, where one is knowable from this one. An annual gas
    // safety check recurs on the calendar; a dental recall does not, and the
    // absence of `recur_days` on that clock is what stops us mailing a patient
    // who stopped attending twice a year forever.
    const clock = clockFor(reminder.vertical, reminder.kind);
    if (clock?.recurDays !== undefined) {
      const nextDue = new Date(reminder.dueAt.getTime() + clock.recurDays * DAY_MS);
      const inserted = await db.query(
        `INSERT INTO reminders (customer_id, kind, subject_ref, contact, anchor_at, due_at, statutory, source_case_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          reminder.customerId, reminder.kind, reminder.subjectRef, reminder.contact,
          new Date(nextDue.getTime() - clock.offsetDays * DAY_MS), nextDue,
          reminder.statutory, reminder.sourceCaseId,
        ],
      );
      if ((inserted.rowCount ?? 0) > 0) result.recurred += 1;
    }

    await emit({
      eventType: "reminder.fired",
      subject: { kind: "reminder", id: reminder.id },
      payload: { kind: reminder.kind, statutory: reminder.statutory, delivered: outcome.delivered },
    });
  }
  return result;
}

export async function cancelReminder(db: Db, id: string, reason: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE reminders SET cancelled_at = now(), cancel_reason = $2 WHERE id = $1 AND fired_at IS NULL AND cancelled_at IS NULL",
    [id, reason],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface UpcomingReminder {
  id: string;
  kind: string;
  label: string;
  subjectRef: string;
  dueAt: Date;
  statutory: boolean;
  severity: number;
}

/** What is coming, for the owner's dashboard. Statutory first. */
export async function upcomingReminders(
  db: Db,
  customerId: string,
  withinDays = 90,
  now: Date = new Date(),
): Promise<UpcomingReminder[]> {
  const rows = await db.query<{
    id: string; kind: string; subject_ref: string; due_at: Date; statutory: boolean; vertical: string | null;
  }>(
    `SELECT r.id, r.kind, r.subject_ref, r.due_at, r.statutory, b.vertical
       FROM reminders r
       JOIN customers c  ON c.id = r.customer_id
       JOIN businesses b ON b.id = c.business_id
      WHERE r.customer_id = $1 AND r.fired_at IS NULL AND r.cancelled_at IS NULL
        AND r.due_at <= $2
      ORDER BY r.due_at ASC`,
    [customerId, new Date(now.getTime() + withinDays * DAY_MS)],
  );
  return rows.rows
    .map((r) => {
      const clock = clockFor(r.vertical ?? "", r.kind);
      return {
        id: r.id,
        kind: r.kind,
        label: clock?.label ?? r.kind,
        subjectRef: r.subject_ref,
        dueAt: new Date(r.due_at),
        statutory: r.statutory,
        severity: clock?.severity ?? SEVERITY_FALLBACK,
      };
    })
    .sort((a, b) => Number(b.statutory) - Number(a.statutory) || a.dueAt.getTime() - b.dueAt.getTime());
}
