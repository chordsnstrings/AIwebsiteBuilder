// Journaled-step durable workflow engine. Workflows are deterministic async
// functions; every side effect goes through ctx and is journaled by sequence
// number. On resume the workflow re-runs from the top — journaled steps return
// memoized results instantly, and execution proceeds live from the first
// un-journaled step. Durable timers (sleep), signals and conditions suspend the
// workflow; the runner persists progress and resumes when the wall clock passes
// a timer or a signal arrives. A Clock abstraction gives deterministic
// time-skipping in tests.
import type { Db } from "@adw/db";
import {
  Suspension,
  SystemClock,
  type ActivityFn,
  type Clock,
  type WorkflowContext,
  type WorkflowDefinition,
} from "./types.ts";

interface JournalEntry {
  seq: number;
  kind: string;
  name: string;
  result: unknown;
  error: string | null;
}

/**
 * Collapse an error message to what is stable about it, for grouping.
 *
 * ⛔ Identifiers vary per execution, so leaving them in would defeat the
 * deduplication entirely: "deploy failed for build a1b2…" and "deploy failed
 * for build c3d4…" are one bug, and grouping them separately reproduces the
 * exact queue-flooding this exists to prevent.
 */
export function normaliseError(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface EngineOptions {
  db: Db;
  clock?: Clock;
}

export class Engine {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly activities = new Map<string, ActivityFn>();
  private readonly workflows = new Map<string, WorkflowDefinition<unknown, unknown>>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.clock = opts.clock ?? new SystemClock();
  }

  registerActivity(name: string, fn: ActivityFn): void {
    this.activities.set(name, fn);
  }

  /**
   * Invoke a registered activity directly.
   *
   * ⛔ For tests and operational tooling only — no workflow path calls this,
   * because an activity run outside an execution has no journal entry and so no
   * replay guarantee. It exists so that a test can assert an activity's
   * behaviour through the registry it is actually reached by, rather than by
   * calling the helper underneath it. That distinction is the difference
   * between proving a kill switch is wired and proving a function exists.
   */
  async runActivity(name: string, input: unknown): Promise<unknown> {
    const fn = this.activities.get(name);
    if (fn === undefined) throw new Error(`Unregistered activity: ${name}`);
    return fn(input);
  }

  registerWorkflow<In, Out>(def: WorkflowDefinition<In, Out>): void {
    this.workflows.set(def.type, def as WorkflowDefinition<unknown, unknown>);
  }

  /** Start a new workflow execution and drive it as far as it will go now. */
  async start<In>(type: string, id: string, input: In): Promise<void> {
    if (!this.workflows.has(type)) throw new Error(`Unregistered workflow type: ${type}`);
    await this.db.query(
      `INSERT INTO workflow_executions (id, type, status, input) VALUES ($1,$2,'running',$3)
       ON CONFLICT (id) DO NOTHING`,
      [id, type, JSON.stringify(input ?? null)],
    );
    await this.runOnce(id);
  }

  /** Deliver a signal and resume the execution. */
  async signal(id: string, name: string, payload: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO workflow_signals (execution_id, name, payload) VALUES ($1,$2,$3)`,
      [id, name, JSON.stringify(payload ?? null)],
    );
    await this.runOnce(id);
  }

  /** Fire any timers whose fire_at has passed, and resume their executions.
   * Scoped to executions of a type this engine handles, so an engine sharing a
   * database with another does not fire (and starve) the other's timers. */
  async fireDueTimers(): Promise<number> {
    const now = new Date(this.clock.now());
    const types = [...this.workflows.keys()];
    if (types.length === 0) return 0;
    const due = await this.db.query<{ id: string; execution_id: string }>(
      `SELECT t.id, t.execution_id FROM workflow_timers t
       JOIN workflow_executions e ON e.id = t.execution_id
       WHERE t.fired = FALSE AND t.fire_at <= $1 AND e.type = ANY($2)`,
      [now, types],
    );
    for (const t of due.rows) {
      await this.db.query("UPDATE workflow_timers SET fired = TRUE WHERE id = $1", [t.id]);
    }
    const executions = [...new Set(due.rows.map((r) => r.execution_id))];
    for (const id of executions) {
      await this.runOnce(id);
    }
    return due.rows.length;
  }

  async getStatus(id: string): Promise<{ status: string; result: unknown; error: string | null } | null> {
    const row = await this.db.maybeOne<{ status: string; result: unknown; error: string | null }>(
      "SELECT status, result, error FROM workflow_executions WHERE id = $1",
      [id],
    );
    return row;
  }

  async result<T>(id: string): Promise<T> {
    const row = await this.getStatus(id);
    if (!row) throw new Error(`No such execution: ${id}`);
    if (row.status === "failed") throw new Error(`Workflow failed: ${row.error}`);
    if (row.status !== "completed") throw new Error(`Workflow ${id} not completed (status ${row.status})`);
    return row.result as T;
  }

  private async runOnce(id: string): Promise<void> {
    // Serialize replays of the same execution within this process.
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.locks.set(id, prev.then(() => gate));
    await prev;
    try {
      await this.replay(id);
    } finally {
      release();
      if (this.locks.get(id) === gate) this.locks.delete(id);
    }
  }

  private async replay(id: string): Promise<void> {
    const exec = await this.db.maybeOne<{ type: string; status: string; input: unknown }>(
      "SELECT type, status, input FROM workflow_executions WHERE id = $1",
      [id],
    );
    if (!exec || exec.status === "completed" || exec.status === "failed") return;

    // Skip executions of a type this engine does not handle. In a multi-engine
    // deployment (or a shared test database) fireDueTimers may surface an
    // execution owned by a different engine — it is not ours to drive.
    const def = this.workflows.get(exec.type);
    if (!def) return;

    const journalRows = await this.db.query<JournalEntry>(
      "SELECT seq, kind, name, result, error FROM workflow_journal WHERE execution_id = $1 ORDER BY seq",
      [id],
    );
    const journal = new Map(journalRows.rows.map((r) => [r.seq, r]));

    const ctx = this.makeContext(id, journal);
    try {
      const result = await def.run(ctx, exec.input);
      await this.db.query(
        "UPDATE workflow_executions SET status='completed', result=$2, updated_at=now() WHERE id=$1",
        [id, JSON.stringify(result ?? null)],
      );
    } catch (err) {
      if (err instanceof Suspension) {
        await this.db.query("UPDATE workflow_executions SET updated_at=now() WHERE id=$1", [id]);
        return; // stay running; resumed by a timer or signal
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.db.query(
        "UPDATE workflow_executions SET status='failed', error=$2, updated_at=now() WHERE id=$1",
        [id, message],
      );
      // ⛔ THE ROW WAS THE ONLY RECORD. Marking `status='failed'` and stopping
      // is how 28 revision workflows sat dead for hours with nothing anywhere
      // reporting it — every customer who asked for a change to their site got
      // an "ok, queued" and then silence. A workflow is the unit of work for
      // everything this system promises: outreach, builds, onboarding,
      // subscriptions, revisions. When one dies the promise it carried dies
      // with it, so the death has to reach a person.
      //
      // Raised AFTER the status write and swallowed on error: a failure in
      // reporting the failure must never leave the execution stuck 'running',
      // which would make it replay forever.
      await this.reportFailure(id, exec.type, message).catch((reportErr: unknown) => {
        console.error(`[engine] workflow ${id} failed and the failure could not be reported`, reportErr);
      });
    }
  }

  /**
   * Put a dead workflow on the operator's queue.
   *
   * ⛔ Deduplicated by (type, normalised error) across OPEN exceptions. One
   * broken activity fails every execution that reaches it, and 500 identical
   * rows would bury the queue so thoroughly that the operator learns nothing —
   * the same outcome as reporting nothing at all. Collapsed, it reads as one
   * item: which workflow, how many executions, when it started, when it last
   * happened.
   *
   * `raised_at` deliberately stays at the FIRST occurrence, so the age shown in
   * the console is how long this has been broken rather than how recently it
   * last recurred.
   */
  private async reportFailure(id: string, type: string, message: string): Promise<void> {
    const signature = normaliseError(message);
    const open = await this.db.maybeOne<{ id: string; context: { occurrences?: number; executionIds?: string[] } }>(
      `SELECT id, context FROM exceptions
        WHERE status = 'open' AND trigger = 'workflow_failed'
          AND context->>'workflowType' = $1 AND context->>'signature' = $2
        LIMIT 1`,
      [type, signature],
    );

    if (open) {
      const seen = Array.isArray(open.context.executionIds) ? open.context.executionIds : [];
      await this.db.query(
        `UPDATE exceptions
            SET context = context
              || jsonb_build_object('occurrences', $2::int, 'lastAt', $3::text, 'executionIds', $4::jsonb)
          WHERE id = $1`,
        [
          open.id,
          (open.context.occurrences ?? 1) + 1,
          new Date(this.clock.now()).toISOString(),
          // A sample, not a log: enough to reproduce, capped so the row cannot
          // grow without bound while the exception stays open.
          JSON.stringify([...seen, id].slice(-20)),
        ],
      );
      return;
    }

    await this.db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
       VALUES ('workflow_failed', 2, $1,
               'execution marked failed; no further steps will run',
               'Fix the cause, then restart the affected executions — a failed workflow does not retry itself')`,
      [
        JSON.stringify({
          workflowType: type,
          signature,
          error: message.slice(0, 500),
          occurrences: 1,
          firstAt: new Date(this.clock.now()).toISOString(),
          lastAt: new Date(this.clock.now()).toISOString(),
          executionIds: [id],
        }),
      ],
    );
  }

  private makeContext(id: string, journal: Map<number, JournalEntry>): WorkflowContext {
    let seq = -1;
    const db = this.db;
    const clock = this.clock;
    const activities = this.activities;

    const persist = async (kind: string, name: string, result: unknown, error: string | null) => {
      await db.query(
        `INSERT INTO workflow_journal (execution_id, seq, kind, name, result, error) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (execution_id, seq) DO NOTHING`,
        [id, seq, kind, name, JSON.stringify(result ?? null), error],
      );
    };

    return {
      executionId: id,
      now: () => new Date(clock.now()),

      async activity<In, Out>(name: string, input: In): Promise<Out> {
        seq++;
        const existing = journal.get(seq);
        if (existing) {
          if (existing.error) throw new Error(existing.error);
          return existing.result as Out;
        }
        const fn = activities.get(name);
        if (!fn) throw new Error(`Unregistered activity: ${name}`);
        try {
          const result = (await fn(input)) as Out;
          await persist("activity", name, result, null);
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await persist("activity", name, null, msg);
          throw err;
        }
      },

      async sideEffect<T>(name: string, fn: () => T): Promise<T> {
        seq++;
        const existing = journal.get(seq);
        if (existing) return existing.result as T;
        const result = fn();
        await persist("side_effect", name, result, null);
        return result;
      },

      async sleep(name: string, ms: number): Promise<void> {
        seq++;
        const existing = journal.get(seq);
        if (existing) return;
        // Ensure a timer exists for this step.
        const timerName = `${seq}:${name}`;
        const timer = await db.maybeOne<{ fired: boolean; fire_at: string }>(
          "SELECT fired, fire_at FROM workflow_timers WHERE execution_id=$1 AND name=$2",
          [id, timerName],
        );
        if (!timer) {
          const fireAt = new Date(clock.now() + ms);
          await db.query(
            "INSERT INTO workflow_timers (execution_id, name, fire_at) VALUES ($1,$2,$3)",
            [id, timerName, fireAt],
          );
          throw new Suspension("timer", timerName);
        }
        const fired = timer.fired || new Date(timer.fire_at).getTime() <= clock.now();
        if (!fired) throw new Suspension("timer", timerName);
        await persist("timer", timerName, null, null);
      },

      async waitForSignal<T>(name: string, timeoutMs?: number): Promise<{ received: boolean; payload?: T }> {
        seq++;
        const existing = journal.get(seq);
        if (existing) return existing.result as { received: boolean; payload?: T };
        const sig = await db.maybeOne<{ id: string; payload: unknown }>(
          "SELECT id, payload FROM workflow_signals WHERE execution_id=$1 AND name=$2 AND delivered=FALSE ORDER BY created_at LIMIT 1",
          [id, name],
        );
        if (sig) {
          await db.query("UPDATE workflow_signals SET delivered=TRUE WHERE id=$1", [sig.id]);
          const out = { received: true, payload: sig.payload as T };
          await persist("signal", name, out, null);
          return out;
        }
        // Register/check a timeout timer.
        if (timeoutMs !== undefined) {
          const timerName = `${seq}:signal_timeout:${name}`;
          const timer = await db.maybeOne<{ fired: boolean; fire_at: string }>(
            "SELECT fired, fire_at FROM workflow_timers WHERE execution_id=$1 AND name=$2",
            [id, timerName],
          );
          if (!timer) {
            await db.query("INSERT INTO workflow_timers (execution_id, name, fire_at) VALUES ($1,$2,$3)", [
              id,
              timerName,
              new Date(clock.now() + timeoutMs),
            ]);
            throw new Suspension("signal", name);
          }
          const fired = timer.fired || new Date(timer.fire_at).getTime() <= clock.now();
          if (fired) {
            const out = { received: false };
            await persist("signal", name, out, null);
            return out;
          }
        }
        throw new Suspension("signal", name);
      },

      async condition(name: string, predicate: () => boolean, timeoutMs?: number): Promise<boolean> {
        seq++;
        const existing = journal.get(seq);
        if (existing) return existing.result as boolean;
        if (predicate()) {
          await persist("condition", name, true, null);
          return true;
        }
        if (timeoutMs !== undefined) {
          const timerName = `${seq}:condition_timeout:${name}`;
          const timer = await db.maybeOne<{ fired: boolean; fire_at: string }>(
            "SELECT fired, fire_at FROM workflow_timers WHERE execution_id=$1 AND name=$2",
            [id, timerName],
          );
          if (!timer) {
            await db.query("INSERT INTO workflow_timers (execution_id, name, fire_at) VALUES ($1,$2,$3)", [
              id,
              timerName,
              new Date(clock.now() + timeoutMs),
            ]);
            throw new Suspension("condition", name);
          }
          const fired = timer.fired || new Date(timer.fire_at).getTime() <= clock.now();
          if (fired) {
            await persist("condition", name, false, null);
            return false;
          }
        }
        throw new Suspension("condition", name);
      },

      patched(_patchId: string): boolean {
        // New executions are always patched. (Historical executions would carry
        // a journaled decision; omitted in this subset.)
        return true;
      },
    };
  }
}
