// ADW internal API surface (spec Appendix C). Built as a composable Hono app so
// it can be exercised in tests via `app.request()` without binding a port.
//
// The load-bearing properties:
//   • POST /gate/evaluate is the ONLY route to transport.
//   • POST /suppression is append-only — there is deliberately no DELETE route.
//   • POST /registry/champion requires an evalRunId (harness-only).
//   • Operator routes require an authenticated superadmin.
//   • The customer revision loop (claim / changes / not-for-me) is public by
//     design — it hangs off an unguessable claim token, never a session.
//   • Webhooks are signature-verified and idempotent.
import { Hono } from "hono";
import { z } from "zod";
import { createDb, emailHash, type Db } from "@adw/db";
import {
  gate,
  clearKillSwitchCache,
  engageKillSwitch,
  readEngagedSwitches,
  releaseKillSwitch,
  KILL_SWITCHES,
  type OutboundMessage,
} from "@adw/gate";
import {
  agentBoard,
  businessBoard,
  businessDetail,
  costByRole,
  customerBoard,
  customerDetail,
  deployedAgents,
  gateSummary,
  invocations,
  jobBoard,
  outreachFunnel,
  recentJobFailures,
  spendBoard,
  worklist,
} from "@adw/opsview";
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
import {
  clientIp,
  cookieSecure,
  corsMiddleware,
  rateLimitMiddleware,
  type RateLimitStore,
} from "./middleware.ts";
import { applyWebhookEffects } from "./webhooks.ts";
import { authenticateWebhook } from "./webhook-auth.ts";
import { routeInbound } from "@adw/inbound";
import { emailResponderAgent } from "@adw/agents";
import { availableSlots } from "@adw/scheduling";
import { httpCollectors, simulatedCollectors, type FetchLike } from "@adw/watch";
import { factsOnlyDrafter, type Drafter } from "@adw/publish";
import { contentDrafterAgent, type AgentDeps } from "@adw/agents";
import { agentRoutes, type AgentRouteDeps } from "./agent-routes.ts";
import { enqueueIntent, executionId } from "@adw/workflows";
import {
  unsubscribeSecret,
  verifyUnsubscribeToken,
} from "@adw/compliance";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * How long another process may keep serving a stale kill-switch reading.
 * Mirrors the gate's own cache TTL and is reported to the console so an
 * operator knows when "engaged" becomes "engaged everywhere".
 */
const KILL_SWITCH_CACHE_SECONDS = 10;

/** Longest change request we accept in one submission. */
const MAX_REQUEST_TEXT = 2000;
/** Change requests accepted per preview before a human takes over. */
const MAX_CHANGES_PER_PREVIEW = 10;
/** Fallback for the consent wording when the page did not send its own. */
const DEFAULT_CONSENT_WORDING = "Text me updates about my website";

/**
 * The model-backed drafter.
 *
 * ⛔ Returns the model's words unaltered. It is tempting to trim an over-long
 * body here so the draft "works"; the caller refuses one instead, because a
 * model that overshot by four hundred characters cannot be trusted to have
 * stopped anywhere sensible and the cut lands wherever it happens to land —
 * frequently in the middle of a price.
 */
function agentDrafter(db: Parameters<typeof createApp>[0]["db"], vault: SecretsBackend, forceMock: boolean): Drafter {
  const agentDeps: AgentDeps = { db, vault, forceMock };
  return async ({ channel, vertical, topic, facts, maxChars }) => {
    const out = await contentDrafterAgent.run(
      { vertical, channel: channel.id, topic, facts, maxChars },
      agentDeps,
    );
    return { body: out.result.body, usedFacts: out.result.usedFacts };
  };
}

const nodeFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppDeps {
  db: Db;
  vault: SecretsBackend;
  forceMock?: boolean;
  /** Test hook: bypass cookie auth with a fixed user. */
  authOverride?: SessionUser | null;
  /** Test hook: share or disable the rate-limit store. */
  rateLimitStore?: RateLimitStore;
  /** Absent means the upload routes refuse with 503 rather than accepting
   *  files nothing stores. */
  uploads?: AgentRouteDeps["uploads"];
}

