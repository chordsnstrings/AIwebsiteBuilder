// ⛔ The cold email body is the product's first delivery. These rules were four
// lines inside a 1,400-line activity, untestable without a database, a campaign,
// a sending asset and a transport — and two of them were wrong the whole time.
import { describe, expect, it } from "vitest";
import { composeColdEmailBody, PREVIEW_CTA } from "./src/index.ts";

const BLOCKS = {
  ai_disclosure: "This message was written with AI assistance.",
  unsubscribe: "Not interested? Unsubscribe here: {unsub_url}",
};

const parts = (over: Partial<Parameters<typeof composeColdEmailBody>[0]> = {}) =>
  composeColdEmailBody({
    bodyText: "Hi, we checked your listing and found two things making you harder to find.",
    previewUrl: "https://previews-abc123-html.pages.dev",
    blocks: BLOCKS,
    unsubscribeUrl: "https://p.adwpreview.com/u/tok123",
    entity: "ADW Sites Ltd",
    postalAddress: "1 Example Street, Leeds",
    privacyUrl: "https://adwsites.com/privacy",
    ...over,
  });

describe("⛔ the preview link is in the email", () => {
  it("carries the real deployed URL", async () => {
    // The whole pitch is "we built you a site, look at it". The link reached the
    // body only because demo mode's simulator interpolated it — against a real
    // model the body came out with no link and nothing downstream added one.
    const body = parts();
    expect(body).toContain("https://previews-abc123-html.pages.dev");
    expect(body).toContain(PREVIEW_CTA);
  });

  it("puts it above the legal footer, where a person will see it", () => {
    const body = parts();
    expect(body.indexOf(PREVIEW_CTA)).toBeLessThan(body.indexOf("Unsubscribe here"));
  });

  it("⛔ omits the line entirely when there is no preview", () => {
    // This used to substitute the foundry's own marketing homepage, so a lead
    // the workflow deliberately routed to a text-only pitch was told a site had
    // been built for them and sent to our front page.
    const body = parts({ previewUrl: null, bodyText: "Hi, we help trades get found online." });
    expect(body).not.toContain(PREVIEW_CTA);
    // The only URLs left are the ones the system owns.
    const urls = body.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual(["https://p.adwpreview.com/u/tok123", "https://adwsites.com/privacy"]);
  });
});

describe("⛔ the legal blocks are substituted, never generated", () => {
  it("resolves the unsubscribe placeholder", () => {
    const body = parts();
    expect(body).toContain("Unsubscribe here: https://p.adwpreview.com/u/tok123");
    expect(body, "an unresolved placeholder ships a dead unsubscribe link").not.toContain("{unsub_url}");
  });

  it("carries the AI disclosure and the sender identity", () => {
    const body = parts();
    expect(body).toContain("written with AI assistance");
    expect(body).toContain("ADW Sites Ltd, 1 Example Street, Leeds");
    expect(body).toContain("Privacy: https://adwsites.com/privacy");
  });

  it("does not invent a block the jurisdiction has not defined", () => {
    // ⛔ Empty over substituted-from-elsewhere. Falling back to another
    // jurisdiction's wording is how a GB recipient receives a US notice.
    const body = composeColdEmailBody({
      bodyText: "Hi.",
      previewUrl: null,
      blocks: {},
      unsubscribeUrl: "https://u.example/t",
      entity: "E",
      postalAddress: "A",
      privacyUrl: "https://p.example",
    });
    expect(body).not.toContain("AI assistance");
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("[object Object]");
  });
});

describe("the model's prose", () => {
  it("leads, and is not rewritten", () => {
    const body = parts({ bodyText: "EXACT PROSE FROM THE MODEL" });
    expect(body.startsWith("EXACT PROSE FROM THE MODEL")).toBe(true);
  });
});
