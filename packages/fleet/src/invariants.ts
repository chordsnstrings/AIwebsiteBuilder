// Fleet invariants (spec §22). Structural safety checks over the sending fleet
// that must hold regardless of any per-asset health. Deterministic; returns the
// list of violated invariants (empty === healthy). When a `pool` is given the
// checks are scoped to that pool.
import type { Db } from "@adw/db";
import { config } from "@adw/config";

// Live mailboxes are anything not already removed from the fleet.
const LIVE_HEALTH = ["warming", "healthy", "warn", "throttled"];

// Domains may not be registered faster than this per rolling day (spec §22).
const MAX_DOMAINS_PER_DAY = 15;

/**
 * Check fleet invariants and return any violations:
 *  (a) at least two distinct providers among live mailboxes;
 *  (b) no single provider exceeds the concentration cap of live mailboxes;
 *  (c) no more than 15 domains registered in the last rolling day.
 */
export async function checkFleetInvariants(db: Db, pool?: string): Promise<string[]> {
  const violations: string[] = [];
  const concentrationCap = config.thresholds().data.control.provider_concentration_max;

  const poolFilter = pool ? " AND pool = $1" : "";
  const poolParams = pool ? [pool] : [];

  // (a) + (b): provider spread across live mailboxes.
  const providerRows = await db.query<{ provider: string; n: string }>(
    `SELECT provider, count(*) AS n
       FROM sending_assets
      WHERE kind = 'mailbox' AND health = ANY($${pool ? 2 : 1})${poolFilter}
      GROUP BY provider`,
    pool ? [pool, LIVE_HEALTH] : [LIVE_HEALTH],
  );
  const total = providerRows.rows.reduce((s, r) => s + Number(r.n), 0);

  if (providerRows.rows.length < 2) {
    violations.push(`fewer than 2 providers among live mailboxes (found ${providerRows.rows.length})`);
  }
  if (total > 0) {
    for (const r of providerRows.rows) {
      const share = Number(r.n) / total;
      if (share > concentrationCap) {
        violations.push(
          `provider ${r.provider} holds ${(share * 100).toFixed(1)}% of live mailboxes (cap ${(concentrationCap * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  // (c): domain registration rate over the last rolling day.
  const domainRow = await db.one<{ n: string }>(
    `SELECT count(*) AS n
       FROM sending_assets
      WHERE kind = 'domain' AND created_at >= now() - interval '1 day'${poolFilter}`,
    poolParams,
  );
  const domainsToday = Number(domainRow.n);
  if (domainsToday > MAX_DOMAINS_PER_DAY) {
    violations.push(`${domainsToday} domains registered in the last day (cap ${MAX_DOMAINS_PER_DAY})`);
  }

  return violations;
}
