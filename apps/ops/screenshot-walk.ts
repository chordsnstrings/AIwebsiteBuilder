// Walk every console surface with a real session and photograph it.
//
// ⛔ This script exists because the last four attempts to photograph this
// console produced pictures of demo fixtures, and each time the pictures
// looked fine. The specific traps, all of which have caught us:
//
//   1. Browsing 127.0.0.1 instead of localhost. Different origin, CORS-blocked,
//      every request fails — and the old console silently rendered fixtures.
//   2. HashRouter. Navigating to /customers serves the index and leaves the
//      app on whatever view it was already showing, so five "different"
//      screenshots come back identical.
//   3. Typing into a pre-filled field, producing admin@x.exampleadmin@x.example.
//   4. Assuming the session took. It had not.
//
// So: the session is minted server-side and injected as a cookie, the routes
// are hash routes, and the walk THROWS if the page is not signed in or if any
// view renders a failure banner. A screenshot run that cannot prove it was
// looking at live data is a screenshot run that failed.

import { createDb } from "@adw/db";
import { createUser, login, totp } from "@adw/auth";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const DB_URL = process.env["DATABASE_ADMIN_URL"] ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const APP = process.env["OPS_URL"] ?? "http://localhost:5173";
const OUT = process.env["OUT_DIR"] ?? "/tmp/ops-shots";
const EMAIL = "shotwalk@adw.example";
const PASSWORD = "correct horse battery staple";

const ROUTES: { hash: string; name: string; waitFor: string }[] = [
  { hash: "#/", name: "01-now", waitFor: ".coverage" },
  { hash: "#/customers", name: "02-customers", waitFor: ".family-strip, .empty" },
  { hash: "#/acquisition", name: "03-acquisition", waitFor: "table.data, .empty" },
  { hash: "#/fleet", name: "04-fleet", waitFor: ".figures" },
  { hash: "#/models", name: "05-models", waitFor: "table.data, .empty" },
  { hash: "#/vendors", name: "06-vendors", waitFor: "table.data, .empty" },
  { hash: "#/controls", name: "07-controls", waitFor: ".switch-row" },
  { hash: "#/search", name: "08-search", waitFor: ".empty" },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const db = await createDb({ backend: "pg", url: DB_URL });

  // A dedicated operator, so the walk never depends on a seeded password.
  const created = await createUser(db, { email: EMAIL, password: PASSWORD, role: "superadmin" });
  const secret =
    created.totpSecret ??
    (await db.one<{ totp_secret: string }>("SELECT totp_secret FROM users WHERE email = $1", [EMAIL])).totp_secret;
  const signed = await login(db, EMAIL, PASSWORD, totp(secret, Math.floor(Date.now() / 1000)));
  if (!signed.ok) throw new Error(`could not sign in: ${signed.reason}`);

  const browser = await puppeteer.launch({
    executablePath: process.env["CHROME"] ?? "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });

  // Inject before the first navigation, so the app's `api.me()` resolves on its
  // very first render and never shows the sign-in screen.
  await page.setCookie({
    name: "adw_session",
    value: signed.token,
    domain: "localhost",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });

  const problems: string[] = [];
  // ⛔ A blank screenshot is the least informative failure there is. Capture the
  // page's own errors so a crash reports its cause rather than its symptom.
  page.on("pageerror", (err) => problems.push(`PAGE ERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`CONSOLE: ${msg.text().slice(0, 200)}`);
  });

  for (const route of ROUTES) {
    await page.goto(`${APP}/${route.hash}`, { waitUntil: "networkidle0" });
    // ⛔ HashRouter: a full navigation between two hashes does not always
    // remount, so force it and give React a beat.
    await page.evaluate((h: string) => { window.location.hash = h.slice(1); }, route.hash);
    await new Promise((r) => setTimeout(r, 900));

    // ⛔ Prove we are signed in. A sign-in form on screen means every
    // screenshot after this point is worthless.
    const signInVisible = await page.$(".login form");
    if (signInVisible !== null) throw new Error(`${route.name}: the console is showing the sign-in form`);

    await page.waitForSelector(route.waitFor, { timeout: 8000 }).catch(() => {
      problems.push(`${route.name}: never rendered ${route.waitFor}`);
    });

    // ⛔ A failure banner means the board could not load. Recorded rather than
    // thrown, so the whole walk still completes and reports everything at once.
    const failures = await page.$$eval(".failed", (els) => els.map((e) => e.textContent?.trim() ?? ""));
    for (const f of failures) problems.push(`${route.name}: ${f.slice(0, 160)}`);

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t: string) => document.documentElement.setAttribute("data-theme", t), theme);
      await new Promise((r) => setTimeout(r, 250));
      // ⛔ Viewport, not fullPage. What matters is what an operator sees
      // without scrolling; a 22,000px tall PNG of every row is unreadable and
      // hides the very density problem it is meant to reveal.
      await page.screenshot({ path: `${OUT}/${route.name}-${theme}.png` });
    }
    console.log(`✓ ${route.name}`);
  }

  // A narrow viewport too — the console is used from a phone during an incident.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.evaluate(() => { window.location.hash = "/"; });
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.screenshot({ path: `${OUT}/09-now-mobile.png`, fullPage: true });
  console.log("✓ 09-now-mobile");

  await browser.close();
  await db.close();

  if (problems.length > 0) {
    console.error("\nPROBLEMS:");
    for (const p of problems) console.error(`  · ${p}`);
    process.exitCode = 1;
  } else {
    console.log("\nEvery view rendered live data with no failure banner.");
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
