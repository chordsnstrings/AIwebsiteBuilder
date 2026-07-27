import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, emailHash, type Db } from "./src/index.ts";

// These tests require the real Postgres server (append-only triggers + role
// grants cannot be exercised on PGlite). Tagged implicitly by connecting to PG.
const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://adw_app:adw@127.0.0.1:5433/adw_test";

let admin: Db;
let app: Db;

beforeAll(async () => {
  admin = await createDb({ backend: "pg", url: ADMIN_URL });
  await migrate(admin);
  app = await createDb({ backend: "pg", url: APP_URL });
});

afterAll(async () => {
  await admin?.close();
  await app?.close();
});

describe("append-only ledgers", () => {
  it("rejects DELETE on suppression even for the admin (trigger)", async () => {
    const hash = emailHash(`del-${Date.now()}@example.com`);
    await admin.query(
      "INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'manual','all')",
      [hash],
    );
    await expect(
      admin.query("DELETE FROM suppression WHERE email_hash = $1", [hash]),
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects UPDATE on gate_decisions", async () => {
    const row = await admin.one<{ id: string }>(
      `INSERT INTO gate_decisions (allow, channel, message_class, config_version)
       VALUES (true, 'email', 'cold', 'test@0') RETURNING id`,
    );
    await expect(
      admin.query("UPDATE gate_decisions SET allow = false WHERE id = $1", [row.id]),
    ).rejects.toThrow(/append-only/i);
  });

  it("the app role cannot DELETE from suppression (grant revoked)", async () => {
    const hash = emailHash(`app-del-${Date.now()}@example.com`);
    await admin.query(
      "INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'manual','all')",
      [hash],
    );
    // Either the grant is missing (permission denied) or the trigger fires first.
    await expect(
      app.query("DELETE FROM suppression WHERE email_hash = $1", [hash]),
    ).rejects.toThrow();
  });
});

describe("tos_acceptance single writer", () => {
  it("blocks a direct UPDATE to tos_acceptance", async () => {
    const cust = await admin.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
       VALUES ('demo', gen_random_uuid(), 'X', 'US', 'R1', 'no_site')
       RETURNING id`,
    ).catch(async () => {
      // needs a batch FK; create one
      const b = await admin.one<{ id: string }>(
        `INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum)
         VALUES ('demo','lic',1,0,'x') RETURNING id`,
      );
      return admin.one<{ id: string }>(
        `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
         VALUES ('demo', $1, 'X', 'US', 'R1', 'no_site') RETURNING id`,
        [b.id],
      );
    });
    const customer = await admin.one<{ id: string }>(
      `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
       VALUES ($1,'R1','X','x@y.z','en-US','UTC','active') RETURNING id`,
      [cust.id],
    );
    const acct = await admin.one<{ id: string }>(
      `INSERT INTO merchant_accounts (customer_id, rail_id) VALUES ($1,'stripe') RETURNING id`,
      [customer.id],
    );
    await expect(
      admin.query("UPDATE merchant_accounts SET tos_acceptance = '{\"date\":1}'::jsonb WHERE id = $1", [
        acct.id,
      ]),
    ).rejects.toThrow(/webhook/i);

    // The blessed path succeeds.
    await admin.query("SELECT adw_accept_tos($1, $2::jsonb)", [acct.id, '{"date":1,"ip":"1.2.3.4"}']);
    const updated = await admin.one<{ tos_acceptance: unknown }>(
      "SELECT tos_acceptance FROM merchant_accounts WHERE id = $1",
      [acct.id],
    );
    expect(updated.tos_acceptance).not.toBeNull();
  });

  it("enforces charge_type = direct", async () => {
    await expect(
      admin.query(
        `INSERT INTO merchant_accounts (customer_id, rail_id, charge_type)
         VALUES ((SELECT id FROM customers LIMIT 1), 'stripe', 'destination')`,
      ),
    ).rejects.toThrow();
  });
});
