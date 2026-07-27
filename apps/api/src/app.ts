// ADW internal API surface (spec Appendix C). Built as a composable Hono app so
// it can be exercised in tests via `app.request()` without binding a port.
//
// The load-bearing properties:
//   • POST /gate/evaluate is the ONLY route to transport.
//   • POST /suppression is append-only — there is deliberately no DELETE route.
//   • POST /registry/champion requires an evalRunId (harness-only).
//   • Operator routes require an authenticated superadmin.
//   • Webhooks are signature-verified and idempotent.
import { Hono } from "hono";
import { z } from "zod";
import { createDb, emailHash, type Db } from "@adw/db";
import {
  gate,
  engageKillSwitch,
  releaseKillSwitch,
  KILL_SWITCHES,
  type OutboundMessage,
} from "@adw/gate";
import { complete } from "@adw/gateway";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { registryStatus, setChampion, type RoleId } from "@adw/registry";
import { dsarExport } from "@adw/dsar";
import {
  clearCookie,
  invalidateSession,
  login,
  readSessionCookie,
  sessionCookie,
  validateSession,
  type SessionUser,
} from "@adw/auth";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface AppDeps {
  db: Db;
  vault: SecretsBackend;
  forceMock?: boolean;
  /** Test hook: bypass cookie auth with a fixed user. */
  authOverride?: SessionUser | null;
}

