// Exercises the internal API surface (spec Appendix C) through app.request(),
// with particular attention to the routes that MUST NOT exist or MUST refuse.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { seedRegistry, setChampion, type RoleId } from "@adw/registry";
import { config } from "@adw/config";
import type { SessionUser } from "@adw/auth";
import { createApp, signPayload } from "./src/app.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let vault: SecretsBackend;

const OPERATOR: SessionUser = { id: "op", email: "ops@adw.example", role: "superadmin", customerId: null, totpEnabled: true };
const CUSTOMER: SessionUser = { id: "cu", email: "cust@example.com", role: "customer", customerId: null, totpEnabled: false };

const appAs = (user: SessionUser | null) => createApp({ db, vault, forceMock: true, authOverride: user });

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
  await seedRegistry(db);
  const reg = config.registry().data.roles;
  for (const [role, r] of Object.entries(reg)) {
    const existing = await db.maybeOne("SELECT champion FROM registry_roles WHERE role=$1 AND champion IS NOT NULL", [role]);
    if (!existing) {
      const run = await db.one<{ id: string }>(
        "INSERT INTO eval_runs (role, suite, candidate, metric, metric_value) VALUES ($1,$2,$3,$4,0.01) RETURNING id",
        [role, r.eval_suite, r.candidates[0], r.selection_metric],
      );
      await setChampion(db, role as RoleId, r.candidates[0]!, run.id, 0.01);
    }
  }
});
afterAll(async () => {
  await db?.close();
});

