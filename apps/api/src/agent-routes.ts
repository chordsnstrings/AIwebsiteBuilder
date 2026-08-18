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
import { markReturned, missedCalls, recordCall } from "@adw/voice";
import {
  advanceOpportunity,
  approveBusinessCase,
  casesFor,
  draftBusinessCase,
  openOpportunity,
  pipeline,
  recordEvidence,
  recordQuote,
  type CaseFinding,
} from "@adw/acquisition";
import {
  approveAsset,
  assetKindsFor,
  assetLibrary,
  budgetFor,
  pendingAssets,
  rejectAsset,
  requestAsset,
  setMonthlyCap,
} from "@adw/assets";
import {
  closeRun,
  ingest,
  openDifferences,
  openRun,
  reconTypesFor,
  resolveDifference,
  runReconciliation,
  runsFor,
  type IngestLine,
} from "@adw/reconcile";
import {
  approvePublication,
  channelsFor,
  draftPublication,
  pendingApproval,
  publicationLog,
  rejectPublication,
  type Drafter,
} from "@adw/publish";
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
import { resolveVertical } from "@adw/taxonomy";
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
  /** ⛔ Absent means the drafting route refuses with 503 rather than
   *  manufacturing copy from nothing. */
  drafter?: Drafter;
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
 * ⛔ Only an OWNER-APPROVED pack is served. An unapproved one resolves to null
 * and every surface 404s rather than falling back to a draft — a draft
 * answering the public on a business's behalf is exactly what the sign-off
 * prevents. `approval_kind = 'owner'` is explicit: a speculative approval is a
 * policy decision this system made so a preview could answer the owner it was
 * built for, and it must never be mistaken for a person's signature on a
 * paying customer's live site.
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
      WHERE p.customer_id = $1 AND p.approved_at IS NOT NULL AND p.approval_kind = 'owner'
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

/**
 * The agent behind a speculative preview.
 *
 * ⛔ `/agent/session` has accepted a `previewId` since it was written, and
 * `/agent/turn` then refused every session without a customer with a 409. So a
 * preview session could be opened and could never take a turn: the acquisition
 * hook the whole v3 pitch rests on — "here is a receptionist that already knows
 * your business, ask it what you charge" — was unreachable by construction.
 *
 * Two things differ from a live agent, and both are deliberate:
 *
 *   * Capabilities are `answer` only. A live agent may capture an enquiry or
 *     escalate to its owner; doing either on a speculative preview would mean
 *     taking a customer's details, or contacting a business, on behalf of
 *     someone who has not agreed to any of it.
 *   * ⛔ APPROVAL IS STILL REQUIRED, and §21.3 is not weakened. A speculative
 *     pack carries `approval_kind = 'speculative'` — a policy approval this
 *     system made, recorded as such, never a person's signature. The reading
 *     is that §21.3 protects the CUSTOMER'S SITE VISITORS: people who believe
 *     they are talking to the business. A preview is emailed to the business
 *     owner, is banner-labelled unofficial, and answers only from what that
 *     business itself published. `loadLiveAgent` demands
 *     `approval_kind = 'owner'` and the database refuses a speculative
 *     approval on any pack with a customer, so the two can never be confused.
 */
