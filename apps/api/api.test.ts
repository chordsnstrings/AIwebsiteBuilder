// Exercises the internal API surface (spec Appendix C) through app.request(),
// with particular attention to the routes that MUST NOT exist or MUST refuse.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { seedRegistry, setChampion, type RoleId } from "@adw/registry";
import { config } from "@adw/config";
import type { SessionUser } from "@adw/auth";
import { mintUnsubscribeToken } from "@adw/compliance";
import { createApp, signPayload } from "./src/app.ts";
import { allowedOrigins, MemoryRateLimitStore } from "./src/middleware.ts";
import { randomUUID } from "node:crypto";

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

describe("authentication", () => {
  it("rejects a bad password with 401 and requires TOTP for a superadmin", async () => {
    const { createUser, totp } = await import("@adw/auth");
    const email = `apiadmin${Date.now()}@example.com`;
    const { totpSecret } = await createUser(db, { email, password: "pw12345678", role: "superadmin" });
    // Real cookie auth for this block (no override).
    const app = createApp({ db, vault, forceMock: true });

    const bad = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong" }),
    });
    expect(bad.status).toBe(401);

    const noTotp = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "pw12345678" }),
    });
    expect(noTotp.status).toBe(403);
    expect((await noTotp.json()).error).toBe("totp_required");

    const ok = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "pw12345678", totp: totp(totpSecret!, Math.floor(Date.now() / 1000)) }),
    });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("adw_session=");
    expect(cookie).toContain("HttpOnly");

    // The session cookie now unlocks the operator surfaces.
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.role).toBe("superadmin");

    const vendors = await app.request("/vendors", { headers: { cookie } });
    expect(vendors.status).toBe(200);

    // And logging out revokes it.
    await app.request("/auth/logout", { method: "POST", headers: { cookie } });
    const after = await app.request("/vendors", { headers: { cookie } });
    expect(after.status).toBe(403);
  });

  it("/auth/me is 401 when anonymous", async () => {
    const res = await createApp({ db, vault, forceMock: true }).request("/auth/me");
    expect(res.status).toBe(401);
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

  // ⛔ The three below are the route-level assertions this endpoint never had.
  //
  // The webhook effects — hard bounce to suppression, complaint to suppression,
  // dunning advance — were fully implemented and fully tested by calling
  // `applyWebhookEffects()` directly. Nothing tested that a real notification
  // could REACH it, and it could not: the route verified an `x-adw-signature`
  // HMAC that neither Amazon nor Stripe sends, so every genuine event was
  // answered 401 and the bounce detector was unreachable in production while
  // its own suite was green.
  it("⛔ refuses a shared-secret signature in live mode", async () => {
    // The simulator path must not be a second door into a live deployment.
    // Anyone holding ADW_WEBHOOK_SECRET could otherwise forge a hard bounce and
    // suppress an arbitrary address.
    const raw = JSON.stringify({ id: `evt_live_${Date.now()}`, type: "payment.succeeded" });
    const live = createApp({ db, vault, forceMock: false, authOverride: null });
    const res = await live.request("/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "x-adw-signature": signPayload(raw, secret) },
      body: raw,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toMatch(/only accepted against simulators/);
  });

  it("⛔ refuses a provider whose scheme is not implemented, rather than defaulting", async () => {
    const raw = JSON.stringify({ id: `evt_x_${Date.now()}` });
    const res = await appAs(null).request("/webhooks/postmark", {
      method: "POST",
      headers: { "content-type": "application/json", "x-adw-signature": signPayload(raw, secret) },
      body: raw,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toMatch(/no signature scheme is implemented/);
  });

  it("records every refusal, because a misconfiguration and a forgery look identical from outside", async () => {
    const before = await db.one<{ n: string }>("SELECT count(*) AS n FROM events WHERE event_type = 'webhook.rejected'");
    await appAs(null).request("/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_unsigned" }),
    });
    const after = await db.one<{ n: string }>("SELECT count(*) AS n FROM events WHERE event_type = 'webhook.rejected'");
    expect(Number(after.n)).toBeGreaterThan(Number(before.n));
  });
});

// ---------------------------------------------------------------------------
// The customer revision loop: preview claim / change request / opt-out, and the
// post-sale dashboard revision route.
// ---------------------------------------------------------------------------
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
  body: JSON.stringify(body),
});

