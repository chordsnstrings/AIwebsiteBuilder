// Fleet + deliverability control-loop tests (spec §22, §40). Each test builds
// isolated sending_assets rows with a unique pool so global fleet checks stay
// deterministic against a shared test database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { config } from "@adw/config";
import { setSinkForTesting } from "@adw/telemetry";
import {
  assertDnsReady,
  checkFleetInvariants,
  evaluateAssetHealth,
  pickAsset,
  provisionMailbox,
  warmupCap,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

const bands = () => config.thresholds().data.deliverability;
const uniq = () => `p_${Math.random().toString(36).slice(2, 10)}`;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  // Keep telemetry out of the way (no second DB pool, no external calls).
  setSinkForTesting({ emit: async () => {} });
});
afterAll(async () => {
  setSinkForTesting(null);
  await db?.close();
});

async function seedAsset(
  opts: { pool: string; provider?: string; health?: string; dailyCap?: number; kind?: string; identifier?: string },
): Promise<string> {
  const r = await db.one<{ id: string }>(
    `INSERT INTO sending_assets (kind, provider, identifier, domain_class, pool, health, daily_cap, warmup_started)
     VALUES ($1,$2,$3,'burner',$4,$5,$6, now()) RETURNING id`,
    [
      opts.kind ?? "mailbox",
      opts.provider ?? "google",
      opts.identifier ?? `${opts.pool}-${Math.random().toString(36).slice(2)}@x.com`,
      opts.pool,
      opts.health ?? "healthy",
      opts.dailyCap ?? 20,
    ],
  );
  return r.id;
}

describe("§40 warm-up curve", () => {
  it("returns the fixed cap per band", () => {
    expect(warmupCap(1)).toBe(2);
    expect(warmupCap(3)).toBe(2);
    expect(warmupCap(4)).toBe(5);
    expect(warmupCap(7)).toBe(5);
    expect(warmupCap(8)).toBe(10);
    expect(warmupCap(14)).toBe(10);
    expect(warmupCap(15)).toBe(15);
    expect(warmupCap(21)).toBe(15);
    expect(warmupCap(22)).toBe(20);
    expect(warmupCap(60)).toBe(20);
  });
});

describe("§40 DNS readiness", () => {
  it("requires all five assertions", () => {
    expect(assertDnsReady({ spf: true, dkim: true, dmarc: true, ptr: true, tls: true }).ok).toBe(true);
    const r = assertDnsReady({ spf: true, dkim: true, dmarc: true, ptr: false, tls: true });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("ptr");
    expect(assertDnsReady({ spf: false, dkim: false, dmarc: false, ptr: false, tls: false }).ok).toBe(false);
  });
});

describe("§40 provisioning", () => {
  it("provisions a warming mailbox at the day-1 cap", async () => {
    const asset = await provisionMailbox(db, { provider: "microsoft", pool: uniq(), domainClass: "burner" });
    expect(asset.health).toBe("warming");
    expect(asset.daily_cap).toBe(2);
    expect(asset.identifier).toContain("@");
  });
});

describe("§22/§40 deliverability control loop", () => {
  it("complaint spike above the halt threshold ⇒ asset halted AND exception written (REQUIRED GATE)", async () => {
    const pool = uniq();
    const id = await seedAsset({ pool, health: "healthy", dailyCap: 20 });
    const spike = bands().complaint_rate.halt + 0.001; // above halt
    const state = await evaluateAssetHealth(
      db,
      id,
      { complaintRate: spike, bounceRate: 0.001, dailyGmailVolume: 100, inboxPlacement: 0.95 },
      bands(),
    );
    expect(state).toBe("halted");

    const asset = await db.one<{ health: string; daily_cap: number }>(
      "SELECT health, daily_cap FROM sending_assets WHERE id = $1",
      [id],
    );
    expect(asset.health).toBe("halted");
    expect(asset.daily_cap).toBe(0); // removed from rotation

    const exc = await db.maybeOne<{ trigger: string; severity: number }>(
      "SELECT trigger, severity FROM exceptions WHERE context->>'assetId' = $1",
      [id],
    );
    expect(exc).not.toBeNull();
    expect(exc?.trigger).toBe("deliverability_halt");
    expect(exc?.severity).toBe(2);
  });

  it("warn ⇒ throttled halves the daily cap", async () => {
    const pool = uniq();
    const id = await seedAsset({ pool, health: "warn", dailyCap: 20 });
    const throttleLevel = bands().complaint_rate.throttle + 0.00001; // in the throttle band, below halt
    const state = await evaluateAssetHealth(
      db,
      id,
      { complaintRate: throttleLevel, bounceRate: 0.001, dailyGmailVolume: 100, inboxPlacement: 0.95 },
      bands(),
    );
    expect(state).toBe("throttled");
    const asset = await db.one<{ health: string; daily_cap: number }>(
      "SELECT health, daily_cap FROM sending_assets WHERE id = $1",
      [id],
    );
    expect(asset.health).toBe("throttled");
    expect(asset.daily_cap).toBe(10);
  });

  it("healthy metrics ⇒ warn only (notify), cap unchanged", async () => {
    const pool = uniq();
    const id = await seedAsset({ pool, health: "healthy", dailyCap: 20 });
    const warnLevel = bands().complaint_rate.warn + 0.00001; // warn band only
    const state = await evaluateAssetHealth(
      db,
      id,
      { complaintRate: warnLevel, bounceRate: 0.001, dailyGmailVolume: 100, inboxPlacement: 0.95 },
      bands(),
    );
    expect(state).toBe("warn");
    const asset = await db.one<{ daily_cap: number }>("SELECT daily_cap FROM sending_assets WHERE id = $1", [id]);
    expect(asset.daily_cap).toBe(20);
  });

  it("low inbox placement below the halt floor ⇒ halted", async () => {
    const pool = uniq();
    const id = await seedAsset({ pool, health: "healthy", dailyCap: 20 });
    const state = await evaluateAssetHealth(
      db,
      id,
      { complaintRate: 0, bounceRate: 0, dailyGmailVolume: 0, inboxPlacement: bands().inbox_placement.halt - 0.01 },
      bands(),
    );
    expect(state).toBe("halted");
  });
});

