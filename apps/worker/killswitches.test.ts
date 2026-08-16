// ⛔ The three kill switches nothing read.
//
// `HALT_BUILDS`, `HALT_PAYMENTS_ONBOARDING` and `HALT_AGENT:<role>` were
// settable from the console, stored, displayed as engaged, and read by
// absolutely nothing that halted. `HALT_ALL_SENDING` and `HALT_COLD_ONLY`
// worked, so the console showed five switches of which two were real.
//
// That is worse than having no switch at all: a switch that appears to work
// stops the operator looking for the real off button, and they only find out
// during the incident it was installed for.
//
// These tests live in the worker because it is the composition root that has
// the gateway, the activities and the gate in one place.
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  agentHalted, buildsHalted, clearKillSwitchCache, engageKillSwitch,
  paymentsOnboardingHalted, readEngagedSwitches, releaseKillSwitch,
} from "@adw/gate";
import { complete } from "@adw/gateway";
import { LocalKeyWrapper, LocalPgBackend } from "@adw/vault";
import { z } from "zod";

const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
});
afterEach(() => { clearKillSwitchCache(); });
afterAll(async () => { await db?.close(); });

describe("the readers", () => {
  it("report each switch independently", async () => {
    await engageKillSwitch(db, "HALT_BUILDS", "op@example.com");
    let engaged = await readEngagedSwitches(db, Date.now());
    expect(buildsHalted(engaged)).toBe(true);
    expect(paymentsOnboardingHalted(engaged)).toBe(false);

    await releaseKillSwitch(db, "HALT_BUILDS", "op@example.com");
    clearKillSwitchCache();
    engaged = await readEngagedSwitches(db, Date.now());
    expect(buildsHalted(engaged)).toBe(false);
  });

  it("⛔ HALT_AGENT is exact-match, never a prefix", () => {
    // `HALT_AGENT:developer` must not silence `developer_review` as well. An
    // incident response that halts more than the operator asked for makes the
    // next operator hesitate to use it.
    const engaged = new Set(["HALT_AGENT:developer"]);
    expect(agentHalted(engaged, "developer")).toBe(true);
    expect(agentHalted(engaged, "developer_review")).toBe(false);
    expect(agentHalted(engaged, "customer_care")).toBe(false);
  });
});

describe("⛔ HALT_AGENT actually stops a model call", () => {
  const vault = () => new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
  const request = {
    role: "customer_care" as const,
    dataClass: "CUST" as const,
    system: "s",
    user: "u",
    schema: z.object({ ok: z.boolean() }),
    maxTokensOut: 50,
    budgetUsdPerPassingOutput: 0.01,
    simulate: () => ({ ok: true }),
  };

  it("runs normally, then refuses once the switch is engaged, then runs again", async () => {
    const deps = { db, vault: vault(), forceMock: true };
    clearKillSwitchCache();
    expect((await complete(request, deps)).result.ok).toBe(true);

    await engageKillSwitch(db, "HALT_AGENT:customer_care", "op@example.com");
    clearKillSwitchCache();
    await expect(complete(request, deps)).rejects.toThrow(/HALT_AGENT:customer_care/);

    // ⛔ And only that role. Halting one agent must not take the fleet down.
    clearKillSwitchCache();
    const other = await complete({ ...request, role: "intent_router" as const }, deps);
    expect(other.result.ok).toBe(true);

    await releaseKillSwitch(db, "HALT_AGENT:customer_care", "op@example.com");
    clearKillSwitchCache();
    expect((await complete(request, deps)).result.ok).toBe(true);
  });
});

