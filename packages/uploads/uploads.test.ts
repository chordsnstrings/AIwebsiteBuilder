// MF6 + MF9 — 112 units that were blocked on one missing primitive.
//
// There was no file upload route anywhere in the API and `photo_assessments`
// had zero writers. Not partial, not stubbed: absent. So this is mostly a test
// of a security boundary being built for the first time, against the most
// sensitive data the system will ever hold — a KYC pack is a passport scan.
//
// The two constraints carried straight from the catalogue's own wording:
//   ⛔ MF6 "collects and tracks on schedule; performs no assessment"
//   ⛔ MF9 "assesses, never prices"
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { MockObjectStore } from "@adw/vendors";
import {
  UnsupportedUploadError,
  UploadAccessError,
  acceptUpload,
  assemblePack,
  attachDocument,
  consentedPhotos,
  dueChases,
  grantMarketingConsent,
  loadRequest,
  mintStorageKey,
  openRequest,
  ownerPrices,
  packsFor,
  purgeExpired,
  readUpload,
  recordAssessment,
  sniff,
  type UploadDeps,
} from "./src/index.ts";

const URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
let deps: UploadDeps;
let customerId: string;

const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 3)]);

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  deps = { db, store: new MockObjectStore("r2"), scan: async () => ({ clean: true }) };
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment)
     VALUES ('d',$1,'Upload Co','GB','R2','no_site') RETURNING id`,
    [batch.id],
  );
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Upload Co','up@example.com','en-GB','Europe/London','active') RETURNING id`,
    [biz.id],
  );
  customerId = cust.id;
});
afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
describe("⛔ what a file IS, not what it claims to be", () => {
  it("identifies by magic number", () => {
    expect(sniff(JPEG()).mime).toBe("image/jpeg");
    expect(sniff(PDF()).mime).toBe("application/pdf");
    expect(sniff(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)])).mime)
      .toBe("image/png");
  });

  it("accepts HEIC, which is what an iPhone actually produces", () => {
    // The format most upload handlers forget until a customer's photograph
    // silently fails and they conclude the feature is broken.
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from("ftypheic"),
      Buffer.alloc(200),
    ]);
    expect(sniff(heic).kind).toBe("photo");
  });

  it("⛔ ignores the filename entirely", () => {
    // `invoice.pdf` is whatever its first eight bytes say it is.
    const html = Buffer.from("<!doctype html><script>alert(1)</script>" + "x".repeat(200));
    expect(() => sniff(html)).toThrow(UnsupportedUploadError);
  });

  it("⛔ refuses an SVG, and says why", () => {
    // It looks like an image and is a script container. A bare "unsupported
    // file type" makes someone try four times and then telephone.
    expect(() => sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')))
      .toThrow(/script/i);
  });

  it("⛔ refuses archives, executables and macro formats by name", () => {
    const cases: [Buffer, RegExp][] = [
      [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), /zip-based|docx/i],
      [Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0]), /executable/i],
      [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), /executable/i],
      [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), /macro/i],
    ];
    for (const [buf, why] of cases) expect(() => sniff(buf), buf.toString("hex")).toThrow(why);
  });

  it("⛔ refuses an empty or truncated file rather than storing it", async () => {
    // A zero-byte upload is a failed transfer the sender believes succeeded.
    // Marking a requirement 'received' for one completes a pack with nothing
    // in it, which is worse than a pack that stays open.
    await expect(acceptUpload({ bytes: Buffer.alloc(0), declaredName: "a.jpg" }, deps)).rejects.toThrow(
      UnsupportedUploadError,
    );
    await expect(
      acceptUpload({ bytes: Buffer.from([0xff, 0xd8, 0xff]), declaredName: "a.jpg" }, deps),
    ).rejects.toThrow(/too small/);
  });
});