describe("§22 fleet invariants", () => {
  it("detects a single provider over the concentration cap", async () => {
    const pool = uniq();
    // 3 google + 1 microsoft ⇒ 2 providers (a ok) but google = 75% > 60% (b fails)
    await seedAsset({ pool, provider: "google" });
    await seedAsset({ pool, provider: "google" });
    await seedAsset({ pool, provider: "google" });
    await seedAsset({ pool, provider: "microsoft" });
    const violations = await checkFleetInvariants(db, pool);
    expect(violations.some((v) => v.includes("google") && v.includes("live mailboxes"))).toBe(true);
  });

  it("detects fewer than two providers", async () => {
    const pool = uniq();
    await seedAsset({ pool, provider: "google" });
    await seedAsset({ pool, provider: "google" });
    const violations = await checkFleetInvariants(db, pool);
    expect(violations.some((v) => v.includes("fewer than 2 providers"))).toBe(true);
  });

  it("a balanced two-provider pool has no violations", async () => {
    const pool = uniq();
    await seedAsset({ pool, provider: "google" });
    await seedAsset({ pool, provider: "microsoft" });
    const violations = await checkFleetInvariants(db, pool);
    expect(violations).toEqual([]);
  });
});

describe("§22 rotation", () => {
  it("returns a healthy asset under its per-domain cap; skips capped ones", async () => {
    const pool = uniq();
    const under = await seedAsset({ pool, provider: "google", health: "healthy", dailyCap: 20 });
    const capped = await seedAsset({ pool, provider: "microsoft", health: "healthy", dailyCap: 5 });
    await db.query("UPDATE sending_assets SET sends_today = 5 WHERE id = $1", [capped]);
    const picked = await pickAsset(db, pool);
    expect(picked?.id).toBe(under);
  });

  it("returns null when every asset is at its cap", async () => {
    const pool = uniq();
    const a = await seedAsset({ pool, health: "healthy", dailyCap: 3 });
    await db.query("UPDATE sending_assets SET sends_today = 3 WHERE id = $1", [a]);
    const picked = await pickAsset(db, pool);
    expect(picked).toBeNull();
  });

  it("⛔ an unmeasured inbox placement contributes nothing, rather than a pass", async () => {
    // It was a hardcoded 0.75 described as a "neutral default". 0.75 sits ABOVE
    // the 0.70 warn floor, so the one input that detects a domain quietly going
    // to spam could never fire — and the board rendered a passing placement
    // metric for a seed-list probe that does not exist.
    const clean = { complaintRate: 0, bounceRate: 0, dailyGmailVolume: 10 };
    const id = await seedAsset({ pool: uniq(), health: "healthy", dailyCap: 20 });
    expect(await evaluateAssetHealth(db, id, { ...clean, inboxPlacement: null }, bands())).toBe("healthy");

    // And a measured bad value still trips, so skipping is not the same as
    // disabling the band.
    const id2 = await seedAsset({ pool: uniq(), health: "healthy", dailyCap: 20 });
    const below = bands().inbox_placement.halt - 0.01;
    expect(await evaluateAssetHealth(db, id2, { ...clean, inboxPlacement: below }, bands())).toBe("halted");
  });
});
