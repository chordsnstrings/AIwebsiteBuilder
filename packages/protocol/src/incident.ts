// Recording an incident and starting its clock.
//
// The clock is the part that matters and the part that is easy to get wrong.
// An incident that is raised, logged, and then depends on someone happening to
// look at a dashboard is not an escalation — it is a hope. So every step is
// written as a ROW WITH A DUE TIME at the moment the incident opens, and a job
// fires them whether or not anyone is watching.
//
// ⛔ The steps are written up front, in the same transaction as the incident.
// Scheduling step 2 only after step 1 fires would mean a worker that dies
// between them loses the rest of the chain silently, which is precisely the
// failure a safeguarding escalation cannot have.

import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { loadProtocols, protocolById } from "./catalogue.ts";
import { respond } from "./detect.ts";
import type { ProtocolMatch } from "./types.ts";

export interface OpenIncidentInput {
  match: ProtocolMatch;
  /** ⛔ The visitor's own words. Never summarised — see the migration. */
  triggerText: string;
  customerId?: string | undefined;
  businessId?: string | undefined;
  sessionId?: string | undefined;
  channel?: string | undefined;
  detectedBy?: "automatic" | "manual";
  raisedBy?: string | undefined;
}

export interface OpenedIncident {
  incidentId: string;
  severity: number;
  stepsScheduled: number;
  respond: string;
}

export async function openIncident(db: Db, input: OpenIncidentInput, now: Date = new Date()): Promise<OpenedIncident> {
  const { protocol } = input.match;
  const { version } = loadProtocols();

  return db.tx(async (tx) => {
    const incident = await tx.one<{ id: string }>(
      `INSERT INTO protocol_incidents
         (protocol_id, protocol_version, severity, customer_id, business_id, session_id, channel,
          trigger_text, matched_on, interlocks, agent_response, detected_by, raised_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        protocol.id,
        version,
        protocol.severity,
        input.customerId ?? null,
        input.businessId ?? null,
        input.sessionId ?? null,
        input.channel ?? "web",
        input.triggerText,
        input.match.matchedOn,
        protocol.interlocks,
        input.match.respond,
        input.detectedBy ?? "automatic",
        input.raisedBy ?? null,
      ],
    );

    // ⛔ Every step, now, in this transaction.
    for (const [i, step] of protocol.escalation.entries()) {
      await tx.query(
        `INSERT INTO protocol_escalations (incident_id, step_index, notify_role, due_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (incident_id, step_index) DO NOTHING`,
        [incident.id, i, step.notify, new Date(now.getTime() + step.afterMinutes * 60_000)],
      );
    }

    await emit({
      eventType: "protocol.opened",
      subject: { kind: "incident", id: incident.id },
      // ⛔ Never the trigger text. The event log is read casually and widely;
      // the disclosure lives in one append-only table with a reason to open it.
      payload: {
        protocolId: protocol.id,
        severity: protocol.severity,
        safetyCritical: protocol.safetyCritical,
        detectedBy: input.detectedBy ?? "automatic",
      },
    });

    return {
      incidentId: incident.id,
      severity: protocol.severity,
      stepsScheduled: protocol.escalation.length,
      respond: input.match.respond,
    };
  });
}

/** Raise one by hand — 121 of the 141 protocols can only start this way. */
export async function raiseManually(
  db: Db,
  protocolId: string,
  input: Omit<OpenIncidentInput, "match"> & { raisedBy: string },
  now: Date = new Date(),
): Promise<OpenedIncident> {
  const protocol = protocolById(protocolId);
  if (protocol === undefined) throw new Error(`Unknown protocol "${protocolId}"`);
  return openIncident(
    db,
    {
      ...input,
      detectedBy: "manual",
      match: { protocol, matchedOn: "(raised by hand)", respond: respond(protocol), interlocks: protocol.interlocks },
    },
    now,
  );
}

/**
 * A named human takes it.
 *
 * ⛔ Acknowledgement cancels the REMAINING steps and nothing else. It does not
 * resolve the incident and it does not stop the record: "someone saw it" and
 * "someone dealt with it" are different facts and a board that conflates them
 * shows a wall of green over open safeguarding cases.
 */
export async function acknowledgeIncident(
  db: Db,
  incidentId: string,
  by: string,
  now: Date = new Date(),
): Promise<{ acknowledged: boolean; stepsCancelled: number }> {
  return db.tx(async (tx) => {
    const row = await tx.maybeOne<{ acknowledged_at: Date | null }>(
      "SELECT acknowledged_at FROM protocol_incidents WHERE id = $1 FOR UPDATE",
      [incidentId],
    );
    if (row === null) return { acknowledged: false, stepsCancelled: 0 };
    // First acknowledgement wins, like the pack approval: it is evidence.
    if (row.acknowledged_at !== null) return { acknowledged: true, stepsCancelled: 0 };

    await tx.query("UPDATE protocol_incidents SET acknowledged_at = $2, acknowledged_by = $3 WHERE id = $1", [
      incidentId,
      now,
      by,
    ]);
    const cancelled = await tx.query(
      "DELETE FROM protocol_escalations WHERE incident_id = $1 AND fired_at IS NULL",
      [incidentId],
    );
    await emit({
      eventType: "protocol.acknowledged",
      subject: { kind: "incident", id: incidentId },
      payload: { by },
    });
    return { acknowledged: true, stepsCancelled: cancelled.rowCount ?? 0 };
  });
}

export async function resolveIncident(db: Db, incidentId: string, by: string, resolution: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE protocol_incidents
        SET resolved_at = now(), resolution = $2,
            acknowledged_at = COALESCE(acknowledged_at, now()),
            acknowledged_by = COALESCE(acknowledged_by, $3)
      WHERE id = $1 AND resolved_at IS NULL`,
    [incidentId, resolution, by],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface OpenIncidentRow {
  id: string;
  protocolId: string;
  label: string;
  severity: number;
  createdAt: Date;
  minutesOpen: number;
  interlocks: string[];
  staysHuman?: string;
}

/** The queue a human works. Most severe first, then oldest. */
export async function openIncidents(db: Db, customerId?: string): Promise<OpenIncidentRow[]> {
  const rows = await db.query<{
    id: string;
    protocol_id: string;
    severity: number;
    created_at: Date;
    interlocks: string[];
  }>(
    `SELECT id, protocol_id, severity, created_at, interlocks
       FROM protocol_incidents
      WHERE resolved_at IS NULL AND ($1::uuid IS NULL OR customer_id = $1)
      ORDER BY severity ASC, created_at ASC`,
    [customerId ?? null],
  );
  const now = Date.now();
  return rows.rows.map((r) => {
    const p = protocolById(r.protocol_id);
    return {
      id: r.id,
      protocolId: r.protocol_id,
      label: p?.label ?? r.protocol_id,
      severity: r.severity,
      createdAt: r.created_at,
      minutesOpen: Math.floor((now - new Date(r.created_at).getTime()) / 60_000),
      interlocks: r.interlocks,
      ...(p?.staysHuman === undefined ? {} : { staysHuman: p.staysHuman }),
    };
  });
}
