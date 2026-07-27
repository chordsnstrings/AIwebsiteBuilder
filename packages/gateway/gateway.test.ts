import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { seedRegistry, resolveRole, setChampion, type RoleId } from "@adw/registry";
import { config } from "@adw/config";
import { complete, GatewayError, type GatewayDeps } from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let vault: SecretsBackend;

// Seed champions directly (avoids depending on the eval harness, which depends
// on this package). Each role's first candidate becomes champion via a stored
// eval run — the same provenance the harness would produce.
async function seedChampions(): Promise<void> {
  const { data } = config.registry();
  for (const [role, r] of Object.entries(data.roles)) {
    const champ = r.candidates[0]!;
    const run = await db.one<{ id: string }>(
      `INSERT INTO eval_runs (role, suite, candidate, metric, metric_value)
       VALUES ($1,$2,$3,$4,0.01) RETURNING id`,
      [role, r.eval_suite, champ, r.selection_metric],
    );
    await setChampion(db, role as RoleId, champ, run.id, 0.01);
  }
}

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
  await seedRegistry(db);
  await seedChampions();
});
afterAll(async () => {
  await db?.close();
});

const deps = (): GatewayDeps => ({ db, vault, forceMock: true });
const schema = z.object({ reply: z.string(), score: z.number() });

describe("gateway", () => {
  it("resolves a role to a champion and returns validated output", async () => {
    const res = await complete(
      {
        role: "enrichment",
        dataClass: "PUB",
        system: "Classify the record.",
        user: "record",
        schema,
        maxTokensOut: 500,
        budgetUsdPerPassingOutput: 0.01,
        simulate: () => ({ reply: "ok", score: 62 }),
      },
      deps(),
    );
    expect(res.result.score).toBe(62);
    expect(res.firstPass).toBe(true);
    expect(res.roleChain[0]).toBe("enrichment:champion");
    expect(res.costCents).toBeGreaterThan(0);
  });

  it("rejects a PAY-class call at the gateway (no model sees PAY)", async () => {
    await expect(
      complete(
        {
          role: "finance_pricing",
          dataClass: "PAY",
          system: "x",
          user: "y",
          schema,
          maxTokensOut: 100,
          budgetUsdPerPassingOutput: 0.01,
          simulate: () => ({ reply: "x", score: 1 }),
        },
        deps(),
      ),
    ).rejects.toThrow(/PAY/i);
  });

  it("escalates to the next candidate on a parse failure and records escalation depth", async () => {
    const resolution = await resolveRole(db, "developer");
    const res = await complete(
      {
        role: "developer",
        dataClass: "PUBLISHABLE",
        system: "build",
        user: "site",
        schema,
        maxTokensOut: 500,
        budgetUsdPerPassingOutput: 0.22,
        simulate: () => ({ reply: "built", score: 90 }),
        // Force the champion to emit invalid JSON; escalation[0] succeeds.
        failFor: (model) => (model === resolution.champion ? "parse" : undefined),
      },
      deps(),
    );
    expect(res.firstPass).toBe(false);
    expect(res.escalationDepth).toBe(1);
    expect(res.model).toBe(resolution.escalation[0]);
  });

  it("throws when all candidates are exhausted (human exception)", async () => {
    await expect(
      complete(
        {
          role: "enrichment",
          dataClass: "PUB",
          system: "x",
          user: "y",
          schema,
          maxTokensOut: 100,
          budgetUsdPerPassingOutput: 0.01,
          simulate: () => ({ reply: "x", score: 1 }),
          failFor: () => "parse", // every candidate fails to parse
        },
        deps(),
      ),
    ).rejects.toThrow(GatewayError);
  });
});
