// The recurring work. Without this process nothing in the system advances:
// durable timers never fire (so every lead workflow stalls at its first sleep),
// probes never run (so the Sentinel is blind), the heartbeat never emits (so the
// dead man's switch reports the Sentinel dead), asset health never updates and
// dunning never progresses.
import type { Db } from "@adw/db";
import {
  buildProbeCatalogue,
  emitHeartbeat,
  runProbe,
  type Probe,
} from "@adw/sentinel";
import {
  Engine,
  markIntentDelivered,
  markIntentFailed,
  pendingIntents,
} from "@adw/workflows";
import type { Job } from "./scheduler.ts";

/**
 * Durable timers. Fires any workflow timer whose deadline has passed. The engine
 * only fires timers for workflow types it has registered, so this worker must
 * register every production workflow.
 */
export function workflowTimerJob(engine: Engine): Job {
  return {
    name: "workflow_timers",
    intervalMs: 10_000,
    async run() {
      await engine.fireDueTimers();
    },
  };
}

/**
 * The dead man's switch (spec §71.6). Emits every 60s. The external heartbeat
 * vendor alerts a human after three misses — you are alerted by ABSENCE, so this
 * job silently stopping is itself the signal.
 */
export function heartbeatJob(): Job {
  return {
    name: "sentinel_heartbeat",
    intervalMs: 60_000,
    async run({ db }) {
      await emitHeartbeat(db);
    },
  };
}

/**
 * Probes, each on its own cadence from the catalogue rather than one blanket
 * interval — a 30s Postgres probe and a 24h counsel check should not share a
 * schedule. Grouped into buckets so we register a handful of jobs, not thirty.
 */
export function probeJobs(): Job[] {
  const catalogue = buildProbeCatalogue();
  const buckets = new Map<number, Probe[]>();
  for (const probe of catalogue) {
    const list = buckets.get(probe.intervalMs) ?? [];
    list.push(probe);
    buckets.set(probe.intervalMs, list);
  }
  return [...buckets.entries()].map(([intervalMs, probes]) => ({
    name: `probes_${intervalMs}ms`,
    intervalMs,
    async run({ db }) {
      // One probe failing must not stop the rest of its bucket.
      for (const probe of probes) {
        await runProbe(db, probe).catch(() => undefined);
      }
    },
  }));
}

/**
 * Deliverability control loop (spec §22): every 15 minutes, per sending asset,
 * over the trailing 7-day window.
 */
export function deliverabilityJob(evaluate: (db: Db) => Promise<void>): Job {
  return {
    name: "deliverability_loop",
    intervalMs: 15 * 60_000,
    run: ({ db }) => evaluate(db),
  };
}

/**
 * Protocol escalations (MF14).
 *
 * ⛔ ONE MINUTE. Every other job here runs on a 15-minute-to-hourly cadence,
 * and this one does not, because a severity-1 chain has a step at +0 minutes.
 * A safeguarding disclosure sitting in a queue for a quarter of an hour before
 * anyone is told is the failure this family exists to prevent, and the interval
 * is the difference between a chain and a report.
 */
export function protocolEscalationJob(run: (db: Db, now: Date) => Promise<unknown>): Job {
  return {
    name: "protocol_escalations",
    intervalMs: 60_000,
    run: async ({ db, now }) => void (await run(db, now)),
  };
}

/**
 * Document chases (MF6) and upload retention.
 *
 * ⛔ Hourly, and the retention half is not optional. An identity document with
 * no expiry is an identity document kept forever by accident, and the storage
 * layer sets a retain_until on every row precisely so something has to come
 * along and honour it. A retention policy nothing enforces is a paragraph.
 */
export function documentsJob(run: (db: Db, now: Date) => Promise<unknown>): Job {
  return {
    name: "documents_and_retention",
    intervalMs: 60 * 60_000,
    run: async ({ db, now }) => void (await run(db, now)),
  };
}

/**
 * Customer clocks (MF4) and multi-touch journeys (MF5).
 *
 * ⛔ Hourly, and deliberately NOT on the durable-timer engine. There was exactly
 * one production `ctx.sleep` in this repository before MF4 — a 180-day lead
 * cooldown — and extending that pattern to customer dates would park tens of
 * thousands of executions on multi-month sleeps, so every engine upgrade would
 * become a migration of live sleeping state. A due-date table is queryable and
 * correctable by a human; a sleeping workflow is neither.
 */
export function clocksJob(run: (db: Db, now: Date) => Promise<unknown>): Job {
  return {
    name: "clocks_and_journeys",
    intervalMs: 60 * 60_000,
    run: async ({ db, now }) => void (await run(db, now)),
  };
}

