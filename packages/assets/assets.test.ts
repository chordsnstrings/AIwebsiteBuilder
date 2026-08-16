// MF13 — generated images and video.
//
// This is the only place in the system where calling a function debits a real
// account per invocation, and the money is gone whether or not the file is ever
// used. Every assertion here is about that, or about the fact that what comes
// back is not a photograph of anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { MockMediaGenerator, getObjectStore, type MediaGenerator, type MediaRequest, type MediaResult } from "@adw/vendors";
import {
  approveAsset, assetKindsFor, assetLibrary, budgetFor, checkBrief, composePrompt,
  generateApproved, isDecorativeSlot, pendingAssets, rejectAsset, requestAsset,
  setMonthlyCap, spentThisMonthCents, DEFAULT_MONTHLY_CAP_CENTS,
} from "./src/index.ts";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
const uniq = () => `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

async function makeCustomer(vertical = "plumber"): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
     VALUES ('d',$1,$2,'GB','R2','no_site',$3) RETURNING id`, [batch.id, `Asset ${uniq()}`, vertical]);
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R2','Asset Co',$2,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, `a${uniq()}@example.com`]);
  return cust.id;
}

/** A generator that claims to be billable and records every call. */
class SpyGenerator implements MediaGenerator {
  readonly vendorId = "spy";
  readonly calls: MediaRequest[] = [];
  constructor(readonly billable: boolean) {}
  async generate(req: MediaRequest): Promise<MediaResult> {
    this.calls.push(req);
    return {
      url: "data:image/png;base64,iVBORw0KGgo=",
      kind: req.kind, model: req.model, provenance: "ai_generated", tokens: 0,
    };
  }
}

const deps = (generator: MediaGenerator) => ({ generator, store: getObjectStore() });

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterAll(async () => { await db?.close(); });

describe("the catalogue", () => {
  it("resolves asset kinds per archetype", () => {
    expect(assetKindsFor("plumber").map((k) => k.id)).toContain("hero_background");
    // ⛔ A law firm's site carrying AI-generated illustration reads as exactly
    // what it is, so archetype C gets the least.
    expect(assetKindsFor("lawyer").map((k) => k.id)).not.toContain("hero_background");
  });

  it("⛔ every kind targets a decorative slot and none depicts people", () => {
    // The loader throws otherwise, so reaching this line means both held — but
    // asserting makes the rule visible to whoever edits the YAML next.
    for (const t of ["plumber", "lawyer", "restaurant", "hair_salon", "estate_agent"]) {
      for (const k of assetKindsFor(t)) {
        expect(isDecorativeSlot(k.slot), `${t}/${k.id} slot ${k.slot}`).toBe(true);
        expect(k.subject.toLowerCase()).toMatch(/no people/);
      }
    }
  });

  it("⛔ the kind's subject comes first, so a brief cannot repurpose the slot", () => {
    const kind = assetKindsFor("plumber").find((k) => k.id === "hero_background")!;
    const prompt = composePrompt(kind, "blue tones please");
    expect(prompt.startsWith(kind.subject)).toBe(true);
  });
});

describe("⛔ briefs that would make a documentary claim", () => {
  it("refuses the ones an owner will ask for in good faith", () => {
    // The owner is not the adversary. They will ask for "a photo of our team
    // outside the van" because it is a reasonable thing to want, and nothing
    // about the interface says it would be people who do not exist.
    for (const brief of [
      "a photo of our team outside the van",
      "our crew on a roof",
      "a friendly man in overalls",
      "before and after of a bathroom we did",
      "our showroom in Camden",
      "our logo on a van",
      "a Gas Safe badge",
      "a headshot for the about page",
    ]) {
      const out = checkBrief(brief);
      expect(out.ok, `allowed: ${brief}`).toBe(false);
    }
  });

  it("allows an ordinary decorative brief", () => {
    for (const brief of ["soft blue gradient", "abstract copper pipework pattern", "warm neutral texture"]) {
      expect(checkBrief(brief).ok, brief).toBe(true);
    }
  });

  it("refuses at the request, not after generating", async () => {
    const customerId = await makeCustomer();
    const out = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "our team outside the shop" });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("unsafe_brief");
    expect((await pendingAssets(db, customerId)).length, "a refused brief was stored anyway").toBe(0);
  });
});

