// Runs a mobile Lighthouse audit against a built + previewed app and asserts the
// reviewer-gate thresholds (Perf >= 85, A11y >= 90, Best Practices >= 90,
// SEO >= 95). Usage: node scripts/lighthouse-audit.mjs <appDir> <port>
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

const appDir = process.argv[2];
const port = Number(process.argv[3] ?? 4300);
// Profile: "public" (indexable — marketing site, generated customer sites) is
// held to SEO >= 95. "internal" (noindex authed consoles: ops, dashboard,
// preview links) skips SEO, which Lighthouse always scores low for a noindex
// page by design. Perf/A11y/Best-Practices apply to every surface.
const profile = process.argv[4] ?? "public";
const THRESHOLDS =
  profile === "internal"
    ? { performance: 85, accessibility: 90, "best-practices": 90 }
    : { performance: 85, accessibility: 90, "best-practices": 90, seo: 95 };

async function main() {
  // Build then preview.
  await run("npx", ["vite", "build"], appDir);
  const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
    cwd: appDir,
    stdio: "ignore",
  });
  try {
    await waitForServer(`http://localhost:${port}`);
    const chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
      chromePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium",
    });
    try {
      const result = await lighthouse(
        `http://localhost:${port}`,
        { port: chrome.port, output: "json", logLevel: "error" },
        {
          extends: "lighthouse:default",
          settings: { formFactor: "mobile", screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 2 }, onlyCategories: Object.keys(THRESHOLDS) },
        },
      );
      const cats = result.lhr.categories;
      const scores = Object.fromEntries(Object.keys(THRESHOLDS).map((k) => [k, Math.round((cats[k].score ?? 0) * 100)]));
      console.log(`\n${appDir} Lighthouse (mobile):`, scores);
      let ok = true;
      for (const [k, min] of Object.entries(THRESHOLDS)) {
        if (scores[k] < min) {
          console.error(`  ✗ ${k} ${scores[k]} < ${min}`);
          ok = false;
        }
      }
      if (!ok) process.exitCode = 1;
      else console.log("  ✓ all thresholds met");
    } finally {
      await chrome.kill();
    }
  } finally {
    server.kill("SIGTERM");
  }
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "ignore" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForServer(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`server did not start at ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