/**
 * Watchers for the customer's market (MF7).
 *
 * ⛔ Hourly, because the shortest cadence in the catalogue is one hour and the
 * runner applies each watch's own cadence per row. A blanket 15-minute sweep
 * would run a weekly competitor-price watch 672 times a week to fetch the same
 * page, which is how a watcher gets a customer's IP blocked by the site it is
 * watching.
 */
export function watchJob(run: (db: Db, now: Date) => Promise<unknown>): Job {
  return {
    name: "market_watchers",
    intervalMs: 60 * 60_000,
    run: async ({ db, now }) => void (await run(db, now)),
  };
}

/**
 * Releasing approved publications (MF12).
 *
 * ⛔ Hourly, and the cadence floor lives in the publisher rather than here. An
 * owner working through their queue on a Sunday evening approves eight posts in
 * ten minutes; a job that simply drained the queue would release all eight, and
 * a business posting eight times in an hour looks automated — which is the one
 * thing this whole product exists to avoid.
 */
export function publishJob(run: (db: Db, now: Date) => Promise<unknown>): Job {
  return {
    name: "publish_approved",
    intervalMs: 60 * 60_000,
    run: async ({ db, now }) => void (await run(db, now)),
  };
}

/**
 * Generating the assets an owner has approved (MF13).
 *
 * ⛔ Hourly, and the only job in this list whose work costs money per item. It
 * is deliberately NOT on the five-second dispatcher: an owner approving a batch
 * is not waiting at the screen for the pictures, and a slow cadence means a
 * runaway request loop is caught by a human before it is caught by a bill.
 */
export function assetJob(run: (db: Db, now: Date) => Promise<unknown>): Job {
  return {
    name: "generate_assets",
    intervalMs: 60 * 60_000,
    run: async ({ db, now }) => void (await run(db, now)),
  };
}

/** Dunning: advance any subscription whose next action is due (spec §29). */
export function dunningJob(advance: (db: Db, subscriptionId: string) => Promise<unknown>): Job {
  return {
    name: "dunning",
    intervalMs: 60 * 60_000,
    async run({ db, now }) {
      const due = await db.query<{ subscription_id: string }>(
        "SELECT subscription_id FROM dunning_state WHERE status = 'active' AND next_action_at IS NOT NULL AND next_action_at <= $1",
        [now],
      );
      for (const row of due.rows) {
        await advance(db, row.subscription_id).catch(() => undefined);
      }
    },
  };
}

/**
 * Preview expiry (spec §13): previews expire 30 days after generation if
 * unclaimed. Left unenforced this becomes a live unofficial page about someone's
 * business with no end date — the highest-frequency complaint risk in the system.
 */
export function previewExpiryJob(): Job {
  return {
    name: "preview_expiry",
    intervalMs: 60 * 60_000,
    async run({ db, now }) {
      await db.query(
        `UPDATE previews SET takedown_at = $1, takedown_reason = 'expired'
         WHERE expires_at < $1 AND takedown_at IS NULL AND claimed_at IS NULL`,
        [now],
      );
    },
  };
}

/**
 * Vendor watches (spec §75.5): credential expiry, contract renewals before the
 * notice period closes, credit balances. Daily is enough — the thresholds are
 * measured in days.
 */
export function vendorWatchJob(runWatches: (db: Db) => Promise<{ vendorId: string; kind: string; urgency: string; detail: string }[]>): Job {
  return {
    name: "vendor_watches",
    intervalMs: 24 * 60 * 60_000,
    async run({ db }) {
      const findings = await runWatches(db);
      for (const f of findings.filter((x) => x.urgency === "escalation")) {
        await db.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
           VALUES ($1, 2, $2, 'flagged by vendor watch', $3)`,
          [
            f.kind,
            JSON.stringify({ vendorId: f.vendorId, detail: f.detail }),
            `Review ${f.vendorId}: ${f.detail}`,
          ],
        );
      }
    },
  };
}

/**
 * Drain the workflow outbox. This is the job that turns "a customer claimed
 * their preview" into a running onboarding — without it the API records
 * intentions nobody acts on, and the pipeline has no ignition.
 *
 * Runs every 5 seconds: an entry point is the one place latency is visible to a
 * person who just clicked something.
 */
export function intentDispatcherJob(engine: Engine, db: Db): Job {
  return {
    name: "intent-dispatcher",
    intervalMs: 5_000,
    run: async () => {
      for (const intent of await pendingIntents(db)) {
        try {
          if (intent.kind === "start") {
            await engine.start(intent.workflow_type, intent.execution_id, intent.payload);
          } else {
            await engine.signal(intent.execution_id, intent.signal_name!, intent.payload);
          }
          await markIntentDelivered(db, intent.id);
        } catch (err) {
          // One bad intent must not stall the queue behind it.
          await markIntentFailed(db, intent.id, String(err));
        }
      }
    },
  };
}
