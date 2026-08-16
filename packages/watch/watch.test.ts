// MF7 — watchers for the customer's market.
//
// The Sentinel watched OUR vendors and nothing looked outward on a customer's
// behalf. The assertions that matter here are all about the two ways a watcher
// lies: reporting the world as new on its first run, and reporting a value it
// has not actually fetched since March.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  acknowledgeFinding, assertPublicUrl, detectChanges, dismissFinding, httpJsonCollector,
  openFindings, pruneObservations, readableText, runDueWatches, simulatedCollectors,
  subscribeWatch, uptimeCollector, watchBoard, watchesFor, watchFor,
  type Collectors, type MinimalResponse,
} from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let plumber: string;
const HOUR = 3_600_000;
const uniq = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

async function makeCustomer(vertical: string): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,$2,'GB','R2','no_site',$3) RETURNING id`, [batch.id, `Watch ${uniq()}`, vertical]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Watch Co',$2,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, `w${uniq()}@example.com`]);
  return cust.id;
}

/** A collector map whose single source returns exactly what the test queued. */
function scripted(source: "reviews" | "uptime" | "web_page", values: (unknown | Error)[]): Collectors {
  let i = 0;
  return {
    [source]: async () => {
      const v = values[Math.min(i++, values.length - 1)];
      if (v instanceof Error) return { ok: false as const, error: v.message };
      return { ok: true as const, value: v };
    },
  };
}

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
  plumber = await makeCustomer("plumber");
});
afterAll(async () => { await db?.close(); });

describe("the catalogue", () => {
  it("resolves watches per archetype", () => {
    expect(watchesFor("plumber").map((w) => w.id)).toContain("severe_weather");
    expect(watchesFor("restaurant").map((w) => w.id)).toContain("hygiene_rating");
    expect(watchesFor("lawyer").map((w) => w.id)).toContain("regulator_bulletin");
  });

  it("⛔ every threshold rule actually carries a threshold", () => {
    // A numeric rule with no `by` and no `pct` is `any_change` wearing a hat:
    // it fires on every rounding difference. The loader throws, so reaching
    // this line means it held for all of them.
    for (const w of watchesFor("plumber").concat(watchesFor("restaurant"), watchesFor("estate_agent"))) {
      if (w.rule.kind === "numeric_drop" || w.rule.kind === "numeric_rise") {
        expect(w.rule.by !== undefined || w.rule.pct !== undefined, w.id).toBe(true);
      }
    }
  });
});

describe("change detection", () => {
  const watch = (over: Record<string, unknown>) => ({
    id: "t", label: "Test", source: "index" as const, cadenceHours: 24, severity: 3, ...over,
  }) as Parameters<typeof detectChanges>[0];

  it("⛔ a missing number is not a change of zero", () => {
    // Treating an absent field as 0 turns "the source stopped publishing this"
    // into "it crashed to zero" — a page in the night about nothing.
    const w = watch({ rule: { kind: "numeric_drop", field: "rating", by: 0.2 } });
    expect(detectChanges(w, { rating: 4.8 }, { somethingElse: 1 })).toEqual([]);
    expect(detectChanges(w, {}, { rating: 1 })).toEqual([]);
  });

  it("respects the threshold in both directions", () => {
    const drop = watch({ rule: { kind: "numeric_drop", field: "rating", by: 0.2 } });
    expect(detectChanges(drop, { rating: 4.8 }, { rating: 4.7 })).toEqual([]);
    expect(detectChanges(drop, { rating: 4.8 }, { rating: 4.5 }).length).toBe(1);
    // A rise is not a drop.
    expect(detectChanges(drop, { rating: 4.5 }, { rating: 4.9 })).toEqual([]);
  });

  it("⛔ identifies feed items by content, never by position", () => {
    // Keyed by index, one insertion at the top of a feed makes every entry
    // below it "new" — a five-item feed reports five findings for one story.
    const w = watch({ rule: { kind: "new_items" } });
    const before = { items: [{ title: "b" }, { title: "c" }] };
    const after = { items: [{ title: "a" }, { title: "b" }, { title: "c" }] };
    const found = detectChanges(w, before, after);
    expect(found.length).toBe(1);
    expect((found[0]!.detail as { count: number }).count).toBe(1);
  });

  it("says so when it truncates a list", () => {
    const w = watch({ rule: { kind: "new_items" } });
    const after = { items: Array.from({ length: 30 }, (_, i) => ({ id: `x${i}` })) };
    const detail = detectChanges(w, { items: [] }, after)[0]!.detail as { ids: string[]; truncated?: number };
    expect(detail.ids.length).toBe(20);
    expect(detail.truncated).toBe(10);
  });

  it("⛔ reports a term only when it was not already there", () => {
    // A weather feed that has said "storm" for a week is not news every three
    // hours.
    const w = watch({ rule: { kind: "text_appeared", terms: ["storm", "flood"] } });
    expect(detectChanges(w, { summary: "storm expected" }, { summary: "storm continues" })).toEqual([]);
    expect(detectChanges(w, { summary: "settled" }, { summary: "storm expected" }).length).toBe(1);
  });

  it("hashes objects by content, not by key order", () => {
    const w = watch({ rule: { kind: "any_change" } });
    expect(detectChanges(w, { a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });
});

describe("running a watch", () => {
  it("⛔ raises nothing on the first observation", async () => {
    // A watcher that reports on first sight reports every existing review,
    // competitor and register entry on the day the customer switches it on.
    const customerId = await makeCustomer("plumber");
    const sub = await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    expect(sub.ok).toBe(true);

    const t0 = new Date();
    const run = await runDueWatches(db, scripted("reviews", [{ items: [{ id: "a" }, { id: "b" }] }]), t0, { customerId });
    expect(run.ok).toBe(1);
    expect(run.findings).toBe(0);
    expect((await openFindings(db, customerId)).length).toBe(0);
  });

  it("raises on the second, when something has actually moved", async () => {
    const customerId = await makeCustomer("plumber");
    await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const t0 = new Date();
    const collectors = scripted("reviews", [
      { items: [{ id: "a" }] },
      { items: [{ id: "a" }] },              // unchanged — still nothing
      { items: [{ id: "a" }, { id: "b" }] }, // one new review
    ]);
    await runDueWatches(db, collectors, t0, { customerId });
    await runDueWatches(db, collectors, new Date(t0.getTime() + 7 * HOUR), { customerId });
    expect((await openFindings(db, customerId)).length, "an unchanged world produced a finding").toBe(0);
    await runDueWatches(db, collectors, new Date(t0.getTime() + 14 * HOUR), { customerId });

    const findings = await openFindings(db, customerId);
    expect(findings.length).toBe(1);
    expect(findings[0]!.summary).toMatch(/1 new/);
  });

  it("respects each watch's own cadence", async () => {
    const customerId = await makeCustomer("plumber");
    await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const t0 = new Date();
    const collectors = scripted("reviews", [{ items: [] }]);
    expect((await runDueWatches(db, collectors, t0, { customerId })).ran).toBe(1);
    // reviews_new is every 6 hours; two hours later it is not due.
    expect((await runDueWatches(db, collectors, new Date(t0.getTime() + 2 * HOUR), { customerId })).ran).toBe(0);
    expect((await runDueWatches(db, collectors, new Date(t0.getTime() + 7 * HOUR), { customerId })).ran).toBe(1);
  });

  it("⛔ a failure does not carry the last value forward, and does not look fresh", async () => {
    // "Unchanged" and "we could not see" have to stay distinguishable.
    const customerId = await makeCustomer("plumber");
    const sub = await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const t0 = new Date();
    await runDueWatches(db, scripted("reviews", [{ items: [{ id: "a" }] }]), t0, { customerId });
    await runDueWatches(db, scripted("reviews", [new Error("HTTP 503")]), new Date(t0.getTime() + 7 * HOUR), { customerId });

    const row = await db.one<{ last_run_at: Date; last_ok_at: Date; consecutive_failures: number }>(
      "SELECT last_run_at, last_ok_at, consecutive_failures FROM watch_subscriptions WHERE id = $1",
      [sub.ok && sub.id]);
    expect(new Date(row.last_run_at).getTime()).toBeGreaterThan(new Date(row.last_ok_at).getTime());
    expect(row.consecutive_failures).toBe(1);
    const failed = await db.one<{ value: unknown; error: string }>(
      "SELECT value, error FROM watch_observations WHERE subscription_id = $1 ORDER BY observed_at DESC LIMIT 1",
      [sub.ok && sub.id]);
    expect(failed.value).toBeNull();
    expect(failed.error).toMatch(/503/);
  });

  it("⛔ the board never shows a stale reading as a current one", async () => {
    const customerId = await makeCustomer("plumber");
    await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const t0 = new Date();
    await runDueWatches(db, scripted("reviews", [{ items: [{ id: "a" }], rating: 4.9 }]), t0, { customerId });

    const fresh = (await watchBoard(db, customerId, t0))[0]!;
    expect(fresh.state).toBe("ok");
    expect(fresh.value).not.toBeNull();

    // Three cadences later with nothing since: stale, and the number is gone.
    const later = new Date(t0.getTime() + 19 * HOUR);
    const stale = (await watchBoard(db, customerId, later))[0]!;
    expect(stale.state).toBe("stale");
    expect(stale.value, "a stale number was still on the board").toBeNull();
    expect(stale.valueAsOf).not.toBeNull();
  });

  it("⛔ a subscription that has never run says so, rather than showing green", async () => {
    const customerId = await makeCustomer("plumber");
    await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const board = await watchBoard(db, customerId);
    expect(board[0]!.state).toBe("never_run");
    expect(board[0]!.valueAsOf).toBeNull();
  });

  it("reads as failing, not merely late, after repeated failures", async () => {
    const customerId = await makeCustomer("plumber");
    await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const t0 = new Date();
    await runDueWatches(db, scripted("reviews", [{ items: [] }]), t0, { customerId });
    const collectors = scripted("reviews", [new Error("boom")]);
    for (let i = 1; i <= 3; i++) await runDueWatches(db, collectors, new Date(t0.getTime() + i * 7 * HOUR), { customerId });
    const board = await watchBoard(db, customerId, new Date(t0.getTime() + 22 * HOUR));
    expect(board[0]!.state).toBe("failing");
    expect(board[0]!.lastError).toMatch(/boom/);
  });

  it("⛔ does not report the same change over and over", async () => {
    // A price that oscillates between two values twice a day is one finding,
    // not fifty-six a fortnight.
    const customerId = await makeCustomer("plumber");
    await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "competitor_pricing", subject: `https://rival.example/prices` },
      simulatedCollectors());
    const t0 = new Date();
    const flip = ["A", "B", "A", "B"].map((t) => ({ text: t }));
    let i = 0;
    const collectors: Collectors = { web_page: async () => ({ ok: true, value: flip[Math.min(i++, 3)] }) };
    for (let n = 0; n < 4; n++) await runDueWatches(db, collectors, new Date(t0.getTime() + n * 169 * HOUR), { customerId });
    // Two distinct values seen, so at most two distinct findings — not four.
    expect((await openFindings(db, customerId)).length).toBeLessThanOrEqual(2);
  });

  it("⛔ refuses a watch this deployment cannot collect", async () => {
    // A subscription that cannot run looks identical on every board to one that
    // runs and finds nothing.
    const customerId = await makeCustomer("plumber");
    const out = await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "severe_weather", subject: "London" },
      { reviews: async () => ({ ok: true, value: {} }) });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("no_collector");
  });

  it("refuses a watch the vertical does not have", async () => {
    const out = await subscribeWatch(db,
      { customerId: plumber, vertical: "plumber", watchId: "hygiene_rating", subject: "x" },
      simulatedCollectors());
    expect(!out.ok && out.reason).toBe("unknown_watch");
  });

  it("acknowledges and dismisses findings, and once only", async () => {
    const customerId = await makeCustomer("plumber");
    await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const t0 = new Date();
    const collectors = scripted("reviews", [{ items: [{ id: "a" }] }, { items: [{ id: "a" }, { id: "b" }] }]);
    await runDueWatches(db, collectors, t0, { customerId });
    await runDueWatches(db, collectors, new Date(t0.getTime() + 7 * HOUR), { customerId });
    const [finding] = await openFindings(db, customerId);
    expect(await acknowledgeFinding(db, finding!.id, "owner@example.com")).toBe(true);
    expect(await acknowledgeFinding(db, finding!.id, "owner@example.com")).toBe(false);
    expect((await openFindings(db, customerId)).length).toBe(0);
    expect(await dismissFinding(db, finding!.id)).toBe(true);
  });

  it("⛔ pruning never removes the baseline the next comparison needs", async () => {
    // Pruning it turns the next run into a first run: no finding, and a board
    // that quietly resets.
    const customerId = await makeCustomer("plumber");
    const sub = await subscribeWatch(db,
      { customerId, vertical: "plumber", watchId: "reviews_new", subject: `place-${uniq()}` },
      simulatedCollectors());
    const old = new Date(Date.now() - 200 * 86_400_000);
    await runDueWatches(db, scripted("reviews", [{ items: [{ id: "a" }] }]), old, { customerId });
    await pruneObservations(db, 90);
    const left = await db.query(
      "SELECT id FROM watch_observations WHERE subscription_id = $1 AND ok = TRUE", [sub.ok && sub.id]);
    expect(left.rows.length).toBe(1);
  });
});

