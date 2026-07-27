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
    await db.query("UPDATE registry_roles SET champion = NULL WHERE role = 'enrichment'");
    await expect(resolveRole(db, "enrichment")).rejects.toThrow(/no champion/i);
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
});
