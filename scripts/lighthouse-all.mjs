// Mobile Lighthouse across every app, at the profile each is held to.
//
// "public" surfaces are indexable and carry the SEO threshold. "internal" ones
// are deliberately noindex — Lighthouse scores a noindex page low for SEO by
// design, so holding the ops console to it would only teach us to ignore a red
// number. Perf, a11y and best-practices apply everywhere.
import { spawn } from "node:child_process";

const APPS = [
  { dir: "apps/web", port: 4301, profile: "public" },
  { dir: "apps/ops", port: 4302, profile: "internal" },
  { dir: "apps/preview", port: 4303, profile: "internal" },
  { dir: "apps/dashboard", port: 4304, profile: "internal" },
];

let failed = false;
for (const app of APPS) {
  const code = await new Promise((resolve) => {
    spawn("node", ["scripts/lighthouse-audit.mjs", app.dir, String(app.port), app.profile], {
      stdio: "inherit",
    }).on("exit", resolve);
  });
  if (code !== 0) failed = true;
}
if (failed) {
  console.error("\n❌ one or more apps missed a reviewer-gate threshold");
  process.exit(1);
}
console.log("\n✅ every app meets its reviewer-gate thresholds");
