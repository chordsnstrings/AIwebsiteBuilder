// Webhook effects. These paths are the ones that fail silently when they are
// wrong: a complaint that is acknowledged and dropped looks exactly like a
// complaint that was honoured, right up until the sending domain is dead.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { randomUUID } from "node:crypto";
import { applyWebhookEffects } from "./src/webhooks.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

/** A sent outbound message carrying the provider's message id. */
async function makeSentMessage(): Promise<{ messageId: string; providerId: string; email: string }> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,'Feedback Co','US','R1','no_site') RETURNING id`,
    [batch.id],
  );
  const email = `fb_${randomUUID()}@example.com`;
  const contact = await db.one<{ id: string }>(
    "INSERT INTO contacts (business_id, email, email_hash, verification) VALUES ($1,$2,$3,'valid') RETURNING id",
    [biz.id, email, emailHash(email)],
  );
  const campaign = await db.one<{ id: string }>(
    "INSERT INTO campaigns (name, region_code) VALUES ($1,'R1') RETURNING id",
    [`fb-campaign-${randomUUID()}`],
  );
  const lead = await db.one<{ id: string }>(
    `INSERT INTO leads (contact_id, campaign_id, state, workflow_id) VALUES ($1,$2,'EMAIL_SENT','wf-fb') RETURNING id`,
    [contact.id, campaign.id],
  );
  const conv = await db.one<{ id: string }>(
    "INSERT INTO conversations (lead_id, channel) VALUES ($1,'email') RETURNING id",
    [lead.id],
  );
  // Every outbound message carries the gate decision that let it out — golden
  // test §48.2 fails the whole suite on an orphan, so the fixture builds one
  // rather than side-stepping the invariant it is standing next to.
  const decision = await db.one<{ id: string }>(
    `INSERT INTO gate_decisions (allow, channel, message_class, jurisdiction, legal_basis,
                                 config_version, contact_hash)
     VALUES (true,'email','cold_outreach','US','legitimate_interest','test',$1) RETURNING id`,
    [emailHash(email)],
  );
  const providerId = `prov_${randomUUID()}`;
  const msg = await db.one<{ id: string }>(
    `INSERT INTO messages (conversation_id, direction, channel, body_r2_key, body_hash,
                           gate_decision_id, idempotency_key, provider_message_id, sent_at)
     VALUES ($1,'outbound','email','r2/x','h',$2,$3,$4, now()) RETURNING id`,
    [conv.id, decision.id, `idem_${randomUUID()}`, providerId],
  );
  return { messageId: msg.id, providerId, email };
}

const suppressedFor = async (email: string): Promise<string | null> => {
  const row = await db.maybeOne<{ reason: string }>(
    "SELECT reason FROM suppression WHERE email_hash = $1",
    [emailHash(email)],
  );
  return row?.reason ?? null;
};

describe("email feedback", () => {
  it("suppresses on a complaint and marks the message", async () => {
    const { providerId, email, messageId } = await makeSentMessage();
    const out = await applyWebhookEffects(db, "aws_ses", {
      notificationType: "Complaint",
      mail: { messageId: providerId },
      complaint: { complainedRecipients: [{ emailAddress: email }] },
    });

    expect(out.handled).toBe(true);
    expect(await suppressedFor(email)).toBe("complaint");
    const row = await db.one<{ complained_at: string | null }>(
      "SELECT complained_at FROM messages WHERE id = $1",
      [messageId],
    );
    expect(row.complained_at).not.toBeNull();
  });

  it("suppresses on a permanent bounce", async () => {
    const { providerId, email, messageId } = await makeSentMessage();
    await applyWebhookEffects(db, "aws_ses", {
      notificationType: "Bounce",
      mail: { messageId: providerId },
      bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: email }] },
    });

    expect(await suppressedFor(email)).toBe("hard_bounce");
    const row = await db.one<{ bounced_at: string | null }>("SELECT bounced_at FROM messages WHERE id = $1", [
      messageId,
    ]);
    expect(row.bounced_at).not.toBeNull();
  });

  it("does NOT suppress on a transient bounce", async () => {
    // A full mailbox is not a person who cannot be contacted, and suppression
    // is irreversible — the safe direction here is to leave them reachable.
    const { providerId, email, messageId } = await makeSentMessage();
    await applyWebhookEffects(db, "aws_ses", {
      notificationType: "Bounce",
      mail: { messageId: providerId },
      bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: email }] },
    });

    expect(await suppressedFor(email)).toBeNull();
    // It still counts against the asset's bounce rate.
    const row = await db.one<{ bounced_at: string | null }>("SELECT bounced_at FROM messages WHERE id = $1", [
      messageId,
    ]);
    expect(row.bounced_at).not.toBeNull();
  });

  it("records a delivery", async () => {
    const { providerId, messageId } = await makeSentMessage();
    const out = await applyWebhookEffects(db, "aws_ses", {
      notificationType: "Delivery",
      mail: { messageId: providerId },
    });
    expect(out.handled).toBe(true);
    const row = await db.one<{ delivered_at: string | null }>(
      "SELECT delivered_at FROM messages WHERE id = $1",
      [messageId],
    );
    expect(row.delivered_at).not.toBeNull();
  });

  it("unwraps the SNS envelope SES actually posts", async () => {
    const { providerId, email } = await makeSentMessage();
    const out = await applyWebhookEffects(db, "aws_ses", {
      Type: "Notification",
      TopicArn: "arn:aws:sns:us-east-1:1:ses-feedback",
      Message: JSON.stringify({
        notificationType: "Complaint",
        mail: { messageId: providerId },
        complaint: { complainedRecipients: [{ emailAddress: email }] },
      }),
    });
    expect(out.handled).toBe(true);
    expect(await suppressedFor(email)).toBe("complaint");
  });

  it("is idempotent — a replayed complaint does not error", async () => {
    const { providerId, email } = await makeSentMessage();
    const event = {
      notificationType: "Complaint",
      mail: { messageId: providerId },
      complaint: { complainedRecipients: [{ emailAddress: email }] },
    };
    await applyWebhookEffects(db, "aws_ses", event);
    const second = await applyWebhookEffects(db, "aws_ses", event);
    expect(second.handled).toBe(true);
    const count = await db.one<{ n: string }>("SELECT count(*) AS n FROM suppression WHERE email_hash = $1", [
      emailHash(email),
    ]);
    expect(Number(count.n)).toBe(1);
  });

  it("tolerates a notification naming a message we never sent", async () => {
    const out = await applyWebhookEffects(db, "aws_ses", {
      notificationType: "Delivery",
      mail: { messageId: `unknown_${randomUUID()}` },
    });
    expect(out.handled).toBe(true);
  });
});

describe("billing events", () => {
  async function makeSubscription(): Promise<{ id: string; stripeId: string }> {
    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
    );
    const biz = await db.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
       VALUES ('d',$1,'Billing Co','US','R1','no_site') RETURNING id`,
      [batch.id],
    );
    const cust = await db.one<{ id: string }>(
      `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
       VALUES ($1,'R1','Billing Co',$2,'en-US','UTC','active') RETURNING id`,
      [biz.id, `bill_${randomUUID()}@example.com`],
    );
    const stripeId = `sub_${randomUUID().replace(/-/g, "")}`;
    const sub = await db.one<{ id: string }>(
      `INSERT INTO subscriptions (customer_id, plan_code, billing_interval, amount_cents, currency,
                                  stripe_subscription_id, status, current_period_end)
       VALUES ($1,'R1_STANDARD','month',34900,'USD',$2,'active', now() + interval '30 days') RETURNING id`,
      [cust.id, stripeId],
    );
    return { id: sub.id, stripeId };
  }

  it("starts dunning on a failed payment", async () => {
    const sub = await makeSubscription();
    const out = await applyWebhookEffects(db, "stripe", {
      type: "invoice.payment_failed",
      data: { object: { subscription: sub.stripeId } },
    });
    expect(out.handled).toBe(true);

    const state = await db.one<{ step: number; pause_at: string | null }>(
      "SELECT step, pause_at FROM dunning_state WHERE subscription_id = $1",
      [sub.id],
    );
    expect(state.step).toBe(1);
    // Step 1 never pauses the site — that is the whole point of the schedule.
    expect(state.pause_at).toBeNull();
  });

  it("resolves dunning when payment succeeds", async () => {
    const sub = await makeSubscription();
    await applyWebhookEffects(db, "stripe", {
      type: "invoice.payment_failed",
      data: { object: { subscription: sub.stripeId } },
    });
    await applyWebhookEffects(db, "stripe", {
      type: "invoice.paid",
      data: { object: { subscription: sub.stripeId } },
    });

    const state = await db.one<{ step: number; status: string }>(
      "SELECT step, status FROM dunning_state WHERE subscription_id = $1",
      [sub.id],
    );
    expect(state.step).toBe(0);
    expect(state.status).toBe("active");
  });

  it("cancels on subscription deletion", async () => {
    const sub = await makeSubscription();
    await applyWebhookEffects(db, "stripe", {
      type: "customer.subscription.deleted",
      data: { object: { id: sub.stripeId } },
    });
    const row = await db.one<{ status: string }>("SELECT status FROM subscriptions WHERE id = $1", [sub.id]);
    expect(row.status).toBe("canceled");
  });

  it("escalates a dispute to a human instead of acting on it", async () => {
    const before = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM exceptions WHERE trigger = 'payment_dispute'",
    );
    const out = await applyWebhookEffects(db, "stripe", {
      type: "charge.dispute.created",
      data: { object: { id: "dp_1" } },
    });
    expect(out.effects).toContain("exception:payment_dispute");
    const after = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM exceptions WHERE trigger = 'payment_dispute'",
    );
    expect(Number(after.n)).toBe(Number(before.n) + 1);
  });

  it("ignores an unknown subscription without touching anything", async () => {
    const out = await applyWebhookEffects(db, "stripe", {
      type: "invoice.payment_failed",
      data: { object: { subscription: "sub_neverseen" } },
    });
    expect(out.effects).toEqual(["ignored:unknown_subscription"]);
  });
});

describe("unhandled shapes", () => {
  it("reports not-handled rather than throwing", async () => {
    for (const payload of [null, "string", 42, {}, { type: "some.unmapped.event" }]) {
      const out = await applyWebhookEffects(db, "stripe", payload);
      expect(out.handled).toBe(false);
    }
  });
});