type Vars = { user: SessionUser | null };

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  const { db, vault } = deps;

  // Origin allowlist and per-IP metering run before anything reads the body, so
  // a rejected origin or a flood never reaches the database.
  app.use("*", corsMiddleware());
  app.use(
    "*",
    deps.rateLimitStore
      ? rateLimitMiddleware(undefined, deps.rateLimitStore)
      : rateLimitMiddleware(),
  );

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

  // --- The customer's agent (§39) ------------------------------------------
  // Mounted after the auth middleware so its owner-facing routes see a user,
  // and at the root so /.well-known/mcp lands where an assistant looks for it.
  app.route(
    "/",
    agentRoutes({
      db,
      ...(deps.authOverride === undefined ? {} : { authOverride: deps.authOverride }),
      // ⛔ The supplier the booking machine never had. `bookingNext` was written
      // and tested and reachable, and `availableSlots` was optional and never
      // passed — so every booking conversation asked for a contact and promised
      // a call back that nobody scheduled.
      concierge: {
        availableSlots: async (ctx) =>
          ctx.session.customerId === undefined
            ? []
            : (
                await availableSlots(
                  db,
                  ctx.session.customerId,
                  { from: new Date(), to: new Date(Date.now() + 14 * 86_400_000) },
                  { limit: 3 },
                )
              ).map((s) => ({ start: s.start, end: s.end })),
      },
      ...(deps.uploads === undefined ? {} : { uploads: deps.uploads }),
      // ⛔ Chosen by mode rather than defaulted. In demo the simulated sources
      // are the honest answer; in live mode the HTTP collectors are, and the
      // sources with no real adapter are simply absent from the map so
      // `subscribeWatch` refuses them out loud.
      watchCollectors: (deps.forceMock ?? true) ? simulatedCollectors() : httpCollectors(nodeFetch),
      // ⛔ In demo the facts-only drafter is the honest answer: it says exactly
      // what it was given and nothing more. In live mode the model writes, and
      // the same refusal guard and the same owner approval apply to both.
      drafter: (deps.forceMock ?? true) ? factsOnlyDrafter() : agentDrafter(db, vault, deps.forceMock ?? false),
    }),
  );

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
    c.header("set-cookie", sessionCookie(result.token, cookieSecure()));
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

  // --- The customer revision loop (spec §13, §36) ---------------------------
  // These four routes are the only bridge between "a customer asked for a
  // change" and "the revised site is redeployed". The three preview routes are
  // deliberately unauthenticated: the preview page is reached from a cold email
  // by someone with no account, and the unguessable claim_token is the
  // capability. They are metered per IP by the rate-limit middleware.

  interface PreviewRow {
    id: string;
    business_id: string;
    label_version: string;
    expires_at: string;
    claimed_at: string | null;
    takedown_at: string | null;
  }

  /** Resolve a claim token, or the HTTP status that should be returned instead. */
  const resolvePreview = async (
    token: string,
  ): Promise<{ preview: PreviewRow } | { status: 404 | 410; error: string }> => {
    const preview = await db.maybeOne<PreviewRow>(
      "SELECT id, business_id, label_version, expires_at, claimed_at, takedown_at FROM previews WHERE claim_token = $1",
      [token],
    );
    if (!preview) return { status: 404, error: "unknown preview" };
    if (preview.takedown_at) return { status: 410, error: "preview withdrawn" };
    if (new Date(preview.expires_at).getTime() <= Date.now()) return { status: 410, error: "preview expired" };
    return { preview };
  };

  /** The conversation this preview's lead is already having, if any. */
  const conversationForPreview = async (previewId: string): Promise<{ id: string; channel: string } | null> =>
    db.maybeOne<{ id: string; channel: string }>(
      `SELECT c.id, c.channel FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE l.preview_id = $1 ORDER BY c.opened_at DESC LIMIT 1`,
      [previewId],
    );

  /** Append the customer's own words to a conversation as an inbound message. */
  const recordInboundMessage = async (
    conversation: { id: string; channel: string },
    text: string,
    idempotencyKey: string,
  ): Promise<void> => {
    const hash = createHash("sha256").update(text).digest("hex");
    await db.query(
      `INSERT INTO messages (conversation_id, direction, channel, body_r2_key, body_hash, idempotency_key)
       VALUES ($1,'inbound',$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`,
      [conversation.id, conversation.channel, `inbound/change-request/${hash}`, hash, idempotencyKey],
    );
  };

  /** Shared validation for every free-text change request. */
  const readRequestText = (body: { requestText?: unknown }): { text: string } | { error: string } => {
    const text = typeof body.requestText === "string" ? body.requestText.trim() : "";
    if (!text) return { error: "requestText required" };
    if (text.length > MAX_REQUEST_TEXT) return { error: `requestText exceeds ${MAX_REQUEST_TEXT} characters` };
    return { text };
  };

  /** Claim a preview — the moment a stranger becomes a customer. */
  app.post("/previews/:claimToken/claim", async (c) => {
    const found = await resolvePreview(c.req.param("claimToken"));
    if ("status" in found) return c.json({ error: found.error }, found.status);
    const body = (await c.req.json().catch(() => ({}))) as {
      smsConsent?: boolean;
      phone?: string;
      consentWording?: string;
      pageVersion?: string;
    };

    await db.query("UPDATE previews SET claimed_at = COALESCE(claimed_at, now()) WHERE id = $1", [found.preview.id]);

    // The consent event is the legal artefact that makes a later SMS lawful. It
    // records what was shown, when, from where and on which version of the page
    // — a bare boolean would prove nothing.
    if (body.smsConsent === true) {
      await db.query(
        `INSERT INTO events (event_type, actor_kind, actor_id, subject_kind, subject_id, payload)
         VALUES ('consent.captured','customer',$1,'preview',$1,$2)`,
        [
          found.preview.id,
          JSON.stringify({
            timestamp: new Date().toISOString(),
            ip: clientIp(c),
            pageVersion: body.pageVersion ?? found.preview.label_version,
            wording: body.consentWording ?? DEFAULT_CONSENT_WORDING,
            channel: "sms",
            phone: body.phone ?? null,
          }),
        ],
      );
    }

    // Ignition. A claim is the moment a prospect becomes a customer, and until
    // this enqueue existed the claim was recorded and then nothing happened —
    // no build, no domain, no delivery. The worker turns it into a running
    // onboarding; the unique index makes a double-click a no-op.
    const lead = await db.maybeOne<{ id: string; business_id: string; region_code: string }>(
      `SELECT l.id, b.id AS business_id, b.region_code
         FROM leads l JOIN contacts ct ON ct.id = l.contact_id JOIN businesses b ON b.id = ct.business_id
        WHERE l.preview_id = $1 LIMIT 1`,
      [found.preview.id],
    );
    if (lead) {
      await enqueueIntent(db, {
        kind: "start",
        workflowType: "onboarding",
        executionId: executionId.onboarding(lead.id),
        payload: { leadId: lead.id, businessId: lead.business_id, region: lead.region_code },
      });
    }
    return c.json({ ok: true, claimed: true, onboardingQueued: Boolean(lead) });
  });

  /** A change request typed on the preview page, before there is any account. */
  app.post("/previews/:claimToken/changes", async (c) => {
    const found = await resolvePreview(c.req.param("claimToken"));
    if ("status" in found) return c.json({ error: found.error }, found.status);
    const body = (await c.req.json().catch(() => ({}))) as { requestText?: unknown };
    const parsed = readRequestText(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const prior = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE event_type = 'preview.change_requested' AND subject_id = $1",
      [found.preview.id],
    );
    if (Number(prior.n) >= MAX_CHANGES_PER_PREVIEW) {
      return c.json({ error: "too many change requests for this preview" }, 429);
    }

    const event = await db.one<{ event_id: string }>(
      `INSERT INTO events (event_type, actor_kind, actor_id, subject_kind, subject_id, payload)
       VALUES ('preview.change_requested','customer',$1,'preview',$1,$2) RETURNING event_id`,
      [found.preview.id, JSON.stringify({ requestText: parsed.text, ip: clientIp(c), round: Number(prior.n) + 1 })],
    );
    const conversation = await conversationForPreview(found.preview.id);
    if (conversation) await recordInboundMessage(conversation, parsed.text, `preview-change:${event.event_id}`);

    return c.json({ ok: true, queued: true, round: Number(prior.n) + 1 });
  });

  /** The friction-free opt-out. Public, idempotent, and it never asks why. */
  app.post("/previews/:claimToken/not-for-me", async (c) => {
    const preview = await db.maybeOne<{ id: string; business_id: string; takedown_at: string | null }>(
      "SELECT id, business_id, takedown_at FROM previews WHERE claim_token = $1",
      [c.req.param("claimToken")],
    );
    if (!preview) return c.json({ error: "unknown preview" }, 404);

    // Suppression first: it is the promise being made, and it must survive even
    // if the takedown update fails. Append-only, so a repeat is a no-op.
    const contact =
      (await db.maybeOne<{ email_hash: Buffer }>(
        `SELECT c.email_hash FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.preview_id = $1 LIMIT 1`,
        [preview.id],
      )) ??
      (await db.maybeOne<{ email_hash: Buffer }>(
        "SELECT email_hash FROM contacts WHERE business_id = $1 ORDER BY created_at LIMIT 1",
        [preview.business_id],
      ));
    if (contact) {
      await db.query(
        "INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'takedown','all') ON CONFLICT DO NOTHING",
        [contact.email_hash],
      );
    }

    const taken = await db.query(
      `UPDATE previews SET takedown_at = now(), takedown_reason = 'not_for_me'
       WHERE id = $1 AND takedown_at IS NULL RETURNING id`,
      [preview.id],
    );
    if (taken.rowCount > 0) {
      await db.query(
        `INSERT INTO events (event_type, actor_kind, actor_id, subject_kind, subject_id, payload)
         VALUES ('preview.not_for_me','customer',$1,'preview',$1,$2)`,
        [preview.id, JSON.stringify({ ip: clientIp(c), suppressed: Boolean(contact) })],
      );
    }
    return c.json({ ok: true, suppressed: Boolean(contact), takenDown: true });
  });

  // --- One-click unsubscribe (RFC 8058) -------------------------------------
  // The gate refuses to send a cold message without List-Unsubscribe and
  // List-Unsubscribe-Post headers. These two routes are what those headers point
  // at. Both are public, unauthenticated and idempotent; the POST must never
  // redirect, never ask for confirmation and never return anything but 2xx for a
  // valid token, because a mailbox provider calls it unattended and treats any
  // other outcome as a broken unsubscribe.
  const doUnsubscribe = async (rawToken: string): Promise<{ ok: boolean; suppressed: boolean }> => {
    const token = verifyUnsubscribeToken(rawToken, unsubscribeSecret());
    if (!token) return { ok: false, suppressed: false };
    const contact = await db.maybeOne<{ email_hash: Buffer }>(
      "SELECT email_hash FROM contacts WHERE id = $1",
      [token.contactId],
    );
    // A token that verifies but names a contact we deleted (DSAR erasure) is
    // still a successful unsubscribe from the recipient's point of view.
    if (!contact) return { ok: true, suppressed: false };
    const res = await db.query(
      "INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'unsubscribe','all') ON CONFLICT DO NOTHING",
      [contact.email_hash],
    );
    if ((res.rowCount ?? 0) > 0) {
      await db.query(
        `INSERT INTO events (event_type, actor_kind, actor_id, subject_kind, subject_id, payload)
         VALUES ('suppression.added','customer',$1,'contact',$1,$2)`,
        [token.contactId, JSON.stringify({ reason: "unsubscribe", campaignId: token.campaignId ?? null })],
      );
    }
    return { ok: true, suppressed: true };
  };

  app.post("/u/:token", async (c) => {
    const result = await doUnsubscribe(c.req.param("token"));
    if (!result.ok) return c.json({ error: "unknown token" }, 404);
    return c.json({ ok: true, unsubscribed: true });
  });

  // The human version of the same URL. One click, no form, no login — the page
  // confirms what already happened rather than asking whether to do it.
  app.get("/u/:token", async (c) => {
    const result = await doUnsubscribe(c.req.param("token"));
    const status = result.ok ? 200 : 404;
    const message = result.ok
      ? "You're unsubscribed. You won't hear from us again."
      : "That unsubscribe link isn't valid.";
    return c.html(unsubscribePage(message), status);
  });

  /** A change request from the customer dashboard, after the sale. */
  app.post("/customers/:customerId/revisions", async (c) => {
    const customerId = c.req.param("customerId");
    const user = c.get("user");
    const allowed = user && (user.role === "superadmin" || user.customerId === customerId);
    if (!allowed) return c.json({ error: "forbidden" }, 403);
    if (!UUID_RE.test(customerId)) return c.json({ error: "unknown customer" }, 404);
    const exists = await db.maybeOne("SELECT 1 AS x FROM customers WHERE id = $1", [customerId]);
    if (!exists) return c.json({ error: "unknown customer" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { requestText?: unknown };
    const parsed = readRequestText(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const prior = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM events WHERE event_type = 'customer.revision_requested' AND subject_id = $1",
      [customerId],
    );
    const round = Number(prior.n) + 1;
    const event = await db.one<{ event_id: string }>(
      `INSERT INTO events (event_type, actor_kind, actor_id, subject_kind, subject_id, payload)
       VALUES ('customer.revision_requested','customer',$1,'customer',$1,$2) RETURNING event_id`,
      [customerId, JSON.stringify({ requestText: parsed.text, round, requestedBy: user.email })],
    );
    const conversation = await db.maybeOne<{ id: string; channel: string }>(
      "SELECT id, channel FROM conversations WHERE customer_id = $1 ORDER BY opened_at DESC LIMIT 1",
      [customerId],
    );
    if (conversation) await recordInboundMessage(conversation, parsed.text, `customer-revision:${event.event_id}`);

    // Deliver to the onboarding execution if one is still parked on its revision
    // window; otherwise run the standalone revision workflow. The signal is the
    // preferred path because it consumes an included round in the same loop the
    // customer is already in.
    const parked = await db.maybeOne<{ id: string }>(
      `SELECT e.id FROM workflow_executions e
        WHERE e.type = 'onboarding' AND e.status = 'running'
          AND e.input->>'leadId' IN (SELECT l.id::text FROM leads l
                                       JOIN contacts ct ON ct.id = l.contact_id
                                       JOIN customers cu ON cu.business_id = ct.business_id
                                      WHERE cu.id = $1)
        LIMIT 1`,
      [customerId],
    );
    if (parked) {
      await enqueueIntent(db, {
        kind: "signal",
        workflowType: "onboarding",
        executionId: parked.id,
        signalName: "revision_requested",
        payload: { requestText: parsed.text },
      });
    } else {
      const build = await db.maybeOne<{ id: string; business_id: string }>(
        "SELECT id, business_id FROM builds WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1",
        [customerId],
      );
      // ⛔ NO BUILD MEANS NOTHING TO REVISE. This used to substitute `""` for
      // both ids and enqueue the workflow anyway, then answer `queued: true`.
      // The workflow died on the first activity that touched a uuid column and
      // nobody was told — the customer had been shown a confirmation, so the
      // one person who would have chased it believed it was in hand.
      //
      // A customer with no build and no running onboarding is already an
      // exceptional state (the onboarding died or never started), so it goes to
      // the operator queue. The request itself is safe either way: it is on the
      // event log and on the conversation above, so it is not lost — it is
      // waiting for a person rather than being applied by a machine.
      if (!build) {
        await db.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
           VALUES ('revision_without_build', 2, $1,
                   'change request recorded; no revision workflow started',
                   'The customer has no build to revise — check whether their onboarding failed, then apply the change once a build exists')`,
          [JSON.stringify({ customerId, round, requestText: parsed.text.slice(0, 500), eventId: event.event_id })],
        );
        return c.json({ ok: true, round, queued: false, status: "awaiting_build" });
      }
      await enqueueIntent(db, {
        kind: "start",
        workflowType: "revision",
        executionId: executionId.revision(customerId, round),
        payload: {
          customerId,
          businessId: build.business_id,
          buildId: build.id,
          requestText: parsed.text,
          round,
        },
      });
    }

    return c.json({ ok: true, round, queued: true });
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

    // ⛔ Read back what the GATE reads, not what we just wrote. The console used
    // to move the toggle on local state alone: an operator pulling
    // HALT_ALL_SENDING during an incident saw it turn red and go on sending.
    // A control that reports success without effect is worse than no control,
    // because it stops the operator looking for the real off switch.
    clearKillSwitchCache();
    const engagedNow = await readEngagedSwitches(db, Date.now());
    return c.json({
      ok: true,
      name,
      engaged: engage,
      // What the gate will actually deny on, straight from its own reader.
      confirmedByGate: engagedNow.has(name) === engage,
      engagedSwitches: [...engagedNow].sort(),
      // Other processes hold their own cache. Said out loud rather than implied,
      // because "it is engaged" and "it is engaged everywhere" differ by 10s.
      propagationSeconds: KILL_SWITCH_CACHE_SECONDS,
    });
  });

  app.get("/killswitch", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const rows = await db.query<{ name: string; engaged: boolean; toggled_by: string | null; toggled_at: Date | null }>(
      "SELECT name, engaged, toggled_by, toggled_at FROM kill_switches ORDER BY name",
    );
    clearKillSwitchCache();
    const engagedNow = await readEngagedSwitches(db, Date.now());
    return c.json({
      switches: rows.rows.map((r) => ({
        ...r,
        // ⛔ Per row. If the stored flag and the gate's own reader ever disagree,
        // the console says so on that switch rather than averaging it away.
        confirmedByGate: engagedNow.has(r.name) === r.engaged,
      })),
      // The switches that exist but have never been toggled have no row at all;
      // the console needs the full roster to render them as released.
      known: [...KILL_SWITCHES],
      propagationSeconds: KILL_SWITCH_CACHE_SECONDS,
      asOf: new Date().toISOString(),
    });
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

  // --- The console's read model --------------------------------------------
  //
  // Organised by the QUESTION an operator has, not by the table the answer
  // lives in. The six noun-shaped views these replace (exceptions, registry,
  // vendors, vault …) each named a table and none of them answered "what needs
  // me", "is it running" or "how is this customer doing".
  //
  // ⛔ Every payload carries `asOf`. A figure without a time is a figure whose
  // staleness cannot be seen, and staleness is this system's characteristic
  // failure.

  /** Everything the home surface needs, in one round trip. */
  app.get("/ops/now", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const now = new Date();
    // Settled, not all-or-nothing: one board failing must not blank the other
    // two. A home screen that renders empty on a single query error is
    // indistinguishable from a home screen with nothing to report.
    const [work, jobs, failures, spend] = await Promise.allSettled([
      worklist(db, now),
      jobBoard(db, now),
      recentJobFailures(db, 10),
      spendBoard(db, now),
    ]);
    const unwrap = <T,>(r: PromiseSettledResult<T>): { ok: true; data: T } | { ok: false; error: string } =>
      r.status === "fulfilled"
        ? { ok: true, data: r.value }
        : { ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    return c.json({
      asOf: now.toISOString(),
      worklist: unwrap(work),
      jobs: unwrap(jobs),
      recentFailures: unwrap(failures),
      spend: unwrap(spend),
    });
  });

  app.get("/ops/jobs", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const now = new Date();
    return c.json({
      asOf: now.toISOString(),
      jobs: await jobBoard(db, now),
      recentFailures: await recentJobFailures(db, 50),
    });
  });

  app.get("/ops/customers", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200)));
    return c.json(await customerBoard(db, new Date(), limit));
  });

  app.get("/ops/customers/:id", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const detail = await customerDetail(db, c.req.param("id"), new Date());
    if (detail === null) return c.json({ error: "unknown customer" }, 404);
    return c.json(detail);
  });

  app.get("/ops/spend", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const since = new Date(Date.now() - 30 * 86_400_000);
    return c.json({ ...(await spendBoard(db, new Date())), byRole: await costByRole(db, since) });
  });

  /** Models: the registry's champions beside what each role actually costs. */
  app.get("/ops/models", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const since = new Date(Date.now() - 30 * 86_400_000);
    return c.json({
      asOf: new Date().toISOString(),
      window: "last 30 days",
      registry: await registryStatus(db),
      cost: await costByRole(db, since),
    });
  });

  /**
   * ADW's own agents: contract, activity and whether each is halted.
   *
   * ⛔ The halt state is read from the gate's own switch reader rather than
   * from a separate table, so the console cannot show an agent as running while
   * the gate is refusing it.
   */
  app.get("/ops/agents", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const engaged = await readEngagedSwitches(db, Date.now());
    const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30)));
    return c.json(await agentBoard(db, new Date(), engaged, days));
  });

  /** One row per agent run — the granular record. */
  app.get("/ops/agents/invocations", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const agentId = c.req.query("agentId");
    return c.json({
      asOf: new Date().toISOString(),
      invocations: await invocations(db, {
        ...(agentId === undefined ? {} : { agentId }),
        injectionOnly: c.req.query("injection") === "1",
        escalatedOnly: c.req.query("escalated") === "1",
        retriedOnly: c.req.query("retried") === "1",
        limit: Number(c.req.query("limit") ?? 100),
      }),
    });
  });

  /** The agent DEPLOYED to each customer — a different thing from the roster above. */
  app.get("/ops/deployed-agents", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200)));
    return c.json(await deployedAgents(db, new Date(), limit));
  });

  /** The SMB outreach funnel, gate denials by rule, and the businesses reached. */
  app.get("/ops/outreach", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const now = new Date();
    const [funnel, gate] = await Promise.allSettled([outreachFunnel(db, now), gateSummary(db, now)]);
    return c.json({
      asOf: now.toISOString(),
      funnel: funnel.status === "fulfilled" ? { ok: true, data: funnel.value } : { ok: false, error: String(funnel.reason) },
      gate: gate.status === "fulfilled" ? { ok: true, data: gate.value } : { ok: false, error: String(gate.reason) },
    });
  });

  app.get("/ops/businesses", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const q = c.req.query("q");
    return c.json(
      await businessBoard(db, new Date(), {
        ...(q === undefined || q === "" ? {} : { q }),
        limit: Number(c.req.query("limit") ?? 100),
      }),
    );
  });

  /**
   * One business in full: every contact, every gate decision with the rule that
   * fired, every message, the provenance behind the contact and any preview.
   */
  app.get("/ops/businesses/:id", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const detail = await businessDetail(db, id, new Date());
    if (detail === null) return c.json({ error: "unknown business" }, 404);
    return c.json(detail);
  });

  /** The sending fleet: pools, warm-up and health. */
  app.get("/ops/fleet", async (c) => {
    if (!requireOperator(c)) return c.json({ error: "forbidden" }, 403);
    const assets = await db.query(
      `SELECT id, kind, provider, identifier, domain_class, pool, health, daily_cap,
              sends_today, warmup_started, first_send_at, retired_at, retire_reason
         FROM sending_assets WHERE retired_at IS NULL ORDER BY pool, health, identifier`,
    );
    // ⛔ The rates come with the counts they were divided by. A 0.00% complaint
    // rate over four sends is not a healthy fleet, it is an unmeasured one, and
    // the two are indistinguishable once the denominator is dropped.
    const window = await db.one<{ sent: string; bounced: string; complained: string }>(
      `SELECT count(*) FILTER (WHERE event_type = 'email.sent')       AS sent,
              count(*) FILTER (WHERE event_type = 'email.bounced')    AS bounced,
              count(*) FILTER (WHERE event_type = 'email.complained') AS complained
         FROM events
        WHERE event_type IN ('email.sent','email.bounced','email.complained')
          AND occurred_at >= now() - interval '30 days'`,
    );
    const sent = Number(window.sent);
    return c.json({
      asOf: new Date().toISOString(),
      window: "last 30 days",
      assets: assets.rows,
      deliverability: {
        sent,
        bounced: Number(window.bounced),
        complained: Number(window.complained),
        // ⛔ Null, not 0, when nothing was sent. A rate over an empty
        // denominator is undefined, and rendering it as 0.00% is the exact
        // lie this console exists to stop telling.
        bounceRate: sent === 0 ? null : Number(window.bounced) / sent,
        complaintRate: sent === 0 ? null : Number(window.complained) / sent,
      },
      retired: (await db.one<{ n: string }>(
        "SELECT count(*) AS n FROM sending_assets WHERE retired_at IS NOT NULL",
      )).n,
    });
  });

  // --- Webhooks: signature-verified and idempotent --------------------------
  app.post("/webhooks/:provider", async (c) => {
    const provider = c.req.param("provider");
    const raw = await c.req.text();
    const verdict = await authenticateWebhook(
      { provider, raw, header: (name) => c.req.header(name) },
      // ⛔ The shared-secret path is for our simulators only. A live deployment
      // accepting it would give anyone holding ADW_WEBHOOK_SECRET the ability to
      // forge a hard bounce and suppress any address.
      { simulated: deps.forceMock ?? true },
    );
    if (!verdict.ok) {
      // ⛔ Record the refusal. A misconfigured topic ARN and an actual forgery
      // are both 401s from outside, and the difference only exists in here —
      // the previous scheme rejected every genuine notification silently for
      // months because nothing counted the rejections.
      await db.query(
        "INSERT INTO events (event_type, actor_kind, actor_id, payload) VALUES ('webhook.rejected','system',$1,$2)",
        [provider, JSON.stringify({ reason: verdict.reason, bytes: raw.length })],
      );
      return c.json({ error: "invalid signature", reason: verdict.reason }, 401);
    }
    // An SNS subscription that is never confirmed delivers nothing, forever,
    // and reports no error at either end. Confirming is the handshake that
    // turns a configured topic into a live one.
    if (verdict.kind === "subscription_confirmation") {
      const confirmed = await fetch(verdict.subscribeUrl, { method: "GET" })
        .then((r) => r.ok)
        .catch(() => false);
      await db.query(
        "INSERT INTO events (event_type, actor_kind, actor_id, payload) VALUES ('webhook.subscription_confirmed','system',$1,$2)",
        [provider, JSON.stringify({ confirmed })],
      );
      if (!confirmed) {
        await db.query(
          `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
           VALUES ('webhook_subscription_unconfirmed', 2, $1, 'confirmation fetch failed',
                   'Confirm the SNS subscription by hand; until it is confirmed no bounce or complaint reaches suppression')`,
          [JSON.stringify({ provider })],
        );
      }
      return c.json({ received: true, subscriptionConfirmed: confirmed });
    }
    let payload: { id?: string; type?: string };
    try {
      payload = JSON.parse(raw) as { id?: string; type?: string };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    // Idempotent: the same event id is accepted once and acknowledged thereafter.
    // The dedupe row is written BEFORE the effects run, so a provider retrying
    // after a timeout cannot double-advance dunning or double-suppress.
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

    // The effects are what make this endpoint more than an acknowledgement:
    // complaints and hard bounces reach the suppression ledger, and delivery
    // feedback reaches the columns the deliverability loop scores assets from.
    // A handler failure is logged and still acknowledged — a 500 would make the
    // provider retry an event we have already deduped, and the retry would then
    // be swallowed as a duplicate, losing it permanently.
    let outcome: Awaited<ReturnType<typeof applyWebhookEffects>> = { handled: false, effects: [] };
    try {
      outcome = await applyWebhookEffects(db, provider, JSON.parse(raw), {
        // ⛔ Wired here, not defaulted inside the handler. An inbound rail that
        // silently no-ops is the state this system was already in — replies
        // acknowledged with 200 and read by nobody.
        routeInbound: async (mime) =>
          routeInbound(mime, {
            db,
            replyTokenSecret: replyTokenSecret(),
            // ⛔ Only reached for a message already classified as written by a
            // human. An auto-reply never costs a model call and never scores.
            respond: async ({ text, subject }) => {
              const out = await emailResponderAgent.run(
                { message: text, businessName: "", ourLastSubject: subject },
                { db, vault, forceMock: deps.forceMock ?? true },
              );
              return {
                intent: out.result.intentScore,
                disposition: out.result.disposition,
                replyText: out.result.replyText,
                requestsNoContact: out.result.requestsNoContact,
                escalate: out.result.escalate,
                escalateReason: out.result.escalateReason,
              };
            },
            // Through the outbox, not straight at the engine: the API and the
            // worker are different processes, and only one of them replays
            // journals.
            signalWorkflow: async (workflowId, name, payload) => {
              await enqueueIntent(db, {
                kind: "signal",
                workflowType: "lead",
                executionId: workflowId,
                signalName: name,
                payload: payload as Record<string, unknown>,
              });
            },
          }),
      });
    } catch (err) {
      await db.query(
        `INSERT INTO exceptions (trigger, severity, context, system_action, recommendation)
         VALUES ('webhook_handler_failed', 2, $1, 'event acknowledged; effects not applied',
                 'Replay this event by hand after fixing the handler')`,
        [JSON.stringify({ provider, eventId, error: String(err) })],
      );
    }
    return c.json({ received: true, duplicate: false, handled: outcome.handled, effects: outcome.effects });
  });

  return app;
}

/**
 * The unsubscribe confirmation page. Deliberately self-contained: no bundle, no
 * fonts, no analytics. It is reached from an email client's in-app browser on a
 * bad connection, and it must render instantly and identically forever.
 */
function unsubscribePage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Unsubscribe</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#f6f8fa; color:#1c2530; padding:24px; }
  main { max-width:32rem; text-align:center; background:#fff; border-radius:14px;
         padding:40px 32px; box-shadow:0 1px 3px rgba(16,24,40,.08); }
  h1 { font-size:1.375rem; margin:0 0 12px; }
  p { margin:0; color:#4a5666; }
  @media (prefers-color-scheme: dark) {
    body { background:#11161d; color:#e8edf4; }
    main { background:#1a212b; box-shadow:none; }
    p { color:#a6b2c2; }
  }
</style></head>
<body><main><h1>${escapeHtml(message)}</h1>
<p>Nothing else is needed — this is already recorded.</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

/**
 * The secret that signs plus-addressed Reply-To tokens.
 *
 * ⛔ Rotating it orphans every in-flight thread — a reply minted under the old
 * secret fails verification and lands in the exception queue rather than on its
 * conversation. That is the correct failure (a forged token must not attach a
 * message to someone else's thread) but it is not a free operation, so the
 * default is only acceptable in demo mode.
 */
export function replyTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env["ADW_REPLY_TOKEN_SECRET"] ?? "demo-reply-token-secret";
}

/**
 * Sign a payload the way OUR simulators sign.
 *
 * ⛔ This is not how Amazon or Stripe sign, and it never was. Verification now
 * lives in `./webhook-auth.ts`, which picks the scheme by provider; this stays
 * only so the mock rail and its tests have something to produce.
 */
export function signPayload(raw: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

/**
 * Whether this process is pinned to mock adapters.
 *
 * This used to be hardcoded true, which meant a deploy holding real credentials
 * would still quietly talk to simulators — the system would look healthy and
 * send nothing. Now it is a decision, in this order:
 *
 *   1. ADW_FORCE_MOCK=1 pins mocks on (used by the demo and by CI).
 *   2. ADW_ENV=local|test defaults to mocks, so a developer cannot bill a card.
 *   3. Anywhere else, adapters resolve per vendor from vault credential
 *      presence: a vendor with keys deposited goes live, one without stays
 *      mocked. That is the switch the Settings screen is flipping.
 */
export function resolveForceMock(env: NodeJS.ProcessEnv = process.env): boolean {
  const pinned = env["ADW_FORCE_MOCK"];
  if (pinned === "1" || pinned === "true") return true;
  if (pinned === "0" || pinned === "false") return false;
  const mode = env["ADW_ENV"] ?? "production";
  return mode === "local" || mode === "test";
}

/**
 * Build the app with real dependencies (server entrypoint + scripts). The db
 * handle comes back with it so the entrypoint can drain the pool on SIGTERM.
 */
export async function buildApp(): Promise<{ app: Hono<{ Variables: Vars }>; db: Db }> {
  const db = await createDb({});
  const vault = new LocalPgBackend(db, new LocalKeyWrapper(process.env.ADW_VAULT_MASTER_KEY ?? "0".repeat(64)));
  return { app: createApp({ db, vault, forceMock: resolveForceMock() }), db };
}
