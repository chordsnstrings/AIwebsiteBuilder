// The inbound path.
//
// The system was outbound-only: replies landed in a mailbox nobody read,
// `replied_at` was written by nothing, and LeadWorkflow waited on a `reply`
// signal with no production emitter — so every lead ran all three touches and
// was marked EXHAUSTED regardless of what the recipient wrote back.
//
// The assertions that carry weight are the ones about what must NOT happen: an
// out-of-office must not advance a lead, our own unsubscribe footer must not
// suppress someone who said yes, and an ambiguous thread must not be guessed at.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import {
  classifyInbound,
  extractFailedRecipient,
  extractSesInbound,
  matchConversation,
  mintReplyToken,
  parseEmail,
  replyAddress,
  routeInbound,
  stripQuoted,
  tokenFromAddress,
  verifyReplyToken,
} from "./src/index.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const SECRET = "reply-token-secret";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db.end?.();
});

const mime = (headers: Record<string, string>, body: string): string =>
  Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n") + `\n\n${body}`;

// ---------------------------------------------------------------------------
describe("parsing", () => {
  it("unfolds headers, which is how a long References line arrives", () => {
    const raw = "Subject: a very\n long subject\nFrom: A <a@b.com>\n\nbody";
    const e = parseEmail(raw);
    expect(e.subject).toBe("a very long subject");
    expect(e.from).toBe("a@b.com");
  });

  it("prefers text/plain in a multipart/alternative", () => {
    const raw = [
      "From: a@b.com",
      "Content-Type: multipart/alternative; boundary=X",
      "",
      "--X",
      "Content-Type: text/plain",
      "",
      "the plain one",
      "--X",
      "Content-Type: text/html",
      "",
      "<p>the html one</p>",
      "--X--",
    ].join("\n");
    expect(parseEmail(raw).text).toBe("the plain one");
  });

  it("⛔ strips an HTML-only reply to text rather than dropping it", () => {
    // A reply we cannot read is indistinguishable downstream from a reply that
    // never came, and plenty of mobile clients send HTML only.
    const raw = mime({ From: "a@b.com", "Content-Type": "text/html" }, "<div>Yes please<br>call me</div>");
    expect(parseEmail(raw).text).toContain("Yes please");
  });

  it("decodes base64 and quoted-printable bodies", () => {
    const b64 = mime(
      { From: "a@b.com", "Content-Transfer-Encoding": "base64" },
      Buffer.from("interested, call Tuesday").toString("base64"),
    );
    expect(parseEmail(b64).text).toBe("interested, call Tuesday");
    const qp = mime({ From: "a@b.com", "Content-Transfer-Encoding": "quoted-printable" }, "caf=C3=A9 at 3pm");
    expect(parseEmail(qp).text).toContain("at 3pm");
  });
});

describe("quoted-history stripping", () => {
  it("removes the quote block and the signature", () => {
    const body = ["Sounds good, call me Tuesday.", "", "-- ", "Jane", "", "On Mon, 3 Jun, ADW <a@b> wrote:", "> our pitch"].join("\n");
    const out = stripQuoted(body);
    expect(out).toBe("Sounds good, call me Tuesday.");
  });

  it("⛔ never returns empty when the input was not empty", () => {
    // A top-quoted "Yes please" is the most valuable message in the system. An
    // over-eager stripper returning "" would have it read as silence.
    const topQuoted = ["On Mon, ADW wrote:", "> our pitch", "", "Yes please"].join("\n");
    expect(stripQuoted(topQuoted).length).toBeGreaterThan(0);
    expect(stripQuoted(topQuoted)).toContain("Yes please");
  });
});