describe("health + gateway", () => {
  it("reports health", async () => {
    const res = await appAs(null).request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("completes through the registry-resolved gateway", async () => {
    const res = await appAs(null).request("/gateway/complete", {
      method: "POST",
      body: JSON.stringify({ role: "enrichment", dataClass: "PUB", system: "s", user: "u", simulate: { score: 7 } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.score).toBe(7);
  });

  it("refuses a PAY-class completion (no model ever sees PAY)", async () => {
    const res = await appAs(null).request("/gateway/complete", {
      method: "POST",
      body: JSON.stringify({ role: "finance_pricing", dataClass: "PAY", system: "s", user: "u", simulate: {} }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
  });
});

describe("the gate is the only route to transport", () => {
  it("evaluates a message and denies an EU contact at rule 3", async () => {
    const res = await appAs(null).request("/gate/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          emailHash: emailHash("eu@example.com").toString("hex"),
          countryCode: "DE",
          subscriberType: "corporate",
          channel: "email",
          messageClass: "cold",
          domainClass: "burner",
          campaignId: "c",
          idempotencyKey: `api-eu-${Date.now()}`,
          localHour: 10,
          localWeekday: 2,
          body: "hello",
          headers: {},
        },
      }),
    });
    const body = await res.json();
    expect(body.allow).toBe(false);
    expect(body.reason).toBe("MARKET_NOT_ENABLED");
  });

  it("exposes no route that sends without the gate", async () => {
    for (const path of ["/send", "/transport", "/email/send"]) {
      const res = await appAs(OPERATOR).request(path, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    }
  });
});

describe("append-only ledgers", () => {
  it("accepts a suppression write", async () => {
    const res = await appAs(null).request("/suppression", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `sup${Date.now()}@example.com`, reason: "unsubscribe" }),
    });
    expect(res.status).toBe(200);
  });

  it("exposes NO delete route for suppression", async () => {
    const del = await appAs(OPERATOR).request("/suppression", { method: "DELETE" });
    expect(del.status).toBe(404);
    const byId = await appAs(OPERATOR).request("/suppression/123", { method: "DELETE" });
    expect(byId.status).toBe(404);
  });
});

describe("registry champion writes require an eval run", () => {
  it("rejects a champion change with no evalRunId", async () => {
    const res = await appAs(OPERATOR).request("/registry/champion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "developer", champion: "modelark/glm-5-2" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/evalRunId/);
  });

  it("rejects an unknown evalRunId", async () => {
    const res = await appAs(OPERATOR).request("/registry/champion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        role: "developer",
        champion: "modelark/glm-5-2",
        evalRunId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a champion change backed by a real eval run", async () => {
    const run = await db.one<{ id: string }>(
      "INSERT INTO eval_runs (role, suite, candidate, metric, metric_value) VALUES ('developer','developer','modelark/glm-5-2','cost_per_pass',0.09) RETURNING id",
    );
    const res = await appAs(OPERATOR).request("/registry/champion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "developer", champion: "modelark/glm-5-2", evalRunId: run.id, metric: 0.09 }),
    });
    expect(res.status).toBe(200);
  });
});

describe("operator surfaces require a superadmin", () => {
  const operatorRoutes: [string, string][] = [
    ["GET", "/killswitch"],
    ["GET", "/search?q=test"],
    ["GET", "/exceptions"],
    ["GET", "/vendors"],
    ["GET", "/vault"],
    ["GET", "/cost"],
  ];

  for (const [method, path] of operatorRoutes) {
    it(`${method} ${path} is forbidden anonymously and to a customer`, async () => {
      expect((await appAs(null).request(path, { method })).status).toBe(403);
      expect((await appAs(CUSTOMER).request(path, { method })).status).toBe(403);
    });
    it(`${method} ${path} is allowed for a superadmin`, async () => {
      expect((await appAs(OPERATOR).request(path, { method })).status).toBe(200);
    });
  }

  it("DSAR export is superadmin-only and returns a signed manifest", async () => {
    const anon = await appAs(null).request("/dsar/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "x@example.com" }),
    });
    expect(anon.status).toBe(403);

    const res = await appAs(OPERATOR).request("/dsar/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "x@example.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.signature).toMatch(/^sha256:/);
    expect(body.manifest.retentionNotes.join(" ")).toMatch(/provenance/i);
  });

  it("a kill switch can be engaged and released by an operator", async () => {
    const app = appAs(OPERATOR);
    const on = await app.request("/killswitch/HALT_BUILDS", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engage: true }),
    });
    expect((await on.json()).engaged).toBe(true);
    const off = await app.request("/killswitch/HALT_BUILDS", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engage: false }),
    });
    expect((await off.json()).engaged).toBe(false);
  });

  it("rejects an unknown kill switch name", async () => {
    const res = await appAs(OPERATOR).request("/killswitch/HALT_EVERYTHING_FOREVER", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engage: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe("vault", () => {
  it("deposits a credential and never returns the secret", async () => {
    const vendorId = `apivendor${Date.now()}`;
    const post = await appAs(OPERATOR).request(`/vault/${vendorId}/api_key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "sk_live_supersecret_value" }),
    });
    expect(post.status).toBe(200);
    const posted = await post.json();
    expect(JSON.stringify(posted)).not.toContain("sk_live_supersecret_value");

    const list = await appAs(OPERATOR).request("/vault");
    const text = await list.text();
    expect(text).not.toContain("sk_live_supersecret_value");
    expect(text).toContain(vendorId);
  });

  it("exposes no route that reads a secret back", async () => {
    const res = await appAs(OPERATOR).request("/vault/modelark/api_key", { method: "GET" });
    expect(res.status).toBe(404);
  });
});

describe("webhooks", () => {
  const secret = process.env.ADW_WEBHOOK_SECRET ?? "demo-webhook-secret";

  it("rejects an unsigned webhook", async () => {
    const res = await appAs(null).request("/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1", type: "payment.succeeded" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a signed webhook and is idempotent on replay", async () => {
    const raw = JSON.stringify({ id: `evt_${Date.now()}`, type: "payment.succeeded" });
    const sig = signPayload(raw, secret);
    const app = appAs(null);
    const first = await app.request("/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "x-adw-signature": sig },
      body: raw,
    });
    expect((await first.json()).duplicate).toBe(false);
    const replay = await app.request("/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "x-adw-signature": sig },
      body: raw,
    });
    expect((await replay.json()).duplicate).toBe(true);
  });
});