export async function loadPreviewAgent(db: Db, previewId: string): Promise<LiveAgent | null> {
  const row = await db.maybeOne<{
    pack_id: string;
    business_id: string;
    business_name: string;
    vertical: string | null;
  }>(
    `SELECT p.id AS pack_id, b.id AS business_id, b.name AS business_name, b.vertical
       FROM previews pv
       JOIN businesses b ON b.id = pv.business_id
       JOIN qa_packs p ON p.business_id = b.id AND p.customer_id IS NULL
      WHERE pv.id = $1 AND pv.takedown_at IS NULL
      ORDER BY p.version DESC
      LIMIT 1`,
    [previewId],
  );
  if (row === null) return null;
  // ⛔ Not cached. `cachedPack` only holds approved packs, and a speculative
  // pack is rebuilt whenever the business's published content changes — caching
  // it would serve answers from content that has since moved on.
  const pack = await loadQAPack(db, row.pack_id).catch(() => null);
  // Unapproved is not an error here, it is the ordinary state of a speculative
  // pack. It means there is no agent, and the caller says so plainly.
  if (pack === null || !(pack.approvedAt instanceof Date)) return null;

  const facts = await db.query<{ value: string }>(
    `SELECT f.value FROM kb_facts f
      WHERE f.kb_id = $1 AND f.status = 'verified'
      ORDER BY f.fact_key`,
    [pack.kbId],
  );

  return {
    pack,
    vertical: row.vertical ?? pack.vertical,
    capabilities: ["answer"],
    calendarConnected: false,
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

  /**
   * The endpoint the site widget posts to.
   *
   * ⛔ The widget and the API were built to different shapes and neither side
   * noticed. `agentWidget` posts `{ sessionRef, question }` to a single URL and
   * reads `{ answer, source }`; the API offered `POST /agent/session` followed
   * by `POST /agent/turn` keyed on a session id. There was no endpoint the
   * widget could talk to, which is the real reason no rendered page has ever
   * carried an agent: wiring it in would have produced a chat box that always
   * said "Could not reach the agent just now."
   *
   * `sessionRef` identifies which agent is speaking. On a speculative preview
   * it is the claim token — already unguessable, already embedded in the page
   * for the claim form, and granting strictly less here than it does there. On
   * a paying customer's live site it is their customer id: that site is public
   * and the agent exists to answer the public, so this grants nothing
   * `/agent/session` did not already accept unauthenticated.
   */
  app.post("/agent/ask", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      sessionRef?: string;
      question?: string;
      sessionId?: string;
    };
    const ref = (b.sessionRef ?? "").trim();
    const question = (b.question ?? "").trim();
    if (ref === "") return c.json({ error: "sessionRef required" }, 400);
    if (question === "") return c.json({ error: "question required" }, 400);
    if (question.length > MAX_QUESTION) return c.json({ error: "question too long" }, 413);

    // A uuid is a customer's live site; anything else is a preview claim token.
    const live = UUID_RE.test(ref);
    let agent: LiveAgent | null = null;
    let previewId: string | undefined;

    if (live) {
      agent = await loadLiveAgent(db, ref);
      if (agent === null) return c.json({ error: "no approved agent for this customer" }, 404);
    } else {
      const preview = await db.maybeOne<{ id: string; takedown_at: Date | null }>(
        "SELECT id, takedown_at FROM previews WHERE claim_token = $1",
        [ref],
      );
      if (preview === null) return c.json({ error: "unknown sessionRef" }, 404);
      // ⛔ A withdrawn preview answers nothing. Takedown means the business
      // asked us to stop, and an agent still speaking for them afterwards is
      // the same violation the takedown existed to end.
      if (preview.takedown_at !== null) return c.json({ error: "preview withdrawn" }, 410);
      agent = await loadPreviewAgent(db, preview.id);
      if (agent === null) return c.json({ error: "no agent for this preview" }, 404);
      previewId = preview.id;
    }

    // One session per visitor thread. The widget sends back the id it was given
    // so a follow-up question lands in the same transcript.
    const session = b.sessionId !== undefined && UUID_RE.test(b.sessionId)
      ? await loadSession(db, b.sessionId)
      : await openSession(db, {
          ...(previewId === undefined ? { customerId: ref } : { previewId }),
          businessId: agent.businessId,
          channel: "web",
        });
    if (session === null) return c.json({ error: "unknown session" }, 404);

    const turn = await handleTurn(conciergeDeps, contextFor(agent, session), question, {
      turnIndex: session.turnIndex,
    });
    return c.json({
      sessionId: session.id,
      answer: turn.answer,
      // The widget styles a gap differently — that framing is the most
      // persuasive thing on the page, so it must survive the response shape.
      source: turn.answeredFrom === "pack" ? "pack" : "gap",
      refused: turn.refused,
    });
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

    // ⛔ A preview session is a first-class case, not an error. This used to
    // 409 anything without a customer, which made every preview agent
    // unanswerable — `/agent/session` accepted a previewId and the turn that
    // followed it could never succeed.
    const agent = session.customerId !== undefined
      ? await loadLiveAgent(db, session.customerId)
      : session.previewId !== undefined
        ? await loadPreviewAgent(db, session.previewId)
        : null;
    if (agent === null) {
      return c.json(
        {
          error: session.customerId !== undefined
            ? "no approved agent for this customer"
            : "no agent for this preview",
        },
        session.customerId === undefined && session.previewId === undefined ? 409 : 404,
      );
    }

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

  // -------------------------------------------------------------------------
  // Reconciliation (MF8)
  // -------------------------------------------------------------------------
  //
  // ⛔ There is no route here that adjusts an amount. `resolve` records what a
  // person decided about a difference; the difference stays exactly where it
  // was, with a name and an explanation beside it.

  app.get("/agent/:customerId/reconciliations", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    return c.json({
      available: reconTypesFor(vertical).map((t) => ({
        id: t.id, label: t.label, ours: t.oursLabel, theirs: t.theirsLabel,
        toleranceCents: t.toleranceCents, statutory: t.statutory,
      })),
      runs: await runsFor(db, customerId),
    });
  });

  app.post("/agent/:customerId/reconciliations", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      reconType?: string; periodStart?: string; periodEnd?: string;
      ours?: unknown[]; theirs?: unknown[];
    };
    if (typeof b.reconType !== "string") return c.json({ error: "reconType required" }, 400);
    const start = new Date(b.periodStart ?? "");
    const end = new Date(b.periodEnd ?? "");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      return c.json({ error: "periodStart and periodEnd must be dates, and the end must not precede the start" }, 400);
    }
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);

    const run = await openRun(db, { customerId, vertical, reconType: b.reconType, periodStart: start, periodEnd: end });
    if (!run.ok) return c.json({ error: run.reason, detail: run.detail }, run.reason === "unknown_type" ? 400 : 409);

    try {
      for (const [side, lines] of [["ours", b.ours], ["theirs", b.theirs]] as const) {
        if (!Array.isArray(lines)) continue;
        await ingest(db, run.runId, side, lines.map(toIngestLine));
      }
    } catch (err) {
      // ⛔ 422 with the reason, never a 200 over a partially-loaded run. A
      // reconciliation missing half a statement reports a discrepancy exactly
      // equal to the half that did not arrive.
      return c.json({ error: err instanceof Error ? err.message : "bad lines" }, 422);
    }
    return c.json({ ok: true, runId: run.runId, statutory: run.statutory });
  });

  app.post("/agent/reconciliations/:runId/run", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const runId = c.req.param("runId");
    if (!UUID_RE.test(runId)) return c.json({ error: "bad runId" }, 400);
    try {
      const summary = await runReconciliation(db, runId);
      return c.json({ ok: true, summary, differences: await openDifferences(db, runId) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed" }, 409);
    }
  });

  app.post("/agent/reconciliations/differences/:matchId/resolve", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const matchId = c.req.param("matchId");
    if (!UUID_RE.test(matchId)) return c.json({ error: "bad matchId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { resolution?: string };
    if (typeof b.resolution !== "string" || b.resolution.trim() === "") {
      // ⛔ An explanation is the point. "Resolved" with no reason is a
      // difference deleted rather than a difference understood.
      return c.json({ error: "a resolution is required" }, 400);
    }
    return (await resolveDifference(db, matchId, operator.email, b.resolution))
      ? c.json({ ok: true })
      : c.json({ error: "unknown or already resolved" }, 404);
  });

  app.post("/agent/reconciliations/:runId/close", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const runId = c.req.param("runId");
    if (!UUID_RE.test(runId)) return c.json({ error: "bad runId" }, 400);
    const out = await closeRun(db, runId, operator.email);
    return out.ok
      ? c.json({ ok: true })
      : c.json({ error: out.reason, ...(out.outstanding === undefined ? {} : { outstanding: out.outstanding }) }, 409);
  });

  // -------------------------------------------------------------------------
  // Publishing (MF12) and drafting (MF13)
  // -------------------------------------------------------------------------

  app.get("/agent/:customerId/publications", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    return c.json({
      channels: channelsFor(vertical).map((ch) => ({
        id: ch.id, label: ch.label, approvalRequired: ch.approvalRequired,
        cadenceDays: ch.cadenceDays, maxChars: ch.maxChars,
      })),
      awaitingApproval: await pendingApproval(db, customerId),
      log: await publicationLog(db, customerId),
    });
  });

  app.post("/agent/:customerId/publications", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    if (deps.drafter === undefined) {
      return c.json({ error: "drafting is not configured on this deployment" }, 503);
    }
    const b = (await c.req.json().catch(() => ({}))) as {
      channel?: string; topic?: string; body?: string; payload?: Record<string, unknown>;
    };
    if (typeof b.channel !== "string" || typeof b.topic !== "string" || b.topic.trim() === "") {
      return c.json({ error: "channel and topic are required" }, 400);
    }
    const agent = await loadLiveAgent(db, customerId);
    if (agent === null) return c.json({ error: "no live agent for that customer" }, 404);

    const out = await draftPublication(
      db,
      {
        customerId, vertical: agent.vertical, channel: b.channel, topic: b.topic.trim(),
        // ⛔ The verified KB slice, and only that. The drafter has no other
        // source, so a claim in the copy is a claim the business made to us.
        facts: agent.kbSlice,
        body: b.body,
        payload: b.payload,
      },
      deps.drafter,
    );
    if (!out.ok) {
      return c.json({ error: out.reason, detail: out.detail }, out.reason === "unknown_channel" ? 400 : 422);
    }
    // ⛔ `state: draft`, said out loud in the response. A 200 that reads like a
    // publish is how an owner ends up believing something went out.
    return c.json({ ok: true, publicationId: out.publicationId, body: out.body, state: "draft" });
  });

  app.post("/agent/publications/:publicationId/approve", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("publicationId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad publicationId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { body?: string; payload?: Record<string, unknown> };
    const out = await approvePublication(db, id, operator.email, {
      ...(typeof b.body === "string" ? { body: b.body } : {}),
      ...(b.payload === undefined ? {} : { payload: b.payload }),
    });
    if (!out.ok) return c.json({ error: out.reason, detail: out.detail }, out.reason === "unknown" ? 404 : 409);
    return c.json({ ok: true, edited: out.edited, queued: true });
  });

  app.post("/agent/publications/:publicationId/reject", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("publicationId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad publicationId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { reason?: string };
    return (await rejectPublication(db, id, (b.reason ?? "").trim() || "rejected by owner"))
      ? c.json({ ok: true })
      : c.json({ error: "unknown or not a draft" }, 404);
  });

  // -------------------------------------------------------------------------
  // The enterprise pipeline
  // -------------------------------------------------------------------------
  //
  // ⛔ Operator-facing, all of it. There is no self-serve enterprise path and
  // there is deliberately no route here that creates a preview, takes a card,
  // or lets one person approve on an organisation's behalf.

  app.get("/ops/opportunities", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    return c.json({ pipeline: await pipeline(db) });
  });

  app.post("/ops/opportunities", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const b = (await c.req.json().catch(() => ({}))) as {
      businessId?: string; targetFunction?: string; namedContactRole?: string;
    };
    if (typeof b.businessId !== "string" || !UUID_RE.test(b.businessId)) {
      return c.json({ error: "a valid businessId is required" }, 400);
    }
    const biz = await db.maybeOne<{ vertical: string | null; category: string | null }>(
      "SELECT vertical, category FROM businesses WHERE id = $1", [b.businessId]);
    if (biz === null) return c.json({ error: "unknown business" }, 404);
    const out = await openOpportunity(db, {
      businessId: b.businessId,
      vertical: resolveVertical(biz.vertical, biz.category),
      targetFunction: b.targetFunction,
      namedContactRole: b.namedContactRole,
      ownerEmail: operator.email,
    });
    // ⛔ 409 with the reason. An SMB business in the enterprise pipeline is a
    // deal being forecast by people who cannot sell to them.
    if (!out.ok) return c.json({ error: out.reason, detail: out.detail }, 409);
    return c.json({ ok: true, opportunityId: out.opportunityId, created: out.created, track: out.track.label });
  });

  app.post("/ops/opportunities/:opportunityId/evidence", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("opportunityId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad opportunityId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { evidence?: Record<string, unknown> };
    if (b.evidence === undefined || typeof b.evidence !== "object") {
      return c.json({ error: "evidence object required" }, 400);
    }
    return (await recordEvidence(db, id, b.evidence, operator.email))
      ? c.json({ ok: true })
      : c.json({ error: "nothing recordable — an empty value is not evidence" }, 422);
  });

  app.post("/ops/opportunities/:opportunityId/advance", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("opportunityId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad opportunityId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { stage?: string; note?: string };
    if (typeof b.stage !== "string") return c.json({ error: "stage required" }, 400);
    const out = await advanceOpportunity(db, id, b.stage, operator.email, b.note);
    if (!out.ok) {
      return c.json(
        { error: out.reason, ...(out.missing === undefined ? {} : { missing: out.missing }), detail: out.detail },
        out.reason === "unknown" ? 404 : 409,
      );
    }
    return c.json({ ok: true, stage: out.stage });
  });

  app.post("/ops/opportunities/:opportunityId/quote", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("opportunityId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad opportunityId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      amountCents?: number; currency?: string; reference?: string;
    };
    if (typeof b.amountCents !== "number" || !Number.isFinite(b.amountCents) || b.amountCents <= 0) {
      return c.json({ error: "amountCents must be a positive number of minor units" }, 400);
    }
    // ⛔ The approver is the authenticated operator, never a field in the body.
    // A quote approved by whoever the caller says approved it is not approved.
    const out = await recordQuote(db, id, {
      amountCents: b.amountCents,
      currency: (b.currency ?? "GBP").toUpperCase(),
      reference: b.reference ?? "",
      approvedBy: operator.email,
    });
    return out.ok ? c.json({ ok: true }) : c.json({ error: out.reason }, out.reason === "unknown" ? 404 : 409);
  });

  app.get("/ops/opportunities/:opportunityId/cases", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("opportunityId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad opportunityId" }, 400);
    return c.json({ cases: await casesFor(db, id) });
  });

  app.post("/ops/opportunities/:opportunityId/cases", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const id = c.req.param("opportunityId");
    if (!UUID_RE.test(id)) return c.json({ error: "bad opportunityId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      targetFunction?: string; findings?: CaseFinding[]; body?: string; auditId?: string;
    };
    if (typeof b.targetFunction !== "string" || b.targetFunction.trim() === "") {
      return c.json({ error: "targetFunction required" }, 400);
    }
    const out = await draftBusinessCase(db, {
      opportunityId: id,
      targetFunction: b.targetFunction.trim(),
      findings: Array.isArray(b.findings) ? b.findings : [],
      body: b.body,
      auditId: b.auditId,
    });
    if (!out.ok) return c.json({ error: out.reason, detail: out.detail }, out.reason === "unknown_opportunity" ? 404 : 422);
    return c.json({ ok: true, caseId: out.caseId, body: out.body, state: "draft" });
  });

  app.post("/ops/cases/:caseId/approve", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const caseId = c.req.param("caseId");
    if (!UUID_RE.test(caseId)) return c.json({ error: "bad caseId" }, 400);
    const out = await approveBusinessCase(db, caseId, operator.email);
    return out.ok ? c.json({ ok: true }) : c.json({ error: out.reason }, out.reason === "unknown" ? 404 : 409);
  });

  // -------------------------------------------------------------------------
  // Generated assets (MF13)
  // -------------------------------------------------------------------------
  //
  // ⛔ The only routes in this file where pressing a button spends money. The
  // estimate and the remaining budget come back on the REQUEST so the approval
  // surface can show them — "approve" means nothing if the person pressing it
  // does not know the number.

  app.get("/agent/:customerId/assets", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    return c.json({
      kinds: assetKindsFor(vertical).map((k) => ({
        id: k.id, label: k.label, kind: k.kind, slot: k.slot, maxPerMonth: k.maxPerMonth,
      })),
      budget: await budgetFor(db, customerId),
      awaitingApproval: await pendingAssets(db, customerId),
      library: await assetLibrary(db, customerId),
    });
  });

  app.post("/agent/:customerId/assets", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { assetKind?: string; brief?: string; publicationId?: string };
    if (typeof b.assetKind !== "string" || typeof b.brief !== "string" || b.brief.trim() === "") {
      return c.json({ error: "assetKind and brief are required" }, 400);
    }
    const vertical = await verticalOf(db, customerId);
    if (vertical === null) return c.json({ error: "unknown customer" }, 404);
    const out = await requestAsset(db, {
      customerId, vertical, assetKind: b.assetKind, brief: b.brief.trim(),
      requestedBy: operator.email,
      ...(typeof b.publicationId === "string" ? { publicationId: b.publicationId } : {}),
    });
    if (!out.ok) {
      // ⛔ The reason is returned verbatim. "We cannot generate a picture of
      // your team because it would be people who do not exist" is a sentence
      // the owner deserves to read, not a 400 they have to guess at.
      return c.json({ error: out.reason, detail: out.detail }, out.reason === "unknown_kind" ? 400 : 422);
    }
    return c.json({
      ok: true, assetId: out.assetId, state: "requested",
      estimatedCostCents: out.estimatedCostCents,
      remainingCapCents: out.remainingCapCents,
      prompt: out.prompt,
    });
  });

  app.post("/agent/assets/:assetId/approve", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const assetId = c.req.param("assetId");
    if (!UUID_RE.test(assetId)) return c.json({ error: "bad assetId" }, 400);
    const out = await approveAsset(db, assetId, operator.email);
    if (!out.ok) return c.json({ error: out.reason, detail: out.detail }, out.reason === "unknown" ? 404 : 409);
    return c.json({ ok: true, queued: true, costCents: out.estimatedCostCents });
  });

  app.post("/agent/assets/:assetId/reject", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const assetId = c.req.param("assetId");
    if (!UUID_RE.test(assetId)) return c.json({ error: "bad assetId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { reason?: string };
    return (await rejectAsset(db, assetId, (b.reason ?? "").trim() || "rejected by owner"))
      ? c.json({ ok: true })
      : c.json({ error: "unknown or not awaiting approval" }, 404);
  });

  app.post("/agent/:customerId/assets/budget", async (c) => {
    const operator = user(c);
    if (operator === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { monthlyCapCents?: number };
    if (typeof b.monthlyCapCents !== "number" || !Number.isFinite(b.monthlyCapCents) || b.monthlyCapCents < 0) {
      return c.json({ error: "monthlyCapCents must be a non-negative number of minor units" }, 400);
    }
    await setMonthlyCap(db, customerId, b.monthlyCapCents, operator.email);
    return c.json({ ok: true, budget: await budgetFor(db, customerId) });
  });

  // -------------------------------------------------------------------------
  // Telephony (MF11)
  // -------------------------------------------------------------------------

  /**
   * A call event from a telephony provider.
   *
   * ⛔ Authenticated as an operator rather than left open. A public route that
   * writes enquiries from an unsigned body is a spam endpoint; the real
   * provider webhooks arrive at /webhooks/:provider, which verifies signatures,
   * and this is the internal seam behind it.
   */
  app.post("/agent/:customerId/calls", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      provider?: string; providerCallId?: string; outcome?: string;
      callerNumber?: string; startedAt?: string; durationSeconds?: number;
      transcript?: string; countryCode?: string; attemptFollowUp?: boolean;
    };
    if (b.outcome !== "missed" && b.outcome !== "answered" && b.outcome !== "voicemail") {
      return c.json({ error: "outcome must be missed, answered or voicemail" }, 400);
    }
    if (typeof b.callerNumber !== "string" || b.callerNumber.trim() === "") {
      return c.json({ error: "callerNumber required" }, 400);
    }
    if (typeof b.providerCallId !== "string" || b.providerCallId.trim() === "") {
      // ⛔ Required. Without it there is no idempotency, and a redelivered
      // webhook rings the same person twice.
      return c.json({ error: "providerCallId required" }, 400);
    }
    const startedAt = new Date(b.startedAt ?? "");
    const out = await recordCall(db, {
      customerId,
      provider: (b.provider ?? "unknown").trim(),
      providerCallId: b.providerCallId.trim(),
      outcome: b.outcome,
      callerNumber: b.callerNumber,
      startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
      durationSeconds: b.durationSeconds,
      transcript: b.transcript,
      countryCode: b.countryCode,
    }, { attemptFollowUp: b.attemptFollowUp === true });
    return c.json({
      ok: true, callId: out.callId, created: out.created, enquiryId: out.enquiryId,
      // ⛔ The gate's verdict is returned rather than swallowed. A caller that
      // asked for a text-back must be told it did not happen and why.
      followUp: out.followUp,
    });
  });

  app.get("/agent/:customerId/calls/missed", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const customerId = c.req.param("customerId");
    if (!UUID_RE.test(customerId)) return c.json({ error: "bad customerId" }, 400);
    return c.json({ missed: await missedCalls(db, customerId) });
  });

  app.post("/agent/calls/:callId/returned", async (c) => {
    if (user(c) === null) return c.json({ error: "unauthorised" }, 401);
    const callId = c.req.param("callId");
    if (!UUID_RE.test(callId)) return c.json({ error: "bad callId" }, 400);
    return (await markReturned(db, callId)) ? c.json({ ok: true }) : c.json({ error: "unknown call" }, 404);
  });

  return app;
}

