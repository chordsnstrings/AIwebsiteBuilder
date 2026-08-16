// @adw/cases — long-running case objects and the owner's queue (MF2, MF3).
//
// MF2 is 80 units of "matters, claims, tickets, NCRs, permits, applications".
// They are one shape with different nouns, which is why the stages are config.
// The only long-running objects in this system were ADW's own
// `workflow_executions`; the customer had none.
//
// MF3 is 52 units of "watches a queue and surfaces only what needs a human".
// `exceptions` existed with ten insert sites — all ADW vendor-ops — and `status`
// never left 'open'. No acknowledge writer, no resolve writer, no assignee, no
// due date, and the console's Approve/Reject buttons had no handler. A queue
// nothing can be cleared from is a list.
//
// ⛔ The clamp MF3 repeats in its own unit descriptions: "Flags, never clears —
// judgement stays human". "Suggests codes; human codes". "Signals to SIU; never
// concludes". So nothing here decides; it surfaces, orders, and records who
// decided.

import { config } from "@adw/config";
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";
import { primaryArchetype } from "@adw/taxonomy";

export interface CaseStage {
  key: string;
  label: string;
  /** Hours before this stage is overdue. Absent means no clock. */
  dueHours?: number;
  terminal: boolean;
  /** ⛔ Defaults FALSE. Visibility is granted, never assumed. */
  customerVisible: boolean;
}

export interface CaseType {
  id: string;
  label: string;
  stages: CaseStage[];
}

let cached: { version: string; data: Record<string, unknown> } | null = null;
function caseConfig(): { version: string; data: Record<string, unknown> } {
  if (cached === null) {
    const { data, version } = config.caseTypes();
    cached = { version, data: data as Record<string, unknown> };
  }
  return cached;
}
export function clearCaseTypeCache(): void {
  cached = null;
}

interface RawStage {
  key?: string;
  label?: string;
  due_hours?: number;
  terminal?: boolean;
  customer_visible?: boolean;
}

export function caseTypesFor(vertical: string): CaseType[] {
  const code = primaryArchetype(vertical);
  const byArchetype = (caseConfig().data["archetype_cases"] ?? {}) as Record<string, { id?: string; label?: string; stages?: RawStage[] }[]>;
  const rows = code === undefined ? [] : (byArchetype[code] ?? []);
  return rows.map((t) => ({
    id: t.id ?? "",
    label: t.label ?? t.id ?? "",
    stages: (t.stages ?? []).map((s) => ({
      key: s.key ?? "",
      label: s.label ?? s.key ?? "",
      ...(s.due_hours === undefined ? {} : { dueHours: s.due_hours }),
      terminal: s.terminal === true,
      customerVisible: s.customer_visible === true,
    })),
  }));
}

export function caseTypeFor(vertical: string, caseType: string): CaseType | undefined {
  return caseTypesFor(vertical).find((t) => t.id === caseType);
}

export interface OpenCaseInput {
  customerId: string;
  vertical: string;
  caseType: string;
  reference: string;
  title: string;
  contact?: string | undefined;
  sessionId?: string | undefined;
}

