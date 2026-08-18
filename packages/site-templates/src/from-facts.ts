// Turning what the knowledge base extracted into what the page publishes.
//
// ⛔ WHY THIS EXISTS. `renderSite` has accepted a `machine` input since the
// machine surface was built, and its own comment says supplying it "upgrades the
// page from 'has schema' to 'is transactable'" while omitting it "falls back to
// the bare LocalBusiness node, which is what the market already has and what the
// Reviewer's machine-surface gates will flag". Both callers omitted it. Every
// preview and every paid build shipped the fallback — the exact thing the
// product is sold as fixing — while a knowledge base full of the business's own
// published services, hours and coverage sat in the database unused.
//
// The type here is structural rather than an import of `@adw/kb`, so this
// package keeps its three dependencies and the mapping stays testable with
// literals instead of a database.

import { mayPublish } from "@adw/kb";
import type { MachineSurfaceInput, ServiceOffering } from "./machine-surface.ts";

// Re-exported so a caller building a page does not need a second import for the
// one rule that decides what goes on it.
export { mayPublish };

/** A knowledge-base fact, narrowed to what the page needs. */
export interface PublishedFact {
  type: string;
  value: string;
  /** `verified` | `claimed_unverified` | `stale` | `inferred`. */
  status: string;
}

export interface FactSurfaceBase {
  name: string;
  category: string;
  city: string;
  phone: string;
  url?: string;
  rating?: number;
  reviewCount?: number;
  schemaType?: string;
}

/** Days as schema.org spells them, for parsing an hours fact like "Mon-Fri 8-5". */
const DAYS: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/**
 * A published price, or nothing.
 *
 * ⛔ Absent is the correct rendering for a business that does not publish
 * prices. An invented `Offer` is a claim we made on their behalf, and it is the
 * claim a customer would be held to.
 */
function priceFrom(value: string): { priceCents: number; currency: string } | { priceNote: string } | null {
  const money = /(?:[£$€])\s?(\d{1,6}(?:\.\d{2})?)/.exec(value);
  if (money?.[1] !== undefined) {
    const symbol = value.includes("£") ? "GBP" : value.includes("€") ? "EUR" : "USD";
    return { priceCents: Math.round(Number(money[1]) * 100), currency: symbol };
  }
  // "from £X", "call for a quote", "free estimates" — a quoting convention, not
  // a figure. Publishing it as prose is honest; publishing it as an Offer is not.
  if (/quote|estimate|varies|per hour|hourly|call/i.test(value)) return { priceNote: value.trim().slice(0, 120) };
  return null;
}

function parseHours(value: string): { dayOfWeek: string[]; opens: string; closes: string } | null {
  const m = /([a-z]{3})\s*(?:-|to|–)\s*([a-z]{3})[^\d]*(\d{1,2})(?::(\d{2}))?\s*(?:-|to|–)\s*(\d{1,2})(?::(\d{2}))?/i.exec(value);
  if (!m) return null;
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const from = order.indexOf((m[1] ?? "").toLowerCase());
  const to = order.indexOf((m[2] ?? "").toLowerCase());
  if (from < 0 || to < 0 || to < from) return null;
  const pad = (h: string, min: string | undefined): string => `${h.padStart(2, "0")}:${min ?? "00"}`;
  // A trades listing writing "8-5" means 08:00–17:00, not 08:00–05:00.
  const closeHour = Number(m[5]);
  const close = closeHour < 8 ? String(closeHour + 12) : (m[5] ?? "");
  return {
    dayOfWeek: order.slice(from, to + 1).map((d) => DAYS[d]!),
    opens: pad(m[3] ?? "", m[4]),
    closes: pad(close, m[6]),
  };
}

/**
 * Build the machine surface from published facts.
 *
 * ⛔ Credentials are included only when the fact is `verified`. A
 * `claimed_unverified` certification is the business's own assertion, and
 * repeating it in structured data is us asserting it — the most damaging false
 * claim in this market and the one that creates a regulatory problem for the
 * customer we are supposed to be helping.
 */
export function machineSurfaceFromFacts(base: FactSurfaceBase, facts: PublishedFact[]): MachineSurfaceInput {
  const services: ServiceOffering[] = [];
  const hours: { dayOfWeek: string[]; opens: string; closes: string }[] = [];
  const areaServed: string[] = [];
  const verifiedCredentials: string[] = [];
  // Prices are matched to services by position: the extractor emits them in the
  // order it found them, and a price with no service to attach to is dropped
  // rather than attached to the wrong one.
  const prices: (ReturnType<typeof priceFrom>)[] = [];

  for (const fact of facts) {
    const value = fact.value.trim();
    if (value === "" || !mayPublish(fact)) continue;
    switch (fact.type) {
      case "service":
        services.push({ name: value.slice(0, 80), description: value });
        break;
      case "price":
        prices.push(priceFrom(value));
        break;
      case "hours": {
        const parsed = parseHours(value);
        if (parsed) hours.push(parsed);
        break;
      }
      case "area":
        areaServed.push(value);
        break;
      case "credential":
        // `mayPublish` already required `verified` above.
        verifiedCredentials.push(value);
        break;
      default:
        break;
    }
  }

  for (let i = 0; i < services.length && i < prices.length; i++) {
    const price = prices[i];
    if (price === null || price === undefined) continue;
    services[i] = { ...services[i]!, ...price };
  }

  return {
    name: base.name,
    category: base.category,
    city: base.city,
    phone: base.phone,
    services,
    ...(base.url === undefined ? {} : { url: base.url }),
    ...(base.rating === undefined ? {} : { rating: base.rating }),
    ...(base.reviewCount === undefined ? {} : { reviewCount: base.reviewCount }),
    ...(base.schemaType === undefined ? {} : { schemaType: base.schemaType }),
    ...(hours.length === 0 ? {} : { hours }),
    ...(areaServed.length === 0 ? {} : { areaServed }),
    ...(verifiedCredentials.length === 0 ? {} : { verifiedCredentials }),
  };
}

/**
 * Service names for the human copy slots, from what the business published.
 *
 * ⛔ Returns an empty list rather than a guess. The caller used to substitute a
 * three-entry lookup table keyed on category — every roofer in the database got
 * "Roof repair, Roof replacement, Inspections" whether or not they do any of
 * them, and every business outside the three known categories got
 * "Consultations, Installation, Maintenance". A page describing services a
 * business does not offer is a page they cannot approve.
 */
export function serviceNamesFromFacts(facts: PublishedFact[], limit = 3): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const fact of facts) {
    if (fact.type !== "service" || !mayPublish(fact)) continue;
    const name = fact.value.trim().slice(0, 60);
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}