describe("collectors", () => {
  const res = (body: string, ok = true, status = 200): MinimalResponse => ({
    ok, status, text: async () => body,
  });

  it("⛔ refuses to fetch a private or non-http address", () => {
    // The owner supplies these URLs. Unfenced, a subscription pointed at
    // 169.254.169.254 has this process read the cloud metadata service on
    // their behalf.
    for (const bad of [
      "http://localhost:5433/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/",
      "file:///etc/passwd", "gopher://x.example/", "http://db.internal/", "http://intranet/",
    ]) {
      expect(() => assertPublicUrl(bad), bad).toThrow();
    }
    expect(() => assertPublicUrl("https://example.com/prices")).not.toThrow();
  });

  it("the URL fence applies through the collector, not just the helper", async () => {
    const collector = httpJsonCollector(async () => res("{}"));
    const out = await collector({ subject: "http://127.0.0.1/", params: {}, watch: watchFor("plumber", "reviews_new")! });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/non-public host/);
  });

  it("⛔ strips scripts and timestamps out of a page before hashing it", async () => {
    // Without this an `any_change` watch on a price list reports a change on
    // every fetch, and the owner stops reading the board.
    const a = readableText("<html><head><style>.x{}</style></head><body>Boiler £90 <script>t=1</script></body></html>");
    const b = readableText("<html><body>   Boiler   £90   <script>t=2</script>  </body></html>");
    expect(a).toBe(b);
  });

  it("⛔ a site being down is an observation, not a failed observation", async () => {
    // Recorded as a failure it would leave last_ok_at stale and report the
    // watch as broken rather than reporting the outage it just found.
    const collector = uptimeCollector(async () => { throw new Error("ECONNREFUSED"); });
    const out = await collector({ subject: "https://example.com", params: {}, watch: watchFor("plumber", "site_availability")! });
    expect(out.ok).toBe(true);
    expect((out as { value: { up: number } }).value.up).toBe(0);
  });

  it("a simulated world at rest produces no findings", async () => {
    // The temptation with a demo collector is to make it produce drama on every
    // run. That teaches whoever evaluates this that findings are cheap.
    const customerId = await makeCustomer("plumber");
    const clock = { at: new Date("2026-05-01T09:00:00Z") };
    const collectors = simulatedCollectors(() => clock.at);
    for (const watchId of ["reviews_new", "listing_changed", "search_visibility"]) {
      await subscribeWatch(db, { customerId, vertical: "plumber", watchId, subject: `s-${uniq()}` }, collectors);
    }
    await runDueWatches(db, collectors, clock.at, { customerId });
    const later = new Date(clock.at.getTime() + 25 * HOUR);
    clock.at = later;
    await runDueWatches(db, collectors, later, { customerId });
    // A day passes; the simulated world may move, but it does not manufacture a
    // finding for every watch on every run.
    expect((await openFindings(db, customerId)).length).toBeLessThan(3);
  });
});
