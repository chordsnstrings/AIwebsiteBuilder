// The public runtime surface. Three of these four routes are reachable by
// anyone with the URL, so the tests are mostly about what they will NOT do:
// serve an unapproved pack, let the machine surface answer more than the human
// one, hand back a similarity score, or let a new answer into a pack without an
// owner behind it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { embedText, persistQAPack, type QAPack, type QAPair } from "@adw/qapack";
import type { SessionUser } from "@adw/auth";
import { createApp } from "./src/app.ts";
import { forgetPack } from "./src/agent-routes.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let vault: SecretsBackend;

const OWNER: SessionUser = { id: "ow", email: "owner@example.com", role: "customer", customerId: null, totpEnabled: false };
const appAs = (user: SessionUser | null) => createApp({ db, vault, forceMock: true, authOverride: user });

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
});
afterAll(async () => {
  await db?.close();
});

const PAIRS: [string, string][] = [
  ["What areas do you cover?", "We cover Bur Dubai, Deira and Jumeirah."],
  ["What are your opening hours?", "We're open Monday to Friday, 8am to 5pm."],
  ["How much is a callout?", "Our standard callout is AED 150."],
  ["Do you install boilers?", "We install and service boilers."],
];

function pair(question: string, answer: string): QAPair {
  return {
    id: randomUUID(),
    question,
    answer,
    sourceFactIds: [randomUUID()],
    embedding: embedText(question),
    confidence: 0.9,
    source: "generated",
  };
}

interface Fixture {
  customerId: string;
  businessId: string;
  kbId: string;
  leadId: string;
  pack: QAPack;
}

async function seed(opts: { approved?: boolean } = {}): Promise<Fixture> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical, phone_e164, city)
     VALUES ('d',$1,'Route Plumbing','AE','R3','no_site','plumber','+971500000000','Dubai') RETURNING id`,
    [batch.id],
  );
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R3','Route Plumbing',$2,'en-GB','Asia/Dubai','active') RETURNING id`,
    [biz.id, `routes_${randomUUID()}@example.com`],
  );
  // ⛔ A contact and a lead, because a real customer always has both and the
  // approval route reaches the onboarding workflow through them. Seeding a
  // customer with no lead was why the first version of the release assertion
  // failed against a route that was working correctly — the fixture, not the
  // code, was the thing missing a link.
  const contactEmail = `contact_${randomUUID()}@example.com`;
  const contact = await db.one<{ id: string }>(
    `INSERT INTO contacts (business_id, email, email_hash, verification)
     VALUES ($1,$2,$3,'valid') RETURNING id`,
    [biz.id, contactEmail, emailHash(contactEmail)],
  );
  const campaign = await db.one<{ id: string }>(
    `INSERT INTO campaigns (name, region_code) VALUES ($1,'R3') RETURNING id`,
    [`route-${randomUUID()}`],
  );
  const lead = await db.one<{ id: string }>(
    `INSERT INTO leads (contact_id, campaign_id, state, workflow_id)
     VALUES ($1,$2,'WON',$3) RETURNING id`,
    [contact.id, campaign.id, `lead:${contact.id}`],
  );
  const kb = await db.one<{ id: string }>(
    `INSERT INTO knowledge_bases (business_id, customer_id) VALUES ($1,$2) RETURNING id`,
    [biz.id, cust.id],
  );
  for (const [key, type, value, status] of [
    ["area_1", "area", "Bur Dubai", "verified"],
    ["service_1", "service", "Boiler installation", "verified"],
    // Deliberately unverified: a certification we found on their site and could
    // not confirm. Nothing may assert it.
    ["credential_1", "credential", "Public liability insurance", "claimed_unverified"],
  ] as [string, string, string, string][]) {
    await db.query(
      `INSERT INTO kb_facts (kb_id, fact_key, type, value, status, source_url, retrieved_at)
       VALUES ($1,$2,$3,$4,$5,'https://example.test', now())`,
      [kb.id, key, type, value, status],
    );
  }
  const pack: QAPack = {
    id: randomUUID(),
    kbId: kb.id,
    businessId: biz.id,
    customerId: cust.id,
    version: 1,
    vertical: "plumber",
    playbookVersion: "test",
    embeddingProvider: "adw-hashed-ngram-v1",
    pairs: PAIRS.map(([q, a]) => pair(q!, a!)),
    coverage: { byTopic: {}, byVerticalTemplate: { answered: 0, total: 0, ratio: 0 }, factsUsed: 4, factsAvailable: 6 },
    templateFallbacks: [],
    gaps: [],
    excluded: [],
    thin: true,
    extendedOnboarding: true,
    createdAt: new Date(),
    ...(opts.approved === false ? {} : { approvedAt: new Date(), approvedBy: "owner@example.com" }),
  };
  await persistQAPack(db, pack);
  if (opts.approved !== false) {
    await db.query(`UPDATE qa_packs SET approved_at = now(), approved_by = 'owner@example.com' WHERE id = $1`, [pack.id]);
  }
  forgetPack(pack.id);
  return { customerId: cust.id, businessId: biz.id, kbId: kb.id, leadId: lead.id, pack };
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