// ---------------------------------------------------------------------------
describe("⛔ an out-of-office must never count as a reply", () => {
  // Auto-replies outnumber real replies on most cold lists. Counting one as
  // engagement marks the lead ENGAGED, stops the sequence, means no human ever
  // follows up, and makes the reply rate on the dashboard a fiction.
  it("catches the RFC 3834 header", () => {
    const e = parseEmail(mime({ From: "a@b.com", "Auto-Submitted": "auto-replied" }, "I am away"));
    expect(classifyInbound(e).kind).toBe("auto_reply");
  });

  it("catches Precedence: bulk and the vendor headers", () => {
    for (const h of [{ Precedence: "bulk" }, { "X-Autoreply": "yes" }, { "X-Auto-Response-Suppress": "All" }]) {
      const e = parseEmail(mime({ From: "a@b.com", ...h }, "away"));
      expect(classifyInbound(e).kind, JSON.stringify(h)).toBe("auto_reply");
    }
  });

  it("catches the subject lines, including localised ones", () => {
    for (const s of [
      "Automatic reply: your email",
      "Out of office",
      "Re: Out of the office until Monday",
      "Abwesenheitsnotiz",
      "Réponse automatique",
    ]) {
      expect(classifyInbound(parseEmail(mime({ From: "a@b.com", Subject: s }, "away"))).kind, s).toBe("auto_reply");
    }
  });

  it("⛔ does NOT treat Auto-Submitted: no as automated", () => {
    // The header exists precisely so a human-generated message can say so.
    // Treating its presence as the signal misclassifies well-behaved senders.
    const e = parseEmail(mime({ From: "a@b.com", "Auto-Submitted": "no" }, "Yes, interested"));
    expect(classifyInbound(e).kind).toBe("human");
  });
});

describe("stop requests", () => {
  it("catches the phrasings people actually use", () => {
    for (const body of [
      "please unsubscribe me",
      "Take me off your list",
      "stop emailing me",
      "Do not contact me again",
      "STOP",
      "No thanks",
    ]) {
      expect(classifyInbound(parseEmail(mime({ From: "a@b.com" }, body))).kind, body).toBe("unsubscribe");
    }
  });

  it("⛔ does not fire on OUR unsubscribe footer inside the quoted history", () => {
    // Every email we send carries a List-Unsubscribe footer by law, so it is in
    // the quoted history of every reply we receive. Matching it there would
    // suppress people who replied "sounds great" — the exact opposite outcome.
    const body = [
      "Sounds great, when can you start?",
      "",
      "On Mon, ADW <a@b> wrote:",
      "> Here is your preview.",
      "> To unsubscribe from these emails, click here.",
    ].join("\n");
    const e = parseEmail(mime({ From: "a@b.com" }, body));
    expect(classifyInbound(e).kind).toBe("human");
  });
});

describe("bounces that arrive as mail rather than as a webhook", () => {
  it("recognises a DSN and extracts the failed recipient", () => {
    const raw = mime(
      { From: "MAILER-DAEMON@x.com", Subject: "Undeliverable: your message", "Return-Path": "<>" },
      "Final-Recipient: rfc822; gone@example.com\nAction: failed",
    );
    const e = parseEmail(raw);
    expect(classifyInbound(e).kind).toBe("bounce");
    expect(extractFailedRecipient(e)).toBe("gone@example.com");
  });

  it("prefers X-Failed-Recipients, which is what several large providers send", () => {
    const e = parseEmail(mime({ From: "d@x.com", "X-Failed-Recipients": "Gone@Example.com" }, "failed"));
    expect(extractFailedRecipient(e)).toBe("gone@example.com");
  });

  it("returns null rather than guessing when it cannot attribute the bounce", () => {
    // Suppressing the wrong address silently removes a real prospect.
    const e = parseEmail(mime({ From: "d@x.com", Subject: "Delivery Status Notification" }, "something went wrong"));
    expect(extractFailedRecipient(e)).toBeNull();
  });

  it("recognises an ARF feedback report as a complaint", () => {
    const e = parseEmail(
      mime({ From: "fbl@isp.com", "Content-Type": 'multipart/report; report-type="feedback-report"; boundary=X' }, "--X--"),
    );
    expect(classifyInbound(e).kind).toBe("complaint");
  });
});

