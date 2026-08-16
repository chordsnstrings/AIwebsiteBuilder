// Kill switches (spec §5.4). Read on every gate evaluation, cached ≤10s.
// Five independently-effective switches, each engaged within 60s.
import type { Db } from "@adw/db";
import type { ChannelKind, MessageClass } from "@adw/compliance";

export const KILL_SWITCHES = [
  "HALT_ALL_SENDING",
  "HALT_COLD_ONLY",
  "HALT_BUILDS",
  "HALT_PAYMENTS_ONBOARDING",
] as const;
export type KillSwitchName = (typeof KILL_SWITCHES)[number] | `HALT_AGENT:${string}`;

interface CacheEntry {
  engaged: Set<string>;
  at: number;
}
let cache: CacheEntry | null = null;
const TTL_MS = 10_000;

export async function readEngagedSwitches(db: Db, now: number = Date.now()): Promise<Set<string>> {
  if (cache && now - cache.at < TTL_MS) return cache.engaged;
  const rows = await db.query<{ name: string }>("SELECT name FROM kill_switches WHERE engaged = TRUE");
  const engaged = new Set(rows.rows.map((r) => r.name));
  cache = { engaged, at: now };
  return engaged;
}

export function clearKillSwitchCache(): void {
  cache = null;
}

/**
 * ⛔ THE THREE SWITCHES NOTHING READ.
 *
 * `HALT_BUILDS`, `HALT_PAYMENTS_ONBOARDING` and `HALT_AGENT:<role>` were
 * settable from the console, stored, displayed as engaged, and read by
 * absolutely nothing that halted. An operator pulling one during an incident
 * would have watched the board turn red and the builds carry on — which is
 * worse than having no switch at all, because a switch that appears to work
 * stops anyone looking for the real off button.
 *
 * The readers below are consumed at the three chokepoints: the gateway (every
 * model call), the build activities, and payments onboarding.
 */

/** Halts every build and every deploy. Runbook R6: malicious content found. */
export function buildsHalted(engaged: Set<string>): boolean {
  return engaged.has("HALT_BUILDS");
}

/** Halts new merchant onboarding. Runbook R12: charge_type anomaly. */
export function paymentsOnboardingHalted(engaged: Set<string>): boolean {
  return engaged.has("HALT_PAYMENTS_ONBOARDING");
}

/**
 * Halts ONE agent role. Runbook R5: a canary fired, quarantine the role for 24
 * hours.
 *
 * ⛔ Exact-match on the role, never a prefix. `HALT_AGENT:developer` must not
 * silence `developer_review` as well — an incident response that halts more
 * than the operator asked for makes the next operator hesitate to use it.
 */
export function agentHalted(engaged: Set<string>, role: string): boolean {
  return engaged.has(`HALT_AGENT:${role}`);
}

/** Does any engaged kill switch halt a send on this channel/class? */
export function sendingHalted(
  engaged: Set<string>,
  channel: ChannelKind,
  messageClass: MessageClass,
): boolean {
  if (engaged.has("HALT_ALL_SENDING")) return true;
  if (engaged.has("HALT_COLD_ONLY") && messageClass !== "transactional") return true;
  void channel;
  return false;
}

export async function engageKillSwitch(db: Db, name: KillSwitchName, actor: string): Promise<void> {
  await db.query(
    `INSERT INTO kill_switches (name, engaged, toggled_by, toggled_at)
     VALUES ($1, TRUE, $2, now())
     ON CONFLICT (name) DO UPDATE SET engaged = TRUE, toggled_by = $2, toggled_at = now()`,
    [name, actor],
  );
  clearKillSwitchCache();
}

export async function releaseKillSwitch(db: Db, name: KillSwitchName, actor: string): Promise<void> {
  await db.query(
    `INSERT INTO kill_switches (name, engaged, toggled_by, toggled_at)
     VALUES ($1, FALSE, $2, now())
     ON CONFLICT (name) DO UPDATE SET engaged = FALSE, toggled_by = $2, toggled_at = now()`,
    [name, actor],
  );
  clearKillSwitchCache();
}
