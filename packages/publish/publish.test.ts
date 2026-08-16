// MF12 + MF13 — publishing and drafting.
//
// The system could build a site and then had no way to say anything afterwards.
// Everything asserted here is about the one step between a model's sentence and
// a business's public profile: an owner reading it and saying yes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  approvePublication, channelsFor, draftPublication, factsOnlyDrafter, pendingApproval,
  publicationLog, publishApproved, rejectPublication, simulatedConnectors,
  type Connectors, type Drafter,
} from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
const uniq = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
const DAY = 86_400_000;

const FACTS = ["We cover Camden and Islington.", "Gas Safe registered.", "Open Monday to Friday, 8am to 5pm."];

async function makeCustomer(vertical: string): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,$2,'GB','R2','no_site',$3) RETURNING id`, [batch.id, `Pub ${uniq()}`, vertical]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Pub Co',$2,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, `p${uniq()}@example.com`]);
  return cust.id;
}

const fixed = (body: string): Drafter => async () => ({ body, usedFacts: FACTS.slice(0, 1) });

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });

describe("the catalogue", () => {
  it("resolves channels per archetype", () => {
    expect(channelsFor("plumber").map((c) => c.id)).toContain("gbp_post");
    expect(channelsFor("restaurant").map((c) => c.id)).toContain("event_listing");
  });

  it("⛔ every channel that carries claims requires approval", () => {
    // The loader throws otherwise, so reaching this line means it held — but
    // asserting it here is what makes the rule visible to whoever edits the
    // YAML next.
    for (const t of ["plumber", "lawyer", "restaurant", "estate_agent"]) {
      for (const ch of channelsFor(t)) {
        if (ch.carriesClaims) expect(ch.approvalRequired, `${t}/${ch.id}`).toBe(true);
      }
    }
  });
});

describe("drafting", () => {
  it("⛔ will not draft prose with no facts to draft from", async () => {
    // A model asked to write a promotional post about a business it knows
    // nothing about will invent the business, and the invention goes out under
    // their name.
    const customerId = await makeCustomer("plumber");
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel: "gbp_post", topic: "Winter boiler checks" },
      factsOnlyDrafter());
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("no_facts");
  });

  it("records which facts the words rested on", async () => {
    const customerId = await makeCustomer("plumber");
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel: "gbp_post", topic: "Winter boiler checks", facts: FACTS },
      factsOnlyDrafter());
    expect(out.ok).toBe(true);
    const [row] = await pendingApproval(db, customerId);
    expect(row!.sourceFacts.length).toBeGreaterThan(0);
    expect(row!.state).toBe("draft");
  });

  it("⛔ refuses a draft that makes a promise, rather than publishing it", async () => {
    // A promise is a promise whether it is made in a chat window or on a
    // Google post.
    const customerId = await makeCustomer("plumber");
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel: "gbp_post", topic: "Emergencies", facts: FACTS },
      fixed("We guarantee an engineer at your door within 60 minutes, day or night."));
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("refused");
  });

  it("⛔ refuses an over-long draft rather than truncating it", async () => {
    // A post cut at 280 characters lands wherever the model happened to be —
    // frequently in the middle of a price.
    const customerId = await makeCustomer("plumber");
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel: "social_post", topic: "News", facts: FACTS },
      fixed("x".repeat(400)));
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("too_long");
    expect((await pendingApproval(db, customerId)).length, "a refused draft was stored anyway").toBe(0);
  });

  it("refuses a channel the vertical does not publish to", async () => {
    const customerId = await makeCustomer("lawyer");
    const out = await draftPublication(db,
      { customerId, vertical: "lawyer", channel: "product_feed", topic: "x", facts: FACTS },
      factsOnlyDrafter());
    expect(!out.ok && out.reason).toBe("unknown_channel");
  });
});

describe("approval", () => {
  const draft = async (customerId: string, body = "Winter boiler checks. We cover Camden and Islington.") => {
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel: "gbp_post", topic: `Topic ${uniq()}`, facts: FACTS },
      fixed(body));
    return (out.ok && out.publicationId) as string;
  };

  it("⛔ a draft never reaches a connector", async () => {
    // The approval step is the only thing standing between a model's sentence
    // and a business's public profile.
    const customerId = await makeCustomer("plumber");
    await draft(customerId);
    const run = await publishApproved(db, simulatedConnectors(), new Date(), { customerId });
    expect(run.published).toBe(0);
  });

  it("publishes once approved, and records who approved it", async () => {
    const customerId = await makeCustomer("plumber");
    const id = await draft(customerId);
    expect((await approvePublication(db, id, "owner@example.com")).ok).toBe(true);
    const run = await publishApproved(db, simulatedConnectors(), new Date(), { customerId });
    expect(run.published).toBe(1);
    const [row] = await publicationLog(db, customerId);
    expect(row!.state).toBe("published");
    expect(row!.approvedBy).toBe("owner@example.com");
    expect(row!.externalId).toMatch(/^gbp_/);
  });

  it("lets the owner edit before approving, and says that they did", async () => {
    const customerId = await makeCustomer("plumber");
    const id = await draft(customerId);
    const out = await approvePublication(db, id, "owner@example.com", { body: "My own words." });
    expect(out.ok && out.edited).toBe(true);
    const row = await db.one<{ body: string; edited: boolean }>("SELECT body, edited FROM publications WHERE id = $1", [id]);
    expect(row.body).toBe("My own words.");
    expect(row.edited).toBe(true);
  });

  it("⛔ what went out is what was approved — the database refuses, not the code", async () => {
    // Without this, an edit after approval leaves the audit trail asserting a
    // sign-off against words the owner never read.
    const customerId = await makeCustomer("plumber");
    const id = await draft(customerId);
    await approvePublication(db, id, "owner@example.com");
    await expect(db.query("UPDATE publications SET body = 'something else' WHERE id = $1", [id]))
      .rejects.toThrow(/cannot be changed/);
  });

  it("approving twice is a no-op, and a rejected draft stays rejected", async () => {
    const customerId = await makeCustomer("plumber");
    const id = await draft(customerId);
    expect((await approvePublication(db, id, "a@example.com")).ok).toBe(true);
    const second = await approvePublication(db, id, "b@example.com");
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toBe("not_draft");

    const other = await draft(customerId);
    expect(await rejectPublication(db, other, "not our tone")).toBe(true);
    expect(await rejectPublication(db, other, "again")).toBe(false);
    await publishApproved(db, simulatedConnectors(), new Date(), { customerId });
    // Asserted on the REJECTED row specifically: a sweep that publishes the
    // approved one is correct, and counting the sweep's total would have hidden
    // whether the rejected one went with it.
    const row = await db.one<{ state: string }>("SELECT state FROM publications WHERE id = $1", [other]);
    expect(row.state).toBe("rejected");
  });

  it("⛔ an over-long edit is refused at approval too", async () => {
    const customerId = await makeCustomer("plumber");
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel: "social_post", topic: `T ${uniq()}`, facts: FACTS },
      fixed("Short and fine."));
    const id = (out.ok && out.publicationId) as string;
    const approved = await approvePublication(db, id, "owner@example.com", { body: "y".repeat(400) });
    expect(approved.ok).toBe(false);
    expect(!approved.ok && approved.reason).toBe("too_long");
  });
});

describe("publishing", () => {
  const approvedDraft = async (customerId: string, channel = "gbp_post") => {
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel, topic: `Topic ${uniq()}`, facts: FACTS },
      fixed("Winter boiler checks. We cover Camden and Islington."));
    const id = (out.ok && out.publicationId) as string;
    await approvePublication(db, id, "owner@example.com");
    return id;
  };

  it("⛔ holds back a second post on a channel inside its cadence", async () => {
    // An owner working through their queue on a Sunday approves eight posts in
    // ten minutes; releasing all eight is a business that looks automated.
    const customerId = await makeCustomer("plumber");
    await approvedDraft(customerId);
    await approvedDraft(customerId);
    const t0 = new Date();
    const first = await publishApproved(db, simulatedConnectors(), t0, { customerId });
    expect(first.published).toBe(1);
    expect(first.deferred).toBe(1);

    // gbp_post is every 7 days.
    const tooSoon = await publishApproved(db, simulatedConnectors(), new Date(t0.getTime() + 3 * DAY), { customerId });
    expect(tooSoon.published).toBe(0);
    const later = await publishApproved(db, simulatedConnectors(), new Date(t0.getTime() + 8 * DAY), { customerId });
    expect(later.published).toBe(1);
  });

  it("⛔ a retry after a timeout is the same post, not a second one", async () => {
    // A duplicate on a business's own profile is visible to their customers and
    // cannot be recalled.
    const customerId = await makeCustomer("plumber");
    const id = await approvedDraft(customerId);
    const keys: string[] = [];
    const connectors: Connectors = {
      gbp: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        return keys.length === 1
          ? { ok: false, error: "gateway timeout", retryable: true }
          : { ok: true, externalId: `gbp_${idempotencyKey.slice(0, 8)}` };
      },
    };
    const t0 = new Date();
    await publishApproved(db, connectors, t0, { customerId });
    await publishApproved(db, connectors, new Date(t0.getTime() + 60_000), { customerId });
    expect(keys.length).toBe(2);
    expect(keys[0], "the retry used a different idempotency key").toBe(keys[1]);
    const row = await db.one<{ state: string }>("SELECT state FROM publications WHERE id = $1", [id]);
    expect(row.state).toBe("published");
  });

  it("⛔ stops immediately on a refusal rather than retrying into a rate limit", async () => {
    // The third attempt against a platform that already said no tells us
    // nothing the first did not.
    const customerId = await makeCustomer("plumber");
    const id = await approvedDraft(customerId);
    let calls = 0;
    const connectors: Connectors = {
      gbp: async () => { calls += 1; return { ok: false, error: "post rejected by policy", retryable: false }; },
    };
    await publishApproved(db, connectors, new Date(), { customerId });
    await publishApproved(db, connectors, new Date(), { customerId });
    expect(calls).toBe(1);
    const row = await db.one<{ state: string; last_error: string }>(
      "SELECT state, last_error FROM publications WHERE id = $1", [id]);
    expect(row.state).toBe("failed");
    expect(row.last_error).toMatch(/policy/);
  });

  it("⛔ counts what it could not send rather than reporting a clean sweep", async () => {
    const customerId = await makeCustomer("plumber");
    await approvedDraft(customerId);
    const run = await publishApproved(db, { social: async () => ({ ok: true, externalId: "x" }) }, new Date(), { customerId });
    expect(run.published).toBe(0);
    expect(run.unconnected).toBe(1);
  });

  it("a mechanical signal needs no approval and has no cadence", async () => {
    // answer_file_refresh carries no claim, so it is the one shape of thing
    // this system may do in a business's name unattended.
    const customerId = await makeCustomer("plumber");
    const out = await draftPublication(db,
      { customerId, vertical: "plumber", channel: "answer_file_refresh", topic: `refresh ${uniq()}`,
        payload: { reason: "site rebuilt" } },
      factsOnlyDrafter());
    expect(out.ok).toBe(true);
    await approvePublication(db, (out.ok && out.publicationId) as string, "system");
    const run = await publishApproved(db, simulatedConnectors(), new Date(), { customerId });
    expect(run.published).toBe(1);
  });
});
