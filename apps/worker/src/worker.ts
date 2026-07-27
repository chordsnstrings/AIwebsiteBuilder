// The ADW worker. This is the process that makes the system run: without it the
// API answers requests but nothing ever advances on its own.
//
// Run one or more replicas — leadership is a Postgres advisory lock, so exactly
// one replica performs side effects and the others stand by.
import { createDb } from "@adw/db";
import { runWatches } from "@adw/orchestrator";
import { evaluateAssetHealth } from "@adw/fleet";
import { advanceDunning } from "@adw/billing";
import { config } from "@adw/config";
import { Engine } from "@adw/workflows";
import {
  buildWorkflow,
  leadWorkflow,
  onboardingWorkflow,
  revisionWorkflow,
  subscriptionWorkflow,
  paymentsOnboardingWorkflow,
  deliverabilityLoopWorkflow,
  evalLoopWorkflow,
} from "@adw/workflows";
import { LocalKeyWrapper, LocalPgBackend } from "@adw/vault";
import { registerActivities } from "./activities.ts";
import { Scheduler } from "./scheduler.ts";
import {
  deliverabilityJob,
  dunningJob,
  heartbeatJob,
  previewExpiryJob,
  probeJobs,
  vendorWatchJob,
  workflowTimerJob,
} from "./jobs.ts";

const db = await createDb({});

// Every production workflow must be registered here, or its durable timers will
// never fire (the engine deliberately ignores types it does not own).
const engine = new Engine({ db });
for (const wf of [
  leadWorkflow,
  buildWorkflow,
  onboardingWorkflow,
  revisionWorkflow,
  subscriptionWorkflow,
  paymentsOnboardingWorkflow,
  deliverabilityLoopWorkflow,
  evalLoopWorkflow,
]) {
  engine.registerWorkflow(wf as never);
}

// ...and every activity those workflows name, or the first step of the first
// execution throws "Unregistered activity" and the whole pipeline stalls.
const vault = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));
const forceMock = process.env.ADW_FORCE_MOCK === "1" || ["local", "test"].includes(process.env.ADW_ENV ?? "production");
registerActivities(engine, {
  db,
  vault,
  forceMock,
  ...(process.env.ADW_PUBLIC_BASE ? { publicBase: process.env.ADW_PUBLIC_BASE } : {}),
});

/**
 * Deliverability sweep over every live sending asset. Metrics come from the
 * message ledger over the trailing 7 days — the same window the thresholds are
 * defined against.
 */
async function sweepDeliverability(database: typeof db): Promise<void> {
  const thresholds = config.thresholds().data.deliverability;
  const assets = await database.query<{ id: string }>(
    "SELECT id FROM sending_assets WHERE health IN ('healthy','warn','throttled')",
  );
  for (const asset of assets.rows) {
    const m = await database.one<{ sent: string; bounced: string; complained: string }>(
      `SELECT count(*) AS sent,
              count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced,
              count(*) FILTER (WHERE complained_at IS NOT NULL) AS complained
       FROM messages
       WHERE sending_asset_id = $1 AND sent_at >= now() - interval '7 days'`,
      [asset.id],
    );
    const sent = Number(m.sent);
    if (sent === 0) continue;
    await evaluateAssetHealth(
      database,
      asset.id,
      {
        complaintRate: Number(m.complained) / sent,
        bounceRate: Number(m.bounced) / sent,
        dailyGmailVolume: sent / 7,
        inboxPlacement: 0.75, // measured by the seed-list probe; neutral default
      },
      thresholds,
    ).catch(() => undefined);
  }
}

const scheduler = new Scheduler({
  db,
  jobs: [
    workflowTimerJob(engine),
    heartbeatJob(),
    ...probeJobs(),
    deliverabilityJob(sweepDeliverability),
    dunningJob(advanceDunning),
    previewExpiryJob(),
    vendorWatchJob(runWatches),
  ],
});

const leader = await scheduler.acquireLeadership();
console.log(`[worker] ${leader ? "LEADER — running jobs" : "standby — leader elsewhere"}`);
scheduler.start();

// Graceful shutdown: stop scheduling, let in-flight jobs settle, release the
// lock so a standby replica can take over immediately.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} — draining`);
  await scheduler.stop();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A crash in an unobserved promise must be loud, not silent.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection:", reason);
});

// Keep the process alive (all job timers are unref'd).
setInterval(() => {}, 1 << 30);