// ---------------------------------------------------------------------------
describe("reply tokens", () => {
  it("round-trips and survives the plus-address form", () => {
    const t = mintReplyToken({ conversationId: "conv-1", leadId: "lead-1" }, SECRET);
    const addr = replyAddress("reply@inbound.example", t);
    expect(addr).toContain("reply+");
    expect(verifyReplyToken(tokenFromAddress(addr)!, SECRET)).toEqual({ conversationId: "conv-1", leadId: "lead-1" });
  });

  it("⛔ refuses a token whose conversation id was edited", () => {
    // Without the signature, anyone can read a Reply-To off an email we sent,
    // change the id, and post a reply into someone else's conversation.
    const t = mintReplyToken({ conversationId: "conv-1" }, SECRET);
    const forged = t.replace("conv-1", "conv-2");
    expect(verifyReplyToken(forged, SECRET)).toBeNull();
    expect(verifyReplyToken(t, "different-secret")).toBeNull();
  });
});

describe("matching a reply to a conversation", () => {
  it("⛔ refuses rather than guessing when a sender has several open threads", async () => {
    // Attaching a reply to the wrong conversation would show one business's
    // words to another. An unmatched message in the exception queue is strictly
    // better than a wrong match nobody notices.
    const email = { from: "ambiguous@example.com", to: ["cold@ours.example"], references: [] };
    const seeded = await seedTwoThreads(db, "ambiguous@example.com");
    expect(seeded).toBe(2);
    const m = await matchConversation(email, { db, replyTokenSecret: SECRET });
    expect(m.via).toBe("unmatched");
    expect(m.reason).toMatch(/refusing to guess/);
  });

  it("surfaces a token that fails verification instead of silently falling through", async () => {
    // Either an attack, or a secret rotation that orphaned every in-flight
    // thread. Both need to be visible.
    const m = await matchConversation(
      { from: "x@example.com", to: ["reply+conv-1.badmac@inbound.example"], references: [] },
      { db, replyTokenSecret: SECRET },
    );
    expect(m.via).toBe("unmatched");
    expect(m.reason).toMatch(/failed verification/);
  });
});

// ---------------------------------------------------------------------------
describe("SES receipt notifications", () => {
  it("decodes inline MIME", () => {
    const r = extractSesInbound({
      notificationType: "Received",
      content: Buffer.from("From: a@b.com\n\nhello").toString("base64"),
      receipt: { spamVerdict: { status: "PASS" }, virusVerdict: { status: "PASS" } },
    });
    expect(r.kind).toBe("mime");
    expect(r.kind === "mime" && r.raw).toContain("hello");
  });

  it("⛔ returns an S3 pointer rather than reporting no mail", () => {
    // A receipt rule switched from SNS-inline to S3 for size reasons would
    // otherwise turn every reply into silence.
    const r = extractSesInbound({
      notificationType: "Received",
      receipt: { action: { type: "S3", bucketName: "b", objectKey: "k" } },
    });
    expect(r).toMatchObject({ kind: "s3", bucket: "b", key: "k" });
  });

  it("⛔ refuses a message Amazon already flagged as carrying a virus", () => {
    const r = extractSesInbound({
      notificationType: "Received",
      content: Buffer.from("x").toString("base64"),
      receipt: { virusVerdict: { status: "FAIL" } },
    });
    expect(r.kind).toBe("rejected");
  });

  it("⛔ does NOT refuse on a spam verdict", () => {
    // Cold-outreach replies routinely trip a spam verdict. Dropping those would
    // discard exactly the messages that matter most.
    const r = extractSesInbound({
      notificationType: "Received",
      content: Buffer.from("From: a@b.com\n\nyes").toString("base64"),
      receipt: { spamVerdict: { status: "FAIL" }, virusVerdict: { status: "PASS" } },
    });
    expect(r.kind).toBe("mime");
  });
});

