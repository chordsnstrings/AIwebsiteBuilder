// ⛔ THE TEST THAT WOULD HAVE CAUGHT THE LAST THREE BUGS.
//
// Every other test in this repository calls the handler. A browser does not:
// it enforces the same-origin policy, it preflights a JSON POST, and it
// silently drops a response whose CORS headers do not name the origin. Three
// separate defects lived entirely inside that gap and every one of them shipped
// green:
//
//   * `generate_preview` passed no `agent` to `renderSite`, so no page carried
//     a widget at all.
//   * `/agent/turn` 409'd every preview session, and nothing implemented the
//     `{ sessionRef, question }` shape the widget actually posts.
//   * The CORS allowlist held four localhost origins, so the preflight from any
//     deployed site came back without `access-control-allow-origin` and the
//     browser refused to send the POST. The chat box on every site we had ever
//     deployed said "Could not reach the agent just now."
//
// So this test serves the rendered page from a DIFFERENT ORIGIN to the API,
// drives a real Chromium, clicks a suggested question the way an owner would,
// and asserts an answer comes back. It is slower than the rest of the suite and
// it is the only test here that can fail for the right reason.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import puppeteer, { type Browser } from "puppeteer-core";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import { embedText, persistQAPack, type QAPack } from "@adw/qapack";
import { familyForCategory, machineSurfaceFromFacts, renderSite } from "@adw/site-templates";
import { createApp } from "./src/app.ts";

const URL_ = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const CHROME = process.env["CHROME"] ?? "/opt/pw-browsers/chromium";
/** The sentence the widget prints when it cannot reach the API. */
const UNREACHABLE = "Could not reach the agent just now.";
const QUESTION = "What areas do you cover?";
const ANSWER = "We cover Boise and the Treasure Valley.";

let db: Db;
let vault: SecretsBackend;
let browser: Browser;
let apiServer: ReturnType<typeof serve>;
let siteServer: Server;
let apiOrigin: string;
let siteOrigin: string;
let html = "";

/** A speculative preview with an approved pack, exactly as the pipeline builds one. */
async function seedPreview(): Promise<{ claimToken: string }> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string; name: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, category, city, country_code, region_code,
                             segment, review_count, rating, phone_e164)
     VALUES ('d',$1,'Ridgeline Roofing','roofer','Boise','US','R1','stale_site',64,4.6,'+12085550143')
     RETURNING id, name`,
    [batch.id],
  );
  const kb = await db.one<{ id: string }>(
    `INSERT INTO knowledge_bases (business_id) VALUES ($1) RETURNING id`,
    [biz.id],
  );
  await db.query(
    `INSERT INTO kb_facts (kb_id, fact_key, type, value, status, source_url, retrieved_at)
     VALUES ($1,'area_1','area','Boise','verified','https://example.test', now())`,
    [kb.id],
  );

  const pack: QAPack = {
    id: randomUUID(),
    kbId: kb.id,
    businessId: biz.id,
    version: 1,
    vertical: "roofing",
    playbookVersion: "test",
    embeddingProvider: "adw-hashed-ngram-v1",
    pairs: [
      {
        id: randomUUID(),
        question: QUESTION,
        answer: ANSWER,
        sourceFactIds: [randomUUID()],
        embedding: embedText(QUESTION),
        confidence: 0.95,
        source: "generated",
      },
    ],
    coverage: { byTopic: {}, byVerticalTemplate: { answered: 1, total: 1, ratio: 1 }, factsUsed: 1, factsAvailable: 1 },
    templateFallbacks: [],
    gaps: ["Do you offer emergency callouts?"],
    excluded: [],
    thin: false,
    extendedOnboarding: false,
    createdAt: new Date(),
  };
  await persistQAPack(db, pack);
  await db.query(
    `UPDATE qa_packs SET approved_at = now(), approved_by = 'system:speculative_preview',
                         approval_kind = 'speculative' WHERE id = $1`,
    [pack.id],
  );

  const claimToken = `claim_${randomUUID()}`;
  await db.query(
    `INSERT INTO previews (business_id, r2_key, deploy_url, claim_token, label_version, expires_at, pack_id)
     VALUES ($1,'k','https://p.example',$2,'label-v1', now() + interval '30 days',$3)`,
    [biz.id, claimToken, pack.id],
  );

  html = renderSite({
    family: familyForCategory("roofer").id,
    business: { name: biz.name, category: "roofer", city: "Boise", phone: "+12085550143" },
    copy: {
      headline: "Ridgeline Roofing — trusted roofer in Boise",
      services: [{ title: "Flat roof repair", blurb: "Professional flat roof repair you can count on, done right." }],
      about:
        "Ridgeline Roofing has served Boise with dependable roofing work for years. We show up on time, do quality " +
        "work, and stand behind every job. Local, insured and easy to reach.",
      cta: "Get a free quote today",
    },
    locale: "en-US",
    mode: "preview",
    legalEntity: "ADW Sites Ltd",
    legalAddress: "1 Example Street",
    labelVersion: "label-v1",
    claimToken,
    formAction: `${apiOrigin}/claim`,
    machine: machineSurfaceFromFacts(
      { name: biz.name, category: "roofer", city: "Boise", phone: "+12085550143" },
      [{ type: "area", value: "Boise", status: "verified" }],
    ),
    agent: {
      endpoint: `${apiOrigin}/agent/ask`,
      sessionRef: claimToken,
      gaps: pack.gaps,
      suggestedQuestions: [QUESTION],
      businessName: biz.name,
    },
  });
  return { claimToken };
}

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));

  // The API on one origin…
  const app = createApp({ db, vault, forceMock: true });
  // `serve` binds asynchronously; the callback is the only point at which the
  // ephemeral port is known.
  const apiPort = await new Promise<number>((resolve) => {
    apiServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      resolve((info as { port: number }).port);
    });
  });
  apiOrigin = `http://127.0.0.1:${apiPort}`;

  await seedPreview();

  // ⛔ …and the customer's site on ANOTHER. A different port is a different
  // origin, which is the whole point: serving the page from the API's own
  // origin would make every CORS bug invisible, which is exactly how the last
  // one shipped.
  siteServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
  siteOrigin = `http://127.0.0.1:${(siteServer.address() as { port: number }).port}`;

  browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => siteServer?.close(() => r()));
  apiServer?.close();
  await db?.close();
});

