// ⛔ The console's read model, tested against the two failures it was built to
// stop: a job that fails forever while looking fresh, and a board that renders
// calm because its queries threw.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  FAMILIES, applicableFamilies, configuredCounts, customerBoard, jobBoard,
  pruneJobRuns, recentJobFailures, recordJobRun, registerJob, spendBoard, worklist,
} from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.query("DELETE FROM job_runs");
  await db.query("DELETE FROM job_heartbeats");
});

const MIN = 60_000;

describe("job heartbeats", () => {
  it("⛔ a job failing every tick never reads as healthy", async () => {
    // The defect: the scheduler stamped one timestamp in a `finally` block, so
    // a job failing on every tick had a last-run time as fresh as a job that
    // was working. Health must come from last SUCCESS and nothing else.
    const t0 = new Date("2026-03-01T00:00:00Z");
    await registerJob(db, "clocks_and_journeys", 5 * MIN);
    await recordJobRun(db, {
      name: "clocks_and_journeys", intervalMs: 5 * MIN, ok: true,
      startedAt: t0, durationMs: 120,
    });

    // Now it starts failing, and keeps failing, on schedule.
    for (let i = 1; i <= 6; i++) {
      await recordJobRun(db, {
        name: "clocks_and_journeys", intervalMs: 5 * MIN, ok: false,
        startedAt: new Date(t0.getTime() + i * 5 * MIN), durationMs: 30, error: "connection refused",
      });
    }

    const now = new Date(t0.getTime() + 31 * MIN);
    const board = await jobBoard(db, now);
    const job = board.find((j) => j.name === "clocks_and_journeys")!;

    expect(job.state).toBe("failing");
    // ⛔ The run clock moved. The success clock did not. That gap IS the bug.
    expect(job.lastRunAt!.getTime()).toBe(t0.getTime() + 30 * MIN);
    expect(job.lastSuccessAt!.getTime()).toBe(t0.getTime());
    expect(job.consecutiveFailures).toBe(6);
    expect(job.lastError).toBe("connection refused");
    expect(job.cadencesLate).toBe(6);
  });

  it("⛔ a job that has never run says so, rather than being absent", async () => {
    await registerJob(db, "market_watchers", 60 * MIN);
    const board = await jobBoard(db, new Date("2026-03-01T00:00:00Z"));
    const job = board.find((j) => j.name === "market_watchers")!;
    expect(job.state).toBe("never_run");
    expect(job.lastSuccessAt).toBeNull();
    // ⛔ Not late, because it was never due. "Never run" and "overdue" are
    // different problems with different fixes.
    expect(job.cadencesLate).toBeNull();
  });

  it("judges staleness against each job's OWN cadence", async () => {
    // A blanket timeout calls the daily job dead every morning and calls the
    // 10-second job healthy an hour after it stops — exactly backwards.
    const t0 = new Date("2026-03-01T00:00:00Z");
    await registerJob(db, "workflow_timers", 10_000);
    await registerJob(db, "documents_and_retention", 24 * 60 * MIN);
    for (const [name, interval] of [["workflow_timers", 10_000], ["documents_and_retention", 24 * 60 * MIN]] as const) {
      await recordJobRun(db, { name, intervalMs: interval, ok: true, startedAt: t0, durationMs: 10 });
    }

    const board = await jobBoard(db, new Date(t0.getTime() + 60 * MIN));
    expect(board.find((j) => j.name === "workflow_timers")!.state).toBe("stale");
    expect(board.find((j) => j.name === "documents_and_retention")!.state).toBe("ok");
  });

  it("a success clears the error and resets the streak", async () => {
    const t0 = new Date("2026-03-01T00:00:00Z");
    await registerJob(db, "dunning", MIN);
    await recordJobRun(db, { name: "dunning", intervalMs: MIN, ok: false, startedAt: t0, durationMs: 5, error: "boom" });
    await recordJobRun(db, { name: "dunning", intervalMs: MIN, ok: false, startedAt: new Date(t0.getTime() + MIN), durationMs: 5, error: "boom" });
    expect((await jobBoard(db, new Date(t0.getTime() + MIN))).find((j) => j.name === "dunning")!.state).toBe("failing");

    await recordJobRun(db, { name: "dunning", intervalMs: MIN, ok: true, startedAt: new Date(t0.getTime() + 2 * MIN), durationMs: 5 });
    const job = (await jobBoard(db, new Date(t0.getTime() + 2 * MIN))).find((j) => j.name === "dunning")!;
    expect(job.state).toBe("ok");
    expect(job.consecutiveFailures).toBe(0);
    expect(job.lastError).toBeNull();
    // ⛔ Totals are cumulative. "It is fine now" must not erase "it failed twice
    // this morning" — that history is how a flapping job is spotted at all.
    expect(job.failuresTotal).toBe(2);
    expect(job.runsTotal).toBe(3);
  });

  it("⛔ the writer never invents a cadence", async () => {
    // A run recorded for a job nobody registered used to default to a 1ms
    // interval, which painted a perfectly healthy job red on its first tick.
    const t0 = new Date("2026-03-01T00:00:00Z");
    await recordJobRun(db, { name: "unregistered", intervalMs: 10 * MIN, ok: true, startedAt: t0, durationMs: 5 });
    const job = (await jobBoard(db, new Date(t0.getTime() + MIN))).find((j) => j.name === "unregistered")!;
    expect(job.intervalMs).toBe(10 * MIN);
    expect(job.state).toBe("ok");
  });

  it("keeps failures longer than successes", async () => {
    const t0 = new Date("2026-03-01T00:00:00Z");
    await recordJobRun(db, { name: "j", intervalMs: MIN, ok: true, startedAt: t0, durationMs: 1 });
    await recordJobRun(db, { name: "j", intervalMs: MIN, ok: false, startedAt: t0, durationMs: 1, error: "e" });
    await db.query("UPDATE job_runs SET finished_at = $1", [new Date("2026-03-01T00:00:00Z")]);

    const removed = await pruneJobRuns(db, new Date("2026-03-05T00:00:00Z"));
    expect(removed).toBe(1); // the success only
    const failures = await recentJobFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toBe("e");
  });
});

