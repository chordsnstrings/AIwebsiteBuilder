// ⛔ THE DASHBOARD SHOWED EVERY CUSTOMER SOMEBODY ELSE'S BUSINESS.
//
// Nine of the twelve views rendered `demoCustomer` — "Bright Plumbing", 342
// visits, 28 calls, 11 form enquiries, a domain renewing 14 March 2027 and two
// paid invoices — to whoever logged in. The three views that did call the API
// fell back to those same fixtures on any failure, so a real owner against a
// downed API saw a complete and entirely convincing dashboard belonging to a
// business that does not exist.
//
// Every unit test in this repo would have passed either way, because they call
// handlers rather than render pages. This one builds the real app, serves it,
// points a real Chromium at it with a real API and a real database behind it,
// and asserts the owner's OWN business name and OWN enquiry are on the screen —
// and that "Bright Plumbing" is nowhere on it.
//
// It also asserts the failure direction, which is the half that matters most: a
// dashboard whose API is unreachable must SAY SO rather than quietly serving
// fixtures, because a fabricated dashboard is indistinguishable from a working
// one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { serve } from "@hono/node-server";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, type SecretsBackend } from "@adw/vault";
import type { SessionUser } from "@adw/auth";
import { createApp } from "../api/src/app.ts";

const URL_ = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const CHROME = process.env["CHROME"] ?? "/opt/pw-browsers/chromium";
const DIST = join(import.meta.dirname, "dist");

/** The fixture business that must never appear on a real customer's screen. */
const FIXTURE_NAME = "Bright Plumbing";

const BUSINESS = `Kestrel Plumbing ${randomUUID().slice(0, 6)}`;
const CALLER = "Ada Marsh";
const NEED = "boiler making a banging noise";
const PHONE = "07700900456";

let db: Db;
let vault: SecretsBackend;
let browser: Browser;
let apiServer: ReturnType<typeof serve>;
let appServer: Server;
let apiOrigin = "";
let appOrigin = "";
let customerId = "";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function seed(): Promise<string> {
  const batch = await db.one<{ id: string }>(
    "INSERT INTO ingest_batches (vendor, licence_ref, record_count, cost_cents, checksum) VALUES ('d','LIC',1,0,'x') RETURNING id",
  );
  const biz = await db.one<{ id: string }>(
    `INSERT INTO businesses (source_vendor, source_batch_id, name, country_code, region_code, segment, vertical, phone_e164, city)
     VALUES ('d',$1,$2,'GB','R1','no_site','plumber','+447700900000','Leeds') RETURNING id`,
    [batch.id, BUSINESS],
  );
  const cust = await db.one<{ id: string }>(
    `INSERT INTO customers (business_id, region_code, legal_name, contact_email, locale, timezone, status)
     VALUES ($1,'R1',$2,$3,'en-GB','Europe/London','active') RETURNING id`,
    [biz.id, BUSINESS, `kestrel_${randomUUID()}@example.com`],
  );
  // One real enquiry, of the kind the old screen replaced with a fixture.
  await db.query(
    `INSERT INTO enquiries (customer_id, business_id, name, need, contact, urgency, status)
     VALUES ($1,$2,$3,$4,$5,'urgent','open')`,
    [cust.id, biz.id, CALLER, NEED, PHONE],
  );
  await db.query(
    `INSERT INTO subscriptions (customer_id, plan_code, billing_interval, amount_cents, currency, status, current_period_end)
     VALUES ($1,'care_gb','month',6500,'GBP','active', now() + interval '20 days')`,
    [cust.id],
  );
  return cust.id;
}

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL_ });
  await migrate(db);
  vault = new LocalPgBackend(db, new LocalKeyWrapper("0".repeat(64)));
  customerId = await seed();

  // ⛔ THE APP SERVER STARTS FIRST, because the API's CORS allowlist is read
  // when `createApp` builds its middleware and the dashboard's origin is an
  // ephemeral port. Getting this order wrong reproduces, exactly, the bug this
  // repository has already shipped twice: the browser drops a credentialed
  // response whose headers do not name the origin, the client's catch branch
  // fires, and the screen degrades — silently, and identically to a real
  // outage. Which is also why the first version of this test timed out.
  appServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const file = path === "/" ? "index.html" : path.replace(/^\//, "");
    const full = join(DIST, file);
    if (!full.startsWith(DIST) || !existsSync(full)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
    res.end(readFileSync(full));
  });
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  appOrigin = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
  process.env["ADW_ALLOWED_ORIGINS"] = appOrigin;

  // ⛔ The dashboard is authenticated as the OWNER OF THIS CUSTOMER. A session
  // naming no customer now authorises nothing (see tenancy.ts), which is
  // exactly what a real signed-in owner carries.
  const owner: SessionUser = {
    id: "u_own", email: "owner@example.com", role: "customer", customerId, totpEnabled: false,
  };
  const app = createApp({ db, vault, forceMock: true, authOverride: owner });
  const apiPort = await new Promise<number>((resolve) => {
    apiServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      resolve((info as { port: number }).port);
    });
  });
  apiOrigin = `http://127.0.0.1:${apiPort}`;

  browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => appServer?.close(() => r()));
  await apiServer?.close?.();
  await db?.close();
});

