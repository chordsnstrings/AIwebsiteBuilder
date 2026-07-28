// The runtime surface of the product (§37.5, §38.3, §39).
//
// Four things hang off here, and three of them are public by design because the
// people using them are the customer's customers, not ours:
//
//   POST /agent/turn        the chat widget on their site and on the preview
//   POST /api/enquiry       the no-JS form the same widget degrades into
//   GET  /.well-known/mcp   the manifest an AI assistant discovers
//   POST /.well-known/mcp   the tool call it then makes
//
// ⛔ The MCP endpoint is NOT a privileged caller. It resolves the same pack,
// the same refusal policy and the same coverage rule as the chat widget,
// because a machine surface that could answer more than the human one would
// become the way around the guardrails. `handleMcpCall` takes the refusal
// checker by injection precisely so there is one implementation to reach for.
//
// The owner-facing routes (gap list, gap approval) are authenticated and are
// the only way a new answer enters a pack.

import { Hono } from "hono";
import type { Db } from "@adw/db";
import {
  contextFromPack,
  handleTurn,
  loadSession,
  openGaps,
  openSession,
  refusalPolicy,
  type ConciergeContext,
  type ConciergeDeps,
} from "@adw/concierge";
import { loadQAPack, type QAPack } from "@adw/qapack";
import { handleMcpCall, mcpManifest, MCP_TOOLS, type McpContext, type RefusalChecker } from "@adw/mcp";
import type { SessionUser } from "@adw/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longer than any real question and short enough that a body is not a payload. */
const MAX_QUESTION = 1000;

export interface AgentRouteDeps {
  db: Db;
  concierge?: Omit<ConciergeDeps, "db">;
  /** Test hook, mirroring createApp. */
  authOverride?: SessionUser | null;
}

// ---------------------------------------------------------------------------
// Resolving a customer's live agent
// ---------------------------------------------------------------------------

export interface LiveAgent {
  pack: QAPack;
  vertical: string;
  capabilities: string[];
  calendarConnected: boolean;
  kbSlice: string[];
  businessId: string;
  businessName: string;
}

/**
 * Packs are immutable once approved and a turn must not pay to re-read one, so
 * they are held per process, keyed by pack id. A new pack is a new id, which is
 * what makes the cache safe: there is no invalidation to get wrong.
 */
const packCache = new Map<string, QAPack>();

async function cachedPack(db: Db, packId: string): Promise<QAPack | null> {
  const hit = packCache.get(packId);
  if (hit !== undefined) return hit;
  const pack = await loadQAPack(db, packId);
  if (pack !== null && pack.approvedAt instanceof Date) packCache.set(packId, pack);
  return pack;
}

/** Exposed for tests and for the worker, which rebuilds a pack after approval. */
export function forgetPack(packId: string): void {
  packCache.delete(packId);
}

/**
 * ⛔ Only an APPROVED pack is served. An unapproved one resolves to null and
 * every surface 404s rather than falling back to a draft — a draft answering
 * the public on a business's behalf is exactly what the sign-off prevents.
 */