// ---------------------------------------------------------------------------

describe("POST /agent/turn", () => {
  it("answers from the pack", async () => {
    const { customerId } = await seed();
    const app = appAs(null);
    const opened = await app.request("/agent/session", json({ customerId }));
    expect(opened.status).toBe(200);
    const { sessionId } = (await opened.json()) as { sessionId: string };

    const res = await app.request("/agent/turn", json({ sessionId, question: "What are your opening hours?" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["answer"]).toBe("We're open Monday to Friday, 8am to 5pm.");
    expect(body["answeredFrom"]).toBe("pack");
  });

  it("⛔ never returns the retrieval score or the pair id", async () => {
    // Both are the customer's evidence and both are a similarity oracle: a
    // caller that can see the score can binary-search the pack's contents.
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as {
      sessionId: string;
    };
    const body = (await (
      await app.request("/agent/turn", json({ sessionId, question: "What areas do you cover?" }))
    ).json()) as Record<string, unknown>;
    expect(body["retrievalScore"]).toBeUndefined();
    expect(body["pairId"]).toBeUndefined();
    // The turn record still has them — that is where they belong.
    const row = await db.one<{ pair_id: string | null; retrieval_score: string | null }>(
      `SELECT pair_id, retrieval_score FROM agent_turns WHERE session_id = $1`,
      [sessionId],
    );
    expect(row.pair_id).not.toBeNull();
    expect(row.retrieval_score).not.toBeNull();
  });

  it("refuses and logs the gap when nothing answers", async () => {
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as {
      sessionId: string;
    };
    const body = (await (
      await app.request("/agent/turn", json({ sessionId, question: "Do you fit underfloor heating?" }))
    ).json()) as Record<string, unknown>;
    expect(body["refused"]).toBe(true);
    const gaps = await db.query(`SELECT question FROM agent_gaps WHERE customer_id = $1`, [customerId]);
    expect(gaps.rowCount).toBe(1);
  });

  it("is idempotent when the caller repeats a turn index", async () => {
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as {
      sessionId: string;
    };
    const q = { sessionId, question: "Do you install boilers?", turnIndex: 0 };
    await app.request("/agent/turn", json(q));
    await app.request("/agent/turn", json(q));
    const turns = await db.query(`SELECT id FROM agent_turns WHERE session_id = $1`, [sessionId]);
    expect(turns.rowCount).toBe(1);
  });

  it("⛔ 404s for a customer whose pack is not approved", async () => {
    const { customerId } = await seed({ approved: false });
    const res = await appAs(null).request("/agent/session", json({ customerId }));
    expect(res.status).toBe(404);
  });

  it("rejects an over-long question rather than truncating it", async () => {
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as {
      sessionId: string;
    };
    const res = await app.request("/agent/turn", json({ sessionId, question: "a".repeat(2000) }));
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// ⛔ The speculative preview's agent — the acquisition hook the whole pitch
// rests on: "here is a receptionist that already knows your business, ask it
// what you charge." Three separate pieces of it were built and none of them met.
//
//   * `/agent/session` accepted a previewId and `/agent/turn` then 409'd every
//     session without a customer, so a preview session could be opened and
//     could never take a turn.
//   * The widget posts `{ sessionRef, question }` to one URL and reads
//     `{ answer, source }`. No endpoint had that shape, so wiring the widget in
//     would have produced a chat box that always said "Could not reach the
//     agent just now."
//   * `generate_preview` passed neither `machine` nor `agent` to `renderSite`,
//     so no rendered page carried a widget to post from in the first place.
// ---------------------------------------------------------------------------
describe("⛔ POST /agent/ask — the preview agent", () => {
  /** A speculative preview: a pack with NO customer, and no approval. */
  async function speculativePreview(
    opts: { approved?: boolean } = {},
  ): Promise<{ claimToken: string; previewId: string; packId: string }> {
    const fx = await seed();
    // Re-home the pack as speculative: no customer. Approval is varied by the
    // caller because that is the whole question these tests are about.
    await db.query(
      opts.approved === false
        ? `UPDATE qa_packs SET customer_id = NULL, approved_at = NULL, approved_by = NULL WHERE id = $1`
        : `UPDATE qa_packs SET customer_id = NULL WHERE id = $1`,
      [fx.pack.id],
    );
    forgetPack(fx.pack.id);
    const claimToken = `claim_${randomUUID()}`;
    const preview = await db.one<{ id: string }>(
      `INSERT INTO previews (business_id, r2_key, deploy_url, claim_token, label_version, expires_at)
       VALUES ($1,'k','https://p.example',$2,'label-v1', now() + interval '30 days') RETURNING id`,
      [fx.businessId, claimToken],
    );
    return { claimToken, previewId: preview.id, packId: fx.pack.id };
  }

  it("answers a visitor from the business's own published content", async () => {
    const fx = await speculativePreview();
    const res = await appAs(null).request("/agent/ask", json({ sessionRef: fx.claimToken, question: PAIRS[0]![0] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; source: string; sessionId: string };
    expect(body.answer).toBeTruthy();
    expect(body.source).toBe("pack");
    // ⛔ The widget sends this back so a follow-up lands in the same transcript.
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("⛔ says nothing at all from an unapproved pack", async () => {
    // §21.3, enforced in `assertPackApproved`: an unapproved pack must never
    // reach a visitor. A speculative pack has no owner to sign it — the point
    // of the preview is to reach an owner who has not been contacted — and
    // that tension is unresolved in this repository. The safe reading applies:
    // no approval, no agent, rather than the invariant being relaxed to make
    // the feature work.
    const fx = await speculativePreview({ approved: false });
    const res = await appAs(null).request("/agent/ask", json({ sessionRef: fx.claimToken, question: PAIRS[0]![0] }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("no agent");
  });

  it("keeps a follow-up in the same session", async () => {
    const fx = await speculativePreview();
    const first = await appAs(null).request("/agent/ask", json({ sessionRef: fx.claimToken, question: PAIRS[0]![0] }));
    const { sessionId } = (await first.json()) as { sessionId: string };
    const second = await appAs(null).request(
      "/agent/ask", json({ sessionRef: fx.claimToken, question: PAIRS[0]![0], sessionId }),
    );
    expect(((await second.json()) as { sessionId: string }).sessionId).toBe(sessionId);
  });

  it("⛔ goes silent the moment the preview is taken down", async () => {
    // Takedown means the business asked us to stop. An agent still speaking for
    // them afterwards is the same violation the takedown existed to end.
    const fx = await speculativePreview();
    await db.query("UPDATE previews SET takedown_at = now(), takedown_reason = 'not_for_me' WHERE id = $1", [fx.previewId]);
    const res = await appAs(null).request("/agent/ask", json({ sessionRef: fx.claimToken, question: PAIRS[0]![0] }));
    expect(res.status).toBe(410);
  });

  it("refuses an unknown ref, an empty question and an oversized one", async () => {
    const fx = await speculativePreview();
    expect((await appAs(null).request("/agent/ask", json({ sessionRef: `claim_${randomUUID()}`, question: "hi" }))).status).toBe(404);
    expect((await appAs(null).request("/agent/ask", json({ sessionRef: fx.claimToken, question: "  " }))).status).toBe(400);
    expect((await appAs(null).request("/agent/ask", json({ question: "hi" }))).status).toBe(400);
    expect(
      (await appAs(null).request("/agent/ask", json({ sessionRef: fx.claimToken, question: "x".repeat(5000) }))).status,
    ).toBe(413);
  });
});

describe("POST /api/enquiry — the no-JS path", () => {
  it("answers a plain form post with a page a browser can render", async () => {
    const { customerId } = await seed();
    const form = new FormData();
    form.set("customerId", customerId);
    form.set("question", "What are your opening hours?");
    const res = await appAs(null).request("/api/enquiry", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Monday to Friday");
    expect(html).toContain("viewport");
  });

  it("answers JSON when asked for JSON", async () => {
    const { customerId } = await seed();
    const res = await appAs(null).request(
      "/api/enquiry",
      json({ customerId, question: "What areas do you cover?" }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["answer"])).toContain("Deira");
  });
});

describe("MCP", () => {
  it("advertises only what the vertical and the calendar allow", async () => {
    const { customerId } = await seed();
    const res = await appAs(null).request(`/.well-known/mcp?customerId=${customerId}`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as { tools: { name: string }[] };
    const names = manifest.tools.map((t) => t.name);
    expect(names).toContain("get_business_info");
    // No calendar connected, so booking is not advertised — an assistant must
    // not be told it can do something that will then fail.
    expect(names).not.toContain("book_appointment");
  });

  it("⛔ refuses an assistant exactly what it refuses a person", async () => {
    // The whole reason handleMcpCall takes the refusal checker by injection.
    // If the two surfaces could diverge, this one becomes the way around them.
    const { customerId } = await seed();
    const res = await appAs(null).request(
      "/.well-known/mcp",
      json({ customerId, tool: "book_appointment", arguments: { start: "x", end: "y", contact: "z" } }),
    );
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_available");
  });

  it("returns 200 for a refusal so an assistant does not retry it forever", async () => {
    const { customerId } = await seed();
    const res = await appAs(null).request("/.well-known/mcp", json({ customerId, tool: "get_services" }));
    expect(res.status).toBe(200);
  });

  it("404s an unknown tool", async () => {
    const { customerId } = await seed();
    const res = await appAs(null).request("/.well-known/mcp", json({ customerId, tool: "delete_everything" }));
    expect(res.status).toBe(404);
  });

  it("⛔ only discloses verified credentials", async () => {
    // The fixture's insurance fact is claimed_unverified. An assistant asking
    // for business info must not be handed it as fact.
    const { customerId } = await seed();
    const res = await appAs(null).request("/.well-known/mcp", json({ customerId, tool: "get_business_info" }));
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body.data)).not.toMatch(/public liability/i);
  });
});

describe("the gap list", () => {
  it("requires authentication", async () => {
    const { customerId } = await seed();
    const res = await appAs(null).request(`/agent/${customerId}/gaps`);
    expect(res.status).toBe(401);
  });

  it("shows the owner what was asked and how often", async () => {
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as {
      sessionId: string;
    };
    for (let i = 0; i < 2; i++) {
      await app.request("/agent/turn", json({ sessionId, question: "Do you fit underfloor heating?", turnIndex: i }));
    }
    const res = await appAs(OWNER).request(`/agent/${customerId}/gaps`);
    const body = (await res.json()) as { gaps: { question: string; timesAsked: number }[] };
    expect(body.gaps[0]?.question).toBe("Do you fit underfloor heating?");
    expect(body.gaps[0]?.timesAsked).toBe(2);
  });

  it("⛔ never promotes an answer without a human", async () => {
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as {
      sessionId: string;
    };
    await app.request("/agent/turn", json({ sessionId, question: "Do you fit underfloor heating?" }));
    const gap = await db.one<{ id: string; status: string }>(
      `SELECT id, status FROM agent_gaps WHERE customer_id = $1`,
      [customerId],
    );
    // Answering it is an authenticated action, and the row stays 'open' until
    // someone takes it.
    expect(gap.status).toBe("open");
    const denied = await appAs(null).request(`/agent/gaps/${gap.id}/approve`, json({ answer: "Yes we do." }));
    expect(denied.status).toBe(401);

    const ok = await appAs(OWNER).request(`/agent/gaps/${gap.id}/approve`, json({ answer: "Yes, we fit underfloor heating." }));
    expect(ok.status).toBe(200);
    const after = await db.one<{ status: string; approved_by: string | null }>(
      `SELECT status, approved_by FROM agent_gaps WHERE id = $1`,
      [gap.id],
    );
    expect(after.status).toBe("approved");
    expect(after.approved_by).toBe(OWNER.email);
  });

  it("⛔ applies the refusal policy to the owner's own words", async () => {
    // An owner may not instruct their agent to guarantee an arrival time any
    // more than we may. The rule is about what the agent says, not who wrote it.
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as {
      sessionId: string;
    };
    await app.request("/agent/turn", json({ sessionId, question: "Do you fit underfloor heating?" }));
    const gap = await db.one<{ id: string }>(`SELECT id FROM agent_gaps WHERE customer_id = $1`, [customerId]);
    const res = await appAs(OWNER).request(
      `/agent/gaps/${gap.id}/approve`,
      json({ answer: "Yes — and we guarantee we'll be there within the hour." }),
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
describe("⛔ pack approval — the step that unblocks going live", () => {
  // This route did not exist, and its absence stopped the entire product.
  //
  // `agent_eval_gate` fails `pack_not_approved` unless `qa_packs.approved_at` is
  // set; `onboarding.ts:127` gives it no partial credit; so deploy, cutover and
  // the delivery email were unreachable and every onboarding ended at
  // `raise_onboarding_exception`. `approvePack()` was written, tested and
  // exported with ZERO production callers.
  //
  // The nightly checks had the evidence all along: eval-nightly asserts "No Q&A
  // pack went live without the owner approving it" and passed — vacuously,
  // because no pack ever reached the gate. An invariant that holds because the
  // thing it guards never happens is not a check, it is a decoration.

  const owner: SessionUser = { id: "u-owner", email: "owner@acme.example", role: "superadmin" };

  it("approves a pack, and the agent becomes servable as a direct result", async () => {
    const { customerId, pack } = await seed({ approved: false });

    // Before: every public surface 404s, because loadLiveAgent refuses a draft.
    const before = await appAs(null).request("/agent/session", json({ customerId }));
    expect(before.status).toBe(404);

    const res = await appAs(owner).request(`/agent/packs/${pack.id}/approve`, json({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvedBy: string; pairsApproved: number };
    expect(body.approvedBy).toBe(owner.email);
    expect(body.pairsApproved).toBeGreaterThan(0);

    // After: the same call succeeds. This is the whole product turning on.
    forgetPack(pack.id);
    const after = await appAs(null).request("/agent/session", json({ customerId }));
    expect(after.status).toBe(200);
  });

  it("releases the onboarding workflow rather than only stamping a column", async () => {
    // Approving without signalling would leave the workflow parked forever and
    // look identical to success from the API's side.
    const { pack } = await seed({ approved: false });
    await appAs(owner).request(`/agent/packs/${pack.id}/approve`, json({}));
    const intent = await db.maybeOne<{ signal_name: string; workflow_type: string }>(
      "SELECT signal_name, workflow_type FROM workflow_intents WHERE signal_name = 'approved' ORDER BY created_at DESC LIMIT 1",
    );
    expect(intent?.workflow_type).toBe("onboarding");
  });

  it("⛔ is not public — an unauthenticated caller cannot sign off a pack", async () => {
    const { pack } = await seed({ approved: false });
    const res = await appAs(null).request(`/agent/packs/${pack.id}/approve`, json({}));
    expect(res.status).toBe(401);
  });

  it("first approval wins, so a second click cannot rewrite the evidence", async () => {
    const { pack } = await seed({ approved: false });
    const first = (await (await appAs(owner).request(`/agent/packs/${pack.id}/approve`, json({}))).json()) as {
      approvedAt: string;
      approvedBy: string;
    };
    const other: SessionUser = { id: "u2", email: "someone-else@acme.example", role: "superadmin" };
    const second = (await (await appAs(other).request(`/agent/packs/${pack.id}/approve`, json({}))).json()) as {
      approvedAt: string;
      approvedBy: string;
    };
    expect(second.approvedBy).toBe(first.approvedBy);
    expect(second.approvedAt).toBe(first.approvedAt);
  });

  it("shows the owner every pair, not a sample, before they sign", async () => {
    // An owner who signed off a summary has not signed off the pack, and the
    // pack is what the agent may say on their behalf.
    const { pack } = await seed({ approved: false });
    const res = await appAs(owner).request(`/agent/packs/${pack.id}`);
    const body = (await res.json()) as { pairs: unknown[]; pairCount: number; approvedAt: string | null };
    expect(body.approvedAt).toBeNull();
    expect(body.pairs.length).toBe(body.pairCount);
    expect(body.pairs.length).toBe(pack.pairs.length);
  });
});


// ---------------------------------------------------------------------------
// Bookings, clocks and journeys
// ---------------------------------------------------------------------------
//
// ⛔ `claimSlot` had ZERO callers before these routes. Written, tested,
// exported, and reachable from nothing — the same defect as `approvePack` one
// family earlier. The concierge could offer three times and then had no way to
// take one.

describe("bookings, clocks and journeys", () => {
  const owner: SessionUser = { ...OWNER, role: "superadmin" };

  async function resourceFor(customerId: string): Promise<string> {
    const r = await db.one<{ id: string }>(
      `INSERT INTO scheduling_resources (customer_id, name, kind, capacity)
       VALUES ($1,$2,'crew',1) RETURNING id`,
      [customerId, `van-${randomUUID()}`],
    );
    return r.id;
  }

  it("takes a booking, and a replay is the same booking", async () => {
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as { sessionId: string };
    const resourceId = await resourceFor(customerId);
    const start = new Date(Date.now() + 3 * 86_400_000);
    const body = {
      sessionId, resourceId,
      start: start.toISOString(),
      end: new Date(start.getTime() + 3_600_000).toISOString(),
      contact: `booker_${randomUUID()}@example.com`,
    };
    const first = await app.request("/agent/bookings", json(body));
    expect(first.status).toBe(200);
    const a = (await first.json()) as { bookingId: string };
    expect(a.bookingId).toBeTruthy();

    // ⛔ No idempotencyKey supplied, so the route derives one from the session
    // and the slot. A key the client invents fresh on retry defeats the check
    // entirely and books the same person twice.
    const second = await app.request("/agent/bookings", json(body));
    const b = (await second.json()) as { bookingId: string };
    expect(b.bookingId).toBe(a.bookingId);
  });

  it("⛔ a booking stops every sequence that existed to get them to book", async () => {
    // Otherwise the reminder to book arrives three weeks after the appointment
    // they already have.
    const { customerId } = await seed();
    const app = appAs(null);
    const { sessionId } = (await (await app.request("/agent/session", json({ customerId }))).json()) as { sessionId: string };
    const contact = `rebooker_${randomUUID()}@example.com`;
    const subjectRef = `job-${randomUUID()}`;

    const started = await appAs(owner).request(
      `/agent/${customerId}/journeys`,
      json({ journeyId: "quote_follow_up", subjectRef, contact }),
    );
    expect(started.status).toBe(200);

    const start = new Date(Date.now() + 4 * 86_400_000);
    const booked = await app.request("/agent/bookings", json({
      sessionId, resourceId: await resourceFor(customerId),
      start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), contact,
    }));
    // Asserted, so a refused booking cannot masquerade as a stop-event bug.
    expect(booked.status).toBe(200);

    const run = await db.one<{ state: string; stop_reason: string }>(
      "SELECT state, stop_reason FROM journey_runs WHERE customer_id = $1 AND subject_ref = $2",
      [customerId, subjectRef],
    );
    expect(run.state).toBe("stopped");
    expect(run.stop_reason).toBe("event:booked");
  });

  it("⛔ will not move a statutory date without a reason", async () => {
    const { customerId } = await seed();     // plumber — archetype A
    const subjectRef = `flat-${randomUUID()}`;
    const post = (body: unknown) => appAs(owner).request(`/agent/${customerId}/reminders`, json(body));

    const created = await post({
      kind: "landlord_gas_safety", subjectRef, anchorAt: "2026-06-01T00:00:00Z" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { statutory: boolean }).statutory).toBe(true);

    // No `reason` in the body means no override, so the move is refused rather
    // than applied with the operator's name against a blank justification.
    const blocked = await post({ kind: "landlord_gas_safety", subjectRef, anchorAt: "2026-09-01T00:00:00Z" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toBe("statutory_locked");

    const allowed = await post({
      kind: "landlord_gas_safety", subjectRef, anchorAt: "2027-06-01T00:00:00Z",
      reason: "new certificate issued" });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { moved: boolean }).moved).toBe(true);
  });

  it("⛔ refuses to enrol a suppressed contact rather than reporting success", async () => {
    // Enrolled-but-never-sent looks identical to working on every dashboard.
    const { customerId } = await seed();
    const contact = `gone_${randomUUID()}@example.com`;
    await db.query("INSERT INTO suppression (email_hash, reason) VALUES ($1,'unsubscribe')", [emailHash(contact)]);
    const res = await appAs(owner).request(
      `/agent/${customerId}/journeys`,
      json({ journeyId: "post_job_review", subjectRef: `job-${randomUUID()}`, contact }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("suppressed");
  });

  it("lists what a trade can run and what is running", async () => {
    const { customerId } = await seed();
    const res = await appAs(owner).request(`/agent/${customerId}/journeys`);
    const body = (await res.json()) as { available: { id: string }[]; running: unknown[] };
    expect(body.available.map((j) => j.id)).toContain("post_job_review");
    expect(Array.isArray(body.running)).toBe(true);
  });

  it("requires a login on every owner route", async () => {
    const { customerId } = await seed();
    const anon = appAs(null);
    expect((await anon.request(`/agent/${customerId}/reminders`)).status).toBe(401);
    expect((await anon.request(`/agent/${customerId}/journeys`)).status).toBe(401);
    expect((await anon.request(`/agent/${customerId}/journeys`, json({}))).status).toBe(401);
  });
});
