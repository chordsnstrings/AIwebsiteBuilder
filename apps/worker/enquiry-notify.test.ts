// The notification that closes the only gap where this product lied to the
// public.
//
// A visitor asks a customer's agent for an emergency callout and leaves their
// number. `commitEnquiry` writes the row. The agent says, in words, that it has
// passed the details on. Nothing read the table — no SELECT in the repository,
// no route, no job — so the owner never found out and the caller waited for a
// call that was never coming.
//
// These tests drive the real notifier through the real compliance gate against
// a real database, because every previous version of this defect passed a test
// that stopped short of the transport.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, migrate, type Db } from "@adw/db";
import { MAX_NOTIFY_ATTEMPTS, SETTLE_MS } from "@adw/concierge";
import { notifyPendingEnquiries, bodyFor, subjectFor } from "./src/enquiry-notify.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

/** Records what it was handed instead of sending it. */
function recorder() {
  const sent: { to: string; subject: string; body: string }[] = [];
  return {
    sent,
    transport: {
      async send(m: { to: string; from: string; subject: string; body: string }) {
        sent.push({ to: m.to, subject: m.subject, body: m.body });
        return { messageId: `m_${sent.length}` };
      },
    },
  };
}

/** A transport that refuses, standing in for an outage. */
const brokenTransport = {
  async send(): Promise<{ messageId: string }> {
    throw new Error("ses unavailable");
  },
};

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

interface Fx {
  customerId: string;
  businessId: string;
  email: string;
}

