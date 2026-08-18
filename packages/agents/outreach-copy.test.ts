// ⛔ The cold email IS the product's first delivery. Every defect below shipped
// in it, and every one of them was invisible because demo mode papered over the
// live behaviour:
//
//   * The role's own prompt says "never include a recipient address, link, or
//     sender identity — those come from the workflow". Nothing downstream ever
//     supplied one. The URL reached the body only because `simulate`
//     interpolated it, so against a real model every cold email went out with
//     no preview link at all — the pitch is "we built you a site, look at it",
//     and there was no look-at-it.
//   * The caller hardcoded an empty defect list, so the body read "your current
//     listing has 0 issues that make you hard to find" on every send — the one
//     sentence the whole grading step exists to make true, printing its
//     opposite.
//   * A lead with no preview was handed the foundry's own marketing homepage as
//     its "preview URL", so the text-only branch pitched a preview that did not
//     exist. 601 of 621 contacted leads had no preview.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { outreachAgent, stripModelLinks } from "./src/roles.ts";

const LINK = /(?:https?:\/\/|www\.)[^\s<>"')]+|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const URL_ = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";

let db: Db;
let deps: never;
beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
  deps = { db, forceMock: true } as never;
});
afterAll(async () => { await db?.close(); });
const base = { name: "Halloran Roofing", city: "Leeds", locale: "en-GB" as const };

async function draft(over: Partial<{ verifiedDefects: string[]; hasPreview: boolean; sequenceStep: number }>) {
  const out = await outreachAgent.run(
    { ...base, verifiedDefects: [], hasPreview: true, sequenceStep: 0, ...over },
    deps,
    { subjectId: "test" },
  );
  return out.result;
}

describe("⛔ the model never writes the link", () => {
  it("produces no URL and no address of its own", async () => {
    const withPreview = await draft({ hasPreview: true });
    expect(withPreview.bodyText, "the workflow substitutes the URL, not the model").not.toMatch(LINK);
    expect(withPreview.subject).not.toMatch(LINK);
  });

  it("strips one the model wrote anyway", async () => {
    // ⛔ The prompt asks; postProcess enforces. A fabricated URL in cold
    // outreach is a destination nobody verified, sent to someone who never
    // asked to hear from us — an injection arriving through the output side.
    const cleaned = stripModelLinks({
      subject: "Check https://evil.example now",
      bodyText: "Pay us at billing@evil.example or https://evil.example/x.",
    });
    expect(cleaned.bodyText).not.toMatch(LINK);
    expect(cleaned.subject).not.toMatch(LINK);
    expect(cleaned.subject).toBe("Check now");
  });
});

describe("⛔ claims trace to the audit", () => {
  it("names what the audit actually found", async () => {
    const out = await draft({ verifiedDefects: ["no phone number listed", "no opening hours"], hasPreview: true });
    expect(out.bodyText).toContain("no phone number listed");
    expect(out.bodyText).toMatch(/\b2 things\b/);
  });

  it("says 'one thing' for one, not '1 things'", async () => {
    const out = await draft({ verifiedDefects: ["no opening hours"] });
    expect(out.bodyText).toContain("one thing");
  });

  it("⛔ never claims a count when the audit found nothing", async () => {
    // "your current listing has 0 issues that make you hard to find" was the
    // literal text of every cold email this system sent.
    const out = await draft({ verifiedDefects: [] });
    expect(out.bodyText).not.toMatch(/\b0\b/);
    expect(out.bodyText.toLowerCase()).not.toContain("0 issues");
  });
});

describe("⛔ a preview is claimed only when one exists", () => {
  it("offers the preview when there is one", async () => {
    const out = await draft({ hasPreview: true });
    expect(out.bodyText.toLowerCase()).toContain("preview");
  });

  it("⛔ makes no preview claim when there is none", async () => {
    // The workflow routes low-score leads to a deliberately text-only pitch.
    // It was sending them preview copy pointing at our own marketing site.
    const out = await draft({ hasPreview: false, verifiedDefects: ["no phone number listed"] });
    expect(out.bodyText.toLowerCase()).not.toContain("preview");
    expect(out.bodyText.toLowerCase()).not.toContain("we built");
    expect(out.subject.toLowerCase()).not.toContain("preview");
  });

  it("still says something worth reading with no preview and no defects", async () => {
    const out = await draft({ hasPreview: false, verifiedDefects: [] });
    expect(out.bodyText.trim().length).toBeGreaterThan(40);
    expect(out.subject.trim().length).toBeGreaterThan(5);
  });
});

describe("the follow-up steps", () => {
  it("vary the subject rather than repeating the first one", async () => {
    const subjects = new Set<string>();
    for (const sequenceStep of [0, 1, 2]) subjects.add((await draft({ sequenceStep })).subject);
    expect(subjects.size).toBe(3);
  });

  it("clamp past the last written subject rather than throwing", async () => {
    // There is no fourth touch, but a replayed workflow can ask for one.
    const out = await draft({ sequenceStep: 7 });
    expect(out.subject.trim()).not.toBe("");
  });
});
