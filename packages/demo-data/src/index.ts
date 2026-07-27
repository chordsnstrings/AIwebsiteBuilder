// Seeded demo data for the frontends. Deterministic (no randomness) so every UI
// surface renders meaningfully in keyless demo mode. These fixtures mirror the
// shapes the real API serves; P7 swaps them for live queries.

export interface DemoMetric {
  label: string;
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  delta?: number;
}

export const opsMetrics: DemoMetric[] = [
  { label: "MRR", value: 63384, prefix: "$", delta: 8.2 },
  { label: "Active customers", value: 2187, delta: 6.1 },
  { label: "Cold sends (7d)", value: 61840, delta: 3.4 },
  { label: "Positive reply rate", value: 1.24, decimals: 2, suffix: "%", delta: 0.11 },
  { label: "Inbox placement", value: 72.5, decimals: 1, suffix: "%", delta: -0.5 },
  { label: "First-pass rate", value: 84.0, decimals: 1, suffix: "%", delta: 1.2 },
  { label: "Spend today", value: 412.5, decimals: 2, prefix: "$" },
  { label: "Silent failures", value: 0 },
];

export interface Exception {
  id: string;
  trigger: string;
  severity: number;
  raisedAt: string;
  systemAction: string;
  recommendation: string;
  status: string;
}

export const exceptions: Exception[] = [
  {
    id: "exc_2f8a",
    trigger: "deliverability_halt",
    severity: 2,
    raisedAt: "2026-07-27T09:14:00Z",
    systemAction: "Domain removed from rotation; sends on the template paused.",
    recommendation: "Review the template copy; A/B a replacement before resuming.",
    status: "open",
  },
  {
    id: "exc_7c31",
    trigger: "price_change_notice",
    severity: 3,
    raisedAt: "2026-07-27T06:02:00Z",
    systemAction: "Flagged for cost-model re-run.",
    recommendation: "Re-run the model price card; introductory pricing on one model ends 1 Sep.",
    status: "open",
  },
];

export interface KillSwitch {
  name: string;
  engaged: boolean;
  toggledBy: string | null;
  toggledAt: string | null;
}

export const killSwitches: KillSwitch[] = [
  { name: "HALT_ALL_SENDING", engaged: false, toggledBy: null, toggledAt: null },
  { name: "HALT_COLD_ONLY", engaged: false, toggledBy: null, toggledAt: null },
  { name: "HALT_BUILDS", engaged: false, toggledBy: null, toggledAt: null },
  { name: "HALT_PAYMENTS_ONBOARDING", engaged: false, toggledBy: null, toggledAt: null },
];

export interface RegistryRole {
  role: string;
  champion: string;
  status: string;
  metric: number;
  evalAgeDays: number;
  fallbackLastOk: string;
}

export const registryRoles: RegistryRole[] = [
  { role: "enrichment", champion: "modelark/seed-2-0-mini", status: "active", metric: 0.0003, evalAgeDays: 2, fallbackLastOk: "1d ago" },
  { role: "site_scoring", champion: "modelark/seed-2-0-lite", status: "active", metric: 0.0018, evalAgeDays: 2, fallbackLastOk: "1d ago" },
  { role: "preview_gen", champion: "modelark/seed-2-0-mini", status: "active", metric: 0.0017, evalAgeDays: 2, fallbackLastOk: "1d ago" },
  { role: "outreach_draft", champion: "modelark/seed-2-0-lite", status: "pending", metric: 0.0029, evalAgeDays: 0, fallbackLastOk: "live A/B" },
  { role: "customer_care", champion: "modelark/seed-2-0-pro", status: "pending", metric: 0.055, evalAgeDays: 0, fallbackLastOk: "live A/B" },
  { role: "developer", champion: "modelark/glm-5-2", status: "active", metric: 0.13, evalAgeDays: 5, fallbackLastOk: "6h ago" },
  { role: "ip_claims", champion: "anthropic/sonnet-5", status: "pending", metric: 0.038, evalAgeDays: 5, fallbackLastOk: "1d ago" },
  { role: "ceo", champion: "anthropic/opus-5", status: "active", metric: 0, evalAgeDays: 7, fallbackLastOk: "pinned" },
  { role: "sentinel", champion: "anthropic/opus-5", status: "active", metric: 0, evalAgeDays: 7, fallbackLastOk: "pinned" },
];