describe("⛔ HALT_BUILDS and HALT_PAYMENTS_ONBOARDING reach their chokepoints", () => {
  it("the build activities refuse while the switch is engaged", async () => {
    // Asserted through the registered activity rather than the helper, because
    // the defect being fixed was precisely that the helper existed and nothing
    // called it.
    const { Engine } = await import("@adw/workflows");
    const { registerActivities } = await import("./src/activities.ts");
    const engine = new Engine({ db });
    registerActivities(engine, { db, vault: new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64))), forceMock: true });

    await engageKillSwitch(db, "HALT_BUILDS", "op@example.com");
    clearKillSwitchCache();
    await expect(
      engine.runActivity("cutover_dns", { customerId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/HALT_BUILDS/);

    await engageKillSwitch(db, "HALT_PAYMENTS_ONBOARDING", "op@example.com");
    clearKillSwitchCache();
    const prescreen = (await engine.runActivity("payments_prescreen", {
      customerId: "00000000-0000-0000-0000-000000000000",
    })) as { offered: boolean; reason?: string };
    // ⛔ Refused at the PRESCREEN, so nobody is left half-onboarded.
    expect(prescreen.offered).toBe(false);
    expect(prescreen.reason).toBe("HALT_PAYMENTS_ONBOARDING");

    await expect(
      engine.runActivity("create_connected_account", { customerId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/HALT_PAYMENTS_ONBOARDING/);

    await releaseKillSwitch(db, "HALT_BUILDS", "op@example.com");
    await releaseKillSwitch(db, "HALT_PAYMENTS_ONBOARDING", "op@example.com");
    clearKillSwitchCache();
  });
});

describe("⛔ no enterprise account gets a speculative preview", () => {
  it("the preview activity refuses, and says why in the queue", async () => {
    // Asserted through the REGISTERED ACTIVITY rather than through
    // `mayBuildSpeculativePreview`, because the whole failure class this
    // codebase keeps finding is a guard that exists and is not called. This
    // activity is also reachable from the revision loop and from a manual
    // re-run, which is why the check lives at the render.
    const { Engine } = await import("@adw/workflows");
    const { registerActivities } = await import("./src/activities.ts");
    const engine = new Engine({ db });
    registerActivities(engine, { db, vault: new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64))), forceMock: true });

    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
    const biz = await db.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
       VALUES ('d',$1,'St Elsewhere NHS Trust','GB','R2','no_site','hospitals_and_health_systems') RETURNING id`,
      [batch.id]);

    const out = (await engine.runActivity("generate_preview", {
      leadId: "00000000-0000-0000-0000-000000000000", contactId: "00000000-0000-0000-0000-000000000000",
      businessId: biz.id,
    })) as { generated: boolean; refused?: string };
    expect(out.generated).toBe(false);
    expect(out.refused).toBe("enterprise_segment");

    const raised = await db.maybeOne(
      "SELECT 1 AS x FROM exceptions WHERE trigger = 'enterprise_preview_refused' AND context->>'businessId' = $1",
      [biz.id]);
    expect(raised, "the refusal was silent").not.toBeNull();

    // ⛔ And nothing was written to previews. A refusal that still leaves a page
    // behind is not a refusal.
    const preview = await db.maybeOne("SELECT 1 AS x FROM previews WHERE business_id = $1", [biz.id]);
    expect(preview).toBeNull();
  });

  it("routes the account into the enterprise pipeline instead", async () => {
    const { Engine } = await import("@adw/workflows");
    const { registerActivities } = await import("./src/activities.ts");
    const engine = new Engine({ db });
    registerActivities(engine, { db, vault: new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64))), forceMock: true });

    const batch = await db.one<{ id: string }>(
      "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','L',1,0,'x') RETURNING id");
    const biz = await db.one<{ id: string }>(
      `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical)
       VALUES ('d',$1,'Northgate Bank','GB','R2','no_site','retail_banking_and_lending') RETURNING id`,
      [batch.id]);

    const routed = (await engine.runActivity("resolve_acquisition_track", { businessId: biz.id })) as {
      segment: string; speculativePreview: boolean;
    };
    expect(routed.segment).toBe("enterprise_global");
    expect(routed.speculativePreview).toBe(false);

    const opened = (await engine.runActivity("open_enterprise_opportunity", { businessId: biz.id })) as {
      opened: boolean; created: boolean;
    };
    expect(opened.opened).toBe(true);
    // ⛔ Raised as well as opened. An opportunity nobody is told about is a row.
    const raised = await db.maybeOne(
      "SELECT 1 AS x FROM exceptions WHERE trigger = 'enterprise_opportunity_opened' AND context->>'businessId' = $1",
      [biz.id]);
    expect(raised).not.toBeNull();
  });
});