/**
 * Opens a dashboard page with the API base injected before the bundle runs.
 *
 * `VITE_API_URL` is baked at build time, so the built bundle points at
 * localhost:8787. Rewriting the request at the network layer is what lets the
 * real artefact talk to this test's ephemeral API — and it means the bundle
 * under test is the one that would ship, not a re-bundled variant.
 */
async function open(route: string, opts: { apiUp?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("http://localhost:8787")) {
      if (opts.apiUp === false) {
        // Simulates the API being unreachable — the case the old client papered
        // over with fixtures.
        void req.abort();
        return;
      }
      void req.continue({ url: url.replace("http://localhost:8787", apiOrigin) });
      return;
    }
    void req.continue();
  });
  await page.goto(`${appOrigin}/#${route}?customer=${customerId}`, { waitUntil: "networkidle0" });
  return page;
}

const bodyText = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText);

describe("⛔ the dashboard shows the owner's own business", () => {
  it("puts the real business name and a real enquiry on the screen", async () => {
    const page = await open("/enquiries");
    await page.waitForFunction(
      (needle: string) => document.body.innerText.includes(needle),
      { timeout: 15_000 },
      CALLER,
    );
    const text = await bodyText(page);

    // The caller, what they need, and — the point of the screen — their number.
    expect(text).toContain(CALLER);
    expect(text).toContain(NEED);
    expect(text).toContain(PHONE);
    // The business name in the shell comes from the same live overview.
    expect(text).toContain(BUSINESS);
    // ⛔ And the fixture is nowhere. This is the assertion that fails against
    // the old build.
    expect(text).not.toContain(FIXTURE_NAME);
    await page.close();
  }, 60_000);

  it("shows the real plan in the real currency on Billing", async () => {
    const page = await open("/billing");
    await page.waitForFunction(
      () => document.body.innerText.includes("care_gb"),
      { timeout: 15_000 },
    );
    const text = await bodyText(page);
    expect(text).toContain("care_gb");
    // ⛔ £65, not $65. `money()` was a hardcoded dollar sign over a pricing
    // table with GBP, AUD, CAD and NZD regions.
    expect(text).toMatch(/£65/);
    expect(text).not.toContain(FIXTURE_NAME);
    await page.close();
  }, 60_000);

  it("⛔ says it could not load rather than showing fixtures when the API is down", async () => {
    // The most important assertion in this file. The old client returned null on
    // failure and every caller substituted demo data, so an owner with no
    // connectivity saw a complete fabricated dashboard and had no way to know.
    const page = await open("/enquiries", { apiUp: false });
    await page.waitForFunction(
      () => document.body.innerText.includes("couldn’t load") || document.body.innerText.includes("couldn't load"),
      { timeout: 15_000 },
    );
    const text = await bodyText(page);
    expect(text).not.toContain(FIXTURE_NAME);
    expect(text).not.toContain("342");
    await page.close();
  }, 60_000);
});
