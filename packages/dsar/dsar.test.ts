import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, emailHash, migrate, type Db } from "@adw/db";
import { archiveHash, dsarExport, erase, signArchive, verifyArchive } from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let subject: string;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);

  // Seed a full history for one identity.
  subject = `dsar${Date.now()}@example.com`;
  const hash = emailHash(subject);
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    "INSERT INTO businesses (source_vendor, source_batch_id, name, category, country_code, region_code, city, segment) VALUES ('d',$1,'Subject Co','plumber','US','R1','Denver','no_site') RETURNING id",
    [batch.id],
  );
  const contact = await db.one<{ id: string }>(
    "INSERT INTO contacts (business_id, email, email_hash, verification) VALUES ($1,$2,$3,'valid') RETURNING id",
    [biz.id, subject, hash],
  );
  await db.query(
    "INSERT INTO provenance (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash, no_cem_statement, detector_version, relates_to_role, legal_basis) VALUES ($1,'https://subject.example',now(),'prov/s.png','h',true,'nocem-v1.0.0',true,'can_spam_optout')",
    [contact.id],
  );
  const campaign = await db.one<{ id: string }>(
    "INSERT INTO campaigns (name, region_code, enabled_markets) VALUES ($2,'R1',$1) RETURNING id",
    [["US"], `dsar-${randomUUID()}`],
  );
  const lead = await db.one<{ id: string }>(
    "INSERT INTO leads (contact_id, campaign_id, state, workflow_id) VALUES ($1,$2,'CONTACTED',$3) RETURNING id",
    [contact.id, campaign.id, `wf_${contact.id}`],
  );
  const conv = await db.one<{ id: string }>("INSERT INTO conversations (lead_id, channel) VALUES ($1,'email') RETURNING id", [lead.id]);
  const gd = await db.one<{ id: string }>(
    "INSERT INTO gate_decisions (allow, channel, message_class, config_version, contact_hash) VALUES (true,'email','cold','v1',$1) RETURNING id",
    [hash],
  );
  await db.query(
    "INSERT INTO messages (conversation_id, direction, channel, subject, body_r2_key, body_hash, gate_decision_id, idempotency_key, sent_at) VALUES ($1,'outbound','email','Hello','msg/1','h',$2,$3, now())",
    [conv.id, gd.id, `dsar-${contact.id}`],
  );
  await db.query("INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'unsubscribe','all')", [hash]);
});

afterAll(async () => {
  await db?.close();
});

describe("DSAR export (spec §9.3)", () => {
  it("assembles every section for the identity", async () => {
    const archive = await dsarExport(db, subject);
    const names = archive.manifest.sections.map((s) => s.name);
    for (const expected of ["contacts", "provenance", "messages", "gate_decisions", "suppression", "leads"]) {
      expect(names).toContain(expected);
    }
    const contacts = archive.sections.find((s) => s.name === "contacts")!;
    expect(contacts.rows.length).toBe(1);
    const prov = archive.sections.find((s) => s.name === "provenance")!;
    expect(prov.rows.length).toBe(1);
    expect(archive.manifest.totalRows).toBeGreaterThanOrEqual(5);
  });

  it("includes the provenance source URL and the gate decisions", async () => {
    const archive = await dsarExport(db, subject);
    expect(archive.content).toContain("https://subject.example");
    const gates = archive.sections.find((s) => s.name === "gate_decisions")!;
    expect(gates.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("is signed and the signature verifies; tampering breaks it", async () => {
    const archive = await dsarExport(db, subject);
    expect(archive.manifest.signature).toMatch(/^sha256:/);
    expect(verifyArchive(archive.content, archive.manifest.signature)).toBe(true);
    expect(verifyArchive(archive.content + " ", archive.manifest.signature)).toBe(false);
  });

  it("states the retention carve-outs in the manifest", async () => {
    const archive = await dsarExport(db, subject);
    const notes = archive.manifest.retentionNotes.join(" ");
    expect(notes).toMatch(/provenance/i);
    expect(notes).toMatch(/suppression/i);
    expect(notes).toMatch(/7 years/i);
  });

  it("returns an empty-but-valid archive for an unknown identity", async () => {
    const archive = await dsarExport(db, "nobody-here@example.com");
    expect(archive.manifest.totalRows).toBe(0);
    expect(verifyArchive(archive.content, archive.manifest.signature)).toBe(true);
  });

  it("produces a stable content hash for audit logging", async () => {
    const a = await dsarExport(db, subject, new Date("2026-07-27T00:00:00Z"));
    const b = await dsarExport(db, subject, new Date("2026-07-27T00:00:00Z"));
    expect(archiveHash(a.content)).toBe(archiveHash(b.content));
  });

  it("signArchive is keyed", () => {
    expect(signArchive("x", "k1")).not.toBe(signArchive("x", "k2"));
  });
});

describe("erasure (spec §9.2)", () => {
  it("nulls identifying fields and purges bodies while RETAINING provenance and suppression", async () => {
    const target = `erase${Date.now()}@example.com`;
    const hash = emailHash(target);
    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
    );
    const biz = await db.one<{ id: string }>(
      "INSERT INTO businesses (source_vendor, source_batch_id, name, category, country_code, region_code, city, segment) VALUES ('d',$1,'Erase Co','plumber','US','R1','Denver','no_site') RETURNING id",
      [batch.id],
    );
    const contact = await db.one<{ id: string }>(
      "INSERT INTO contacts (business_id, email, email_hash, verification, role_inferred) VALUES ($1,$2,$3,'valid','owner') RETURNING id",
      [biz.id, target, hash],
    );
    await db.query(
      "INSERT INTO provenance (contact_id, source_url, retrieved_at, screenshot_r2_key, page_hash, no_cem_statement, detector_version, relates_to_role, legal_basis) VALUES ($1,'https://erase.example',now(),'prov/e.png','h',true,'nocem-v1.0.0',true,'can_spam_optout')",
      [contact.id],
    );
    await db.query("INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ($1,'unsubscribe','all')", [hash]);

    const result = await erase(db, target);
    expect(result.contactsNulled).toBe(1);
    expect(result.provenanceRetained).toBe(1);
    expect(result.suppressionRetained).toBe(1);

    // The email is gone but the hash — and therefore the suppression join — survives.
    const after = await db.one<{ email: string; email_hash: Buffer }>(
      "SELECT email, email_hash FROM contacts WHERE id = $1",
      [contact.id],
    );
    expect(after.email).not.toBe(target);
    expect(Buffer.from(after.email_hash).equals(hash)).toBe(true);

    const stillSuppressed = await db.maybeOne("SELECT 1 AS x FROM suppression WHERE email_hash = $1", [hash]);
    expect(stillSuppressed).not.toBeNull();
    const stillEvidenced = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM provenance WHERE contact_id = $1",
      [contact.id],
    );
    expect(Number(stillEvidenced.n)).toBe(1);
  });
});
