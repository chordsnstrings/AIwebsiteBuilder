// Firing the escalation steps that have come due.
//
// ⛔ This runs on a timer, not on a request. The entire value of the family is
// that the clock keeps running after the visitor closes the tab, after the
// owner goes to bed, and after the worker process restarts — a chain that only
// advances while someone is looking is not a chain.
//
// It is deliberately dumb about HOW to notify. The transport is injected,
// because a notification path that depends on the same vendor the incident
// might be about is not a notification path. The catalogue's own §73 rule for
// the Sentinel says the same thing: never page about SES over SES.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { protocolById } from "./catalogue.ts";

export interface Notification {
  incidentId: string;
  protocolId: string;
  label: string;
  severity: number;
  notifyRole: string;
  stepIndex: number;
  minutesOpen: number;
  customerId: string | null;
  /** ⛔ Deliberately absent: the trigger text. A page says "there is a
   *  safeguarding incident, open it" — it does not put a child's disclosure in
   *  an SMS that lands on a lock screen. */
}

export type NotifyFn = (n: Notification) => Promise<{ delivered: boolean; detail?: string }>;

export interface EscalationResult {
  fired: number;
  delivered: number;
  failed: number;
}

/**
 * Fire every step whose time has come, oldest first.
 *
 * A step is marked fired whether or not delivery succeeded, and the failure is
 * recorded on the row. Retrying the same step forever would stall the chain at
 * an unreachable contact — the point of a chain is that it moves PAST someone
 * who does not answer.
 */
export async function runEscalations(
  db: Db,
  notify: NotifyFn,
  now: Date = new Date(),
): Promise<EscalationResult> {
  const due = await db.query<{
    id: string;
    incident_id: string;
    step_index: number;
    notify_role: string;
    protocol_id: string;
    severity: number;
    customer_id: string | null;
    created_at: Date;
  }>(
    `SELECT e.id, e.incident_id, e.step_index, e.notify_role,
            i.protocol_id, i.severity, i.customer_id, i.created_at
       FROM protocol_escalations e
       JOIN protocol_incidents i ON i.id = e.incident_id
      WHERE e.fired_at IS NULL
        AND e.due_at <= $1
        -- ⛔ Acknowledgement cancels remaining steps by deleting them, but a
        -- race between the acknowledge transaction and this one is possible, so
        -- the state is re-checked here as well.
        AND i.acknowledged_at IS NULL
      ORDER BY i.severity ASC, e.due_at ASC
      LIMIT 100`,
    [now],
  );

  const result: EscalationResult = { fired: 0, delivered: 0, failed: 0 };
  for (const row of due.rows) {
    const protocol = protocolById(row.protocol_id);
    const n: Notification = {
      incidentId: row.incident_id,
      protocolId: row.protocol_id,
      label: protocol?.label ?? row.protocol_id,
      severity: row.severity,
      notifyRole: row.notify_role,
      stepIndex: row.step_index,
      minutesOpen: Math.floor((now.getTime() - new Date(row.created_at).getTime()) / 60_000),
      customerId: row.customer_id,
    };
    let outcome: { delivered: boolean; detail?: string };
    try {
      outcome = await notify(n);
    } catch (err) {
      outcome = { delivered: false, detail: err instanceof Error ? err.message : String(err) };
    }
    await db.query(
      "UPDATE protocol_escalations SET fired_at = $2, delivered = $3, detail = $4 WHERE id = $1",
      [row.id, now, outcome.delivered, outcome.detail ?? null],
    );
    result.fired++;
    if (outcome.delivered) result.delivered++;
    else result.failed++;

    await emit({
      eventType: outcome.delivered ? "protocol.escalated" : "protocol.escalation_failed",
      subject: { kind: "incident", id: row.incident_id },
      payload: { protocolId: row.protocol_id, notifyRole: row.notify_role, step: row.step_index },
    });
  }
  return result;
}

/**
 * Incidents whose whole chain has fired with nobody acknowledging.
 *
 * ⛔ This is the state the family exists to make impossible, so it is asked for
 * explicitly rather than inferred from an empty queue. A safeguarding incident
 * that exhausted its chain at 3am and sat unread is the outcome that ends a
 * business, and it must be loud on the operator console rather than merely
 * absent from the due list.
 */
export async function exhaustedIncidents(db: Db): Promise<{ id: string; protocolId: string; severity: number; minutesOpen: number }[]> {
  const rows = await db.query<{ id: string; protocol_id: string; severity: number; created_at: Date }>(
    `SELECT i.id, i.protocol_id, i.severity, i.created_at
       FROM protocol_incidents i
      WHERE i.acknowledged_at IS NULL
        AND EXISTS (SELECT 1 FROM protocol_escalations e WHERE e.incident_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM protocol_escalations e WHERE e.incident_id = i.id AND e.fired_at IS NULL)
      ORDER BY i.severity ASC, i.created_at ASC`,
  );
  const now = Date.now();
  return rows.rows.map((r) => ({
    id: r.id,
    protocolId: r.protocol_id,
    severity: r.severity,
    minutesOpen: Math.floor((now - new Date(r.created_at).getTime()) / 60_000),
  }));
}
