// The ADW worker. This is the process that makes the system run: without it the
// API answers requests but nothing ever advances on its own.
//
// Run one or more replicas — leadership is a Postgres advisory lock, so exactly
// one replica performs side effects and the others stand by.
import { createDb } from "@adw/db";
import { runWatches } from "@adw/orchestrator";
import { evaluateAssetHealth } from "@adw/fleet";
import { EMAIL_VENDOR_IDS, getEmailTransport } from "@adw/vendors";
import { applyEmailFeedback } from "@adw/inbound";
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
  intentDispatcherJob,
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
  const assets = await database.query<{ id: string; kind: string; identifier: string }>(
    "SELECT id, kind, identifier FROM sending_assets WHERE health IN ('healthy','warn','throttled')",
  );

  // ⛔ Mailboxes and domains are scored differently, and the domain half did not
  // exist. `messages.sending_asset_id` is always a MAILBOX — `pickAsset` only
  // returns kind='mailbox' — so every domain row computed sent=0 and was skipped
  // by the `if (sent === 0) continue` below. The threshold is literally named
  // `provider_daily_per_domain` and nothing was ever aggregated per domain, which
  // means a domain could sit far over its provider cap across its mailboxes with
  // every individual mailbox looking healthy.
  const domainTotals = new Map<string, { sent: number; bounced: number; complained: number }>();

  for (const asset of assets.rows) {
    if (asset.kind !== "mailbox") continue;
    const m = await database.one<{ sent: string; bounced: string; complained: string }>(
      `SELECT count(*) AS sent,
              count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced,
              count(*) FILTER (WHERE complained_at IS NOT NULL) AS complained
       FROM messages
       WHERE sending_asset_id = $1 AND sent_at >= now() - interval '7 days'`,
      [asset.id],
    );
    const sent = Number(m.sent);

    // Accumulate for the domain even when this mailbox sent nothing, so a
    // domain's total is the sum of its mailboxes rather than of the busy ones.
    const domain = asset.identifier.split("@")[1] ?? "";
    if (domain) {
      const acc = domainTotals.get(domain) ?? { sent: 0, bounced: 0, complained: 0 };
      acc.sent += sent;
      acc.bounced += Number(m.bounced);
      acc.complained += Number(m.complained);
      domainTotals.set(domain, acc);
    }

    if (sent === 0) continue;
    await evaluateAssetHealth(
      database,
      asset.id,
      {
        complaintRate: Number(m.complained) / sent,
        bounceRate: Number(m.bounced) / sent,
        dailyGmailVolume: sent / 7,
        // ⛔ null, not 0.75. There is no seed-list probe yet, and the old
        // "neutral default" sat above the 0.70 warn floor — so the metric that
        // detects a domain quietly going to spam could never fire, while the
        // board displayed it as passing. Unmeasured reads as unmeasured until
        // the probe exists.
        inboxPlacement: null,
      },
      thresholds,
    ).catch(() => undefined);
  }

  // Now the domains, from the totals of the mailboxes that sit on them.
  for (const asset of assets.rows) {
    if (asset.kind !== "domain") continue;
    const totals = domainTotals.get(asset.identifier.replace(/^@/, ""));
    if (!totals || totals.sent === 0) continue;
    await evaluateAssetHealth(
      database,
      asset.id,
      {
        complaintRate: totals.complained / totals.sent,
        bounceRate: totals.bounced / totals.sent,
        dailyGmailVolume: totals.sent / 7,
        inboxPlacement: null,
      },
      thresholds,
    ).catch(() => undefined);
  }
}

/**
 * Drain the simulator's feedback stream into the same webhook effects a real
 * notification takes.
 *
 * ⛔ `MockEmailTransport` has manufactured bounce, complaint and reply events
 * since it was written, exposed them through `drainEvents()`, and NOTHING ever
 * called it. So the deliverability loop read zero on every asset even in demo
 * mode — the "deliverability loop demo" described in the mock's own header did
 * not exist, and a reviewer watching the board would have concluded the fleet
 * was pristine rather than unobserved.
 *
 * Demo mode only. With real vendors the events arrive over the network.
 */
async function drainSimulatedFeedback(database: typeof db): Promise<void> {
  if (!forceMock) return;
  for (const vendorId of EMAIL_VENDOR_IDS) {
    const transport = getEmailTransport(vendorId);
    for (const event of transport.drainEvents()) {
      // Shaped exactly like the SES notification the real path receives, so the
      // demo exercises the production handler instead of a parallel one.
      const payload =
        event.type === "bounce"
          ? { notificationType: "Bounce", mail: { messageId: event.messageId },
              bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: event.to }] } }
          : event.type === "complaint"
            ? { notificationType: "Complaint", mail: { messageId: event.messageId },
                complaint: { complainedRecipients: [{ emailAddress: event.to }] } }
            : { notificationType: "Delivery", mail: { messageId: event.messageId } };
      await applyEmailFeedback(database, "aws_ses", payload).catch(() => undefined);
    }
  }
}

const scheduler = new Scheduler({
  db,
  jobs: [
    workflowTimerJob(engine),
    intentDispatcherJob(engine, db),
    heartbeatJob(),
    ...probeJobs(),
    // ⛔ Drain BEFORE the sweep, in that order. Sweeping first would score
    // assets against feedback the drain is about to deliver, so every reading
    // would be one cycle stale — 15 minutes behind a complaint spike.
    deliverabilityJob(async (database) => {
      await drainSimulatedFeedback(database);
      await sweepDeliverability(database);
    }),
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
