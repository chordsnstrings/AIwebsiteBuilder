import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { registryStatus, resolveRole } from "@adw/registry";
import { runFullSweep } from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let vault: SecretsBackend;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
  await runFullSweep({ db, vault, forceMock: true });
});
afterAll(async () => {
  await db?.close();
});

describe("eval harness full sweep", () => {
  it("every role gets a champion backed by a stored eval run (Phase 0 exit criterion)", async () => {
    const status = await registryStatus(db);
    expect(status.length).toBeGreaterThanOrEqual(16);
    for (const s of status) {
      expect(s.champion, `role ${s.role} must have a champion`).not.toBeNull();
      expect(s.hasEvalRun, `role ${s.role} champion must have an eval run`).toBe(true);
    }
    const audit = await db.one<{ n: string }>("SELECT count(*) AS n FROM registry_audit");
    expect(Number(audit.n)).toBeGreaterThan(0);
  });

  it("cost_per_pass roles select the cheapest passing candidate", async () => {
    const enrich = await resolveRole(db, "enrichment");
    expect(enrich.champion).toContain("seed-2-0-mini");
  });

  it("live-A/B roles stay 'pending' with a provisional champion", async () => {
    const status = await registryStatus(db);
    const care = status.find((s) => s.role === "customer_care")!;
    expect(care.status).toBe("pending");
    expect(care.champion).not.toBeNull();
  });

  it("marks fallback liveness for roles with an escalation chain", async () => {
    const status = await registryStatus(db);
    const dev = status.find((s) => s.role === "developer")!;
    expect(dev.fallbackLastOk).not.toBeNull();
  });
});
