// @adw/scheduling — capacity, availability and waitlists (catalogue MF10).
//
// `bookingNext` in @adw/concierge was written, unit-tested and reachable from
// POST /agent/turn, and never offered anybody a slot: `availableSlots` had no
// production supplier. This is the supplier.
//
// ⛔ Resource-first, not calendar-first. A salon with three chairs is not one
// calendar with three times the capacity — it is three resources, and a booking
// consumes exactly one. Modelling it as a single stream is what produces two
// customers in one chair at ten past three.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";

export interface Slot {
  start: string;
  end: string;
}

export interface ResourceSlot extends Slot {
  resourceId: string;
  resourceName: string;
  /** Free places. >1 only for a class or a course. */
  remaining: number;
}

export interface AvailabilityWindow {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

export interface SlotOptions {
  /** Only this resource. Absent means any. */
  resourceId?: string | undefined;
  /** Most businesses cannot take a booking starting in nine minutes. */
  leadTimeMinutes?: number;
  /** How many to return. Offering thirty slots is offering none. */
  limit?: number;
  now?: Date;
}

const DEFAULT_LEAD_MINUTES = 120;
const DEFAULT_LIMIT = 6;

interface RuleRow {
  resource_id: string | null;
  weekday: number;
  start_minute: number;
  end_minute: number;
  slot_minutes: number;
  buffer_minutes: number;
}

/**
 * The slots a customer can actually be offered.
 *
 * ⛔ Computed from rules MINUS exceptions MINUS existing bookings, in that
 * order, and never optimistically. Offering a slot that is already taken is
 * worse than offering nothing: the visitor believes they have an appointment,
 * arrives, and the business finds out at the counter.
 */
export async function availableSlots(
  db: Db,
  customerId: string,
  window: AvailabilityWindow,
  opts: SlotOptions = {},
): Promise<ResourceSlot[]> {
  const now = opts.now ?? new Date();
  const lead = opts.leadTimeMinutes ?? DEFAULT_LEAD_MINUTES;
  const earliest = new Date(Math.max(window.from.getTime(), now.getTime() + lead * 60_000));
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (earliest >= window.to) return [];

  const resources = await db.query<{ id: string; name: string; capacity: number }>(
    `SELECT id, name, capacity FROM scheduling_resources
      WHERE customer_id = $1 AND active = TRUE AND ($2::uuid IS NULL OR id = $2)
      ORDER BY name`,
    [customerId, opts.resourceId ?? null],
  );
  if (resources.rows.length === 0) return [];

  const rules = await db.query<RuleRow>(
    "SELECT resource_id, weekday, start_minute, end_minute, slot_minutes, buffer_minutes FROM availability_rules WHERE customer_id = $1",
    [customerId],
  );
  if (rules.rows.length === 0) return [];

  const blocks = await db.query<{ resource_id: string | null; starts_at: Date; ends_at: Date }>(
    `SELECT resource_id, starts_at, ends_at FROM availability_exceptions
      WHERE customer_id = $1 AND ends_at > $2 AND starts_at < $3`,
    [customerId, earliest, window.to],
  );
  const booked = await db.query<{ resource_id: string | null; slot_start: Date; slot_end: Date }>(
    `SELECT resource_id, slot_start, slot_end FROM bookings
      WHERE customer_id = $1 AND status <> 'cancelled' AND slot_end > $2 AND slot_start < $3`,
    [customerId, earliest, window.to],
  );

  const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean =>
    aStart < bEnd && bStart < aEnd;

  const out: ResourceSlot[] = [];
  // Walk day by day rather than minute by minute — a fortnight of one-minute
  // steps is 20k iterations per request for no additional correctness.
  for (let day = new Date(earliest); day < window.to && out.length < limit; day = nextDay(day)) {
    const weekday = day.getUTCDay();
    for (const resource of resources.rows) {
      const applicable = rules.rows.filter(
        (r) => r.weekday === weekday && (r.resource_id === null || r.resource_id === resource.id),
      );
      for (const rule of applicable) {
        const step = rule.slot_minutes + rule.buffer_minutes;
        for (let m = rule.start_minute; m + rule.slot_minutes <= rule.end_minute; m += step) {
          const start = atMinute(day, m);
          const end = new Date(start.getTime() + rule.slot_minutes * 60_000);
          if (start < earliest || end > window.to) continue;

          const blocked = blocks.rows.some(
            (b) => (b.resource_id === null || b.resource_id === resource.id) && overlaps(start, end, b.starts_at, b.ends_at),
          );
          if (blocked) continue;

          const taken = booked.rows.filter(
            (b) => b.resource_id === resource.id && overlaps(start, end, b.slot_start, b.slot_end),
          ).length;
          const remaining = resource.capacity - taken;
          if (remaining <= 0) continue;

          out.push({
            start: start.toISOString(),
            end: end.toISOString(),
            resourceId: resource.id,
            resourceName: resource.name,
            remaining,
          });
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out.slice(0, limit);
}

function nextDay(d: Date): Date {
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return n;
}
function atMinute(day: Date, minute: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, minute));
}

/**
 * Take a slot, refusing if capacity has gone since it was offered.
 *
 * ⛔ Re-checked inside the transaction, not trusted from the offer. Between the
 * agent showing three o'clock and the visitor typing "yes" there is a human
 * pause of any length, and somebody else can take it. A booking system that
 * trusts its own earlier answer double-books at exactly the busiest times.
 */
export async function claimSlot(
  db: Db,
  input: {
    customerId: string;
    resourceId: string;
    start: Date;
    end: Date;
    contact: string;
    sessionId?: string | undefined;
    idempotencyKey: string;
  },
): Promise<{ booked: boolean; bookingId?: string; reason?: string }> {
  return db.tx(async (tx) => {
    // ⛔ Idempotency FIRST, before capacity. A replayed claim is the same
    // booking, not a competitor for it — checking capacity first makes the
    // second delivery of one request report "slot_taken" against the booking it
    // itself created, and the visitor is told their own booking failed.
    const replay = await tx.maybeOne<{ id: string }>("SELECT id FROM bookings WHERE idempotency_key = $1", [
      input.idempotencyKey,
    ]);
    if (replay !== null) return { booked: true, bookingId: replay.id };

    const resource = await tx.maybeOne<{ capacity: number; active: boolean }>(
      "SELECT capacity, active FROM scheduling_resources WHERE id = $1 AND customer_id = $2 FOR UPDATE",
      [input.resourceId, input.customerId],
    );
    if (resource === null) return { booked: false, reason: "unknown_resource" };
    if (!resource.active) return { booked: false, reason: "resource_inactive" };

    const blocked = await tx.maybeOne(
      `SELECT 1 AS x FROM availability_exceptions
        WHERE customer_id = $1 AND (resource_id IS NULL OR resource_id = $2)
          AND starts_at < $4 AND ends_at > $3 LIMIT 1`,
      [input.customerId, input.resourceId, input.start, input.end],
    );
    if (blocked !== null) return { booked: false, reason: "unavailable" };

    const taken = await tx.one<{ n: string }>(
      `SELECT count(*) AS n FROM bookings
        WHERE resource_id = $1 AND status <> 'cancelled' AND slot_start < $3 AND slot_end > $2`,
      [input.resourceId, input.start, input.end],
    );
    if (Number(taken.n) >= resource.capacity) return { booked: false, reason: "slot_taken" };

    const row = await tx.maybeOne<{ id: string }>(
      `INSERT INTO bookings (customer_id, session_id, resource_id, slot_start, slot_end, contact, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed',$7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.customerId, input.sessionId ?? null, input.resourceId, input.start, input.end, input.contact, input.idempotencyKey],
    );
    if (row === null) {
      // A replay. Return the booking that already exists rather than a failure:
      // the visitor gets one confirmation for one booking either way.
      const existing = await tx.one<{ id: string }>("SELECT id FROM bookings WHERE idempotency_key = $1", [
        input.idempotencyKey,
      ]);
      return { booked: true, bookingId: existing.id };
    }
    await emit({
      eventType: "booking.confirmed",
      subject: { kind: "booking", id: row.id },
      payload: { customerId: input.customerId, resourceId: input.resourceId },
    });
    return { booked: true, bookingId: row.id };
  });
}

/**
 * Cancel, and surface whoever was waiting for that slot.
 *
 * ⛔ The waitlist is offered, never auto-booked. Moving somebody into a slot
 * they asked about last week without asking is how a business gets a no-show
 * and a complaint from the same person.
 */
export async function cancelBooking(
  db: Db,
  bookingId: string,
): Promise<{ cancelled: boolean; waiting: { id: string; contact: string }[] }> {
  return db.tx(async (tx) => {
    const booking = await tx.maybeOne<{ customer_id: string; resource_id: string | null; slot_start: Date; slot_end: Date }>(
      "SELECT customer_id, resource_id, slot_start, slot_end FROM bookings WHERE id = $1 AND status <> 'cancelled' FOR UPDATE",
      [bookingId],
    );
    if (booking === null) return { cancelled: false, waiting: [] };
    await tx.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);

    const waiting = await tx.query<{ id: string; contact: string }>(
      `SELECT id, contact FROM waitlist_entries
        WHERE customer_id = $1 AND notified_at IS NULL AND cancelled_at IS NULL AND filled_booking_id IS NULL
          AND earliest_at <= $2 AND latest_at >= $3
          AND (resource_id IS NULL OR resource_id = $4)
        ORDER BY created_at ASC LIMIT 5`,
      [booking.customer_id, booking.slot_start, booking.slot_end, booking.resource_id],
    );
    await emit({
      eventType: "booking.cancelled",
      subject: { kind: "booking", id: bookingId },
      payload: { waitlistCandidates: waiting.rows.length },
    });
    return { cancelled: true, waiting: waiting.rows.map((w) => ({ id: w.id, contact: w.contact })) };
  });
}

export async function joinWaitlist(
  db: Db,
  input: {
    customerId: string;
    contact: string;
    earliestAt: Date;
    latestAt: Date;
    resourceId?: string | undefined;
    sessionId?: string | undefined;
  },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO waitlist_entries (customer_id, session_id, contact, earliest_at, latest_at, resource_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.customerId, input.sessionId ?? null, input.contact, input.earliestAt, input.latestAt, input.resourceId ?? null],
  );
  return row.id;
}

export async function markWaitlistNotified(db: Db, entryId: string): Promise<void> {
  await db.query("UPDATE waitlist_entries SET notified_at = now() WHERE id = $1 AND notified_at IS NULL", [entryId]);
}

// ---------------------------------------------------------------------------
// Setting a business up. The writers `customer_calendars` never had.
// ---------------------------------------------------------------------------

export async function addResource(
  db: Db,
  input: { customerId: string; name: string; kind: string; capacity?: number },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO scheduling_resources (customer_id, name, kind, capacity)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (customer_id, name) DO UPDATE SET kind = EXCLUDED.kind, capacity = EXCLUDED.capacity, active = TRUE
     RETURNING id`,
    [input.customerId, input.name, input.kind, input.capacity ?? 1],
  );
  return row.id;
}

export async function setWeeklyHours(
  db: Db,
  customerId: string,
  rules: { weekday: number; startMinute: number; endMinute: number; slotMinutes?: number; bufferMinutes?: number; resourceId?: string }[],
): Promise<void> {
  await db.tx(async (tx) => {
    // Replace wholesale. A partial update leaves yesterday's Tuesday alongside
    // today's, and the business is open twice.
    await tx.query("DELETE FROM availability_rules WHERE customer_id = $1", [customerId]);
    for (const r of rules) {
      await tx.query(
        `INSERT INTO availability_rules (customer_id, resource_id, weekday, start_minute, end_minute, slot_minutes, buffer_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [customerId, r.resourceId ?? null, r.weekday, r.startMinute, r.endMinute, r.slotMinutes ?? 60, r.bufferMinutes ?? 0],
      );
    }
  });
}

export async function blockTime(
  db: Db,
  input: { customerId: string; startsAt: Date; endsAt: Date; reason?: string; resourceId?: string },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO availability_exceptions (customer_id, resource_id, starts_at, ends_at, reason)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.customerId, input.resourceId ?? null, input.startsAt, input.endsAt, input.reason ?? null],
  );
  return row.id;
}

/**
 * Connect an external calendar. ⛔ `customer_calendars` had zero writers; this
 * is it. Connection is recorded even in demo mode so `calendarConnected` — which
 * gates the booking capability in the MCP manifest — reflects a real decision
 * rather than a hardcoded false.
 */
export async function connectCalendar(
  db: Db,
  input: { customerId: string; provider: string; externalRef: string },
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO customer_calendars (customer_id, provider, external_ref)
     VALUES ($1,$2,$3)
     ON CONFLICT (customer_id, provider) DO UPDATE SET external_ref = EXCLUDED.external_ref, revoked_at = NULL
     RETURNING id`,
    [input.customerId, input.provider, input.externalRef],
  );
  return row.id;
}

export async function revokeCalendar(db: Db, customerId: string, provider: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE customer_calendars SET revoked_at = now() WHERE customer_id = $1 AND provider = $2 AND revoked_at IS NULL",
    [customerId, provider],
  );
  return (res.rowCount ?? 0) > 0;
}