export interface VendorEntry {
  id: string;
  name: string;
  tier: string;
  dataClass: string;
  state: string;
  mode: "mock" | "live";
  probe: "passing" | "failing" | "unknown";
  diligence: number; // 0-9 answered
}

export const vendors: VendorEntry[] = [
  { id: "cloudflare", name: "Cloudflare", tier: "T0", dataClass: "PUB", state: "IDENTIFIED", mode: "mock", probe: "passing", diligence: 9 },
  { id: "stripe", name: "Stripe", tier: "T0", dataClass: "PAY", state: "IDENTIFIED", mode: "mock", probe: "passing", diligence: 6 },
  { id: "aws_ses", name: "AWS SES", tier: "T0", dataClass: "CUST", state: "IDENTIFIED", mode: "mock", probe: "passing", diligence: 4 },
  { id: "modelark", name: "BytePlus ModelArk", tier: "T0", dataClass: "PUB", state: "IDENTIFIED", mode: "mock", probe: "passing", diligence: 7 },
  { id: "anthropic", name: "Anthropic", tier: "T0", dataClass: "CUST", state: "IDENTIFIED", mode: "mock", probe: "passing", diligence: 5 },
  { id: "google_workspace", name: "Google Workspace", tier: "T0", dataClass: "PUB", state: "IDENTIFIED", mode: "mock", probe: "passing", diligence: 3 },
  { id: "healthchecks", name: "Healthchecks.io", tier: "T0", dataClass: "NONE", state: "IDENTIFIED", mode: "mock", probe: "passing", diligence: 2 },
];

export interface VaultSlot {
  vendorId: string;
  keyName: string;
  deposited: boolean;
  fingerprint: string | null;
  expiresAt: string | null;
}

export const vaultSlots: VaultSlot[] = [
  { vendorId: "modelark", keyName: "api_key", deposited: false, fingerprint: null, expiresAt: null },
  { vendorId: "google_ai", keyName: "api_key", deposited: false, fingerprint: null, expiresAt: null },
  { vendorId: "anthropic", keyName: "api_key", deposited: false, fingerprint: null, expiresAt: null },
  { vendorId: "stripe", keyName: "secret_key", deposited: false, fingerprint: null, expiresAt: null },
  { vendorId: "cloudflare", keyName: "api_token", deposited: false, fingerprint: null, expiresAt: null },
  { vendorId: "aws_ses", keyName: "access_key", deposited: false, fingerprint: null, expiresAt: null },
];

// Customer dashboard demo
export const demoCustomer = {
  businessName: "Bright Plumbing",
  siteUrl: "https://brightplumbing.adwsites.com",
  status: "live",
  plan: "Care plan",
  mrr: 65,
  visitsThisMonth: 342,
  callsThisMonth: 28,
  formsThisMonth: 11,
  domain: { name: "brightplumbing.com", status: "active", expiresAt: "2027-03-14" },
  invoices: [
    { id: "inv_01", date: "2026-07-01", amount: 65, status: "paid" },
    { id: "inv_02", date: "2026-06-01", amount: 65, status: "paid" },
  ],
  suggestion: "Add your two newest 5-star reviews to the homepage — reply YES and we'll do it.",
};

export const previewDemo = {
  businessName: "Bright Plumbing",
  category: "plumber",
  city: "Denver",
  rating: 4.8,
  reviewCount: 120,
  headline: "Bright Plumbing — trusted plumber in Denver",
  services: [
    { title: "Leak repair", blurb: "Fast, reliable leak detection and repair for homes and businesses across Denver." },
    { title: "Water heaters", blurb: "Installation and servicing of tanked and tankless water heaters, done right." },
    { title: "Drain cleaning", blurb: "Professional drain and sewer cleaning that clears the problem for good." },
  ],
};