async function seedCustomer(countryCode = "GB"): Promise<Fx> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical, phone_e164, city)
     VALUES ('d',$1,'Notify Plumbing',$2,'R1','no_site','plumber','+447700900000','Leeds') RETURNING id`,
    [batch.id, countryCode],
  );
  const email = `notify_${randomUUID()}@example.com`;
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R1','Notify Plumbing',$2,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, email],
  );
  return { customerId: cust.id, businessId: biz.id, email };
}

/** `createdAt` defaults to well past the settle window so the row is eligible. */
async function seedEnquiry(
  fx: Fx,
  opts: { urgency?: string; need?: string; contact?: string; name?: string; ageMs?: number; orphan?: boolean; asOf?: Date } = {},
): Promise<string> {
  const at = new Date((opts.asOf ?? new Date()).getTime() - (opts.ageMs ?? SETTLE_MS + 60_000));
  const row = await db.one<{ id: string }>(
    `INSERT INTO enquiries (customer_id, business_id, name, need, contact, urgency, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7) RETURNING id`,
    [
      opts.orphan === true ? null : fx.customerId,
      fx.businessId,
      opts.name ?? null,
      opts.need ?? "leaking tap",
      opts.contact ?? "07700900111",
      opts.urgency ?? "normal",
      at,
    ],
  );
  return row.id;
}

/** Isolate each test from rows other tests left behind. */
beforeEach(async () => {
  await db.query("UPDATE enquiries SET notified_at = now() WHERE notified_at IS NULL");
});

const notifiedAt = async (id: string): Promise<Date | null> =>
  (await db.one<{ notified_at: Date | null }>("SELECT notified_at FROM enquiries WHERE id = $1", [id])).notified_at;

// ---------------------------------------------------------------------------
describe("the enquiry notification", () => {
  it("reaches the owner with the caller's number in it", async () => {
    const fx = await seedCustomer();
    const id = await seedEnquiry(fx, { name: "Dana", need: "boiler not firing", contact: "07700900222" });
    const rec = recorder();

    const out = await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });

    expect(out.notified).toBe(1);
    expect(rec.sent).toHaveLength(1);
    const mail = rec.sent[0]!;
    expect(mail.to).toBe(fx.email);
    expect(mail.body).toContain("Dana");
    expect(mail.body).toContain("boiler not firing");
    // ⛔ The contact detail is the entire point. An email that makes the owner
    // log in to find the phone number gets ignored on a Saturday night.
    expect(mail.body).toContain("07700900222");
    expect(await notifiedAt(id)).toBeInstanceOf(Date);
  });

  it("⛔ carries a privacy link, or the gate denies it and nobody is told", async () => {
    // This is the exact defect that stopped the delivery email from EVER
    // sending: rule_10 checks the body materially for a privacy notice, the
    // body had none, and the caller ignored the return value.
    const fx = await seedCustomer();
    await seedEnquiry(fx);
    const rec = recorder();
    await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });
    expect(rec.sent[0]?.body.toLowerCase()).toContain("privacy");
  });

  it("⛔ sends on a Saturday night, because that is when trades get emergencies", async () => {
    // Quiet hours are a marketing rule. Applied to this class they denied every
    // evening and weekend enquiry — precisely the hours a plumber's emergency
    // work arrives — and the owner was never told.
    const fx = await seedCustomer();
    const saturdayNight = new Date("2026-08-22T23:30:00Z"); // Sat, well outside 08:00–18:00
    await seedEnquiry(fx, { urgency: "emergency", need: "kitchen flooding", asOf: saturdayNight });
    const rec = recorder();
    const out = await notifyPendingEnquiries({
      db, transport: rec.transport, from: "hello@adwsites.com", now: () => saturdayNight,
    });
    expect(out.failed).toBe(0);
    expect(out.notified).toBe(1);
    expect(rec.sent[0]?.subject).toContain("Emergency");
  });

  it("batches one owner's enquiries into one email, worst urgency in the subject", async () => {
    const fx = await seedCustomer();
    await seedEnquiry(fx, { need: "quote for a new bathroom" });
    await seedEnquiry(fx, { urgency: "emergency", need: "burst pipe" });
    const rec = recorder();

    const out = await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });

    expect(rec.sent).toHaveLength(1);
    expect(out.notified).toBe(2);
    expect(rec.sent[0]?.subject).toContain("emergency");
    expect(rec.sent[0]?.body).toContain("burst pipe");
    expect(rec.sent[0]?.body).toContain("quote for a new bathroom");
  });

  it("⛔ leaves an enquiry unnotified while the conversation is still settling", async () => {
    // `commitEnquiry` UPDATES the open row when a visitor corrects themselves —
    // "actually it's flooding" turns a normal into an emergency. Mailing
    // instantly would send the draft and never correct it.
    const fx = await seedCustomer();
    const id = await seedEnquiry(fx, { ageMs: 5_000 });
    const rec = recorder();
    const out = await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });
    expect(out.notified).toBe(0);
    expect(rec.sent).toHaveLength(0);
    expect(await notifiedAt(id)).toBeNull();
  });

  it("⛔ never mails about a speculative preview's enquiry", async () => {
    // A preview carries the widget too, and the business has not bought
    // anything or asked to hear from us. That send would be cold mail wearing a
    // transactional hat.
    const fx = await seedCustomer();
    const id = await seedEnquiry(fx, { orphan: true });
    const rec = recorder();
    await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });
    expect(rec.sent).toHaveLength(0);
    expect(await notifiedAt(id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("⛔ when the send does not go", () => {
  it("does not mark it delivered, and keeps the reason", async () => {
    // Marking first and sending second records a failed send as delivered and
    // the enquiry is then lost in a way that looks exactly like success.
    const fx = await seedCustomer();
    const id = await seedEnquiry(fx);

    const out = await notifyPendingEnquiries({ db, transport: brokenTransport, from: "hello@adwsites.com" });

    expect(out.notified).toBe(0);
    expect(out.failed).toBe(1);
    expect(await notifiedAt(id)).toBeNull();
    const row = await db.one<{ notify_attempts: number; notify_error: string | null }>(
      "SELECT notify_attempts, notify_error FROM enquiries WHERE id = $1", [id],
    );
    expect(row.notify_attempts).toBe(1);
    expect(row.notify_error).toContain("ses unavailable");
  });

  it("gives up after a few tries and puts it in the OWNER's queue", async () => {
    // A permanent denial retried forever is an alert storm; one that silently
    // stops is a lost enquiry. It stops, and it says so to the person who needs
    // to know — which is the owner, not us.
    const fx = await seedCustomer();
    const id = await seedEnquiry(fx);

    for (let i = 0; i < MAX_NOTIFY_ATTEMPTS; i++) {
      await notifyPendingEnquiries({ db, transport: brokenTransport, from: "hello@adwsites.com" });
    }

    const exception = await db.maybeOne<{ customer_id: string; severity: number }>(
      `SELECT customer_id, severity FROM exceptions
        WHERE trigger = 'enquiry_notification_undelivered' AND customer_id = $1`,
      [fx.customerId],
    );
    expect(exception?.customer_id).toBe(fx.customerId);

    // And it stops trying: a further pass picks nothing up.
    const rec = recorder();
    const after = await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });
    expect(after.customers).toBe(0);
    expect(rec.sent).toHaveLength(0);

    // ⛔ The enquiry itself is untouched and still open. The email is the nudge;
    // the dashboard is the record, and losing the nudge must not lose the lead.
    const row = await db.one<{ status: string }>("SELECT status FROM enquiries WHERE id = $1", [id]);
    expect(row.status).toBe("open");
  });

  it("does not send the same batch twice after a successful pass", async () => {
    const fx = await seedCustomer();
    await seedEnquiry(fx);
    const rec = recorder();
    await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });
    await notifyPendingEnquiries({ db, transport: rec.transport, from: "hello@adwsites.com" });
    expect(rec.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("the words, without a database", () => {
  const base = {
    customerId: "c1", contactEmail: "o@example.com", legalName: "Plumbing", countryCode: "GB",
    createdAt: new Date(), name: null, need: "tap", contact: "0770", enquiryId: "e1",
  } as const;

  it("names an unnamed caller without pretending to know them", () => {
    expect(bodyFor([{ ...base, urgency: "normal" }], "c1")).toContain("Someone");
  });

  it("puts the worst urgency in the subject, not the newest", () => {
    expect(
      subjectFor([
        { ...base, urgency: "normal" },
        { ...base, enquiryId: "e2", urgency: "emergency" },
      ]),
    ).toContain("emergency");
  });
});