// ---------------------------------------------------------------------------
describe("routing, end to end", () => {
  it("suppresses a stop request even when the thread cannot be identified", async () => {
    // ⛔ Someone who asks to be taken off the list is taken off the list. Making
    // that conditional on our ability to thread their message would be
    // indefensible.
    const from = `stopme-${Date.now()}@example.com`;
    const out = await routeInbound(mime({ From: from, Subject: "Re: preview" }, "take me off your list"), {
      db,
      replyTokenSecret: SECRET,
    });
    expect(out.kind).toBe("unsubscribe");
    expect(out.suppressed).toBe(true);
    expect(out.match).toBe("unmatched");
    const row = await db.maybeOne("SELECT 1 AS x FROM suppression WHERE email_hash = $1", [emailHash(from)]);
    expect(row).not.toBeNull();
  });

  it("⛔ never signals the workflow for an auto-reply", async () => {
    const signals: string[] = [];
    const out = await routeInbound(
      mime({ From: `ooo-${Date.now()}@example.com`, "Auto-Submitted": "auto-replied" }, "I am on leave until August"),
      { db, replyTokenSecret: SECRET, signalWorkflow: async (_id, name) => void signals.push(name) },
    );
    expect(out.kind).toBe("auto_reply");
    expect(out.signalled).toBe(false);
    expect(signals).toEqual([]);
  });

  it("raises an exception for a message it could not place, rather than dropping it", async () => {
    const before = await db.one<{ n: string }>("SELECT count(*) AS n FROM exceptions WHERE trigger = 'inbound_unrouted'");
    await routeInbound(mime({ From: `nowhere-${Date.now()}@example.com` }, "who is this?"), {
      db,
      replyTokenSecret: SECRET,
    });
    const after = await db.one<{ n: string }>("SELECT count(*) AS n FROM exceptions WHERE trigger = 'inbound_unrouted'");
    expect(Number(after.n)).toBeGreaterThan(Number(before.n));
  });

  it("⛔ never writes the message body into the event log", async () => {
    const secretPhrase = `commercially-sensitive-${Date.now()}`;
    await routeInbound(mime({ From: `body-${Date.now()}@example.com` }, secretPhrase), {
      db,
      replyTokenSecret: SECRET,
    });
    const hit = await db.maybeOne(
      "SELECT 1 AS x FROM events WHERE event_type = 'email.received' AND payload::text LIKE $1",
      [`%${secretPhrase}%`],
    );
    expect(hit, "message bodies are not logged at any level").toBeNull();
  });
});

/** Two open conversations for one contact, so the ambiguity branch has something
 *  real to refuse. Returns how many were created. */
async function seedTwoThreads(db: Db, email: string): Promise<number> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,'Amb Ltd','GB','R2','no_site') RETURNING id`,
    [batch.id],
  );
  const contact = await db.one<{ id: string }>(
    "INSERT INTO contacts (business_id, email, email_hash, verification) VALUES ($1,$2,$3,'valid') RETURNING id",
    [biz.id, email, emailHash(email)],
  );
  let made = 0;
  for (let i = 0; i < 2; i++) {
    const campaign = await db.one<{ id: string }>(
      "INSERT INTO campaigns (name, region_code) VALUES ($1,'R2') RETURNING id",
      [`amb-${Date.now()}-${i}`],
    );
    // The partial unique index allows only ONE non-terminal lead per contact, so
    // the second is parked in a terminal state and its conversation still counts
    // as an open thread — which is exactly the ambiguity being tested.
    const lead = await db.one<{ id: string }>(
      "INSERT INTO leads (contact_id, campaign_id, state, workflow_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [contact.id, campaign.id, i === 0 ? "CONTACTED" : "EXHAUSTED", `wf-amb-${i}`],
    );
    await db.query("INSERT INTO conversations (lead_id, channel) VALUES ($1,'email')", [lead.id]);
    made++;
  }
  return made;
}
