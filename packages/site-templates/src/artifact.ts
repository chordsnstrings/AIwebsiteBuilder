// Bridge from a rendered HTML string to a reviewer-gate BuildArtifact. In
// production the Lighthouse/axe/render metrics come from Playwright + Lighthouse
// CI against the deployed page; in demo mode a well-formed template renders to
// strong deterministic scores so the pipeline runs end-to-end keyless.
import { weightKb } from "./render.ts";

export interface DemoArtifactOverrides {
  lighthouse?: Partial<{ perf: number; a11y: number; bestPractices: number; seo: number; cls: number }>;
  brokenLinks?: number;
  formPostArrives?: boolean;
  mobileOverflowPx?: number;
  llmsTxtPresent?: boolean;
  spellingErrors?: number;
  customerDomains?: string[];
  duplicateParagraphCount24h?: number;
  ipVerdict?: "pass" | "flag";
  axeCritical?: number;
  axeSerious?: number;
}

export function buildArtifactFromHtml(html: string, over: DemoArtifactOverrides = {}) {
  return {
    html,
    lighthouse: {
      perf: over.lighthouse?.perf ?? 96,
      a11y: over.lighthouse?.a11y ?? 98,
      bestPractices: over.lighthouse?.bestPractices ?? 100,
      seo: over.lighthouse?.seo ?? 100,
      cls: over.lighthouse?.cls ?? 0.01,
    },
    pageWeightKb: weightKb(html),
    axeCritical: over.axeCritical ?? 0,
    axeSerious: over.axeSerious ?? 0,
    brokenLinks: over.brokenLinks ?? 0,
    formPostArrives: over.formPostArrives ?? true,
    mobileOverflowPx: over.mobileOverflowPx ?? 0,
    llmsTxtPresent: over.llmsTxtPresent ?? true,
    spellingErrors: over.spellingErrors ?? 0,
    customerDomains: over.customerDomains ?? [],
    duplicateParagraphCount24h: over.duplicateParagraphCount24h ?? 0,
    ipVerdict: over.ipVerdict ?? ("pass" as const),
  };
}