describe("⛔ money does not move without an approval", () => {
  it("a requested asset never reaches a billable generator", async () => {
    const customerId = await makeCustomer();
    await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "soft blue gradient" });
    const spy = new SpyGenerator(true);
    const run = await generateApproved(db, deps(spy), new Date(), { customerId });
    expect(run.generated).toBe(0);
    expect(spy.calls.length, "a billable call was made against an unapproved request").toBe(0);
  });

  it("generates once approved, and records the provenance and the cost", async () => {
    const customerId = await makeCustomer();
    const req = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "soft blue gradient" });
    expect(req.ok && req.estimatedCostCents).toBeGreaterThan(0);
    expect((await approveAsset(db, (req.ok && req.assetId) as string, "owner@example.com")).ok).toBe(true);

    const spy = new SpyGenerator(true);
    const run = await generateApproved(db, deps(spy), new Date(), { customerId });
    expect(run.generated).toBe(1);
    const [asset] = await assetLibrary(db, customerId);
    expect(asset!.state).toBe("ready");
    expect(asset!.provenance).toBe("ai_generated");
    expect(asset!.approvedBy).toBe("owner@example.com");
    expect(asset!.storageKey).toBeTruthy();
    expect(asset!.actualCostCents).toBe(asset!.estimatedCostCents);
  });

  it("⛔ what was approved cannot be changed — the database refuses", async () => {
    // Otherwise "the owner approved a 6c image" and "the owner approved a 120c
    // video of something else" are the same row.
    const customerId = await makeCustomer();
    const req = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "warm neutral texture" });
    const id = (req.ok && req.assetId) as string;
    await approveAsset(db, id, "owner@example.com");
    await expect(db.query("UPDATE generated_assets SET prompt = 'something else' WHERE id = $1", [id]))
      .rejects.toThrow(/cannot be changed/);
    await expect(db.query("UPDATE generated_assets SET estimated_cost_cents = 1 WHERE id = $1", [id]))
      .rejects.toThrow(/cannot be changed/);
  });

  it("⛔ provenance cannot be cleared or relabelled", async () => {
    // An AI render of a finished roof in a roofer's gallery is a false
    // statement about a job they did; the column being impossible to un-set is
    // the only thing standing between the two.
    const customerId = await makeCustomer();
    const req = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "section_background", brief: "pale texture" });
    const id = (req.ok && req.assetId) as string;
    await expect(db.query("UPDATE generated_assets SET provenance = 'photograph' WHERE id = $1", [id]))
      .rejects.toThrow();
  });

  it("a rejected request stays rejected and is never generated", async () => {
    const customerId = await makeCustomer();
    const req = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "service_icon", brief: "flat wrench illustration" });
    const id = (req.ok && req.assetId) as string;
    expect(await rejectAsset(db, id, "not our style")).toBe(true);
    expect(await rejectAsset(db, id, "again")).toBe(false);
    const spy = new SpyGenerator(true);
    await generateApproved(db, deps(spy), new Date(), { customerId });
    expect(spy.calls.length).toBe(0);
  });

  it("approving twice is a no-op", async () => {
    const customerId = await makeCustomer();
    const req = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "social_card", brief: "clean gradient" });
    const id = (req.ok && req.assetId) as string;
    expect((await approveAsset(db, id, "a@example.com")).ok).toBe(true);
    const second = await approveAsset(db, id, "b@example.com");
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toBe("not_requested");
  });
});

describe("⛔ the spend cap", () => {
  it("defaults to a real number, never to unlimited", async () => {
    const customerId = await makeCustomer();
    const budget = await budgetFor(db, customerId);
    expect(budget.isDefault).toBe(true);
    expect(budget.capCents).toBe(DEFAULT_MONTHLY_CAP_CENTS);
    expect(budget.capCents).toBeGreaterThan(0);
  });

  it("refuses a request that would breach it", async () => {
    const customerId = await makeCustomer();
    await setMonthlyCap(db, customerId, 5, "owner@example.com");
    const out = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "soft blue gradient" });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toBe("cap_exceeded");
  });

  it("⛔ counts approved-but-not-yet-generated work against the cap", async () => {
    // Ten approved videos in the queue have not been paid for yet, but they
    // will be, and a cap that only looks at completed spend authorises the
    // eleventh.
    const customerId = await makeCustomer();
    await setMonthlyCap(db, customerId, 12, "owner@example.com");
    // Nothing has been generated at any point in this test: every unit of
    // spend below is approved-and-queued, which is the state the assertion is
    // about.
    const first = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "gradient one" });
    await approveAsset(db, (first.ok && first.assetId) as string, "owner@example.com");
    expect(await spentThisMonthCents(db, customerId)).toBe(6);

    const second = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "gradient two" });
    expect(second.ok).toBe(true);
    await approveAsset(db, (second.ok && second.assetId) as string, "owner@example.com");
    expect(await spentThisMonthCents(db, customerId)).toBe(12);

    // 6c each against a 12c cap, with nothing generated yet: the third must not
    // fit, and it only does not fit because queued work counts.
    const third = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "gradient three" });
    expect(third.ok).toBe(false);
    expect(!third.ok && third.reason).toBe("cap_exceeded");
    const ready = await db.one<{ n: string }>(
      "SELECT count(*) AS n FROM generated_assets WHERE customer_id = $1 AND state = 'ready'", [customerId]);
    expect(Number(ready.n), "the cap was enforced against completed spend, not queued").toBe(0);
  });

  it("⛔ re-checks at approval, because ten others may have been approved since", async () => {
    const customerId = await makeCustomer();
    await setMonthlyCap(db, customerId, 100, "owner@example.com");
    const a = await requestAsset(db, { customerId, vertical: "plumber", assetKind: "hero_background", brief: "one" });
    const b = await requestAsset(db, { customerId, vertical: "plumber", assetKind: "hero_background", brief: "two" });
    // Both were requested under a 100c cap; now the owner lowers it.
    await setMonthlyCap(db, customerId, 6, "owner@example.com");
    expect((await approveAsset(db, (a.ok && a.assetId) as string, "o@example.com")).ok).toBe(true);
    const blocked = await approveAsset(db, (b.ok && b.assetId) as string, "o@example.com");
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("cap_exceeded");
  });

  it("holds the per-kind monthly quota independently of the money", async () => {
    const customerId = await makeCustomer();
    await setMonthlyCap(db, customerId, 100_000, "owner@example.com");
    // hero_background is 4 a month.
    for (let i = 0; i < 4; i++) {
      const r = await requestAsset(db, {
        customerId, vertical: "plumber", assetKind: "hero_background", brief: `variation ${i}` });
      await approveAsset(db, (r.ok && r.assetId) as string, "o@example.com");
    }
    const fifth = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "variation five" });
    expect(fifth.ok).toBe(false);
    expect(!fifth.ok && fifth.reason).toBe("kind_quota");
  });
});

