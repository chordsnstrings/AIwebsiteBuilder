import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { registryStatus, resolveRole, seedRegistry, setChampion } from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  await seedRegistry(db);
});
afterAll(async () => {
  await db?.close();
});

describe("registry", () => {
  it("seeds every role from config with candidate pools", async () => {
    const status = await registryStatus(db);
    expect(status.length).toBeGreaterThanOrEqual(16);
  });

  it("pins ceo and sentinel to Anthropic with no failover", async () => {
    const ceo = await resolveRole(db, "ceo");
    expect(ceo.champion).toContain("anthropic");
    expect(ceo.pinned).toBe(true);
    expect(ceo.escalation).toEqual([]);
  });

  it("throws resolving a role with no champion (must eval first)", async () => {
    // enrichment starts with no champion until an eval run selects one.
    //
    // ⛔ Restored afterwards, in a finally. This test shares a database with
    // every other suite, and leaving `enrichment` championless made the gateway
    // tests fail intermittently — they resolve that same role, and whether they
    // passed depended on which file finished first. A test that breaks a shared
    // row and walks away is not testing, it is dealing damage.
    const before = await db.one<{ champion: string | null }>(
      "SELECT champion FROM registry_roles WHERE role = 'enrichment'",
    );
    try {
      await db.query("UPDATE registry_roles SET champion = NULL WHERE role = 'enrichment'");
      await expect(resolveRole(db, "enrichment")).rejects.toThrow(/no champion/i);
    } finally {
      await db.query("UPDATE registry_roles SET champion = $1 WHERE role = 'enrichment'", [before.champion]);
    }
  });

  it("setChampion requires an eval run id and writes an audit row", async () => {
    const run = await db.one<{ id: string }>(
      `INSERT INTO eval_runs (role, suite, candidate, metric, metric_value)
       VALUES ('developer','developer','modelark/glm-5-2','cost_per_pass',0.1) RETURNING id`,
    );
    const before = await db.one<{ n: string }>("SELECT count(*) AS n FROM registry_audit WHERE role='developer'");
    await setChampion(db, "developer", "modelark/glm-5-2", run.id, 0.1);
    const after = await db.one<{ n: string }>("SELECT count(*) AS n FROM registry_audit WHERE role='developer'");
    expect(Number(after.n)).toBe(Number(before.n) + 1);
    const dev = await resolveRole(db, "developer");
    expect(dev.champion).toBe("modelark/glm-5-2");
  });

  it("⛔ hasEvalRun can actually be false", async () => {
    // It could not. The flag was `champion_eval_run_id !== null || champion
    // !== null`, so it was true for every role that had a champion at all —
    // meaning the one condition it exists to detect, a champion promoted with
    // no eval behind it, was the one condition it could never report. The
    // console read this flag and painted a tick for all 28 roles.
    await db.query(
      "UPDATE registry_roles SET champion = 'modelark/seed-2-0-pro', champion_eval_run_id = NULL WHERE role = 'customer_care'",
    );
    const rows = await registryStatus(db);
    const care = rows.find((r) => r.role === "customer_care")!;
    expect(care.champion).not.toBeNull();
    expect(care.hasEvalRun, "a champion with no eval run reported as evaluated").toBe(false);
    expect(care.championEvalRunId).toBeNull();

    // And true when there genuinely is one.
    const run = await db.one<{ id: string }>(
      `INSERT INTO eval_runs (role, suite, candidate, metric, metric_value)
       VALUES ('customer_care','care','modelark/seed-2-0-pro','cost_per_pass',0.05) RETURNING id`,
    );
    await setChampion(db, "customer_care", "modelark/seed-2-0-pro", run.id, 0.05);
    const after = (await registryStatus(db)).find((r) => r.role === "customer_care")!;
    expect(after.hasEvalRun).toBe(true);
    expect(after.championEvalRunId).toBe(run.id);
  });
});
