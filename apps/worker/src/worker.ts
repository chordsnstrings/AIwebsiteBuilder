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
import { runEscalations } from "@adw/protocol";
import { reclassifySubscribers, sourceLeads } from "@adw/provenance";
import { readEngagedSwitches, sendingHalted } from "@adw/gate";
import { resolveEmailVerifier } from "@adw/vendors";
import { runJourneys, runReminders } from "@adw/journeys";
import { httpCollectors, pruneObservations, runDueWatches, simulatedCollectors, type FetchLike } from "@adw/watch";
import { publishApproved, simulatedConnectors } from "@adw/publish";
import { generateApproved } from "@adw/assets";
import { resolveCompanyRegistry, resolveEmailTransport, resolveLeadSource, resolveMediaGenerator } from "@adw/vendors";
import { dueChases, purgeExpired } from "@adw/uploads";
import { resolveObjectStore } from "@adw/vendors";
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
  clocksJob,
  watchJob,
  publishJob,
  assetJob,
  deliverabilityJob,
  documentsJob,
  protocolEscalationJob,
  dunningJob,
  intentDispatcherJob,
  heartbeatJob,
  previewExpiryJob,
  probeJobs,
  vendorWatchJob,
  sourcingJob,
  subscriberReclassificationJob,
  workflowTimerJob,
  enquiryNotifyJob,
  valueReportJob,
} from "./jobs.ts";
import { notifyPendingEnquiries } from "./enquiry-notify.ts";
import { MAX_NOTIFY_ATTEMPTS } from "@adw/concierge";
import { sweepValueReports } from "@adw/reports";

const db = await createDb({});

/**
 * What to source, and how much.
 *
 * ⛔ Environment, not config/*.yaml: the query is an operational dial (which
 * trade in which city we are prospecting this week), not a compliance rule, and
 * config files in this repo are PR-gated precisely because they are the latter.
 * The ceiling is a ceiling only — the real batch size is whatever the fleet can
 * still lawfully send today, computed per run.
 */
const SOURCING_QUERY = process.env.ADW_SOURCING_QUERY ?? "independent trades with no website";
const SOURCING_MAX_PER_RUN = Number(process.env.ADW_SOURCING_MAX_PER_RUN ?? 50);
// Bounded per pass: against a real registry every row is a metered API call, and
// an unbounded backlog drain would spend a day's quota in one tick.
const RECLASSIFY_MAX_PER_RUN = Number(process.env.ADW_RECLASSIFY_MAX_PER_RUN ?? 500);

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

const nodeFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
const watchCollectors = forceMock ? simulatedCollectors() : httpCollectors(nodeFetch);
// ⛔ In demo the simulated connectors record and hand back an id. In live mode
// this map is EMPTY until a platform adapter exists, and `publishApproved`
// counts what it could not send rather than reporting a clean sweep — an
// approved post silently never leaving is exactly the failure this codebase
// keeps finding.
const publishConnectors = forceMock ? simulatedConnectors() : {};

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
    // ⛔ Ahead of the slower loops in the list, and on its own one-minute
    // cadence. The notification transport is injected so a page about a vendor
    // never rides that vendor — the Sentinel's §73 rule, applied here too.
    protocolEscalationJob((database, at) =>
      runEscalations(database, async (n) => {
        await database.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
           VALUES ($1, $2, $3, 'protocol escalation fired', $4)`,
          [
            `protocol_${n.protocolId}`,
            n.severity,
            JSON.stringify({
              incidentId: n.incidentId,
              notifyRole: n.notifyRole,
              step: n.stepIndex,
              minutesOpen: n.minutesOpen,
              customerId: n.customerId,
            }),
            `Open incident ${n.incidentId} and acknowledge it. ${n.label}.`,
          ],
        );
        return { delivered: true, detail: `exception raised for ${n.notifyRole}` };
      }, at),
    ),
    documentsJob(async (database, at) => {
      // Chases first: an outstanding document is worth more than a tidy bucket.
      for (const chase of await dueChases(database, at)) {
        // ⛔ Raised as an exception rather than emailed from here. The gate is
        // the sole route to transport, and a chase is an outbound message to
        // someone who may have unsubscribed since the pack was opened.
        await database.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
           VALUES ('document_chase_due', 4, $1, 'chase scheduled', $2)`,
          [
            JSON.stringify({
              requestId: chase.requestId,
              customerId: chase.customerId,
              subjectRef: chase.subjectRef,
              outstanding: chase.outstanding.map((o) => o.key),
              chaseNumber: chase.chaseNumber,
            }),
            `Send chase ${chase.chaseNumber} for "${chase.packLabel}" — ${chase.outstanding.length} item(s) outstanding.`,
          ],
        );
      }
      const store = await resolveObjectStore({ vault, forceMock });
      await purgeExpired({ db: database, store, now: () => at });
    }),
    clocksJob(async (database, at) => {
      // ⛔ Raised into the OWNER's queue (customer_id set), not ADW's. A recall
      // list and a vendor credential expiry in one undifferentiated stream is
      // how the owner's console ended up with nothing to show, and MF3 exists
      // to keep them apart.
      //
      // ⛔ And raised, not sent. The gate is the sole route to transport, and a
      // business messaging its own patients on its own sending identity is not
      // built. What IS built is the part that was missing entirely: the date
      // existing, surviving a restart, and arriving.
      await runReminders(database, async (r) => {
        await database.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation, customer_id)
           VALUES ($1, $2, $3, 'reminder due', $4, $5)`,
          [
            `reminder_${r.kind}`,
            r.severity,
            JSON.stringify({
              reminderId: r.id, kind: r.kind, subjectRef: r.subjectRef,
              dueAt: r.dueAt, statutory: r.statutory, daysLate: r.daysLate,
              // ⛔ Carried through so the owner decides. An unsubscribe from a
              // business's marketing must not suppress "your gas safety
              // certificate expires in 28 days".
              contactSuppressed: r.contactSuppressed,
            }),
            `${r.label} — ${r.subjectRef}${r.statutory ? " (statutory date)" : ""}`,
            r.customerId,
          ],
        );
        return { delivered: true };
      }, at);

      await runJourneys(database, async (s) => {
        await database.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation, customer_id)
           VALUES ($1, 4, $2, 'journey step due', $3, $4)`,
          [
            `journey_${s.journeyId}`,
            JSON.stringify({
              runId: s.runId, journeyId: s.journeyId, template: s.template,
              subjectRef: s.subjectRef, contact: s.contact,
              step: `${s.stepNumber} of ${s.stepCount}`,
            }),
            `${s.journeyLabel}, step ${s.stepNumber} of ${s.stepCount}: ${s.purpose}`,
            s.customerId,
          ],
        );
        return { delivered: true };
      }, at);
    }),
    watchJob(async (database, at) => {
      const summary = await runDueWatches(database, watchCollectors, at);
      // ⛔ Only the severe findings reach the owner's exception queue; the rest
      // live on the watch board. A queue that receives every competitor price
      // tweak is a queue nobody opens, and MF3 exists precisely to keep "needs
      // a human" separate from "worth knowing".
      if (summary.findings > 0) {
        await database.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation, customer_id)
           SELECT 'watch_' || f.watch_id, f.severity,
                  jsonb_build_object('findingId', f.id, 'watchId', f.watch_id, 'subject', s.subject),
                  'watcher reported a change', f.summary, f.customer_id
             FROM watch_findings f
             JOIN watch_subscriptions s ON s.id = f.subscription_id
            WHERE f.found_at = $1 AND f.severity <= 2`,
          [at],
        );
      }
      // ⛔ Counted out loud. A deployment missing a collector would otherwise
      // report a clean sweep over subscriptions it never touched.
      if (summary.uncollectable > 0) {
        console.warn(`[worker] ${summary.uncollectable} watch subscription(s) have no collector on this deployment`);
      }
      await pruneObservations(database, 90, at);
    }),
    assetJob(async (database, at) => {
      // ⛔ Resolved per sweep rather than held, so depositing a ModelArk
      // credential takes effect without a restart — and so does removing one.
      const generator = await resolveMediaGenerator({ vault, forceMock });
      const store = await resolveObjectStore({ vault, forceMock });
      const out = await generateApproved(database, { generator, store }, at);
      if (out.capped > 0) {
        console.warn(`[worker] ${out.capped} approved asset(s) held back by a monthly cap`);
      }
      if (out.spentCents > 0) {
        // ⛔ Logged in every run that spends. This is the one recurring job that
        // debits a real account, and a silent one is a bill nobody saw coming.
        console.log(`[worker] generated ${out.generated} asset(s), ${out.spentCents}c, billable=${generator.billable}`);
      }
    }),
    publishJob(async (database, at) => {
      const out = await publishApproved(database, publishConnectors, at);
      if (out.unconnected > 0) {
        console.warn(`[worker] ${out.unconnected} approved publication(s) have no connector on this deployment`);
      }
    }),
    deliverabilityJob(async (database) => {
      await drainSimulatedFeedback(database);
      await sweepDeliverability(database);
    }),
    dunningJob(advanceDunning),
    previewExpiryJob(),
    vendorWatchJob(runWatches),
    // ⛔ THE IGNITION. Without this job the whole machine downstream is correct
    // and idle: nothing ever hands it a business. See sourcingJob's comment for
    // why it is hourly and why the batch is sized to send capacity.
    sourcingJob(async (database, at) => {
      const engaged = await readEngagedSwitches(database, at.getTime());
      // ⛔ Do not BUY data we are forbidden to act on. Cold sending halted means
      // every record sourced now would sit ageing towards the provenance
      // staleness limit before it could ever be contacted.
      if (sendingHalted(engaged, "email", "cold")) {
        console.log("[worker] sourcing skipped — cold sending is halted");
        return;
      }
      const source = await resolveLeadSource({ vault, forceMock });
      if (source === null) {
        console.warn("[worker] no lead-data credential and not in demo mode — nothing to source from");
        return;
      }
      const verifier = await resolveEmailVerifier({ vault, forceMock });
      const store = await resolveObjectStore({ vault, forceMock });
      const out = await sourceLeads(
        database,
        source,
        {
          verifier,
          // The listing page the record came from. In demo the fetch is
          // simulated; in live mode this is the real page whose text and
          // screenshot become the provenance evidence.
          fetcher: {
            async fetch(url: string) {
              if (forceMock) {
                return { text: `Listing for ${url}. Contact us for a quote.`, screenshot: Buffer.from("png") };
              }
              const res = await fetch(url).catch(() => null);
              if (res === null || !res.ok) return null;
              return { text: await res.text(), screenshot: Buffer.from("") };
            },
          },
          store: { put: async (key: string, data: Buffer) => void (await store.put(key, data)) },
          // ⛔ WAS `async () => "unknown"`. PECR admits only "corporate", so
          // that stub classified every GB and IE contact as unmailable at
          // ingest and the gate denied them forever — a third of the database,
          // permanently undeliverable, with nothing reporting why. The real
          // classifier resolves the names that carry their own legal-suffix
          // evidence and still says "unknown" about the rest, which still
          // denies. Unknown is not permission; it just is not the only answer.
          registry: await resolveCompanyRegistry({ vault, forceMock }),
        },
        { query: SOURCING_QUERY, maxRecords: SOURCING_MAX_PER_RUN, now: at },
      );
      if (out.halted !== undefined) {
        console.log(`[worker] sourcing halted: ${out.halted}`);
        return;
      }
      const skips = Object.entries(out.skipped).map(([k, n]) => `${k}=${n}`).join(" ");
      console.log(
        `[worker] sourced ${out.fetched} record(s) from ${out.licenceRef ?? "?"}: ` +
          `${out.ingested} ingested, ${out.businessesCreated} new business(es), ` +
          `${out.costCents}c, capacity ${out.capacity}${skips === "" ? "" : ` · skipped ${skips}`}`,
      );
    }),
    // ⛔ Makes the classifier retroactive. Ingest classifies once, at creation,
    // so every contact ingested against the old stub is stuck at "unknown" —
    // which denies under PECR — no matter how good the classifier later gets.
    subscriberReclassificationJob(async (database) => {
      const out = await reclassifySubscribers(
        database,
        await resolveCompanyRegistry({ vault, forceMock }),
        { limit: RECLASSIFY_MAX_PER_RUN },
      );
      if (out.considered === 0) return;
      const types = Object.entries(out.byType).map(([k, n]) => `${k}=${n}`).join(" ");
      console.log(
        `[worker] reclassified ${out.resolved}/${out.considered} GB/IE contact(s)` +
          `${types === "" ? "" : ` · ${types}`} · ${out.backlog} still unresolved` +
          `${out.errors === 0 ? "" : ` · ${out.errors} registry error(s)`}`,
      );
    }),
    // ⛔ The job that stops this product misleading the public. The agent tells
    // a visitor it has passed their details on; `commitEnquiry` writes the row;
    // until this ran, nothing read that table anywhere in the repository and the
    // owner was never told.
    enquiryNotifyJob(async (database, at) => {
      const out = await notifyPendingEnquiries({
        db: database,
        transport: await resolveEmailTransport("aws_ses", { vault, forceMock }),
        from: process.env["ADW_BRAND_SENDER"] ?? "hello@adwsites.com",
        now: () => at,
      });
      if (out.customers === 0) return;
      console.log(
        `[worker] enquiry notifications: ${out.notified} sent to ${out.customers} owner(s)` +
          `${out.failed === 0 ? "" : ` · ${out.failed} refused (${out.reasons.join(", ")})`}` +
          `${out.abandoned === 0 ? "" : ` · ${out.abandoned} abandoned after ${MAX_NOTIFY_ATTEMPTS} attempts`}`,
      );
    }),
    // ⛔ `@adw/reports` had zero consumers. This is the one that makes the
    // monthly report exist for a customer rather than only in the type system.
    valueReportJob(async (database, at) => {
      const out = await sweepValueReports(database, at);
      // Denominator alongside the count: "0 generated" over 0 eligible
      // customers and over 200 are completely different states.
      if (out.considered === 0) return;
      console.log(
        `[worker] value reports ${out.month.year}-${String(out.month.month).padStart(2, "0")}: ` +
          `${out.generated}/${out.considered} generated` +
          `${out.skipped === 0 ? "" : ` · ${out.skipped} already present`}` +
          `${out.errors === 0 ? "" : ` · ${out.errors} failed`}`,
      );
    }),
  ],
});

const leader = await scheduler.acquireLeadership();
console.log(`[worker] ${leader ? "LEADER — running jobs" : "standby — leader elsewhere"}`);
// Declare the roster before the first tick, so the console can distinguish a
// job that has never succeeded from a job that was never deployed.
await scheduler.register();
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
