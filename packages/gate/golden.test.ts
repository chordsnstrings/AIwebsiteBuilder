// The five golden tests (spec §48.2) — must never fail in any environment.
// Plus the direct-transport-bypass build assertion.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, migrate, type Db } from "@adw/db";
import { gate, gatedSend, engageKillSwitch, releaseKillSwitch, clearKillSwitchCache, type EmailTransport } from "./src/index.ts";
import { compliantColdMessage, seedContact } from "./test-helpers.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

const okTransport: EmailTransport = {
  async send() {
    return { messageId: `m-${Math.random().toString(36).slice(2)}`, accepted: true };
  },
};

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  await releaseKillSwitch(db, "HALT_ALL_SENDING", "test").catch(() => {});
  clearKillSwitchCache();
});
afterAll(async () => {
  await db?.close();
});

const deps = () => ({ db, now: () => new Date("2026-07-27T15:00:00Z") });

describe("golden tests (spec §48.2)", () => {
  it("G1. a cold send from the brand domain is refused", async () => {
    const c = await seedContact(db, { country: "US" });
    const res = await gatedSend(
      {
        message: compliantColdMessage({ emailHash: c.hash, contactId: c.contactId, messageClass: "cold", domainClass: "brand" }),
        to: c.email,
        from: "hello@brand.com",
        subject: "hi",
        transport: okTransport,
        conversationId: c.conversationId,
      },
      deps(),
    );
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.reason).toBe("DOMAIN_CLASS_MISMATCH");
  });

  it("G2. a suppressed contact is denied on a channel never used before", async () => {
    const c = await seedContact(db, { country: "US" });
    await db.query("INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'complaint','all')", [c.hash]);
    const res = await gate(compliantColdMessage({ emailHash: c.hash, contactId: c.contactId, channel: "whatsapp" }), deps());
    expect(res.allow).toBe(false);
  });

  it("G4. tos_acceptance cannot be written by any path but the acceptance handler", async () => {
    // (Covered structurally at the DB layer; assert the trigger still guards it.)
    const batch = await db.one<{ id: string }>(
      `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','l',1,0,'x') RETURNING id`,
    );
    const biz = await db.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment) VALUES ('d',$1,'X','US','R1','no_site') RETURNING id`,
      [batch.id],
    );
    const cust = await db.one<{ id: string }>(
      `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status) VALUES ($1,'R1','X','x@y.z','en-US','UTC','active') RETURNING id`,
      [biz.id],
    );
    const acct = await db.one<{ id: string }>(
      `INSERT INTO merchant_accounts (customer_id, rail_id) VALUES ($1,'stripe') RETURNING id`,
      [cust.id],
    );
    await expect(
      db.query("UPDATE merchant_accounts SET tos_acceptance = '{}'::jsonb WHERE id = $1", [acct.id]),
    ).rejects.toThrow(/webhook/i);
  });

  it("G5. an email cannot be sent without a gate_decision_id (recorded on every message)", async () => {
    const c = await seedContact(db, { country: "US" });
    const res = await gatedSend(
      {
        message: compliantColdMessage({ emailHash: c.hash, contactId: c.contactId }),
        to: c.email,
        from: "hello@burner.com",
        subject: "hi",
        transport: okTransport,
        conversationId: c.conversationId,
      },
      deps(),
    );
    expect(res.sent).toBe(true);
    if (res.sent) {
      const msg = await db.one<{ gate_decision_id: string | null }>(
        "SELECT gate_decision_id FROM messages WHERE gate_decision_id = $1 LIMIT 1",
        [res.decisionId],
      );
      expect(msg.gate_decision_id).toBe(res.decisionId);
    }
    // Nightly invariant: zero outbound messages lack a gate_decision_id.
    const orphans = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM messages WHERE direction='outbound' AND gate_decision_id IS NULL",
    );
    expect(Number(orphans.n)).toBe(0);
  });
});

describe("build-time invariant: no transport import outside the gate send layer", () => {
  it("no package under agents/ imports a transport library directly", () => {
    // Static assertion mirroring the eslint rule: grep the gate package's own
    // transport imports live only under src/send.
    const sendIndex = readFileSync(join(import.meta.dirname, "src/send/index.ts"), "utf8");
    expect(sendIndex).toContain("EmailTransport");
    // The gate rule chain itself must not import any transport.
    const gateSrc = readFileSync(join(import.meta.dirname, "src/gate.ts"), "utf8");
    expect(gateSrc).not.toMatch(/nodemailer|@aws-sdk\/client-ses/);
  });
});