describe("the worklist", () => {
  it("⛔ reports its own coverage even when everything is empty", async () => {
    // The single most important property on this screen. An empty worklist and
    // a worklist whose six queries all threw look identical to the eye; only
    // the coverage line separates "nothing to do" from "nothing is working".
    const list = await worklist(db, new Date());
    expect(list.coverage).toHaveLength(6);
    for (const c of list.coverage) {
      expect(c.ok, `${c.source} failed: ${c.error ?? ""}`).toBe(true);
      expect(typeof c.considered).toBe("number");
    }
  });

  it("ranks a safety protocol above everything else, and ages items up", async () => {
    const now = new Date("2026-03-01T12:00:00Z");
    await db.query(
      `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation, status, raised_at)
       VALUES ('budget_exceeded', 2, '{}', 'halted', 'raise the cap', 'open', $1)`,
      [new Date(now.getTime() - 3 * 3_600_000)],
    );
    const incident = await db.one<{ id: string }>(
      `INSERT INTO protocol_incidents (protocol_id, protocol_version, severity, channel, trigger_text, matched_on, interlocks, agent_response, detected_by, created_at)
       VALUES ('gas_leak', 'v1', 1, 'chat', 'smell of gas', 'gas', ARRAY['stop'], 'call 0800 111 999', 'detector', $1) RETURNING id`,
      [new Date(now.getTime() - 2 * 3_600_000)],
    );

    const list = await worklist(db, now);
    expect(list.items[0]!.source).toBe("protocol_incident");
    expect(list.items[0]!.blocking).toBe("unacknowledged safety protocol");
    expect(list.items.some((i) => i.key === `protocol_incident:${incident.id}`)).toBe(true);

    // Scoped to the row this test inserted: the database is shared across the
    // suite and picking "the first exception" would assert about somebody
    // else's fixture.
    const exception = list.items.find((i) => i.title === "budget exceeded")!;
    // 3 hours old, under the 24h escalation window, so it keeps its severity.
    expect(exception.severity).toBe(2);

    const coverage = list.coverage.find((c) => c.source === "exception")!;
    expect(coverage.waiting).toBeGreaterThanOrEqual(1);
    // ⛔ The denominator is never smaller than the numerator. A coverage line
    // claiming "3 waiting out of 1 considered" is the shape of a board that has
    // silently stopped counting what it says it counts.
    expect(coverage.considered).toBeGreaterThanOrEqual(coverage.waiting);

    // ⛔ Acknowledged rather than deleted: `protocol_incidents` is append-only
    // by trigger, which is correct — a destroyed safety incident is exactly the
    // record a regulator would ask for. So the test leaves the row and clears
    // it the way an operator would.
    await db.query("UPDATE protocol_incidents SET acknowledged_at = now(), acknowledged_by = 'test' WHERE id = $1", [incident.id]);
    await db.query("UPDATE exceptions SET status = 'resolved', resolved_at = now() WHERE trigger = 'budget_exceeded'");

    const after = await worklist(db, now);
    expect(after.items.some((i) => i.key === `protocol_incident:${incident.id}`)).toBe(false);
  });
});

