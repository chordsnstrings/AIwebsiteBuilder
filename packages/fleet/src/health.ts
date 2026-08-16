// Deliverability control loop (spec §22, §40). Deterministic state machine — no
// language model. Trailing-7-day metrics are mapped to a monotonic health ladder
//   healthy → warn → throttled → halted → retired
// and the sending_assets row is updated in place. A halt raises an exception
// (trigger 'deliverability_halt', severity 2) so a human is notified while the
// asset is already out of rotation. The ladder never auto-heals: recovery is via
// a fresh warm-up, not a metric dip.
import type { Db } from "@adw/db";
import { emit } from "@adw/telemetry";

export type Health = "warming" | "healthy" | "warn" | "throttled" | "halted" | "retired";

/** One threshold band. Money/ratios are compared as given (spec §69.2). */
export interface DeliverabilityBand {
  warn: number;
  throttle: number;
  halt: number;
}

/** The `deliverability` block of config.thresholds().data. */
export interface DeliverabilityThresholds {
  complaint_rate: DeliverabilityBand;
  bounce_rate: DeliverabilityBand;
  provider_daily_per_domain: DeliverabilityBand;
  inbox_placement: DeliverabilityBand;
}

/** Trailing-7-day metrics for one sending asset. */
export interface AssetMetrics {
  complaintRate: number;
  bounceRate: number;
  dailyGmailVolume: number;
  /**
   * Share of sends landing in the inbox, from a seed-list probe.
   *
   * ⛔ `null` means NOT MEASURED, and the band is skipped. It was previously a
   * hardcoded `0.75` described as a "neutral default" — 0.75 sits above the 0.70
   * warn floor, so the one input that detects a domain quietly going to spam
   * could never fire, and the dashboard showed a passing placement metric for a
   * probe that does not exist. A missing measurement must read as missing.
   */
  inboxPlacement: number | null;
}

// Band levels: 1 = none, 2 = warn, 3 = throttle, 4 = halt.
type BandLevel = 1 | 2 | 3 | 4;

// Higher metric is worse (complaints, bounces, raw volume).
function highBad(value: number, band: DeliverabilityBand): BandLevel {
  if (value >= band.halt) return 4;
  if (value >= band.throttle) return 3;
  if (value >= band.warn) return 2;
  return 1;
}

// Lower metric is worse (inbox placement falling below the floor).
function lowBad(value: number, band: DeliverabilityBand): BandLevel {
  if (value <= band.halt) return 4;
  if (value <= band.throttle) return 3;
  if (value <= band.warn) return 2;
  return 1;
}

function worstBand(metrics: AssetMetrics, t: DeliverabilityThresholds): BandLevel {
  return Math.max(
    highBad(metrics.complaintRate, t.complaint_rate),
    highBad(metrics.bounceRate, t.bounce_rate),
    highBad(metrics.dailyGmailVolume, t.provider_daily_per_domain),
    // An unmeasured metric contributes nothing rather than contributing a pass.
    metrics.inboxPlacement === null ? 1 : lowBad(metrics.inboxPlacement, t.inbox_placement),
  ) as BandLevel;
}

const RANK: Record<Health, number> = {
  warming: 0,
  healthy: 1,
  warn: 2,
  throttled: 3,
  halted: 4,
  retired: 5,
};

/**
 * Evaluate one asset's trailing-7-day metrics and transition its health state,
 * updating the sending_assets row. Returns the new health state.
 *
 * @param thresholds config.thresholds().data.deliverability
 */
export async function evaluateAssetHealth(
  db: Db,
  assetId: string,
  metrics: AssetMetrics,
  thresholds: DeliverabilityThresholds,
  now: Date = new Date(),
): Promise<Health> {
  const asset = await db.one<{ health: Health; daily_cap: number }>(
    "SELECT health, daily_cap FROM sending_assets WHERE id = $1",
    [assetId],
  );
  const current = asset.health;
  const band = worstBand(metrics, thresholds);

  // Map the worst breached band onto the ladder, never downgrading (fail-safe):
  // a metric dip does not silently promote a throttled/halted asset.
  let next: Health;
  if (band === 1) {
    next = current; // nothing breached — no change
  } else if (band === 2) {
    next = RANK[current] > RANK.warn ? current : "warn";
  } else if (band === 3) {
    next = RANK[current] > RANK.throttled ? current : "throttled";
  } else {
    // Halt-level metrics on an already-halted asset retire it for good.
    next = current === "halted" || current === "retired" ? "retired" : "halted";
  }

  if (next === current && band !== 1) {
    // Same state, nothing structural to change (e.g. already warn and still warn).
    return next;
  }

  switch (next) {
    case "warn": {
      // Notify only — capacity unchanged.
      await db.query("UPDATE sending_assets SET health = 'warn' WHERE id = $1", [assetId]);
      await emit({
        eventType: "fleet.asset.warn",
        subject: { kind: "sending_asset", id: assetId },
        payload: { metrics },
      });
      break;
    }
    case "throttled": {
      // Halve the daily cap and extend (restart) warm-up.
      const halved = Math.max(1, Math.floor(asset.daily_cap / 2));
      await db.query(
        "UPDATE sending_assets SET health = 'throttled', daily_cap = $2, warmup_started = $3 WHERE id = $1",
        [assetId, halved, now],
      );
      await emit({
        eventType: "fleet.asset.throttled",
        subject: { kind: "sending_asset", id: assetId },
        payload: { metrics, dailyCap: halved },
      });
      break;
    }
    case "halted": {
      // Remove from rotation (health halted, cap 0) and raise an exception.
      await db.query(
        "UPDATE sending_assets SET health = 'halted', daily_cap = 0 WHERE id = $1",
        [assetId],
      );
      await db.query(
        `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
         VALUES ('deliverability_halt', 2, $1, 'asset removed from rotation, daily_cap set to 0', 'investigate provider signals; retire if unrecoverable')`,
        [JSON.stringify({ assetId, metrics })],
      );
      await emit({
        eventType: "fleet.asset.halted",
        subject: { kind: "sending_asset", id: assetId },
        payload: { metrics },
      });
      break;
    }
    case "retired": {
      await db.query(
        "UPDATE sending_assets SET health = 'retired', daily_cap = 0, retired_at = $2, retire_reason = 'deliverability' WHERE id = $1",
        [assetId, now],
      );
      await emit({
        eventType: "fleet.asset.retired",
        subject: { kind: "sending_asset", id: assetId },
        payload: { metrics },
      });
      break;
    }
    default: {
      // healthy / warming — record but leave capacity managed by warm-up.
      await db.query("UPDATE sending_assets SET health = $2 WHERE id = $1", [assetId, next]);
      break;
    }
  }

  return next;
}