/**
 * One line of a statement, from JSON.
 *
 * ⛔ `amountCents` is passed through unchanged, including when it is a decimal.
 * `ingest` throws on a non-integer and that error reaching the caller as a 422
 * is the point: coercing 12.34 to 12 here would turn a hundredfold unit error
 * into a plausible number nobody questions.
 */
function toIngestLine(raw: unknown): IngestLine {
  const r = (raw ?? {}) as Record<string, unknown>;
  const occurred = typeof r["occurredOn"] === "string" ? new Date(r["occurredOn"]) : null;
  return {
    sourceKey: String(r["sourceKey"] ?? ""),
    reference: typeof r["reference"] === "string" ? r["reference"] : null,
    amountCents: typeof r["amountCents"] === "number" ? r["amountCents"] : Number.NaN,
    occurredOn: occurred !== null && !Number.isNaN(occurred.getTime()) ? occurred : null,
    description: typeof r["description"] === "string" ? r["description"] : null,
  };
}

/** The business's trade, which is what every per-archetype lookup resolves from. */
async function verticalOf(db: Db, customerId: string): Promise<string | null> {
  const row = await db.maybeOne<{ vertical: string | null; category: string | null }>(
    "SELECT b.vertical, b.category FROM customers c JOIN businesses b ON b.id = c.business_id WHERE c.id = $1",
    [customerId],
  );
  // ⛔ null means NO SUCH CUSTOMER (a 404). An empty string means a customer
  // whose trade does not resolve — a real state, and one every per-archetype
  // lookup will return nothing for, so it must not be confused with the first.
  return row === null ? null : resolveVertical(row.vertical, row.category);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}
