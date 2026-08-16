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
import { approvePack, loadQAPack, type QAPack } from "@adw/qapack";
import {
  UnsupportedUploadError,
  acceptUpload,
  attachDocument,
  loadRequest,
  readUpload,
  type UploadDeps,
} from "@adw/uploads";
import {
  activeRuns,
  cancelReminder,
  journeyEvent,
  journeysFor,
  scheduleReminder,
  startJourney,
  stopJourney,
  upcomingReminders,
} from "@adw/journeys";
import { cancelBooking, claimSlot } from "@adw/scheduling";
import {
  acknowledgeFinding,
  dismissFinding,
  openFindings,
  pauseWatch,
  subscribeWatch,
  watchBoard,
  watchesFor,
  type Collectors,
} from "@adw/watch";
import { handleMcpCall, mcpManifest, MCP_TOOLS, type McpContext, type RefusalChecker } from "@adw/mcp";
import type { SessionUser } from "@adw/auth";
import { enqueueIntent, executionId } from "@adw/workflows";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longer than any real question and short enough that a body is not a payload. */
const MAX_QUESTION = 1000;

export interface AgentRouteDeps {
  db: Db;
  concierge?: Omit<ConciergeDeps, "db">;
  /** Test hook, mirroring createApp. */
  authOverride?: SessionUser | null;
  /** Absent means the upload routes refuse with 503 rather than silently
   *  accepting files nothing stores. */
  uploads?: UploadDeps;
  /** ⛔ Absent means the watch routes refuse with 503. The same rule as
   *  uploads: a subscription this deployment cannot collect looks identical on
   *  every board to one that runs and finds nothing. */
  watchCollectors?: Collectors;
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

  // -------------------------------------------------------------------------
  // Pack review and sign-off — the step without which nothing ships
  // -------------------------------------------------------------------------
  //
  // ⛔ These two routes are the reason no customer agent could ever go live.
  //
  // `agent_eval_gate` refuses a pack whose `approved_at` is null, and it gives
  // no partial credit — so `deploy_customer_site`, `cutover_dns` and
  // `send_delivery_email` were all unreachable and every onboarding terminated
  // at `raise_onboarding_exception`. `approvePack()` was written, tested and
  // exported, and nothing in production called it.
  //
  // The tell was in the nightly checks the whole time: eval-nightly asserts
  // "No Q&A pack went live without the owner approving it" and PASSED, because
  // no pack ever reached the gate. An invariant that holds because the thing it
  // guards never happens.