async function makeBusiness(): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,'Preview Co','US','R1','no_site') RETURNING id`,
    [batch.id],
  );
  return biz.id;
}

interface Fixture {
  businessId: string;
  previewId: string;
  token: string;
  email: string;
}

/** A preview reachable by claim token, optionally already expired/withdrawn. */
async function makePreview(
  opts: { expiresInDays?: number; takenDown?: boolean; withLead?: boolean } = {},
): Promise<Fixture> {
  const businessId = await makeBusiness();
  const token = `claim_${randomUUID()}`;
  const email = `preview_${randomUUID()}@example.com`;
  const expires = new Date(Date.now() + (opts.expiresInDays ?? 30) * 86_400_000);
  const preview = await db.one<{ id: string }>(
    `INSERT INTO previews (business_id, r2_key, deploy_url, claim_token, label_version, expires_at, takedown_at)
     VALUES ($1,'r2/x','https://p.example/x',$2,'label-v1',$3,$4) RETURNING id`,
    [businessId, token, expires, opts.takenDown ? new Date() : null],
  );
  const contact = await db.one<{ id: string }>(
    "INSERT INTO contacts (business_id, email, email_hash, verification) VALUES ($1,$2,$3,'valid') RETURNING id",
    [businessId, email, emailHash(email)],
  );
  if (opts.withLead) {
    const campaign = await db.one<{ id: string }>(
      "INSERT INTO campaigns (name, region_code) VALUES ('preview-campaign','R1') RETURNING id",
    );
    const lead = await db.one<{ id: string }>(
      `INSERT INTO leads (contact_id, campaign_id, state, workflow_id, preview_id)
       VALUES ($1,$2,'PREVIEW_SENT','wf-preview',$3) RETURNING id`,
      [contact.id, campaign.id, preview.id],
    );
    await db.query("INSERT INTO conversations (lead_id, channel) VALUES ($1,'email')", [lead.id]);
  }
  return { businessId, previewId: preview.id, token, email };
}

describe("preview claim", () => {
  it("404s on an unknown claim token", async () => {
    const res = await appAs(null).request(`/previews/nope_${randomUUID()}/claim`, json({}));
    expect(res.status).toBe(404);
  });

  it("410s on an expired preview", async () => {
    const fx = await makePreview({ expiresInDays: -1 });
    const res = await appAs(null).request(`/previews/${fx.token}/claim`, json({}));
    expect(res.status).toBe(410);
  });

  it("410s on a withdrawn preview", async () => {
    const fx = await makePreview({ takenDown: true });
    const res = await appAs(null).request(`/previews/${fx.token}/claim`, json({}));
    expect(res.status).toBe(410);
  });

  it("claims the preview with no session at all", async () => {
    const fx = await makePreview();
    const res = await appAs(null).request(`/previews/${fx.token}/claim`, json({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, claimed: true });
    const row = await db.one<{ claimed_at: string | null }>("SELECT claimed_at FROM previews WHERE id = $1", [
      fx.previewId,
    ]);
    expect(row.claimed_at).not.toBeNull();
  });

  it("records an SMS consent event carrying the exact wording, page version, ip and timestamp", async () => {
    const fx = await makePreview();
    const wording = "Text me updates about my website";
    const res = await appAs(null).request(
      `/previews/${fx.token}/claim`,
      json({ smsConsent: true, phone: "+15555550147", consentWording: wording }),
    );
    expect(res.status).toBe(200);
    const ev = await db.one<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE event_type = 'consent.captured' AND subject_id = $1",
      [fx.previewId],
    );
    expect(ev.payload.wording).toBe(wording);
    expect(ev.payload.pageVersion).toBe("label-v1");
    expect(ev.payload.ip).toBe("203.0.113.9");
    expect(typeof ev.payload.timestamp).toBe("string");
    expect(ev.payload.phone).toBe("+15555550147");
  });

  it("writes NO consent event when the box was left unchecked", async () => {
    const fx = await makePreview();
    await appAs(null).request(`/previews/${fx.token}/claim`, json({ smsConsent: false }));
    const ev = await db.maybeOne("SELECT 1 AS x FROM events WHERE event_type = 'consent.captured' AND subject_id = $1", [
      fx.previewId,
    ]);
    expect(ev).toBeNull();
  });
});

describe("preview change requests", () => {
  it("rejects empty and oversized text with 400", async () => {
    const fx = await makePreview();
    const empty = await appAs(null).request(`/previews/${fx.token}/changes`, json({ requestText: "   " }));
    expect(empty.status).toBe(400);
    const huge = await appAs(null).request(`/previews/${fx.token}/changes`, json({ requestText: "x".repeat(2001) }));
    expect(huge.status).toBe(400);
  });

  it("queues a change request and lands it on the lead's conversation", async () => {
    const fx = await makePreview({ withLead: true });
    const res = await appAs(null).request(
      `/previews/${fx.token}/changes`,
      json({ requestText: "Please use the new van photo on the homepage." }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);

    const ev = await db.one<{ payload: { requestText: string } }>(
      "SELECT payload FROM events WHERE event_type = 'preview.change_requested' AND subject_id = $1",
      [fx.previewId],
    );
    expect(ev.payload.requestText).toContain("new van photo");
    const msg = await db.one<{ n: string }>(
      `SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
       JOIN leads l ON l.id = c.lead_id WHERE l.preview_id = $1 AND m.direction = 'inbound'`,
      [fx.previewId],
    );
    expect(Number(msg.n)).toBe(1);
  });

  it("404s an unknown token and 410s a withdrawn preview", async () => {
    const unknown = await appAs(null).request(`/previews/nope_${randomUUID()}/changes`, json({ requestText: "hi" }));
    expect(unknown.status).toBe(404);
    const gone = await makePreview({ takenDown: true });
    const res = await appAs(null).request(`/previews/${gone.token}/changes`, json({ requestText: "hi" }));
    expect(res.status).toBe(410);
  });

  it("rate-limits runaway change requests on one token", async () => {
    const fx = await makePreview();
    const app = appAs(null);
    for (let i = 0; i < 10; i++) {
      const ok = await app.request(`/previews/${fx.token}/changes`, json({ requestText: `change ${i}` }));
      expect(ok.status).toBe(200);
    }
    const blocked = await app.request(`/previews/${fx.token}/changes`, json({ requestText: "one more" }));
    expect(blocked.status).toBe(429);
  });
});

describe("preview opt-out (this isn't for me)", () => {
  it("works with no auth, suppresses the contact, takes the preview down, and is idempotent", async () => {
    const fx = await makePreview();
    const app = appAs(null);

    const first = await app.request(`/previews/${fx.token}/not-for-me`, json({}));
    expect(first.status).toBe(200);
    expect((await first.json()).ok).toBe(true);

    const sup = await db.one<{ n: string }>("SELECT count(*) AS n FROM suppression WHERE email_hash = $1", [
      emailHash(fx.email),
    ]);
    expect(Number(sup.n)).toBe(1);
    const row = await db.one<{ takedown_at: string | null; takedown_reason: string | null }>(
      "SELECT takedown_at, takedown_reason FROM previews WHERE id = $1",
      [fx.previewId],
    );
    expect(row.takedown_at).not.toBeNull();
    expect(row.takedown_reason).toBe("not_for_me");

    // Idempotent: a second click is a no-op, not a second suppression row.
    const second = await app.request(`/previews/${fx.token}/not-for-me`, json({}));
    expect(second.status).toBe(200);
    expect((await second.json()).ok).toBe(true);
    const supAgain = await db.one<{ n: string }>("SELECT count(*) AS n FROM suppression WHERE email_hash = $1", [
      emailHash(fx.email),
    ]);
    expect(Number(supAgain.n)).toBe(1);
  });

  it("suppresses the lead's own contact when the preview came from a campaign", async () => {
    const fx = await makePreview({ withLead: true });
    const res = await appAs(null).request(`/previews/${fx.token}/not-for-me`, json({}));
    expect(res.status).toBe(200);
    expect((await res.json()).suppressed).toBe(true);
    const sup = await db.one<{ n: string }>("SELECT count(*) AS n FROM suppression WHERE email_hash = $1", [
      emailHash(fx.email),
    ]);
    expect(Number(sup.n)).toBe(1);
  });

  it("404s an unknown token", async () => {
    const res = await appAs(null).request(`/previews/nope_${randomUUID()}/not-for-me`, json({}));
    expect(res.status).toBe(404);
  });
});

describe("customer revision requests", () => {
  async function makeCustomer(): Promise<string> {
    const businessId = await makeBusiness();
    const row = await db.one<{ id: string }>(
      `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
       VALUES ($1,'R1','Revision Co',$2,'en-US','UTC','active') RETURNING id`,
      [businessId, `rev_${randomUUID()}@example.com`],
    );
    return row.id;
  }
  const owner = (customerId: string): SessionUser => ({
    id: `u_${customerId}`,
    email: "owner@example.com",
    role: "customer",
    customerId,
    totpEnabled: false,
  });

  it("rejects an unauthenticated caller with 403", async () => {
    const customerId = await makeCustomer();
    const res = await appAs(null).request(`/customers/${customerId}/revisions`, json({ requestText: "change it" }));
    expect(res.status).toBe(403);
  });

  it("rejects a different customer with 403", async () => {
    const mine = await makeCustomer();
    const theirs = await makeCustomer();
    const res = await appAs(owner(theirs)).request(`/customers/${mine}/revisions`, json({ requestText: "change it" }));
    expect(res.status).toBe(403);
  });

  it("accepts the owner and increments the round on each request", async () => {
    const customerId = await makeCustomer();
    const app = appAs(owner(customerId));
    const first = await app.request(`/customers/${customerId}/revisions`, json({ requestText: "New opening hours" }));
    expect(first.status).toBe(200);
    expect((await first.json()).round).toBe(1);
    const second = await app.request(`/customers/${customerId}/revisions`, json({ requestText: "Swap the hero photo" }));
    expect((await second.json()).round).toBe(2);

    const rows = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE event_type = 'customer.revision_requested' AND subject_id = $1",
      [customerId],
    );
    expect(Number(rows.n)).toBe(2);
  });

  it("allows a superadmin to file on a customer's behalf", async () => {
    const customerId = await makeCustomer();
    const res = await appAs(OPERATOR).request(`/customers/${customerId}/revisions`, json({ requestText: "ops fix" }));
    expect(res.status).toBe(200);
  });

  it("rejects empty and oversized text with 400", async () => {
    const customerId = await makeCustomer();
    const app = appAs(owner(customerId));
    expect((await app.request(`/customers/${customerId}/revisions`, json({ requestText: "" }))).status).toBe(400);
    expect(
      (await app.request(`/customers/${customerId}/revisions`, json({ requestText: "x".repeat(2001) }))).status,
    ).toBe(400);
  });

  it("404s an unknown customer for an authorised operator", async () => {
    const res = await appAs(OPERATOR).request(`/customers/${randomUUID()}/revisions`, json({ requestText: "hi" }));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// One-click unsubscribe (RFC 8058). The gate will not let a cold message out
// without headers pointing here, so these two routes are load-bearing for every
// send the system will ever make.
// ---------------------------------------------------------------------------
describe("unsubscribe", () => {
  const SECRET = "local-unsubscribe-secret"; // ADW_ENV=test fallback

  async function makeContact(): Promise<{ contactId: string; email: string }> {
    const businessId = await makeBusiness();
    const email = `unsub_${randomUUID()}@example.com`;
    const contact = await db.one<{ id: string }>(
      "INSERT INTO contacts (business_id, email, email_hash, verification) VALUES ($1,$2,$3,'valid') RETURNING id",
      [businessId, email, emailHash(email)],
    );
    return { contactId: contact.id, email };
  }

  const suppressed = async (email: string): Promise<string | null> => {
    const row = await db.maybeOne<{ reason: string }>("SELECT reason FROM suppression WHERE email_hash = $1", [
      emailHash(email),
    ]);
    return row?.reason ?? null;
  };

  it("suppresses on the unattended POST a mailbox provider makes", async () => {
    const { contactId, email } = await makeContact();
    const token = mintUnsubscribeToken({ contactId }, SECRET);
    const res = await appAs(null).request(`/u/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await suppressed(email)).toBe("unsubscribe");
  });

  it("suppresses on the human GET without asking for confirmation", async () => {
    const { contactId, email } = await makeContact();
    const token = mintUnsubscribeToken({ contactId }, SECRET);
    const res = await appAs(null).request(`/u/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    // Already done by the time the page renders — no form, no second click.
    expect(await res.text()).toMatch(/unsubscribed/i);
    expect(await suppressed(email)).toBe("unsubscribe");
  });

  it("is idempotent — a second click still succeeds", async () => {
    const { contactId, email } = await makeContact();
    const token = mintUnsubscribeToken({ contactId }, SECRET);
    const app = appAs(null);
    expect((await app.request(`/u/${token}`, { method: "POST" })).status).toBe(200);
    expect((await app.request(`/u/${token}`, { method: "POST" })).status).toBe(200);
    const n = await db.one<{ n: string }>("SELECT count(*) AS n FROM suppression WHERE email_hash = $1", [
      emailHash(email),
    ]);
    expect(Number(n.n)).toBe(1);
  });

  it("refuses a forged token", async () => {
    const { contactId, email } = await makeContact();
    const token = mintUnsubscribeToken({ contactId }, "a-completely-different-secret");
    expect((await appAs(null).request(`/u/${token}`, { method: "POST" })).status).toBe(404);
    expect(await suppressed(email)).toBeNull();
  });

  it("still reports success for a contact erased by a DSAR", async () => {
    const token = mintUnsubscribeToken({ contactId: randomUUID() }, SECRET);
    const res = await appAs(null).request(`/u/${token}`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("takes no session — the recipient has no account", async () => {
    const { contactId } = await makeContact();
    const token = mintUnsubscribeToken({ contactId }, SECRET);
    const res = await appAs(null).request(`/u/${token}`, { method: "POST" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Transport-level policy: origin allowlist, per-IP metering, cookie flags.
// ---------------------------------------------------------------------------
describe("middleware is actually wired into the app", () => {
  it("reflects an allowed origin and refuses an unknown one", async () => {
    const app = appAs(null);
    const allowed = allowedOrigins()[0]!;
    const ok = await app.request("/health", { headers: { origin: allowed } });
    expect(ok.headers.get("access-control-allow-origin")).toBe(allowed);

    const bad = await app.request("/health", { headers: { origin: "https://evil.example" } });
    // Never a wildcard, and never a reflection of an origin we don't know.
    expect(bad.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(bad.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("rate limits repeated login attempts from one IP", async () => {
    const store = new MemoryRateLimitStore();
    const app = createApp({ db, vault, forceMock: true, authOverride: null, rateLimitStore: store });
    const attempt = () =>
      app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
      });
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await attempt();
      if (res.status === 429) {
        limited = true;
        expect(res.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ignition: the routes that must hand work to the pipeline, not just record it.
// ---------------------------------------------------------------------------
describe("workflow ignition", () => {
  async function makeCustomerForIgnition(): Promise<string> {
    const businessId = await makeBusiness();
    const row = await db.one<{ id: string }>(
      `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
       VALUES ($1,'R1','Ignition Co',$2,'en-US','UTC','active') RETURNING id`,
      [businessId, `ign_${randomUUID()}@example.com`],
    );
    return row.id;
  }

  it("claiming a preview queues an onboarding start", async () => {
    const fx = await makePreview({ withLead: true });
    const res = await appAs(null).request(`/previews/${fx.token}/claim`, json({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ onboardingQueued: true });

    const intent = await db.one<{ kind: string; workflow_type: string }>(
      `SELECT wi.kind, wi.workflow_type FROM workflow_intents wi
        JOIN leads l ON wi.execution_id = 'onboarding:' || l.id::text
       WHERE l.preview_id = $1`,
      [fx.previewId],
    );
    expect(intent).toMatchObject({ kind: "start", workflow_type: "onboarding" });
  });

  it("claiming twice queues one onboarding, not two", async () => {
    const fx = await makePreview({ withLead: true });
    const app = appAs(null);
    await app.request(`/previews/${fx.token}/claim`, json({}));
    await app.request(`/previews/${fx.token}/claim`, json({}));
    const n = await db.one<{ n: string }>(
      `SELECT count(*) AS n FROM workflow_intents wi
         JOIN leads l ON wi.execution_id = 'onboarding:' || l.id::text
        WHERE l.preview_id = $1`,
      [fx.previewId],
    );
    expect(Number(n.n)).toBe(1);
  });

  it("a dashboard revision request queues a revision workflow", async () => {
    const customerId = await makeCustomerForIgnition();
    const res = await appAs(OPERATOR).request(`/customers/${customerId}/revisions`, json({ requestText: "make it blue" }));
    expect(res.status).toBe(200);
    const intent = await db.one<{ kind: string; workflow_type: string }>(
      "SELECT kind, workflow_type FROM workflow_intents WHERE execution_id = $1",
      [`revision:${customerId}:1`],
    );
    expect(intent).toMatchObject({ kind: "start", workflow_type: "revision" });
  });
});
