// The Reviewer — deterministic gates (spec §9, §25). This is CODE. No model makes
// the pass/fail decision; a model is used only to write patches when a soft gate
// fails. Hard fails do not patch — they halt and raise an exception, because
// each is an injection signature, not a quality defect. Every check's numeric
// result is stored, never a boolean, so fleet-wide drift is visible.
import { config } from "@adw/config";

export interface LighthouseScores {
  perf: number;
  a11y: number;
  bestPractices: number;
  seo: number;
  cls: number;
}

export interface BuildArtifact {
  html: string;
  lighthouse: LighthouseScores;
  pageWeightKb: number;
  axeCritical: number;
  axeSerious: number;
  brokenLinks: number;
  formPostArrives: boolean;
  mobileOverflowPx: number; // horizontal overflow at 360px
  llmsTxtPresent: boolean;
  spellingErrors: number;
  customerDomains: string[];
  duplicateParagraphCount24h: number; // fleet-wide identical paragraphs in 24h
  ipVerdict: "pass" | "flag";
}

export type GateResult = Record<string, number | boolean>;

export interface ReviewOutcome {
  pass: boolean;
  hardFail: boolean;
  results: GateResult;
  failures: string[]; // gate codes that failed
  hardFailures: string[];
}

function scriptOrigins(html: string): string[] {
  const origins: string[] = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      origins.push(new URL(m[1]!, "https://self").origin);
    } catch {
      origins.push(m[1]!);
    }
  }
  return origins;
}

function outboundLinks(html: string): string[] {
  const links: string[] = [];
  const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) links.push(m[1]!);
  return links;
}

function hasHiddenText(html: string): boolean {
  // display:none / visibility:hidden / opacity:0 / font-size:0 / off-viewport
  // on an element that carries a link or text.
  return /style=["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0|position\s*:\s*absolute[^"']*left\s*:\s*-\d{3,}px)/i.test(
    html,
  );
}

function hasLocalBusinessSchema(html: string): boolean {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (/"@type"\s*:\s*"LocalBusiness"/.test(m[1]!)) return true;
  }
  return false;
}

function rendersWithoutJs(html: string): boolean {
  // Heuristic: meaningful text content exists in the static markup (not just an
  // empty root div that JS must hydrate).
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 120;
}

function allowedOrigin(origin: string, allowlist: string[]): boolean {
  return allowlist.some((a) => (a === "self" ? origin === "https://self" : origin === a || origin.startsWith(a)));
}

/** Run the full reviewer gate. Returns numeric results and any failures. */
export function reviewBuild(artifact: BuildArtifact): ReviewOutcome {
  const th = config.thresholds().data.build;
  const allow = config.allowlists().data;
  const results: GateResult = {};
  const failures: string[] = [];
  const hardFailures: string[] = [];

  // --- Soft gates (patchable) ---
  results.lighthouse_perf = artifact.lighthouse.perf;
  if (artifact.lighthouse.perf < th.lighthouse.perf) failures.push("GATE_PERFORMANCE");
  results.lighthouse_a11y = artifact.lighthouse.a11y;
  if (artifact.lighthouse.a11y < th.lighthouse.a11y) failures.push("GATE_A11Y");
  results.lighthouse_bp = artifact.lighthouse.bestPractices;
  if (artifact.lighthouse.bestPractices < th.lighthouse.best_practices) failures.push("GATE_BEST_PRACTICES");
  results.lighthouse_seo = artifact.lighthouse.seo;
  if (artifact.lighthouse.seo < th.lighthouse.seo) failures.push("GATE_SEO");
  results.cls = artifact.lighthouse.cls;
  if (artifact.lighthouse.cls >= th.cls_max) failures.push("GATE_CLS");
  results.axe_critical = artifact.axeCritical;
  results.axe_serious = artifact.axeSerious;
  if (artifact.axeCritical > 0 || artifact.axeSerious > 0) failures.push("GATE_AXE");
  results.broken_links = artifact.brokenLinks;
  if (artifact.brokenLinks > 0) failures.push("GATE_LINKS");
  results.form_post_arrived = artifact.formPostArrives;
  if (!artifact.formPostArrives) failures.push("GATE_FORM");
  results.overflow_360 = artifact.mobileOverflowPx;
  if (artifact.mobileOverflowPx > 0) failures.push("GATE_MOBILE");
  results.schema_valid = hasLocalBusinessSchema(artifact.html);
  if (!results.schema_valid) failures.push("GATE_SCHEMA");
  results.llms_txt = artifact.llmsTxtPresent;
  if (!artifact.llmsTxtPresent) failures.push("GATE_LLMS_TXT");
  results.weight_kb = artifact.pageWeightKb;
  if (artifact.pageWeightKb >= th.weight_kb_max) failures.push("GATE_WEIGHT");
  results.spelling_errors = artifact.spellingErrors;
  if (artifact.spellingErrors > 0) failures.push("GATE_SPELLING");
  results.renders_without_js = rendersWithoutJs(artifact.html);
  if (!results.renders_without_js) failures.push("GATE_NO_JS");

  // --- Hard fails (do not patch — halt, injection signatures) ---
  const origins = scriptOrigins(artifact.html);
  results.script_origins_ok = origins.every((o) => allowedOrigin(o, allow.script_origins));
  if (!results.script_origins_ok) hardFailures.push("GATE_SCRIPT_ORIGIN");

  const links = outboundLinks(artifact.html);
  // First-party ADW app domains (email_links) plus the configured outbound
  // allowlist plus the customer's own declared domains.
  const linkAllow = [
    ...allow.outbound_links.filter((l) => l.startsWith("http")),
    ...allow.email_links,
    ...artifact.customerDomains,
  ];
  results.link_allowlist_ok = links.every((l) => {
    try {
      const origin = new URL(l).origin;
      return linkAllow.some((a) => l.startsWith(a) || origin === a);
    } catch {
      return false;
    }
  });
  if (!results.link_allowlist_ok) hardFailures.push("GATE_LINK_ALLOWLIST");

  results.hidden_content = hasHiddenText(artifact.html);
  if (results.hidden_content) hardFailures.push("GATE_HIDDEN_CONTENT");

  results.duplicate_paragraphs = artifact.duplicateParagraphCount24h;
  if (artifact.duplicateParagraphCount24h >= th.duplicate_paragraph_cap_24h) hardFailures.push("GATE_DUPLICATE_CONTENT");

  results.ip_verdict_pass = artifact.ipVerdict === "pass";
  if (artifact.ipVerdict === "flag") hardFailures.push("GATE_IP_CLAIMS");

  return {
    pass: failures.length === 0 && hardFailures.length === 0,
    hardFail: hardFailures.length > 0,
    results,
    failures,
    hardFailures,
  };
}