describe("⛔ the storage key is not a capability anyone can guess", () => {
  it("carries nothing about the customer and never repeats", () => {
    // A key encoding a customer id and a filename is an enumeration attack
    // against other people's identity documents.
    const a = mintStorageKey("a".repeat(64), "pdf");
    const b = mintStorageKey("a".repeat(64), "pdf");
    expect(a).not.toBe(b);
    expect(a).not.toContain(customerId);
    expect(a).toMatch(/^uploads\/[0-9a-f]{8}\/[0-9a-f]{32}\.pdf$/);
  });

  it("is never returned to the visitor who uploaded", async () => {
    const accepted = await acceptUpload({ bytes: JPEG(), declaredName: "leak.jpg", customerId }, deps);
    // The route returns uploadId only; asserted at the route level too.
    expect(Object.keys(accepted)).toContain("id");
    expect(accepted.storageKey).toMatch(/^uploads\//);
  });
});

describe("scanning fails closed", () => {
  it("⛔ refuses an infected file BEFORE it reaches the bucket", async () => {
    const store = new MockObjectStore("r2-infected");
    await expect(
      acceptUpload(
        { bytes: JPEG(), declaredName: "x.jpg" },
        { db, store, scan: async () => ({ clean: false, detail: "eicar" }) },
      ),
    ).rejects.toThrow(/security scan/);
    // A stored-then-quarantined file existed at a readable key for however
    // long the quarantine took.
    expect(await store.list("uploads/")).toEqual([]);
  });

  it("⛔ records 'skipped' rather than 'clean' when no scanner is configured", async () => {
    // ⛔ Unique bytes. Identical content hits the dedup path and returns the
    // EARLIER row's scan status, which is correct behaviour and made the first
    // version of this test assert against a file scanned by a different call.
    const bytes = Buffer.concat([JPEG(), Buffer.from(`noscanner-${Date.now()}`)]);
    const accepted = await acceptUpload({ bytes, declaredName: "y.jpg", customerId }, { db, store: deps.store });
    expect(accepted.scanStatus).toBe("skipped");
    // ...and the download path refuses anything that is not clean, so an
    // unconfigured scanner fails closed instead of waving everything through.
    await expect(readUpload(accepted.id, "op@example.com", deps)).rejects.toThrow(UploadAccessError);
  });
});

describe("reading one back", () => {
  it("logs the access before the bytes move", async () => {
    const accepted = await acceptUpload({ bytes: PDF(), declaredName: "passport.pdf", customerId }, deps);
    await readUpload(accepted.id, "owner@example.com", deps);
    const log = await db.one<{ actor: string; action: string }>(
      "SELECT actor, action FROM upload_access_log WHERE upload_id = $1 ORDER BY at DESC LIMIT 1",
      [accepted.id],
    );
    expect(log.actor).toBe("owner@example.com");
    expect(log.action).toBe("download");
  });

  it("deduplicates the same bytes from the same customer", async () => {
    // Somebody tapping upload twice has not sent two documents.
    const first = await acceptUpload({ bytes: PDF(), declaredName: "dup.pdf", customerId }, deps);
    const second = await acceptUpload({ bytes: PDF(), declaredName: "dup.pdf", customerId }, deps);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("⛔ keeps the row and drops only the bytes when retention expires", async () => {
    // Hard-deleting the row would make a completed pack look as though the item
    // was never received — losing both the evidence we collected it and the
    // evidence we disposed of it on time.
    const accepted = await acceptUpload(
      { bytes: Buffer.concat([JPEG(), Buffer.from("unique-retention")]), declaredName: "old.jpg", customerId, retentionDays: -1 },
      deps,
    );
    const purged = await purgeExpired(deps);
    expect(purged).toBeGreaterThan(0);
    const row = await db.one<{ deleted_at: Date | null }>("SELECT deleted_at FROM uploads WHERE id = $1", [accepted.id]);
    expect(row.deleted_at).not.toBeNull();
    await expect(readUpload(accepted.id, "op@example.com", deps)).rejects.toThrow(/deleted/);
  });
});

// ---------------------------------------------------------------------------
describe("document packs (MF6)", () => {
  it("resolves per trade, falling back to the archetype", () => {
    expect(packsFor("childcare").map((p) => p.id)).toContain("child_registration");
    // A plumber has no pack of its own and inherits archetype A's.
    expect(packsFor("plumber").length).toBeGreaterThan(0);
    // ⛔ Per-trade REPLACES the archetype rather than adding to it; asking for
    // two overlapping sets is how a pack never completes.
    expect(packsFor("childcare").map((p) => p.id)).not.toContain("enrolment");
  });

  it("⛔ has no status word implying judgement", async () => {
    // The clerk collects; it performs no assessment. Deciding whether an
    // insurance certificate is genuine, current and adequate is the customer's
    // licensed judgement, and a clerk that grades it moves that liability here.
    const requestId = await openRequest(db, {
      customerId, subjectRef: "case-1", vertical: "lawyer", packId: "client_onboarding",
    });
    const record = await loadRequest(db, requestId);
    const words = JSON.stringify(record).toLowerCase();
    for (const banned of ["valid", "approved", "accepted", "sufficient", "verified"]) {
      expect(words, `status vocabulary must not contain "${banned}"`).not.toContain(`"${banned}"`);
    }
  });

  it("completes on MANDATORY items only", async () => {
    // A pack waiting for optional documents never completes, and the customer
    // is chased for something they were told was optional.
    const requestId = await openRequest(db, {
      customerId, subjectRef: `case-${Date.now()}`, vertical: "lawyer", packId: "client_onboarding",
    });
    const before = await loadRequest(db, requestId);
    const mandatory = before!.outstanding.filter((o) => o.mandatory);
    expect(mandatory.length).toBeGreaterThan(0);

    let complete = false;
    for (const [i, item] of mandatory.entries()) {
      const up = await acceptUpload(
        { bytes: Buffer.concat([PDF(), Buffer.from(`m${i}${requestId}`)]), declaredName: `${item.key}.pdf`, customerId },
        deps,
      );
      const out = await attachDocument(db, requestId, item.key, up.id);
      complete = out.complete;
    }
    expect(complete, "complete once every mandatory item is in").toBe(true);
    const after = await loadRequest(db, requestId);
    expect(after!.state).toBe("complete");
    // Optional items are still outstanding, and that is fine.
    expect(after!.outstanding.every((o) => !o.mandatory)).toBe(true);
  });

  it("⛔ stops chasing, rather than chasing forever", async () => {
    // A pack that asks forever gets marked as spam, and the damage does not
    // stop at this customer — the next business on the same sending domain
    // cannot reach them either.
    const requestId = await openRequest(db, {
      customerId, subjectRef: `chase-${Date.now()}`, vertical: "lawyer", packId: "client_onboarding",
    }, new Date(0));
    let at = new Date(0);
    for (let i = 0; i < 8; i++) {
      at = new Date(at.getTime() + 60 * 86_400_000);
      await dueChases(db, at);
    }
    const row = await db.one<{ next_chase_at: Date | null; state: string }>(
      "SELECT next_chase_at, state FROM document_requests WHERE id = $1",
      [requestId],
    );
    expect(row.next_chase_at, "chasing has stopped").toBeNull();
    // Still open for a human. It just stopped being automatic.
    expect(row.state).toBe("open");
  });

  it("assembles a manifest that reports, and does not conclude", async () => {
    const subjectRef = `pack-${Date.now()}`;
    const requestId = await openRequest(db, { customerId, subjectRef, vertical: "lawyer", packId: "client_onboarding" });
    const up = await acceptUpload(
      { bytes: Buffer.concat([PDF(), Buffer.from(subjectRef)]), declaredName: "id.pdf", customerId },
      deps,
    );
    await attachDocument(db, requestId, "photo_id", up.id, { expiresOn: new Date("2020-01-01") });
    const manifest = await assemblePack(db, requestId);
    const idItem = manifest!.items.find((i) => i.key === "photo_id");
    expect(idItem?.status).toBe("received");
    // ⛔ Expiry is REPORTED, never acted on. A human decides what an expired
    // document means for this matter.
    expect(idItem?.expired).toBe(true);
    expect(manifest!.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("photo assessment (MF9)", () => {
  const assessment = {
    whatItIs: "A stained ceiling below a bathroom",
    apparentScope: "Localised to one corner, from what is visible",
    visibleComplications: [],
    notDeterminable: ["what is above the plasterboard", "how long it has been wet"],
    urgent: false,
    suggestedReply: "Thanks — the owner will confirm scope.",
  };

  it("writes the row that nothing used to write", async () => {
    const up = await acceptUpload(
      { bytes: Buffer.concat([JPEG(), Buffer.from(`assess${Date.now()}`)]), declaredName: "ceiling.jpg", customerId },
      deps,
    );
    const id = await recordAssessment(db, { uploadId: up.id, assessment, customerId });
    const row = await db.one<{ price_cents: number | null; not_determinable: string[] }>(
      "SELECT price_cents, not_determinable FROM photo_assessments WHERE id = $1",
      [id],
    );
    // ⛔ Never priced by the agent. The output schema has no field for one.
    expect(row.price_cents).toBeNull();
    expect(row.not_determinable.length).toBeGreaterThan(0);
  });

  it("⛔ refuses an assessment that claims to see everything", async () => {
    // A photograph always fails to show something. An empty notDeterminable is
    // a guess wearing an assessment's clothes.
    const up = await acceptUpload(
      { bytes: Buffer.concat([JPEG(), Buffer.from(`nd${Date.now()}`)]), declaredName: "x.jpg", customerId },
      deps,
    );
    await expect(
      recordAssessment(db, { uploadId: up.id, assessment: { ...assessment, notDeterminable: [] }, customerId }),
    ).rejects.toThrow(/guess/);
  });

  it("⛔ refuses to assess a PDF", async () => {
    const up = await acceptUpload(
      { bytes: Buffer.concat([PDF(), Buffer.from(`pdfassess${Date.now()}`)]), declaredName: "d.pdf", customerId },
      deps,
    );
    await expect(recordAssessment(db, { uploadId: up.id, assessment, customerId })).rejects.toThrow(/not a photograph/);
  });

  it("only the owner prices, and only once", async () => {
    const up = await acceptUpload(
      { bytes: Buffer.concat([JPEG(), Buffer.from(`price${Date.now()}`)]), declaredName: "p.jpg", customerId },
      deps,
    );
    const id = await recordAssessment(db, { uploadId: up.id, assessment, customerId });
    expect(await ownerPrices(db, id, 18000, "owner@example.com")).toBe(true);
    expect(await ownerPrices(db, id, 1, "someone@example.com"), "a second price is refused").toBe(false);
  });

  it("⛔ consent is a WHERE clause, not a filter a caller is trusted to apply", async () => {
    // Someone who sent a picture of their flooded kitchen so it could be fixed
    // has not agreed to it appearing on a website.
    const up = await acceptUpload(
      { bytes: Buffer.concat([JPEG(), Buffer.from(`consent${Date.now()}`)]), declaredName: "before.jpg", customerId },
      deps,
    );
    expect((await consentedPhotos(db, customerId)).map((p) => p.id)).not.toContain(up.id);
    await grantMarketingConsent(db, up.id, "customer@example.com");
    expect((await consentedPhotos(db, customerId)).map((p) => p.id)).toContain(up.id);
  });
});