export async function openCase(db: Db, input: OpenCaseInput, now: Date = new Date()): Promise<string> {
  const type = caseTypeFor(input.vertical, input.caseType);
  if (type === undefined) throw new Error(`No case type "${input.caseType}" for vertical "${input.vertical}"`);
  const first = type.stages[0];
  if (first === undefined) throw new Error(`Case type "${input.caseType}" has no stages`);
  const { version } = caseConfig();

  return db.tx(async (tx) => {
    const existing = await tx.maybeOne<{ id: string }>(
      "SELECT id FROM cases WHERE customer_id = $1 AND case_type = $2 AND reference = $3",
      [input.customerId, input.caseType, input.reference],
    );
    if (existing !== null) return existing.id;

    const row = await tx.one<{ id: string }>(
      `INSERT INTO cases (customer_id, case_type, type_version, reference, title, stage, stage_since, stage_due_at, contact, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        input.customerId, input.caseType, version, input.reference, input.title,
        first.key, now,
        first.dueHours === undefined ? null : new Date(now.getTime() + first.dueHours * 3_600_000),
        input.contact ?? null, input.sessionId ?? null,
      ],
    );
    await tx.query(
      "INSERT INTO case_events (case_id, kind, to_stage, detail, actor, customer_visible) VALUES ($1,'stage',$2,'opened','system',$3)",
      [row.id, first.key, first.customerVisible],
    );
    return row.id;
  });
}

/**
 * Move a case to a new stage.
 *
 * ⛔ Only to a stage the TYPE defines, and the clock resets from the move. The
 * clock is per stage rather than per case because "open for 40 days" is normal
 * for a conveyance and a scandal for a complaint; what matters is how long it
 * has sat where it is.
 */
export async function advanceCase(
  db: Db,
  caseId: string,
  toStage: string,
  actor: string,
  opts: { detail?: string; vertical?: string } = {},
  now: Date = new Date(),
): Promise<{ moved: boolean; reason?: string }> {
  return db.tx(async (tx) => {
    const row = await tx.maybeOne<{ customer_id: string; case_type: string; stage: string; closed_at: Date | null }>(
      "SELECT customer_id, case_type, stage, closed_at FROM cases WHERE id = $1 FOR UPDATE",
      [caseId],
    );
    if (row === null) return { moved: false, reason: "unknown_case" };
    if (row.closed_at !== null) return { moved: false, reason: "case_closed" };
    if (row.stage === toStage) return { moved: true };

    const vertical = opts.vertical ?? (await verticalOf(tx, row.customer_id));
    const type = caseTypeFor(vertical, row.case_type);
    const stage = type?.stages.find((s) => s.key === toStage);
    // ⛔ A stage the type does not define fails rather than being created. A
    // case in a stage nothing knows about has no clock and no visibility rule.
    if (stage === undefined) return { moved: false, reason: `no stage "${toStage}" on ${row.case_type}` };

    await tx.query(
      `UPDATE cases SET stage = $2, stage_since = $3, stage_due_at = $4,
              closed_at = $5, close_reason = $6
        WHERE id = $1`,
      [
        caseId, toStage, now,
        stage.dueHours === undefined ? null : new Date(now.getTime() + stage.dueHours * 3_600_000),
        stage.terminal ? now : null,
        stage.terminal ? (opts.detail ?? "completed") : null,
      ],
    );
    await tx.query(
      "INSERT INTO case_events (case_id, kind, from_stage, to_stage, detail, actor, customer_visible) VALUES ($1,'stage',$2,$3,$4,$5,$6)",
      [caseId, row.stage, toStage, opts.detail ?? null, actor, stage.customerVisible],
    );
    await emit({
      eventType: stage.terminal ? "case.closed" : "case.advanced",
      subject: { kind: "case", id: caseId },
      payload: { from: row.stage, to: toStage },
    });
    return { moved: true };
  });
}

async function verticalOf(tx: Db, customerId: string): Promise<string> {
  const row = await tx.maybeOne<{ vertical: string | null }>(
    "SELECT b.vertical FROM customers c JOIN businesses b ON b.id = c.business_id WHERE c.id = $1",
    [customerId],
  );
  return row?.vertical ?? "";
}

export async function addCaseNote(
  db: Db,
  caseId: string,
  detail: string,
  actor: string,
  customerVisible = false,
): Promise<void> {
  await db.query(
    "INSERT INTO case_events (case_id, kind, detail, actor, customer_visible) VALUES ($1,'note',$2,$3,$4)",
    [caseId, detail, actor, customerVisible],
  );
}

export interface CaseStatus {
  reference: string;
  title: string;
  stage: string;
  stageLabel: string;
  updatedAt: Date;
  overdue: boolean;
  history: { at: Date; detail: string }[];
}

/**
 * What the CUSTOMER sees.
 *
 * ⛔ `customer_visible` is a WHERE clause. A case note saying "client is being
 * difficult" is internal, and a status page that leaks one costs the business
 * the client — so there is no query here that can return one.
 */
export async function customerStatus(db: Db, caseId: string, vertical: string): Promise<CaseStatus | null> {
  const row = await db.maybeOne<{
    reference: string; title: string; stage: string; case_type: string;
    stage_since: Date; stage_due_at: Date | null;
  }>(
    "SELECT reference, title, stage, case_type, stage_since, stage_due_at FROM cases WHERE id = $1",
    [caseId],
  );
  if (row === null) return null;
  const type = caseTypeFor(vertical, row.case_type);
  const stage = type?.stages.find((s) => s.key === row.stage);
  // ⛔ A stage the customer may not see reports the case as "in progress" rather
  // than naming it. A conflict check is a real stage and telling the client
  // their matter is in "conflict check" is a conversation the firm chooses to
  // have, not one we start for them.
  if (stage !== undefined && !stage.customerVisible) {
    return {
      reference: row.reference, title: row.title, stage: "in_progress", stageLabel: "In progress",
      updatedAt: row.stage_since, overdue: false, history: [],
    };
  }
  const events = await db.query<{ at: Date; detail: string | null; to_stage: string | null }>(
    "SELECT at, detail, to_stage FROM case_events WHERE case_id = $1 AND customer_visible = TRUE ORDER BY at DESC LIMIT 20",
    [caseId],
  );
  return {
    reference: row.reference,
    title: row.title,
    stage: row.stage,
    stageLabel: stage?.label ?? row.stage,
    updatedAt: row.stage_since,
    overdue: row.stage_due_at !== null && row.stage_due_at < new Date(),
    history: events.rows.map((e) => ({ at: e.at, detail: e.detail ?? e.to_stage ?? "" })),
  };
}

/** ⛔ Anything not moving surfaces first — the catalogue's Case Progress Clerk. */
export async function stalledCases(
  db: Db,
  customerId: string,
  now: Date = new Date(),
): Promise<{ id: string; reference: string; stage: string; hoursOverdue: number }[]> {
  const rows = await db.query<{ id: string; reference: string; stage: string; stage_due_at: Date }>(
    `SELECT id, reference, stage, stage_due_at FROM cases
      WHERE customer_id = $1 AND closed_at IS NULL AND stage_due_at IS NOT NULL AND stage_due_at < $2
      ORDER BY stage_due_at ASC`,
    [customerId, now],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    stage: r.stage,
    hoursOverdue: Math.floor((now.getTime() - new Date(r.stage_due_at).getTime()) / 3_600_000),
  }));
}

// ---------------------------------------------------------------------------
// MF3 — the queue
// ---------------------------------------------------------------------------

export interface QueueItem {
  id: string;
  trigger: string;
  severity: number;
  context: unknown;
  systemAction: string;
  recommendation: string;
  createdAt: Date;
  assignee: string | null;
  dueAt: Date | null;
  acknowledgedAt: Date | null;
  overdue: boolean;
}

/**
 * What needs a human, most severe first.
 *
 * `customerId` null is ADW's own operations queue; a value is that owner's.
 * Both were the same undifferentiated list before, which is why the owner's
 * console had nothing to show.
 */
export async function queue(
  db: Db,
  opts: { customerId?: string | null; includeAcknowledged?: boolean; limit?: number } = {},
  now: Date = new Date(),
): Promise<QueueItem[]> {
  const rows = await db.query<{
    id: string; trigger: string; severity: number; context: unknown;
    system_action: string; recommendation: string; raised_at: Date;
    assignee: string | null; due_at: Date | null; acknowledged_at: Date | null;
  }>(
    `SELECT id, trigger, severity, context, system_action, recommendation, raised_at,
            assignee, due_at, acknowledged_at
       FROM exceptions
      WHERE resolved_at IS NULL
        AND customer_id IS NOT DISTINCT FROM $1
        AND ($2::boolean OR acknowledged_at IS NULL)
      ORDER BY severity ASC, raised_at ASC
      LIMIT $3`,
    [opts.customerId ?? null, opts.includeAcknowledged === true, opts.limit ?? 100],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    severity: r.severity,
    context: r.context,
    systemAction: r.system_action,
    recommendation: r.recommendation,
    createdAt: r.raised_at,
    assignee: r.assignee,
    dueAt: r.due_at,
    acknowledgedAt: r.acknowledged_at,
    overdue: r.due_at !== null && r.due_at < now,
  }));
}

/**
 * ⛔ The writers this table never had. `status` never left 'open' because
 * nothing could move it, and the console's buttons had no handler — so the
 * queue grew forever and every item looked equally urgent and equally new.
 */
export async function acknowledgeItem(db: Db, id: string, by: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE exceptions SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2, assignee = COALESCE(assignee, $2)
      WHERE id = $1 AND acknowledged_at IS NULL`,
    [id, by],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function resolveItem(db: Db, id: string, by: string, resolution: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE exceptions
        SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution = $3,
            acknowledged_at = COALESCE(acknowledged_at, now()),
            acknowledged_by = COALESCE(acknowledged_by, $2)
      WHERE id = $1 AND resolved_at IS NULL`,
    [id, by, resolution],
  );
  if ((res.rowCount ?? 0) === 0) return false;
  await emit({ eventType: "exception.resolved", subject: { kind: "exception", id }, payload: { by } });
  return true;
}

export async function assignItem(db: Db, id: string, to: string, dueAt?: Date): Promise<boolean> {
  const res = await db.query(
    "UPDATE exceptions SET assignee = $2, due_at = COALESCE($3, due_at) WHERE id = $1 AND resolved_at IS NULL",
    [id, to, dueAt ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * ⛔ Items nobody has touched past their due time.
 *
 * Asked for explicitly rather than inferred from an empty queue. The spec's own
 * control threshold is "more than five exceptions a week means the thresholds
 * are wrong" — a queue that silently accumulates unacknowledged items has
 * stopped being a control and become a backlog, and the difference is invisible
 * from the top of the list.
 */
export async function overdueItems(db: Db, now: Date = new Date()): Promise<QueueItem[]> {
  const all = await queue(db, { customerId: null, includeAcknowledged: true, limit: 500 }, now);
  return all.filter((i) => i.overdue);
}
