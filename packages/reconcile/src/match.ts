// The matcher. Deterministic, no model, no network — two lists in, a set of
// verdicts out.
//
// ⛔ The rule the whole file is built around: WHEN IN DOUBT, REFUSE. An
// ambiguous pairing reported as a match is worse than no match at all, because
// the difference it was hiding is now off the list and nobody will look at it
// again. Every path here that cannot tell which of two candidates is the right
// one produces `ambiguous` and stops.

import type { ReconType } from "./catalogue.ts";

export interface ReconItem {
  id: string;
  side: "ours" | "theirs";
  sourceKey: string;
  reference: string | null;
  /** Integer minor units. */
  amountCents: number;
  occurredOn: Date | null;
  description?: string | null;
}

export type MatchStatus = "matched" | "mismatched" | "ambiguous" | "unmatched_ours" | "unmatched_theirs";

export interface MatchResult {
  status: MatchStatus;
  strategy: string | null;
  oursIds: string[];
  theirsIds: string[];
  amountOurs: number;
  amountTheirs: number;
  deltaCents: number;
  note?: string;
}

const DAY_MS = 86_400_000;

/** Case, spacing and punctuation are noise in a payment reference. */
export function normaliseReference(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  const cleaned = ref.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === 0 ? null : cleaned;
}

function daysApart(a: Date | null, b: Date | null): number | null {
  if (a === null || b === null) return null;
  return Math.abs(a.getTime() - b.getTime()) / DAY_MS;
}

function sum(items: ReconItem[]): number {
  return items.reduce((acc, i) => acc + i.amountCents, 0);
}

export function matchItems(type: ReconType, ours: ReconItem[], theirs: ReconItem[]): MatchResult[] {
  // Stable order in, stable order out: the same two files must reconcile the
  // same way twice, or the differences a person signed off move under them.
  const byKey = (a: ReconItem, b: ReconItem): number =>
    (a.occurredOn?.getTime() ?? 0) - (b.occurredOn?.getTime() ?? 0) || a.sourceKey.localeCompare(b.sourceKey);
  const availableOurs = [...ours].sort(byKey);
  const availableTheirs = [...theirs].sort(byKey);
  const usedOurs = new Set<string>();
  const usedTheirs = new Set<string>();
  const results: MatchResult[] = [];

  const freeOurs = (): ReconItem[] => availableOurs.filter((i) => !usedOurs.has(i.id));
  const freeTheirs = (): ReconItem[] => availableTheirs.filter((i) => !usedTheirs.has(i.id));

  const pair = (o: ReconItem[], t: ReconItem[], strategy: string): void => {
    const amountOurs = sum(o);
    const amountTheirs = sum(t);
    const delta = amountTheirs - amountOurs;
    results.push({
      status: Math.abs(delta) <= type.toleranceCents ? "matched" : "mismatched",
      strategy,
      oursIds: o.map((i) => i.id),
      theirsIds: t.map((i) => i.id),
      amountOurs,
      amountTheirs,
      deltaCents: delta,
      ...(Math.abs(delta) > type.toleranceCents
        ? { note: `same ${strategy === "reference" ? "reference" : "grouping"}, amounts differ by ${delta}` }
        : {}),
    });
    o.forEach((i) => usedOurs.add(i.id));
    t.forEach((i) => usedTheirs.add(i.id));
  };

  const refuse = (o: ReconItem[], t: ReconItem[], strategy: string, note: string): void => {
    results.push({
      status: "ambiguous",
      strategy,
      oursIds: o.map((i) => i.id),
      theirsIds: t.map((i) => i.id),
      amountOurs: sum(o),
      amountTheirs: sum(t),
      deltaCents: sum(t) - sum(o),
      note,
    });
    o.forEach((i) => usedOurs.add(i.id));
    t.forEach((i) => usedTheirs.add(i.id));
  };

  for (const strategy of type.matchBy) {
    if (strategy === "reference") {
      const group = (items: ReconItem[]): Map<string, ReconItem[]> => {
        const map = new Map<string, ReconItem[]>();
        for (const item of items) {
          const ref = normaliseReference(item.reference);
          if (ref === null) continue;
          map.set(ref, [...(map.get(ref) ?? []), item]);
        }
        return map;
      };
      const o = group(freeOurs());
      const t = group(freeTheirs());
      for (const ref of [...o.keys()].sort()) {
        const mine = o.get(ref) ?? [];
        const yours = t.get(ref) ?? [];
        if (yours.length === 0) continue;
        if (mine.length === 1 && yours.length === 1) {
          pair(mine, yours, "reference");
        } else {
          // ⛔ The same reference on several lines is the single most common way
          // a reconciliation quietly goes wrong: two invoices given the same
          // number, or a customer paying twice quoting the same reference. Both
          // need a person, and a matcher that picks one is a matcher that
          // conceals the other.
          refuse(mine, yours, "reference", `reference ${ref} appears on ${mine.length} of ours and ${yours.length} of theirs`);
        }
      }
      continue;
    }

    if (strategy === "amount_date") {
      const candidatesOf = (item: ReconItem, pool: ReconItem[]): ReconItem[] =>
        pool.filter((other) => {
          if (Math.abs(other.amountCents - item.amountCents) > type.toleranceCents) return false;
          if (type.dateWindowDays === 0) return true;
          const apart = daysApart(item.occurredOn, other.occurredOn);
          // ⛔ A missing date is not "within the window". Treating null as 0 days
          // apart makes every undated line a candidate for everything.
          return apart !== null && apart <= type.dateWindowDays;
        });

      // Only MUTUALLY unique pairs. Two £150 invoices and one £150 payment must
      // not resolve to whichever invoice happened to sort first.
      const mine = freeOurs();
      const yours = freeTheirs();
      for (const o of mine) {
        if (usedOurs.has(o.id)) continue;
        const forward = candidatesOf(o, yours.filter((y) => !usedTheirs.has(y.id)));
        if (forward.length !== 1) continue;
        const t = forward[0]!;
        const back = candidatesOf(t, mine.filter((m) => !usedOurs.has(m.id)));
        if (back.length !== 1 || back[0]!.id !== o.id) continue;
        pair([o], [t], "amount_date");
      }
      continue;
    }

    // sum_to_one — one of theirs against the natural GROUP of ours behind it.
    //
    // ⛔ There is deliberately no subset search. Over a couple of hundred lines
    // some subset almost always sums to the payout by coincidence, and a
    // coincidence presented as a reconciliation is the worst output this family
    // can produce. Only the natural grouping is tried: everything of ours
    // inside the settlement window.
    for (const t of freeTheirs()) {
      if (t.occurredOn === null) continue;
      const window = freeOurs().filter((o) => {
        if (o.occurredOn === null) return false;
        const lag = (t.occurredOn!.getTime() - o.occurredOn.getTime()) / DAY_MS;
        return lag >= 0 && lag <= type.dateWindowDays;
      });
      if (window.length === 0 || window.length > type.sumMax) continue;
      if (Math.abs(sum(window) - t.amountCents) > type.toleranceCents) continue;
      pair(window, [t], "sum_to_one");
    }
  }

  for (const o of freeOurs()) {
    results.push({
      status: "unmatched_ours", strategy: null, oursIds: [o.id], theirsIds: [],
      amountOurs: o.amountCents, amountTheirs: 0, deltaCents: -o.amountCents,
    });
  }
  for (const t of freeTheirs()) {
    results.push({
      status: "unmatched_theirs", strategy: null, oursIds: [], theirsIds: [t.id],
      amountOurs: 0, amountTheirs: t.amountCents, deltaCents: t.amountCents,
    });
  }
  return results;
}
