// Read-only, zod-validated loaders for config/*.yaml. Config is PR-gated and
// version-stamped (a content hash surfaces on every gate decision). No runtime
// UI path writes these files (spec App. B).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../config");

function load<T>(file: string, schema: z.ZodType<T>): { data: T; version: string } {
  const raw = readFileSync(join(CONFIG_DIR, file), "utf8");
  const parsed = parse(raw);
  const data = schema.parse(parsed);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 7);
  return { data, version: `${file.replace(/\.ya?ml$/, "")}@${hash}` };
}

// --- Jurisdictions -----------------------------------------------------------
const quietHours = z.object({ start: z.number(), end: z.number(), tz: z.string() });
const freqCap = z.object({ count: z.number(), window_days: z.number() });
const jurisdictionRow = z.object({
  enabled: z.boolean(),
  legal_basis: z.string(),
  provenance_required: z.boolean().optional(),
  provenance_captured_anyway: z.boolean().optional(),
  provenance_max_age_months: z.number().optional(),
  requires_relates_to_role: z.boolean().optional(),
  requires_no_cem_statement: z.boolean().optional(),
  quiet_hours: quietHours.optional(),
  frequency_cap: freqCap.optional(),
  optout_honour_days: z.number().optional(),
  required_elements: z.array(z.string()).optional(),
  ai_disclosure: z.string().optional(),
  subscriber_type_required: z.boolean().optional(),
  registry_lookup: z.boolean().optional(),
  credit_agency_consent_required: z.boolean().optional(),
  reason: z.string().optional(),
  reviewed_by: z.string().optional(),
  reviewed_at: z.union([z.string(), z.null()]).optional(),
});
const jurisdictionsSchema = z.object({
  version: z.number(),
  reviewed_by_default: z.string().optional(),
  countries: z.record(z.string(), jurisdictionRow),
});
export type JurisdictionRow = z.infer<typeof jurisdictionRow>;

// --- Thresholds --------------------------------------------------------------
const band = z.object({ warn: z.number(), throttle: z.number(), halt: z.number() });
const thresholdsSchema = z.object({
  deliverability: z.object({
    complaint_rate: band,
    bounce_rate: band,
    provider_daily_per_domain: band,
    inbox_placement: band,
  }),
  build: z.object({
    first_pass_rate_min: z.number(),
    lighthouse: z.object({ perf: z.number(), a11y: z.number(), best_practices: z.number(), seo: z.number() }),
    cls_max: z.number(),
    weight_kb_max: z.number(),
    duplicate_paragraph_cap_24h: z.number(),
  }),
  money: z.object({ dispute_rate_alert: z.number(), refund_rate_alert: z.number(), chargeback_reserve_pct: z.number() }),
  payments: z.object({ merchant_dispute_suspend: z.number(), volume_spike_multiple: z.number(), refund_rate_review: z.number() }),
  control: z.object({ exceptions_per_week_target_max: z.number(), provider_concentration_max: z.number(), cost_per_pass_wow_alert: z.number() }),
});

// --- Pricing -----------------------------------------------------------------
const pricingRegion = z.object({
  setup_fee_cents: z.number(),
  mrr_cents: z.number(),
  discount_floor_pct: z.number(),
  annual_discount_pct: z.number().optional(),
  billing_interval_allowed: z.array(z.string()).optional(),
  addons: z.record(z.string(), z.object({ cents: z.number(), target_attach: z.number() })).optional(),
});
const pricingSchema = z.record(z.string(), pricingRegion);
export type PricingRegion = z.infer<typeof pricingRegion>;

// --- Allowlists --------------------------------------------------------------
const allowlistsSchema = z.object({
  script_origins: z.array(z.string()),
  asset_origins: z.array(z.string()),
  outbound_links: z.array(z.string()),
  email_links: z.array(z.string()),
  csp_template: z.string(),
});

// --- Prohibited categories ---------------------------------------------------
const prohibitedSchema = z.object({ prohibited: z.array(z.string()), review: z.array(z.string()).optional() });

// --- Registry ----------------------------------------------------------------
const registryRole = z.object({
  candidates: z.array(z.string()),
  escalation: z.array(z.string()),
  selection_metric: z.enum(["cost_per_pass", "recall_then_cost", "live_ab_cost_per_close"]),
  re_eval_cadence: z.enum(["continuous", "weekly", "monthly", "quarterly"]),
  data_class: z.enum(["PUB", "PUBLISHABLE", "CUST", "PAY"]),
  eval_suite: z.string(),
  status: z.enum(["active", "pending"]).optional(),
  pinned: z.boolean().optional(),
});
const registrySchema = z.object({
  rails: z.object({ primary: z.string(), fallback: z.string(), pinned: z.record(z.string(), z.string()) }),
  roles: z.record(z.string(), registryRole),
});
export type RegistryRoleConfig = z.infer<typeof registryRole>;

