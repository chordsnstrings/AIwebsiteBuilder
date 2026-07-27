// Warm-up curve (spec §40). Deterministic per-mailbox daily cap as a function of
// days elapsed since warm-up started. A freshly provisioned mailbox sends almost
// nothing; the cap ramps in fixed bands so a new asset never spikes a provider's
// spam signal. No language model is involved — this is a lookup table.

/**
 * Daily send cap for a mailbox `daysSinceStart` days into warm-up (spec §40):
 * days 1-3 → 2, 4-7 → 5, 8-14 → 10, 15-21 → 15, 22+ → 20.
 * Day 0 (started today) is treated as day 1.
 */
export function warmupCap(daysSinceStart: number): number {
  const d = Math.floor(daysSinceStart);
  if (d <= 3) return 2;
  if (d <= 7) return 5;
  if (d <= 14) return 10;
  if (d <= 21) return 15;
  return 20;
}
