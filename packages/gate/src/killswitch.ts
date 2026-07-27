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