describe("⛔ a retry is not a second charge", () => {
  it("the same brief returns the same asset rather than a second request", async () => {
    const customerId = await makeCustomer();
    await setMonthlyCap(db, customerId, 1000, "owner@example.com");
    const first = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "identical brief" });
    const second = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "identical brief" });
    expect(second.ok && second.assetId).toBe(first.ok && first.assetId);
  });

  it("the same idempotency key reaches the provider on a retry", async () => {
    // The provider may or may not honour it; the row's own uniqueness is the
    // backstop either way, but sending it costs nothing and may save a charge.
    const customerId = await makeCustomer();
    await setMonthlyCap(db, customerId, 1000, "owner@example.com");
    const req = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "retry me" });
    const id = (req.ok && req.assetId) as string;
    await approveAsset(db, id, "o@example.com");

    let calls = 0;
    const flaky: MediaGenerator = {
      vendorId: "flaky", billable: true,
      async generate(r) {
        calls += 1;
        if (calls === 1) throw new Error("gateway timeout");
        return { url: "data:image/png;base64,iVBORw0KGgo=", kind: r.kind, model: r.model, provenance: "ai_generated", tokens: 0 };
      },
    };
    const keys: string[] = [];
    const recording: MediaGenerator = {
      vendorId: "rec", billable: true,
      generate: async (r) => { keys.push(r.idempotencyKey); return flaky.generate(r); },
    };
    await generateApproved(db, deps(recording), new Date(), { customerId });
    await generateApproved(db, deps(recording), new Date(), { customerId });
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    const row = await db.one<{ state: string }>("SELECT state FROM generated_assets WHERE id = $1", [id]);
    expect(row.state).toBe("ready");
  });

  it("stops after the retry rather than paying a third time", async () => {
    const customerId = await makeCustomer();
    await setMonthlyCap(db, customerId, 1000, "owner@example.com");
    const req = await requestAsset(db, {
      customerId, vertical: "plumber", assetKind: "hero_background", brief: "always fails" });
    await approveAsset(db, (req.ok && req.assetId) as string, "o@example.com");
    let calls = 0;
    const broken: MediaGenerator = {
      vendorId: "broken", billable: true,
      async generate() { calls += 1; throw new Error("content policy"); },
    };
    for (let i = 0; i < 4; i++) await generateApproved(db, deps(broken), new Date(), { customerId });
    expect(calls).toBe(2);
    const row = await db.one<{ state: string; last_error: string }>(
      "SELECT state, last_error FROM generated_assets WHERE id = $1", [req.ok && req.assetId]);
    expect(row.state).toBe("failed");
    expect(row.last_error).toMatch(/content policy/);
  });
});

describe("the simulator", () => {
  it("⛔ says it is not billable, and the real adapter says it is", async () => {
    // The flag lives on the adapter rather than on an environment variable
    // because the environment variable is exactly what is wrong in the
    // deployment where it matters.
    const mock = new MockMediaGenerator();
    expect(mock.billable).toBe(false);
    const { ModelArkMediaGenerator } = await import("@adw/vendors");
    expect(new ModelArkMediaGenerator({ baseUrl: "https://example.test", apiKey: "x" }).billable).toBe(true);
  });

  it("returns ai_generated provenance and replays an idempotent request", async () => {
    const mock = new MockMediaGenerator();
    const req = { kind: "image" as const, prompt: "p", model: "m", idempotencyKey: "k" };
    const a = await mock.generate(req);
    const b = await mock.generate(req);
    expect(a.provenance).toBe("ai_generated");
    expect(a.url).toBe(b.url);
    expect(mock.requests()).toBe(1);
  });
});