describe("⛔ the agent answers from a real browser, cross-origin", () => {
  it("renders the widget, answers a suggested question, and does not fail the fetch", async () => {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(siteOrigin, { waitUntil: "domcontentloaded" });

    // The widget is on the page at all — the first of the three defects.
    await page.waitForSelector("#adw-agent-form", { timeout: 10_000 });
    const chip = await page.waitForSelector("[data-adw-ask]", { timeout: 5_000 });
    expect(chip, "no suggested question to click").not.toBeNull();

    await chip!.click();

    // ⛔ Wait for a bot message that is not the placeholder. The widget writes
    // "…" first, then replaces it — so asserting too early passes on the
    // placeholder and would go green with the API unreachable.
    await page.waitForFunction(
      () => {
        const nodes = document.querySelectorAll(".adw-msg.bot");
        const last = nodes[nodes.length - 1];
        return last !== undefined && last.textContent !== null && last.textContent.trim() !== "…";
      },
      { timeout: 15_000 },
    );

    const reply = await page.$eval(".adw-msg.bot:last-of-type", (el) => el.textContent ?? "");
    // The exact sentence the catch branch prints. Naming it here means a
    // regression in CORS, in routing, or in the endpoint's shape fails loudly
    // rather than looking like a thin pack.
    expect(reply, "the browser could not reach the API — check CORS on /agent/ask").not.toContain(UNREACHABLE);
    expect(reply).toContain("Boise");
    expect(consoleErrors).toEqual([]);
    await page.close();
  }, 60_000);

  it("⛔ the preflight names the origin, so the POST is allowed to leave", async () => {
    // Asserted from inside the browser, against the running server: a unit test
    // of the middleware cannot see a preflight the browser never sends.
    const page = await browser.newPage();
    await page.goto(siteOrigin, { waitUntil: "domcontentloaded" });
    const status = await page.evaluate(async (api: string) => {
      const res = await fetch(`${api}/agent/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionRef: "nope", question: "hi" }),
      });
      return res.status;
    }, apiOrigin);
    // 404 is the right answer for an unknown ref — and reaching a 404 at all
    // proves the preflight passed. A CORS failure throws in `fetch` instead.
    expect(status).toBe(404);
    await page.close();
  }, 30_000);

  it("⛔ an operator route still refuses this origin", async () => {
    // The blast radius of the wildcard is two public paths. If a credentialed
    // route started answering a customer's domain, that would be the
    // vulnerability the pairing exists to avoid.
    const page = await browser.newPage();
    await page.goto(siteOrigin, { waitUntil: "domcontentloaded" });
    const blocked = await page.evaluate(async (api: string) => {
      try {
        await fetch(`${api}/ops/worklist`, { credentials: "include" });
        return false;
      } catch {
        return true;
      }
    }, apiOrigin);
    expect(blocked, "a credentialed operator route answered a customer's origin").toBe(true);
    await page.close();
  }, 30_000);
});
