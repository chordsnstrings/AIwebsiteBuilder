// Walking-skeleton e2e over the durable engine (spec §35 structural guarantees).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { Engine, TestClock } from "./src/engine/index.ts";
import { registerStubActivities } from "./src/testing.ts";
import { buildWorkflow, leadWorkflow } from "./src/definitions/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

function buildEngine(clock: TestClock, gate: { pass: boolean; hardFail: boolean }, ip: "pass" | "flag") {
  const engine = new Engine({ db, clock });
  const deployed: string[] = [];
  registerStubActivities(engine, {
    reviewer_gate: async () => gate,
    ip_screen: async () => ({ verdict: ip }),
    deploy_build: async () => {
      deployed.push("art/1");
      return { buildId: "b1", url: "https://site.example" };
    },
  });
  engine.registerWorkflow(buildWorkflow);
  return { engine, deployed };
}

describe("build workflow — deploy is unreachable except from a passing gate", () => {
  it("a passing build deploys", async () => {
    const { engine, deployed } = buildEngine(new TestClock(0), { pass: true, hardFail: false }, "pass");
    const id = `build-ok-${Date.now()}`;
    await engine.start("build", id, { businessId: "b", mode: "full" });
    const res = await engine.result<{ deployed: boolean }>(id);
    expect(res.deployed).toBe(true);
    expect(deployed).toEqual(["art/1"]);
  });

  it("a hard-fail build cannot deploy", async () => {
    const { engine, deployed } = buildEngine(new TestClock(0), { pass: false, hardFail: true }, "pass");
    const id = `build-hardfail-${Date.now()}`;
    await engine.start("build", id, { businessId: "b", mode: "full" });
    const res = await engine.result<{ deployed: boolean; haltedReason?: string }>(id);
    expect(res.deployed).toBe(false);
    expect(res.haltedReason).toBe("hard_fail");
    expect(deployed).toEqual([]);
  });

  it("an IP flag blocks deploy (hard stop → human)", async () => {
    const { engine, deployed } = buildEngine(new TestClock(0), { pass: true, hardFail: false }, "flag");
    const id = `build-ip-${Date.now()}`;
    await engine.start("build", id, { businessId: "b", mode: "full" });
    const res = await engine.result<{ deployed: boolean; haltedReason?: string }>(id);
    expect(res.deployed).toBe(false);
    expect(res.haltedReason).toBe("ip_flag");
    expect(deployed).toEqual([]);
  });
});

describe("lead workflow — engagement and cooldown", () => {
  function leadEngine(clock: TestClock) {
    const engine = new Engine({ db, clock });
    const marks: string[] = [];
    registerStubActivities(engine, {
      mark_engaged: async () => { marks.push("engaged"); return null; },
      mark_parked: async () => { marks.push("parked"); return null; },
      mark_exhausted: async () => { marks.push("exhausted"); return null; },
    });
    engine.registerWorkflow(leadWorkflow);
    return { engine, marks };
  }

  it("⛔ an enterprise account never reaches the preview", async () => {
    // A4, A5 and A6 exist to produce a speculative preview. Building one of a
    // hospital group's website, under their name, on our domain, and emailing
    // the link is passing off — so the branch is taken BEFORE the knowledge
    // base and the pack, not at the render.
    const engine = new Engine({ db, clock: new TestClock(0) });
    const reached: string[] = [];
    registerStubActivities(engine, {
      resolve_acquisition_track: async () => ({ segment: "enterprise_global", speculativePreview: false }),
      extract_knowledge_base: async () => { reached.push("kb"); return { kbId: "kb", factCount: 0 }; },
      generate_qa_pack: async () => { reached.push("pack"); return { packId: "p", pairCount: 0, thin: true }; },
      generate_preview: async () => { reached.push("preview"); return { generated: true, agentBound: true }; },
      send_outreach: async () => { reached.push("outreach"); return { sent: true }; },
      open_enterprise_opportunity: async () => { reached.push("opportunity"); return { opened: true }; },
    });
    engine.registerWorkflow(leadWorkflow);
    const id = `lead-ent-${Date.now()}`;
    await engine.start("lead", id, { leadId: "l", contactId: "c", businessId: "b" });
    const res = await engine.result<{ finalState: string; previewGenerated: boolean; contacted: boolean }>(id);

    expect(res.finalState).toBe("ROUTED_ENTERPRISE");
    expect(res.previewGenerated).toBe(false);
    expect(res.contacted).toBe(false);
    expect(reached).toEqual(["opportunity"]);
    // ⛔ Spelled out: no knowledge base, no pack, no preview, no cold email.
    expect(reached).not.toContain("preview");
    expect(reached).not.toContain("outreach");
  });

  it("engages on a positive reply", async () => {
    const { engine, marks } = leadEngine(new TestClock(0));
    const id = `lead-eng-${Date.now()}`;
    await engine.start("lead", id, { leadId: "l", contactId: "c", businessId: "b" });
    await engine.signal(id, "reply", { intent: 85 });
    const res = await engine.result<{ finalState: string }>(id);
    expect(res.finalState).toBe("ENGAGED");
    expect(marks).toContain("engaged");
  });

  it("runs to EXHAUSTED through the full sequence + 180-day cooldown via time-skip", async () => {
    const clock = new TestClock(0);
    const { engine, marks } = leadEngine(clock);
    const id = `lead-exh-${Date.now()}`;
    await engine.start("lead", id, { leadId: "l", contactId: "c", businessId: "b" });
    // No replies: advance through the three sequence timers, then the cooldown.
    for (let i = 0; i < 4; i++) {
      clock.advance(20 * DAY);
      await engine.fireDueTimers();
    }
    clock.advance(200 * DAY);
    await engine.fireDueTimers();
    const res = await engine.result<{ finalState: string }>(id);
    expect(res.finalState).toBe("EXHAUSTED");
    expect(marks).toContain("exhausted");
  });
});