type Vars = { user: SessionUser | null };

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  const { db, vault } = deps;

  // --- Auth middleware: resolves the session user for every request ---------
  app.use("*", async (c, next) => {
    if (deps.authOverride !== undefined) {
      c.set("user", deps.authOverride);
      return next();
    }
    const token = readSessionCookie(c.req.header("cookie"));
    const resolved = token ? await validateSession(db, token) : null;
    c.set("user", resolved?.user ?? null);
    await next();
  });

  const requireOperator = (c: { get: (k: "user") => SessionUser | null }): SessionUser | null => {
    const user = c.get("user");
    return user && user.role === "superadmin" ? user : null;
  };

  app.get("/health", (c) => c.json({ ok: true, mode: deps.forceMock ? "demo" : "live" }));

  // --- Authentication -------------------------------------------------------
  app.post("/auth/login", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; totp?: string };
    if (!b.email || !b.password) return c.json({ error: "email and password required" }, 400);
    const result = await login(db, b.email, b.password, b.totp, {
      ip: c.req.header("x-forwarded-for") ?? undefined,
      userAgent: c.req.header("user-agent") ?? undefined,
    });
    if (!result.ok) {
      // A required-TOTP response is a distinct, non-secret signal so the UI can
      // prompt for the code; it does not reveal whether the password was right.
      const status = result.reason === "invalid_credentials" ? 401 : 403;
      return c.json({ error: result.reason }, status);
    }
    c.header("set-cookie", sessionCookie(result.token, false));
    return c.json({ ok: true, user: result.user });
  });

  app.post("/auth/logout", async (c) => {
    const token = readSessionCookie(c.req.header("cookie"));
    if (token) await invalidateSession(db, token);
    c.header("set-cookie", clearCookie());
    return c.json({ ok: true });
  });

  app.get("/auth/me", (c) => {
    const user = c.get("user");
    return user ? c.json({ user }) : c.json({ user: null }, 401);
  });

  // --- The only route to transport -----------------------------------------
  app.post("/gate/evaluate", async (c) => {
    const body = (await c.req.json()) as { message: Record<string, unknown> };
    const raw = body.message;
    const msg = {
      ...raw,
      emailHash: Buffer.from(String(raw.emailHash ?? ""), "hex"),
      phoneHash: raw.phoneHash ? Buffer.from(String(raw.phoneHash), "hex") : undefined,
    } as unknown as OutboundMessage;
    const decision = await gate(msg, { db });
    return c.json(decision);
  });

  // --- Registry-resolved model completion ----------------------------------
  app.post("/gateway/complete", async (c) => {
    const body = (await c.req.json()) as {
      role: string;
      dataClass: string;
      system: string;
      user: string;
      simulate?: Record<string, unknown>;
    };
    try {
      const res = await complete(
        {
          role: body.role as RoleId,
          dataClass: body.dataClass as "PUB" | "PUBLISHABLE" | "CUST" | "PAY",
          system: body.system,
          user: body.user,
          schema: z.record(z.string(), z.unknown()),
          maxTokensOut: 500,
          budgetUsdPerPassingOutput: 0.05,
          simulate: () => body.simulate ?? { ok: true },
        },
        { db, vault, forceMock: deps.forceMock ?? true },
      );
      return c.json(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A data-class violation is a client error, not a server fault.
      return c.json({ error: message }, /data-class|PAY/i.test(message) ? 422 : 400);
    }
  });

  // --- Append-only ledgers (no DELETE route exists) -------------------------
  app.post("/suppression", async (c) => {
    const body = (await c.req.json()) as { email?: string; phone?: string; reason: string };
    if (!body.email && !body.phone) return c.json({ error: "email or phone required" }, 400);
    await db.query(
      "INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,$2,'all') ON CONFLICT DO NOTHING",
      [body.email ? emailHash(body.email) : null, body.reason],
    );
    return c.json({ ok: true, suppressed: true });
  });

  app.post("/provenance", async (c) => {
    const b = (await c.req.json()) as {
      contactId: string;
      sourceUrl: string;
      screenshotKey: string;
      pageHash: string;
      noCemStatement: boolean;
      relatesToRole: boolean;
      legalBasis: string;
      detectorVersion: string;
    };
    const row = await db.one<{ id: string }>(
      `INSERT INTO provenance (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash,
        no_cem_statement, detector_version, relates_to_role, legal_basis)
       VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.contactId, b.sourceUrl, b.screenshotKey, b.pageHash, b.noCemStatement, b.detectorVersion, b.relatesToRole, b.legalBasis],
    );
    return c.json({ ok: true, id: row.id });
  });

  // --- Registry: champion changes require an eval run (harness only) --------
  app.post("/registry/champion", async (c) => {
    const b = (await c.req.json()) as { role: string; champion: string; evalRunId?: string; metric?: number };
    if (!b.evalRunId) {
      return c.json({ error: "evalRunId is required — a champion must be backed by a stored eval run" }, 400);
    }
    const run = await db.maybeOne("SELECT 1 AS x FROM eval_runs WHERE id = $1", [b.evalRunId]);
    if (!run) return c.json({ error: "unknown evalRunId" }, 400);
    await setChampion(db, b.role as RoleId, b.champion, b.evalRunId, b.metric ?? 0);
    return c.json({ ok: true });
  });

  app.get("/registry", async (c) => c.json(await registryStatus(db)));

  // --- Operator console surfaces (superadmin only) --------------------------
  app.post("/killswitch/:name", async (c) => {
    const user = requireOperator(c);
    if (!user) return c.json({ error: "forbidden" }, 403);
    const name = c.req.param("name");
    if (!(KILL_SWITCHES as readonly string[]).includes(name) && !name.startsWith("HALT_AGENT:")) {
      return c.json({ error: "unknown kill switch" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { engage?: boolean };
    const engage = body.engage !== false;
    if (engage) await engageKillSwitch(db, name as never, user.email);
    else await releaseKillSwitch(db, name as never, user.email);
    return c.json({ ok: true, name, engaged: engage });
  });

  app.get("/killswitch", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const rows = await db.query("SELECT name, engaged, toggled_by, toggled_at FROM kill_switches ORDER BY name");
    return c.json(rows.rows);
  });

  /** One box: email, domain, business name, customer, build id, trace id. */
  app.get("/search", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ query: q, results: {} });
    const like = `%${q}%`;
    const [businesses, contacts, customers, decisions, builds] = await Promise.all([
      db.query("SELECT id, name, city, country_code, segment FROM businesses WHERE name ILIKE $1 LIMIT 10", [like]),
      db.query("SELECT id, email, verification, subscriber_type FROM contacts WHERE email::text ILIKE $1 LIMIT 10", [like]),
      db.query("SELECT id, legal_name, contact_email, status FROM customers WHERE legal_name ILIKE $1 OR contact_email::text ILIKE $1 LIMIT 10", [like]),
      q.includes("@")
        ? db.query(
            "SELECT id, allow, reason, message_class, decided_at FROM gate_decisions WHERE contact_hash = $1 ORDER BY decided_at DESC LIMIT 20",
            [emailHash(q)],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      db.query("SELECT id, mode, first_pass, deployed_url, created_at FROM builds ORDER BY created_at DESC LIMIT 5"),
    ]);
    return c.json({
      query: q,
      results: {
        businesses: businesses.rows,
        contacts: contacts.rows,
        customers: customers.rows,
        gateDecisions: decisions.rows,
        recentBuilds: builds.rows,
      },
    });
  });

  app.post("/dsar/export", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json()) as { identity: string };
    if (!body.identity) return c.json({ error: "identity required" }, 400);
    const archive = await dsarExport(db, body.identity);
    return c.json({ manifest: archive.manifest, sections: archive.sections });
  });

  app.get("/exceptions", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const rows = await db.query(
      "SELECT id, trigger, severity, context, system_action, recommendation, status, raised_at FROM exceptions WHERE status = 'open' ORDER BY severity, raised_at DESC LIMIT 50",
    );
    return c.json(rows.rows);
  });

  app.get("/vendors", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const rows = await db.query(
      "SELECT id, name, tier, data_class, gate, state, probe_status, probe_last_ok FROM vendors ORDER BY tier, id",
    );
    return c.json(rows.rows);
  });

  /** Vault: metadata only. There is deliberately no route that returns a secret. */
  app.get("/vault", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    return c.json(await vault.list());
  });

  app.post("/vault/:vendorId/:keyName", async (c) => {
    const user = requireOperator(c);
    if (!user) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json()) as { secret?: string };
    if (!body.secret) return c.json({ error: "secret required" }, 400);
    const ref = await vault.put(c.req.param("vendorId"), c.req.param("keyName"), body.secret);
    // The ref is opaque and the secret is never echoed back.
    return c.json({ ok: true, ref });
  });

  app.get("/cost", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const rows = await db.query(
      `SELECT actor_id AS role, model, count(*) AS calls, COALESCE(sum(cost_cents),0) AS cost_cents
       FROM events WHERE event_type = 'gateway.completed'
       GROUP BY actor_id, model ORDER BY cost_cents DESC LIMIT 50`,
    );
    return c.json(rows.rows);
  });

  // --- Webhooks: signature-verified and idempotent --------------------------
  app.post("/webhooks/:provider", async (c) => {
    const provider = c.req.param("provider");
    const raw = await c.req.text();
    const signature = c.req.header("x-adw-signature") ?? "";
    const secret = process.env.ADW_WEBHOOK_SECRET ?? "demo-webhook-secret";
    if (!verifySignature(raw, signature, secret)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    let payload: { id?: string; type?: string };
    try {
      payload = JSON.parse(raw) as { id?: string; type?: string };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    // Idempotent: the same event id is accepted once and acknowledged thereafter.
    const eventId = payload.id ?? "";
    if (eventId) {
      const seen = await db.maybeOne("SELECT 1 AS x FROM events WHERE event_type = $1 AND payload->>'webhookId' = $2", [
        `webhook.${provider}`,
        eventId,
      ]);
      if (seen) return c.json({ received: true, duplicate: true });
      await db.query(
        "INSERT INTO events (event_type, actor_kind, actor_id, payload) VALUES ($1,'system',$2,$3)",
        [`webhook.${provider}`, provider, JSON.stringify({ webhookId: eventId, type: payload.type })],
      );
    }
    return c.json({ received: true, duplicate: false });
  });

  return app;
}

export function signPayload(raw: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

function verifySignature(raw: string, signature: string, secret: string): boolean {
  const expected = signPayload(raw, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build the app with real dependencies (server entrypoint + scripts). */
export async function buildApp(): Promise<Hono<{ Variables: Vars }>> {
  const db = await createDb({});
  const vault = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));
  return createApp({ db, vault, forceMock: true });
}