export async function loadLiveAgent(db: Db, customerId: string): Promise<LiveAgent | null> {
  const row = await db.maybeOne<{
    pack_id: string;
    business_id: string;
    business_name: string;
    vertical: string | null;
  }>(
    `SELECT p.id AS pack_id, b.id AS business_id, b.name AS business_name, b.vertical
       FROM qa_packs p
       JOIN customers c ON c.id = p.customer_id
       JOIN businesses b ON b.id = c.business_id
      WHERE p.customer_id = $1 AND p.approved_at IS NOT NULL
      ORDER BY p.version DESC
      LIMIT 1`,
    [customerId],
  );
  if (row === null) return null;
  const pack = await cachedPack(db, row.pack_id);
  if (pack === null || !(pack.approvedAt instanceof Date)) return null;

  const manifest = await db.maybeOne<{ agent_capabilities: string[]; vertical: string }>(
    `SELECT agent_capabilities, vertical FROM delivery_manifests
      WHERE customer_id = $1 OR business_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [customerId, row.business_id],
  );
  const calendar = await db.maybeOne<{ id: string }>(
    `SELECT id FROM customer_calendars WHERE customer_id = $1 AND revoked_at IS NULL LIMIT 1`,
    [customerId],
  );
  // Only VERIFIED facts reach the fallback. A claimed-but-unverified fact is
  // the business's assertion, not ours to repeat when a model is composing.
  const facts = await db.query<{ value: string }>(
    `SELECT f.value FROM kb_facts f
       JOIN knowledge_bases k ON k.id = f.kb_id
      WHERE k.id = $1 AND f.status = 'verified'
      ORDER BY f.fact_key`,
    [pack.kbId],
  );

  return {
    pack,
    vertical: manifest?.vertical ?? row.vertical ?? pack.vertical,
    capabilities: manifest?.agent_capabilities ?? ["answer", "capture_enquiry", "escalate"],
    calendarConnected: calendar !== null,
    kbSlice: facts.rows.map((f) => f.value),
    businessId: row.business_id,
    businessName: row.business_name,
  };
}

function contextFor(agent: LiveAgent, session: Awaited<ReturnType<typeof openSession>>): ConciergeContext {
  return contextFromPack(agent.pack, session, {
    vertical: agent.vertical,
    capabilities: agent.capabilities,
    calendarConnected: agent.calendarConnected,
    kbSlice: agent.kbSlice,
  });
}

// ---------------------------------------------------------------------------

export function agentRoutes(deps: AgentRouteDeps): Hono<{ Variables: { user: SessionUser | null } }> {
  const app = new Hono<{ Variables: { user: SessionUser | null } }>();
  const { db } = deps;
  const conciergeDeps: ConciergeDeps = { db, ...(deps.concierge ?? {}) };

  const user = (c: { get: (k: "user") => SessionUser | null }): SessionUser | null =>
    deps.authOverride !== undefined ? deps.authOverride : c.get("user");

  // --- Opening a conversation ----------------------------------------------
  app.post("/agent/session", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { customerId?: string; previewId?: string; channel?: string };
    if (b.customerId !== undefined && !UUID_RE.test(b.customerId)) return c.json({ error: "bad customerId" }, 400);
    if (b.previewId !== undefined && !UUID_RE.test(b.previewId)) return c.json({ error: "bad previewId" }, 400);
    if (b.customerId === undefined && b.previewId === undefined) {
      return c.json({ error: "customerId or previewId required" }, 400);
    }
    const channel = b.channel === "whatsapp" || b.channel === "mcp" || b.channel === "voice" ? b.channel : "web";

    let businessId: string | undefined;
    if (b.customerId !== undefined) {
      const agent = await loadLiveAgent(db, b.customerId);
      if (agent === null) return c.json({ error: "no approved agent for this customer" }, 404);
      businessId = agent.businessId;
    }
    const session = await openSession(db, {
      ...(b.customerId === undefined ? {} : { customerId: b.customerId }),
      ...(b.previewId === undefined ? {} : { previewId: b.previewId }),
      ...(businessId === undefined ? {} : { businessId }),
      channel,
    });
    return c.json({ sessionId: session.id, turnIndex: 0 });
  });

  // --- One turn -------------------------------------------------------------
  app.post("/agent/turn", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string;
      question?: string;
      turnIndex?: number;
      hasAttachment?: boolean;
    };
    if (!b.sessionId || !UUID_RE.test(b.sessionId)) return c.json({ error: "sessionId required" }, 400);
    const question = (b.question ?? "").trim();
    if (question.length === 0) return c.json({ error: "question required" }, 400);
    // Truncating rather than rejecting would silently answer a different
    // question from the one that was asked.
    if (question.length > MAX_QUESTION) return c.json({ error: "question too long" }, 413);

    const session = await loadSession(db, b.sessionId);
    if (session === null) return c.json({ error: "unknown session" }, 404);
    if (session.customerId === undefined) return c.json({ error: "session has no customer" }, 409);

    const agent = await loadLiveAgent(db, session.customerId);
    if (agent === null) return c.json({ error: "no approved agent for this customer" }, 404);

    const turn = await handleTurn(conciergeDeps, contextFor(agent, session), question, {
      ...(b.hasAttachment === undefined ? {} : { hasAttachment: b.hasAttachment }),
      // The caller's index if it sent one — that is what makes a retried
      // request idempotent — otherwise the next one in the transcript.
      turnIndex: typeof b.turnIndex === "number" ? b.turnIndex : session.turnIndex,
    });

    return c.json({
      answer: turn.answer,
      route: turn.route,
      answeredFrom: turn.answeredFrom,
      refused: turn.refused,
      escalated: turn.escalate,
      urgency: turn.urgency,
      // ⛔ Never returned: retrievalScore and pairId. They are the customer's
      // evidence, stored on the turn, and a public endpoint that reported them
      // would hand an attacker a similarity oracle for probing the pack.
      turnIndex: typeof b.turnIndex === "number" ? b.turnIndex : session.turnIndex,
      effect: turn.effect ?? null,
    });
  });

  // --- The no-JS path the widget degrades into ------------------------------
  //
  // The widget's form posts here with a normal browser submit when JavaScript
  // never ran. It has to work, because the visitor who most needs to reach a
  // trade is often the one on the worst connection.
  app.post("/api/enquiry", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
      : Object.fromEntries(await c.req.formData());
    const customerId = String(body["customerId"] ?? "");
    const question = String(body["question"] ?? body["need"] ?? "").trim();
    if (!UUID_RE.test(customerId)) return c.json({ error: "customerId required" }, 400);
    if (question.length === 0) return c.json({ error: "question required" }, 400);

    const agent = await loadLiveAgent(db, customerId);
    if (agent === null) return c.json({ error: "no approved agent for this customer" }, 404);
    const session = await openSession(db, { customerId, businessId: agent.businessId, channel: "web" });
    const turn = await handleTurn(conciergeDeps, contextFor(agent, session), question.slice(0, MAX_QUESTION));

    // A form post gets a page, not JSON — the browser is going to render
    // whatever comes back.
    if (!contentType.includes("application/json")) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>${escapeHtml(agent.businessName)}</title>` +
          `<main style="font:16px/1.6 system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem">` +
          `<p>${escapeHtml(turn.answer)}</p><p><a href="/">Back</a></p></main>`,
      );
    }
    return c.json({ answer: turn.answer, sessionId: session.id, refused: turn.refused });
  });

  // --- MCP ------------------------------------------------------------------
  const mcpContext = async (customerId: string): Promise<McpContext | null> => {
    const agent = await loadLiveAgent(db, customerId);
    if (agent === null) return null;
    const policy = refusalPolicy(agent.vertical);
    // ⛔ The identical object the chat widget consults. Not a copy of its rules.
    const refusals: RefusalChecker = { check: (q, ctx) => policy.check(q, ctx) };

    const facts = await db.query<{ fact_key: string; value: string; status: string }>(
      `SELECT fact_key, value, status FROM kb_facts WHERE kb_id = $1 ORDER BY fact_key`,
      [agent.pack.kbId],
    );
    const business = await db.one<{ name: string; phone_e164: string | null; city: string | null }>(
      `SELECT name, phone_e164, city FROM businesses WHERE id = $1`,
      [agent.businessId],
    );

    return {
      vertical: agent.vertical,
      business: {
        name: business.name,
        ...(business.phone_e164 === null ? {} : { phone: business.phone_e164 }),
        ...(business.city === null ? {} : { addressLocality: business.city }),
      },
      // Services and prices come from facts, and a fact with no price stays
      // priceless — `publishedServices` marks that explicitly rather than
      // letting an assistant read a missing field as free.
      services: facts.rows
        .filter((f) => f.fact_key.startsWith("service"))
        .map((f) => ({ name: f.value, description: f.value })),
      facts: facts.rows.map((f) => ({
        factKey: f.fact_key,
        value: f.value,
        status: (f.status === "verified" || f.status === "stale" || f.status === "inferred"
          ? f.status
          : "claimed_unverified") as "verified" | "claimed_unverified" | "stale" | "inferred",
      })),
      areaServed: facts.rows.filter((f) => f.fact_key.startsWith("area")).map((f) => f.value),
      calendarConnected: agent.calendarConnected,
      refusals,
    };
  };

  app.get("/.well-known/mcp", async (c) => {
    const customerId = c.req.query("customerId") ?? "";
    if (!UUID_RE.test(customerId)) return c.json({ error: "customerId required" }, 400);
    const ctx = await mcpContext(customerId);
    if (ctx === null) return c.json({ error: "no approved agent for this customer" }, 404);
    return c.json(mcpManifest(ctx));
  });

  app.post("/.well-known/mcp", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { customerId?: string; tool?: string; arguments?: unknown };
    if (!b.customerId || !UUID_RE.test(b.customerId)) return c.json({ error: "customerId required" }, 400);
    const ctx = await mcpContext(b.customerId);
    if (ctx === null) return c.json({ error: "no approved agent for this customer" }, 404);
    const result = await handleMcpCall(String(b.tool ?? ""), b.arguments, ctx);
    // A refusal is a 200 with `ok: false`. An assistant retrying a 4xx would
    // hammer a refusal that is never going to change.
    return c.json(result, result.ok ? 200 : result.reason === "unknown_tool" ? 404 : 200);
  });

  app.get("/mcp/tools", (c) => c.json({ tools: MCP_TOOLS }));

  // --- The owner's gap list -------------------------------------------------
  app.get("/agent/:customerId/gaps", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    return c.json({ gaps: await openGaps(db, { customerId }) });
  });

  /**
   * ⛔ The ONLY route by which an answer enters a pack, and it requires a human.
   *
   * There is deliberately no auto-promotion: a system that promotes its own
   * drafts is a system learning its own hallucinations, and by the second round
   * there is nothing left to check them against. The drafted answer is a
   * suggestion; what gets stored is what the owner sends back.
   */
  app.post("/agent/gaps/:gapId/approve", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const gapId = c.req.param("gapId");
    if (!UUID_RE.test(gapId)) return c.json({ error: "bad gapId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { answer?: string };
    const answer = (b.answer ?? "").trim();
    if (answer.length === 0) return c.json({ error: "answer required" }, 400);

    const gap = await db.maybeOne<{ id: string; customer_id: string | null; question: string; status: string }>(
      `SELECT id, customer_id, question, status FROM agent_gaps WHERE id = $1`,
      [gapId],
    );
    if (gap === null) return c.json({ error: "unknown gap" }, 404);
    if (gap.status === "approved") return c.json({ error: "already approved" }, 409);

    // The refusal policy applies to an owner's words too. They may not instruct
    // their agent to guarantee an arrival time any more than we may.
    const customerId = gap.customer_id;
    const vertical = customerId === null ? "" : (await loadLiveAgent(db, customerId))?.vertical ?? "";
    const blocked = refusalPolicy(vertical).guardAnswer(answer, { grounded: true });
    if (blocked !== null) return c.json({ error: `That answer cannot be published: ${blocked}` }, 422);

    await db.query(
      `UPDATE agent_gaps SET drafted_answer = $2, status = 'approved', approved_at = now(), approved_by = $3
        WHERE id = $1`,
      [gapId, answer, operator.email],
    );
    // The pair is written into the next pack version by the worker, not here —
    // a pack is immutable once approved, and editing one in place would change
    // what a stored answer was signed off against.
    return c.json({ ok: true, gapId, question: gap.question, queuedForNextPack: true });
  });

  return app;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}
