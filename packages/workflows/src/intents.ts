// The workflow outbox — the API side.
//
// A request handler that wants a workflow to start or advance writes an intent
// instead of touching the engine. The worker drains it. That split exists
// because the API and the worker are different processes: only one of them
// should be replaying journals, and the handoff has to survive a crash between
// "we recorded what happened" and "we acted on it".
//
// At-least-once, deliberately. `start` is idempotent in the engine (ON CONFLICT
// DO NOTHING on the execution row) and a duplicate signal is either deduped by
// the unique index below or absorbed by the workflow, which is the safe side to
// err on — a lost claim is a customer who paid and got nothing.
import type { Db } from "@adw/db";

export interface StartIntent {
  kind: "start";
  workflowType: string;
  executionId: string;
  payload?: Record<string, unknown>;
}

export interface SignalIntent {
  kind: "signal";
  /** Recorded for observability; a signal does not need to know the type. */
  workflowType: string;
  executionId: string;
  signalName: string;
  payload?: Record<string, unknown>;
}

export type WorkflowIntent = StartIntent | SignalIntent;

/**
 * Enqueue an intent. Call this inside the same transaction as the state change
 * that justifies it wherever the caller has one — the point of the outbox is
 * that the two commit together.
 */
export async function enqueueIntent(db: Db, intent: WorkflowIntent): Promise<void> {
  await db.query(
    `INSERT INTO workflow_intents (kind, workflow_type, execution_id, signal_name, payload)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`,
    [
      intent.kind,
      intent.workflowType,
      intent.executionId,
      intent.kind === "signal" ? intent.signalName : null,
      JSON.stringify(intent.payload ?? {}),
    ],
  );
}

/** Deterministic execution ids, so a replayed intent addresses the same run. */
export const executionId = {
  lead: (leadId: string): string => `lead:${leadId}`,
  onboarding: (leadId: string): string => `onboarding:${leadId}`,
  build: (businessId: string): string => `build:${businessId}`,
  revision: (customerId: string, round: number): string => `revision:${customerId}:${round}`,
  subscription: (subscriptionId: string): string => `subscription:${subscriptionId}`,
};

export interface PendingIntent {
  id: string;
  kind: "start" | "signal";
  workflow_type: string;
  execution_id: string;
  signal_name: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Retries before an intent is parked for a human. */
export const MAX_INTENT_ATTEMPTS = 5;

/** Read the next batch of undelivered intents, oldest first. */
export async function pendingIntents(db: Db, limit = 50): Promise<PendingIntent[]> {
  const res = await db.query<PendingIntent>(
    `SELECT id, kind, workflow_type, execution_id, signal_name, payload, attempts
       FROM workflow_intents
      WHERE processed_at IS NULL AND attempts < $2
      ORDER BY created_at
      LIMIT $1`,
    [limit, MAX_INTENT_ATTEMPTS],
  );
  return res.rows;
}

export async function markIntentDelivered(db: Db, id: string): Promise<void> {
  await db.query("UPDATE workflow_intents SET processed_at = now() WHERE id = $1", [id]);
}

/**
 * Record a failed delivery. On the final attempt the intent is parked and an
 * exception is raised — an entry point that silently stopped working is exactly
 * the failure this whole table exists to prevent.
 */
export async function markIntentFailed(db: Db, id: string, error: string): Promise<void> {
  const row = await db.one<{ attempts: number; workflow_type: string; execution_id: string }>(
    `UPDATE workflow_intents SET attempts = attempts + 1, last_error = $2
      WHERE id = $1 RETURNING attempts, workflow_type, execution_id`,
    [id, error.slice(0, 500)],
  );
  if (row.attempts >= MAX_INTENT_ATTEMPTS) {
    await db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
       VALUES ('workflow_intent_undeliverable', 2, $1, 'intent parked after repeated failures',
               'Fix the cause and re-enqueue; the pipeline entry point is stalled until then')`,
      [JSON.stringify({ intentId: id, workflowType: row.workflow_type, executionId: row.execution_id, error: error.slice(0, 500) })],
    );
  }
}