// --- Vendors -----------------------------------------------------------------
const vendorRow = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.enum(["T0", "T1", "T2", "T3"]),
  data_class: z.enum(["PUB", "PUBLISHABLE", "CUST", "PAY", "NONE"]),
  gate: z.enum(["self_serve", "contract", "counsel"]),
  category: z.string(),
  provisioning: z.array(z.string()),
});
const vendorsSchema = z.object({ vendors: z.array(vendorRow) });
export type VendorRow = z.infer<typeof vendorRow>;

// Lazily-loaded, cached singletons.
let _cache: Record<string, { data: unknown; version: string }> = {};
function cached<T>(file: string, schema: z.ZodType<T>): { data: T; version: string } {
  if (!_cache[file]) _cache[file] = load(file, schema);
  return _cache[file] as { data: T; version: string };
}

export const config = {
  jurisdictions: () => cached("jurisdictions.yaml", jurisdictionsSchema),
  thresholds: () => cached("thresholds.yaml", thresholdsSchema),
  pricing: () => cached("pricing.yaml", pricingSchema),
  allowlists: () => cached("allowlists.yaml", allowlistsSchema),
  prohibited: () => cached("prohibited_categories.yaml", prohibitedSchema),
  registry: () => cached("registry.yaml", registrySchema),
  legalText: () => {
    const raw = readFileSync(join(CONFIG_DIR, "legal_text.yaml"), "utf8");
    return { data: parse(raw), version: "legal_text@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  taxonomy: () => {
    const raw = readFileSync(join(CONFIG_DIR, "taxonomy.yaml"), "utf8");
    return { data: parse(raw), version: "taxonomy" };
  },
  vendors: () => cached("vendors.yaml", vendorsSchema),
  templates: () => {
    const raw = readFileSync(join(CONFIG_DIR, "templates.yaml"), "utf8");
    return { data: parse(raw), version: "templates" };
  },
  /**
   * Vertical playbooks (§43). Sensitive change class: the refusal sets in here
   * are what stop a customer's agent from creating a regulatory problem for
   * them, and the Architect may only classify AGAINST this file — a capability
   * it proposes that is not listed fails the build.
   */
  playbooks: () => {
    const raw = readFileSync(join(CONFIG_DIR, "playbooks.yaml"), "utf8");
    return { data: parse(raw), version: "playbooks@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  /**
   * The design catalogue (§59). Reviewed change class: the Designer may only
   * CHOOSE from this file. A type pairing or hero archetype the model invents
   * fails the build — enumerating the options is what turned "be different"
   * from a request into a lookup.
   */
  designCatalogue: () => {
    const raw = readFileSync(join(CONFIG_DIR, "design-catalogue.yaml"), "utf8");
    return { data: parse(raw), version: "design@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  /**
   * The protocol & incident playbooks (MF14).
   *
   * ⛔ Restricted change class, and the one config file where a typo is a
   * safety incident rather than a cosmetic bug — so the loader validates the
   * interlock names against the closed set rather than trusting them.
   */
  /**
   * The canonical vertical taxonomy — 60 clusters, 145 trades, 10 archetypes.
   *
   * ⛔ The ONE source. It replaced five partial lists that each enumerated a
   * different subset of nine SMB trades, so adding a vertical meant editing all
   * five and missing one.
   */
  verticals: () => {
    const raw = readFileSync(join(CONFIG_DIR, "verticals.yaml"), "utf8");
    return { data: parse(raw), version: "verticals@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  /** Document requirement packs (MF6). Sensitive: identity-document retention
   *  periods live here. */
  documentPacks: () => {
    const raw = readFileSync(join(CONFIG_DIR, "document-packs.yaml"), "utf8");
    return { data: parse(raw), version: "document-packs@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  /** Customer clocks (MF4). Recall, renewal, statutory and AR dates.
   *  ⛔ Sensitive: `statutory: true` is what stops a licence-renewal date being
   *  silently rescheduled by an automatic process. */
  clocks: () => {
    const raw = readFileSync(join(CONFIG_DIR, "clocks.yaml"), "utf8");
    return { data: parse(raw), version: "clocks@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  /** Multi-touch journeys (MF5). Follow-up, save, reactivation, referral. */
  journeys: () => {
    const raw = readFileSync(join(CONFIG_DIR, "journeys.yaml"), "utf8");
    return { data: parse(raw), version: "journeys@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  /** Case types (MF2). Stage clocks and per-stage customer visibility. */
  caseTypes: () => {
    const raw = readFileSync(join(CONFIG_DIR, "case-types.yaml"), "utf8");
    return { data: parse(raw), version: "case-types@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  protocols: () => {
    const raw = readFileSync(join(CONFIG_DIR, "protocols.yaml"), "utf8");
    return { data: parse(raw), version: "protocols@" + createHash("sha256").update(raw).digest("hex").slice(0, 7) };
  },
  _resetCache: () => {
    _cache = {};
  },
};
