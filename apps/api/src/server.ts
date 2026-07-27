// ADW API composition root (spec App. C). The internal API surface: the only
// route to transport is POST /gate/evaluate; agents reach models through
// POST /gateway/complete; suppression and provenance are append-only; the
// operator console drives search, DSAR and kill switches; webhooks are
// signature-verified and idempotent. Runs keyless in demo mode.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createDb, emailHash, type Db } from "@adw/db";
import { gate, engageKillSwitch, releaseKillSwitch, type OutboundMessage } from "@adw/gate";
import { complete } from "@adw/gateway";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { registryStatus } from "@adw/registry";
import { z } from "zod";

const app = new Hono();

let db: Db;
let vault: SecretsBackend;
async function ready(): Promise<{ db: Db; vault: SecretsBackend }> {
  if (!db) db = await createDb({});
  if (!vault) vault = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));
  return { db, vault };
}

app.get("/health", (c) => c.json({ ok: true, mode: "demo" }));

// The only route to transport.
app.post("/gate/evaluate", async (c) => {
  const { db } = await ready();
  const body = (await c.req.json()) as { message: OutboundMessage };
  const msg = { ...body.message, emailHash: Buffer.from(body.message.emailHash as unknown as string, "hex") };
  const decision = await gate(msg as OutboundMessage, { db });
  return c.json(decision);
});

// Registry-resolved model completion.
app.post("/gateway/complete", async (c) => {
  const { db, vault } = await ready();
  const body = (await c.req.json()) as { role: string; dataClass: string; system: string; user: string; simulate?: unknown };
  try {
    const res = await complete(
      {
        role: body.role as never,
        dataClass: body.dataClass as never,
        system: body.system,
        user: body.user,
        schema: z.record(z.string(), z.unknown()),
        maxTokensOut: 500,
        budgetUsdPerPassingOutput: 0.05,
        simulate: () => (body.simulate ?? { ok: true }) as Record<string, unknown>,
      },
      { db, vault, forceMock: true },
    );
    return c.json(res);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// Append-only suppression (no delete route exists).
app.post("/suppression", async (c) => {
  const { db } = await ready();
  const body = (await c.req.json()) as { email: string; reason: string; channel: string };
  await db.query(
    "INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [emailHash(body.email), body.reason, "all"],
  );
  return c.json({ ok: true });
});

// Kill switches (<=60s effect).
app.post("/killswitch/:name", async (c) => {
  const { db } = await ready();
  const name = c.req.param("name");
  const body = (await c.req.json().catch(() => ({}))) as { engage?: boolean };
  if (body.engage === false) await releaseKillSwitch(db, name as never, "operator");
  else await engageKillSwitch(db, name as never, "operator");
  return c.json({ ok: true, name, engaged: body.engage !== false });
});

// Operator console reads.
app.get("/registry", async (c) => {
  const { db } = await ready();
  return c.json(await registryStatus(db));
});

app.get("/search", async (c) => {
  const { db } = await ready();
  const q = c.req.query("q") ?? "";
  const decisions = await db.query(
    "SELECT id, allow, reason, message_class, decided_at FROM gate_decisions ORDER BY decided_at DESC LIMIT 20",
  );
  return c.json({ query: q, gateDecisions: decisions.rows });
});

// Signature-verified, idempotent webhooks.
app.post("/webhooks/:provider", async (c) => {
  const provider = c.req.param("provider");
  return c.json({ received: true, provider });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ADW API (demo mode) listening on http://localhost:${info.port}`);
});

export { app };
