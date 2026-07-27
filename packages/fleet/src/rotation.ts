// Rotation (spec §22). Picks the next sending asset in a pool. This is NOT plain
// round-robin: the spec forbids selecting an asset without first asserting it is
// under its per-domain daily cap. We pick the least-recently-used healthy asset
// (by most recent outbound send) that still has headroom under daily_cap.
import type { Db } from "@adw/db";

export interface RotationAsset {
  id: string;
  identifier: string;
  provider: string;
  health: string;
  daily_cap: number;
  sends_today: number;
}

/**
 * Return the least-recently-used sendable asset in `pool` that is under its
 * per-domain daily cap (sends_today < daily_cap), or null if none is available.
 * Only 'healthy' and 'warn' assets are sendable (matching the compliance gate).
 * The per-domain cap check is mandatory — never round-robin without it.
 */
export async function pickAsset(db: Db, pool: string): Promise<RotationAsset | null> {
  return db.maybeOne<RotationAsset>(
    `SELECT a.id, a.identifier, a.provider, a.health, a.daily_cap, a.sends_today
       FROM sending_assets a
       LEFT JOIN messages m
         ON m.sending_asset_id = a.id AND m.direction = 'outbound'
      WHERE a.pool = $1
        AND a.kind = 'mailbox'
        AND a.health IN ('healthy', 'warn')
        AND a.sends_today < a.daily_cap
      GROUP BY a.id
      ORDER BY MAX(m.sent_at) ASC NULLS FIRST, a.created_at ASC
      LIMIT 1`,
    [pool],
  );
}