describe("the customer board", () => {
  it("⛔ the cell's denominator comes from config, and verticals really differ", async () => {
    // Measured, not assumed: at FAMILY granularity every known trade uses all
    // fourteen, so a board that only said applicable/not-applicable would be
    // fourteen identical ticks on every row and would carry no information.
    // What actually differs is how many of each a vertical defines.
    expect(applicableFamilies("plumber").size).toBe(FAMILIES.length);
    expect(applicableFamilies("solicitor").size).toBe(FAMILIES.length);

    const plumber = configuredCounts("plumber");
    const dentist = configuredCounts("dentist");
    expect(plumber["clocks"]).toBeGreaterThan(0);
    expect(dentist["clocks"]).toBeGreaterThan(0);
    expect(dentist["clocks"], "dentist and plumber define the same clocks").not.toBe(plumber["clocks"]);
    // Families that are not vertical-selected have no denominator at all, and
    // must say so with null rather than a misleading 0.
    expect(plumber["knowledge"]).toBeNull();
    expect(plumber["calls"]).toBeNull();
  });

  it("⛔ an unresolvable vertical gets zero, never the default archetype's set", async () => {
    // The failure this guards: a vertical nobody could classify quietly
    // inheriting some other trade's clocks and journeys, and then firing them
    // at that customer's contacts.
    const counts = configuredCounts("not-a-real-trade-at-all");
    expect(counts["clocks"]).toBe(0);
    expect(counts["journeys"]).toBe(0);
    expect(counts["watches"]).toBe(0);
    expect(applicableFamilies("not-a-real-trade-at-all").has("clocks")).toBe(false);
  });

  it("⛔ a customer with no vertical is the loudest row, not the quietest", async () => {
    // `businesses.vertical` is written in exactly one place and left NULL when
    // the Architect escalates. Such a customer silently gets no case types, no
    // clocks, no journeys and no channels. On a board that painted them all
    // "not applicable" they would look like the healthiest customer there.
    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
    const biz = await db.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
       VALUES ('d',$1,'Nobody Ltd','GB','R2','no_site') RETURNING id`, [batch.id]);
    await db.query(
      `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status, vertical)
       VALUES ($1,'R2','Nobody Ltd','a@b.example','en-GB','Europe/London','active', NULL)`, [biz.id]);

    const board = await customerBoard(db, new Date());
    const row = board.rows.find((r) => r.legalName === "Nobody Ltd")!;
    expect(row.vertical).toBeNull();
    expect(board.unresolvedVerticals).toBeGreaterThanOrEqual(1);
    for (const f of FAMILIES) expect(row.cells[f.id]!.state).toBe("unknown");
    // ⛔ Sorted to the top, because fourteen unknown cells is the worst state a
    // customer row can be in. Asserted as the ordering property rather than as
    // "row 0 is mine" — the suite shares a database and another test's customer
    // may legitimately tie on attention count.
    expect(row.attentionCount).toBe(FAMILIES.length);
    const counts = board.rows.map((r) => r.attentionCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(board.rows[0]!.attentionCount).toBe(FAMILIES.length);

    await db.query("DELETE FROM customers WHERE business_id = $1", [biz.id]);
    await db.query("DELETE FROM businesses WHERE id = $1", [biz.id]);
  });

  it("reports the total, not just the page", async () => {
    const board = await customerBoard(db, new Date(), 1);
    expect(board.rows.length).toBeLessThanOrEqual(1);
    expect(board.totalCustomers).toBeGreaterThanOrEqual(board.rows.length);
  });
});

describe("money in flight", () => {
  it("⛔ distinguishes no spend from no rows, and never reports a zero cap", async () => {
    const board = await spendBoard(db, new Date());
    expect(board.gatewayToday.rows).toBeGreaterThanOrEqual(0);
    expect(board.gatewayToday.capCents).toBeGreaterThan(0);
    // A null cap means "no ceiling configured". Zero would read as "no budget
    // left" and is never correct here.
    expect(board.gatewayMonth.capCents).toBeNull();
    expect(board.gatewayToday.source).toContain("gateway.completed");
    expect(board.gatewayToday.window).toBeTruthy();
  });
});