  /** What the owner reads before signing. Their words, back to them. */
  app.get("/agent/packs/:packId", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const packId = c.req.param("packId");
    if (!UUID_RE.test(packId)) return c.json({ error: "bad packId" }, 400);
    const pack = await loadQAPack(db, packId);
    if (pack === null) return c.json({ error: "unknown pack" }, 404);
    return c.json({
      packId: pack.id,
      version: pack.version,
      pairCount: pack.pairs.length,
      thin: pack.thin,
      approvedAt: pack.approvedAt ?? null,
      approvedBy: pack.approvedBy ?? null,
      // ⛔ Every pair, never a sample. This is the artefact that decides what
      // the agent may say on their behalf, and an owner who signed off a
      // summary has not signed off the pack.
      pairs: pack.pairs.map((p) => ({
        id: p.id,
        question: p.question,
        answer: p.answer,
        source: p.source,
        grounded: (p.sourceFactIds ?? []).length > 0,
      })),
    });
  });

  app.post("/agent/packs/:packId/approve", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const packId = c.req.param("packId");
    if (!UUID_RE.test(packId)) return c.json({ error: "bad packId" }, 400);

    const pack = await loadQAPack(db, packId);
    if (pack === null) return c.json({ error: "unknown pack" }, 404);

    // ⛔ An empty pack cannot be approved. The eval gate would fail it anyway,
    // but failing here says why in words the owner can act on rather than
    // leaving them an exception row they never see.
    if (pack.pairs.length === 0) {
      return c.json({ error: "This pack has no answers in it yet — nothing to approve." }, 422);
    }

    const approval = await approvePack(db, packId, operator.email);

    // Release the onboarding workflow, which has been parked on this signal.
    // Through the outbox, not the engine: the API and the worker are separate
    // processes and only one of them replays journals.
    const lead = await db.maybeOne<{ id: string }>(
      `SELECT l.id
         FROM qa_packs p
         JOIN contacts ct ON ct.business_id = p.business_id
         JOIN leads l ON l.contact_id = ct.id
        WHERE p.id = $1
        ORDER BY l.entered_state_at DESC LIMIT 1`,
      [packId],
    );
    if (lead !== null) {
      await enqueueIntent(db, {
        kind: "signal",
        workflowType: "onboarding",
        executionId: executionId.onboarding(lead.id),
        signalName: "approved",
        payload: { approvedBy: operator.email, packId },
      });
    }

    await db.query(
      `INSERT INTO events (event_type, actor_kind, actor_id, payload)
       VALUES ('qa_pack.approved', 'customer', $1, $2)`,
      [operator.email, JSON.stringify({ packId, pairsApproved: approval.pairsApproved })],
    );

    return c.json({
      ok: true,
      packId,
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
      pairsApproved: approval.pairsApproved,
      // False here is worth surfacing: the pack is signed but the workflow was
      // not found, so a human has to start onboarding by hand.
      onboardingReleased: lead !== null,
    });
  });

  // -------------------------------------------------------------------------
  // Uploads (MF6, MF9) — the primitive 112 catalogue units were blocked on
  // -------------------------------------------------------------------------
  //
  // ⛔ There was no upload route anywhere in the API. Not a stub, not a
  // half-built one: none. 100 document-collection units and 12 vision units
  // were dead on arrival for want of a way to receive a file.
  //
  // Public by design, like the rest of the visitor surface — a customer sending
  // photographs of a leak has no account. The protections are content sniffing,
  // size caps, a scan gate that fails closed, and unguessable keys, NOT a login.

  app.post("/agent/uploads", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null) return c.json({ error: "expected a multipart form" }, 400);
    const file = form.get("file");
    if (typeof file === "string" || file === null) return c.json({ error: "no file in the form" }, 400);

    const sessionId = form.get("sessionId");
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
      return c.json({ error: "a valid sessionId is required" }, 400);
    }
    const session = await loadSession(db, sessionId);
    if (session === null) return c.json({ error: "unknown session" }, 404);

    if (deps.uploads === undefined) {
      // ⛔ Refused loudly rather than accepted and dropped. A 200 on an upload
      // nobody stored is the shape of bug this whole audit kept finding.
      return c.json({ error: "uploads are not configured on this deployment" }, 503);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const accepted = await acceptUpload(
        {
          bytes,
          declaredName: file.name ?? "upload",
          ...(session.customerId === undefined ? {} : { customerId: session.customerId }),
          ...(session.businessId === undefined ? {} : { businessId: session.businessId }),
          sessionId: session.id,
          uploadedBy: "visitor",
        },
        deps.uploads,
      );
      return c.json({
        uploadId: accepted.id,
        kind: accepted.kind,
        bytes: accepted.bytes,
        deduplicated: accepted.deduplicated,
        // ⛔ Never the storage key. It is the capability — anyone holding it and
        // a bucket URL has the file.
      });
    } catch (err) {
      if (err instanceof UnsupportedUploadError) return c.json({ error: err.message }, 415);
      throw err;
    }
  });

  /** Owner-only. Every read is logged before the bytes move. */
  app.get("/agent/uploads/:uploadId", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const uploadId = c.req.param("uploadId");
    if (!UUID_RE.test(uploadId)) return c.json({ error: "bad uploadId" }, 400);
    if (deps.uploads === undefined) return c.json({ error: "uploads are not configured" }, 503);
    try {
      const found = await readUpload(uploadId, operator.email, deps.uploads);
      c.header("content-type", found.mime);
      // ⛔ Always an attachment, never inline. A PDF rendered inline on our
      // origin is a script running on our origin.
      c.header("content-disposition", `attachment; filename="${found.name.replace(/"/g, "")}"`);
      c.header("x-content-type-options", "nosniff");
      return c.body(new Uint8Array(found.bytes));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "unavailable" }, 404);
    }
  });

  /** What is still outstanding on a document request. Public via the session
   *  that owns it, because the person filling it in has no account. */
  app.get("/agent/documents/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    if (!UUID_RE.test(requestId)) return c.json({ error: "bad requestId" }, 400);
    const record = await loadRequest(db, requestId);
    if (record === null) return c.json({ error: "unknown request" }, 404);
    return c.json({
      requestId: record.id,
      label: record.label,
      state: record.state,
      outstanding: record.outstanding,
      // ⛔ `received`, never `valid`. The clerk collects; it performs no
      // assessment, and a status word implying otherwise moves the customer's
      // professional judgement onto us.
      received: record.received.map((r) => ({ key: r.key, label: r.label, status: "received" })),
    });
  });

  app.post("/agent/documents/:requestId/items/:itemKey", async (c) => {
    const requestId = c.req.param("requestId");
    const itemKey = c.req.param("itemKey");
    if (!UUID_RE.test(requestId)) return c.json({ error: "bad requestId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { uploadId?: string; expiresOn?: string; note?: string };
    if (typeof b.uploadId !== "string" || !UUID_RE.test(b.uploadId)) {
      return c.json({ error: "a valid uploadId is required" }, 400);
    }
    const expires = b.expiresOn === undefined ? undefined : new Date(b.expiresOn);
    if (expires !== undefined && Number.isNaN(expires.getTime())) {
      return c.json({ error: "expiresOn is not a date" }, 400);
    }
    const out = await attachDocument(db, requestId, itemKey, b.uploadId, {
      expiresOn: expires,
      note: b.note,
    });
    if (!out.attached) return c.json({ error: "no such item on that request" }, 404);
    return c.json({ ok: true, complete: out.complete });
  });

  // -------------------------------------------------------------------------
  // Bookings (MF10), clocks (MF4) and journeys (MF5)
  // -------------------------------------------------------------------------
  //
  // ⛔ `claimSlot` had ZERO callers. Written, tested, exported, and reachable
  // from nothing — the same defect as `approvePack`, one family later. The
  // concierge could offer three times and then had no way to take one.

  /** Public via the session, like uploads: the person booking has no account. */
  app.post("/agent/bookings", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string; resourceId?: string; start?: string; end?: string;
      contact?: string; idempotencyKey?: string;
    };
    if (typeof b.sessionId !== "string" || !UUID_RE.test(b.sessionId)) {
      return c.json({ error: "a valid sessionId is required" }, 400);
    }
    const session = await loadSession(db, b.sessionId);
    if (session === null) return c.json({ error: "unknown session" }, 404);
    if (session.customerId === undefined) return c.json({ error: "session is not bound to a business" }, 409);
    if (typeof b.resourceId !== "string" || !UUID_RE.test(b.resourceId)) {
      return c.json({ error: "a valid resourceId is required" }, 400);
    }
    const start = new Date(b.start ?? "");
    const end = new Date(b.end ?? "");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return c.json({ error: "start and end must be dates, and end must be after start" }, 400);
    }
    const contact = (b.contact ?? "").trim();
    if (contact.length === 0) return c.json({ error: "contact required" }, 400);
    // ⛔ Derived from the session and the slot when the caller omits one, never
    // random: a retried booking must be the same booking, and a key the client
    // invents fresh on retry defeats the idempotency check entirely.
    const idempotencyKey = typeof b.idempotencyKey === "string" && b.idempotencyKey.length > 0
      ? b.idempotencyKey
      : `session:${session.id}:${b.resourceId}:${start.toISOString()}`;

    const out = await claimSlot(db, {
      customerId: session.customerId,
      resourceId: b.resourceId,
      start,
      end,
      contact,
      sessionId: session.id,
      idempotencyKey,
    });
    if (!out.booked) return c.json({ error: out.reason ?? "not available" }, 409);

    // ⛔ Booking is a stop event. Every sequence that exists to get this person
    // to book must end the moment they do, or the reminder to book arrives
    // three weeks after the appointment they already have.
    await journeyEvent(db, { customerId: session.customerId, contact, event: "booked" }).catch(() => 0);
    return c.json({ ok: true, bookingId: out.bookingId });
  });

  app.post("/agent/bookings/:bookingId/cancel", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const bookingId = c.req.param("bookingId");
    if (!UUID_RE.test(bookingId)) return c.json({ error: "bad bookingId" }, 400);
    const out = await cancelBooking(db, bookingId);
    if (!out.cancelled) return c.json({ error: "unknown or already cancelled" }, 404);
    return c.json({ ok: true, waitlisted: out.waiting.length });
  });

  /** The owner's calendar of dates: statutory first, then by severity. */
  app.get("/agent/:customerId/reminders", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const withinDays = Number(c.req.query("withinDays") ?? 90);
    return c.json({
      reminders: await upcomingReminders(db, customerId, Number.isFinite(withinDays) ? withinDays : 90),
    });
  });

  app.post("/agent/:customerId/reminders", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      kind?: string; subjectRef?: string; contact?: string; anchorAt?: string; reason?: string;
    };
    if (typeof b.kind !== "string" || typeof b.subjectRef !== "string" || b.subjectRef.trim() === "") {
      return c.json({ error: "kind and subjectRef are required" }, 400);
    }
    const anchorAt = new Date(b.anchorAt ?? "");
    if (Number.isNaN(anchorAt.getTime())) return c.json({ error: "anchorAt is not a date" }, 400);

    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);

    const out = await scheduleReminder(db, {
      customerId, vertical, kind: b.kind, subjectRef: b.subjectRef.trim(),
      contact: b.contact, anchorAt,
      // ⛔ A named human and a reason is the ONLY way a statutory date moves,
      // and the route cannot supply one on the caller's behalf: an absent
      // `reason` means no override, so the move is refused rather than applied
      // with the operator's name attached to a blank justification.
      ...(typeof b.reason === "string" && b.reason.trim() !== ""
        ? { override: { actor: operator.email, reason: b.reason.trim() } }
        : {}),
    });
    if (!out.ok) return c.json({ error: out.reason, detail: out.detail }, out.reason === "unknown_clock" ? 400 : 409);
    return c.json({ ok: true, id: out.id, dueAt: out.dueAt, statutory: out.statutory, moved: out.moved });
  });

  app.post("/agent/reminders/:reminderId/cancel", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const reminderId = c.req.param("reminderId");
    if (!UUID_RE.test(reminderId)) return c.json({ error: "bad reminderId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const ok = await cancelReminder(db, reminderId, (b.reason ?? "").trim() || "cancelled by owner");
    return ok ? c.json({ ok: true }) : c.json({ error: "unknown, already fired, or already cancelled" }, 404);
  });

  app.get("/agent/:customerId/journeys", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    return c.json({
      available: journeysFor(vertical).map((j) => ({ id: j.id, label: j.label, kind: j.kind, steps: j.steps.length })),
      running: await activeRuns(db, customerId, vertical),
    });
  });

  app.post("/agent/:customerId/journeys", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { journeyId?: string; subjectRef?: string; contact?: string };
    if (typeof b.journeyId !== "string" || typeof b.subjectRef !== "string" || typeof b.contact !== "string") {
      return c.json({ error: "journeyId, subjectRef and contact are required" }, 400);
    }
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    const out = await startJourney(db, {
      customerId, vertical, journeyId: b.journeyId, subjectRef: b.subjectRef.trim(), contact: b.contact.trim(),
    });
    // ⛔ A suppressed contact is a 409 with the reason named, not a cheerful
    // 200 over an enrolment that will never send. Enrolled-but-never-sent looks
    // identical to working on every dashboard.
    if (!out.started) return c.json({ error: out.reason }, out.reason === "unknown_journey" ? 400 : 409);
    return c.json({ ok: true, runId: out.runId, nextStepAt: out.nextStepAt });
  });

  app.post("/agent/journeys/:runId/stop", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const runId = c.req.param("runId");
    if (!UUID_RE.test(runId)) return c.json({ error: "bad runId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const ok = await stopJourney(db, runId, (b.reason ?? "").trim() || "stopped by owner");
    return ok ? c.json({ ok: true }) : c.json({ error: "unknown or not running" }, 404);
  });

  /** The owner's systems reporting what happened: they replied, they paid, they
   *  left a review. Without this route `stop_on` is a comment. */
  app.post("/agent/:customerId/journeys/events", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { event?: string; subjectRef?: string; contact?: string };
    if (typeof b.event !== "string" || b.event.trim() === "") return c.json({ error: "event required" }, 400);
    if (typeof b.subjectRef !== "string" && typeof b.contact !== "string") {
      return c.json({ error: "a subjectRef or a contact is required" }, 400);
    }
    const stopped = await journeyEvent(db, {
      customerId,
      event: b.event.trim(),
      ...(typeof b.subjectRef === "string" ? { subjectRef: b.subjectRef.trim() } : {}),
      ...(typeof b.contact === "string" ? { contact: b.contact.trim() } : {}),
    });
    return c.json({ ok: true, stopped });
  });

  // -------------------------------------------------------------------------
  // Watchers (MF7)
  // -------------------------------------------------------------------------

  app.get("/agent/:customerId/watches", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    return c.json({
      available: watchesFor(vertical).map((w) => ({
        id: w.id, label: w.label, source: w.source, cadenceHours: w.cadenceHours, severity: w.severity,
        // ⛔ Whether this deployment can actually run it, stated up front. A
        // list that offers a watch nothing can collect is a list of promises.
        collectable: deps.watchCollectors !== undefined && deps.watchCollectors[w.source] !== undefined,
      })),
      board: await watchBoard(db, customerId),
    });
  });

  app.post("/agent/:customerId/watches", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    if (deps.watchCollectors === undefined) {
      return c.json({ error: "watches are not configured on this deployment" }, 503);
    }
    const b = (await c.req.json().catch(() => ({}))) as { watchId?: string; subject?: string; params?: Record<string, unknown> };
    if (typeof b.watchId !== "string" || typeof b.subject !== "string" || b.subject.trim() === "") {
      return c.json({ error: "watchId and subject are required" }, 400);
    }
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    const out = await subscribeWatch(
      db,
      { customerId, vertical, watchId: b.watchId, subject: b.subject.trim(), params: b.params },
      deps.watchCollectors,
    );
    if (!out.ok) return c.json({ error: out.reason, detail: out.detail }, out.reason === "unknown_watch" ? 400 : 503);
    return c.json({ ok: true, subscriptionId: out.id, created: out.created });
  });

  app.post("/agent/watches/:subscriptionId/pause", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("subscriptionId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad subscriptionId" }, 400);
    return (await pauseWatch(db, id)) ? c.json({ ok: true }) : c.json({ error: "unknown or already paused" }, 404);
  });

  app.get("/agent/:customerId/findings", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    return c.json({ findings: await openFindings(db, customerId) });
  });

  app.post("/agent/findings/:findingId/acknowledge", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("findingId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad findingId" }, 400);
    return (await acknowledgeFinding(db, id, operator.email))
      ? c.json({ ok: true })
      : c.json({ error: "unknown or already handled" }, 404);
  });

  app.post("/agent/findings/:findingId/dismiss", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("findingId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad findingId" }, 400);
    return (await dismissFinding(db, id)) ? c.json({ ok: true }) : c.json({ error: "unknown or already dismissed" }, 404);
  });

  return app;
}

/** The business's trade, which is what every per-archetype lookup resolves from. */
async function verticalOf(db: Db, customerId: string): Promise<string | null> {
  const row = await db.maybeOne<{ vertical: string | null }>(
    "SELECT b.vertical FROM customers c JOIN businesses b ON b.id = c.business_id WHERE c.id = $1",
    [customerId],
  );
  return row === null ? null : row.vertical ?? "";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}
