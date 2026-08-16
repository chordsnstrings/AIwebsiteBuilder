// Where the values come from.
//
// A collector is the seam between "we watch reviews" and any particular
// vendor's review API. Every collector is injected, so the runner never learns
// anything source-specific and demo mode is the same code path with a different
// map — the pattern the Sentinel already uses for vendor probes.
//
// ⛔ These fetch URLs the OWNER supplied. That is a server-side request forgery
// primitive unless it is fenced: a subscription pointed at 169.254.169.254 or
// http://localhost:5433 would have this process read the cloud metadata service
// or the database on the owner's behalf. `assertPublicUrl` is not optional
// politeness; it is the reason this package may take a URL at all.

import { createHash } from "node:crypto";
import type { Collector, CollectorResult, Collectors } from "./run.ts";

export interface MinimalResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<MinimalResponse>;

const PRIVATE_HOSTS = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1|\[::1\]|172\.(1[6-9]|2\d|3[01])\.)/i;
const PRIVATE_SUFFIX = /\.(local|internal|localdomain)$/i;

export class UnsafeWatchUrlError extends Error {}

/** ⛔ http(s) only, public host only. Refuses rather than warns. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWatchUrlError(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeWatchUrlError(`refusing ${url.protocol} — only http and https`);
  }
  const host = url.hostname;
  if (PRIVATE_HOSTS.test(host) || PRIVATE_SUFFIX.test(host) || !host.includes(".")) {
    throw new UnsafeWatchUrlError(`refusing a non-public host: ${host}`);
  }
  return url;
}

function urlFrom(params: Record<string, unknown>, subject: string): string {
  const fromParams = params["url"];
  return typeof fromParams === "string" && fromParams.length > 0 ? fromParams : subject;
}

/** JSON over HTTP. The body IS the value; nothing is interpreted here. */
export function httpJsonCollector(fetchImpl: FetchLike): Collector {
  return async ({ subject, params }): Promise<CollectorResult> => {
    let url: URL;
    try {
      url = assertPublicUrl(urlFrom(params, subject));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const res = await fetchImpl(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, error: "response was not JSON" };
    }
  };
}

/**
 * A page's readable text.
 *
 * ⛔ Scripts, styles and comments are stripped and whitespace collapsed BEFORE
 * hashing. Without that, a page carrying a cache-buster or a rendered timestamp
 * differs on every fetch, so an `any_change` watch on a competitor's price list
 * reports a change every single time and the owner stops reading the board.
 */
export function webPageCollector(fetchImpl: FetchLike): Collector {
  return async ({ subject, params }): Promise<CollectorResult> => {
    let url: URL;
    try {
      url = assertPublicUrl(urlFrom(params, subject));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const res = await fetchImpl(url.toString(), { headers: { accept: "text/html" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, value: { text: readableText(await res.text()) } };
  };
}

export function readableText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is the site up.
 *
 * ⛔ `up: 1|0`, not a latency number. The watch rule is a drop of 1, so a slow
 * response is not an outage — a threshold on latency would page the owner every
 * time their host had a bad afternoon.
 */
export function uptimeCollector(fetchImpl: FetchLike): Collector {
  return async ({ subject, params }): Promise<CollectorResult> => {
    let url: URL;
    try {
      url = assertPublicUrl(urlFrom(params, subject));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const res = await fetchImpl(url.toString(), { method: "GET" });
      return { ok: true, value: { up: res.ok ? 1 : 0, status: res.status } };
    } catch (err) {
      // ⛔ A network error is a successful OBSERVATION of a site that is down,
      // not a failed observation. Recording it as a collector failure would
      // leave `last_ok_at` stale and report the watch as broken rather than
      // reporting the outage it just found.
      return { ok: true, value: { up: 0, status: 0, error: err instanceof Error ? err.message : String(err) } };
    }
  };
}

/**
 * Real collectors, for the sources that are plain HTTP once a key exists.
 * Sources with no real adapter yet are simply absent from the map, and
 * `subscribeWatch` refuses them — an honest 400 rather than a subscription that
 * never runs.
 */
export function httpCollectors(fetchImpl: FetchLike): Collectors {
  const json = httpJsonCollector(fetchImpl);
  return {
    feed: json,
    index: json,
    register: json,
    reviews: json,
    listing: json,
    serp: json,
    marketplace: json,
    weather: json,
    web_page: webPageCollector(fetchImpl),
    uptime: uptimeCollector(fetchImpl),
  };
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

function seed(...parts: (string | number)[]): number {
  const hex = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

/**
 * Deterministic simulated sources, keyed on the subject and the day.
 *
 * ⛔ Deliberately boring. The temptation with a demo collector is to make it
 * produce a dramatic finding on every run so the board looks alive; that
 * teaches whoever is evaluating this that findings are cheap, and hides the one
 * property that matters — that a stable world produces no findings at all.
 * Values here move on a daily boundary and not otherwise.
 */
export function simulatedCollectors(clock: () => Date = () => new Date()): Collectors {
  const day = (): number => Math.floor(clock().getTime() / 86_400_000);

  const reviews: Collector = async ({ subject }) => {
    const d = day();
    const count = 3 + Math.floor(seed(subject, d) * 3);
    return {
      ok: true,
      value: {
        rating: Number((4.2 + seed(subject, d, "r") * 0.6).toFixed(1)),
        items: Array.from({ length: count }, (_, i) => ({ id: `rev-${d}-${i}`, stars: 4 + (i % 2) })),
      },
    };
  };
  const listing: Collector = async ({ subject }) => ({
    ok: true,
    value: { name: subject, hours: "Mon-Fri 08:00-17:00", phone: "+44 20 7946 0000" },
  });
  const serp: Collector = async ({ subject }) => ({
    ok: true, value: { position: 3 + Math.floor(seed(subject, day(), "p") * 4) },
  });
  const feed: Collector = async ({ subject }) => {
    const d = day();
    return { ok: true, value: { items: [{ id: `${subject}-${d - 1}` }, { id: `${subject}-${d}` }] } };
  };
  const index: Collector = async ({ subject }) => ({
    ok: true,
    value: { index: Number((100 + seed(subject, day(), "i") * 8).toFixed(2)), items: [{ id: `${subject}-${day()}` }] },
  });
  const register: Collector = async ({ subject }) => ({
    ok: true, value: { status: "active", rating: 5, items: [{ id: `${subject}-inspection` }] },
  });
  const weather: Collector = async ({ subject }) => ({
    ok: true, value: { summary: seed(subject, day(), "w") > 0.85 ? "storm expected" : "settled" },
  });
  const marketplace: Collector = async ({ subject }) => ({
    ok: true, value: { position: 1 + Math.floor(seed(subject, day(), "m") * 5), inStock: true },
  });
  const webPage: Collector = async ({ subject }) => ({
    ok: true, value: { text: `Prices as published ${new Date(day() * 86_400_000).toISOString().slice(0, 10)} for ${subject}` },
  });
  const uptime: Collector = async () => ({ ok: true, value: { up: 1, status: 200 } });

  return { reviews, listing, serp, feed, index, register, weather, marketplace, web_page: webPage, uptime };
}
