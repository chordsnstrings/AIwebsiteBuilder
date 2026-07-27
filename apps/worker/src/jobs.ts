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
import { Engine } from "@adw/workflows";
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
