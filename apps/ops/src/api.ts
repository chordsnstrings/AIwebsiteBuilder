// API client for the operator console.
//
// ⛔ THERE ARE NO FALLBACKS HERE, AND THAT IS THE POINT.
//
// The previous client substituted `@adw/demo-data` fixtures whenever a request
// failed, timed out, or returned a 403. The console therefore rendered a
// confident health board — $63,384 MRR, 2,187 customers — over a database
// holding one customer, and an operator had no way to tell. Worse, the failure
// that most often triggered the fallback was an auth or CORS problem, which is
// exactly when you are least entitled to invent numbers.
//
// So every call now returns an explicit `Loaded<T>`: loading, ok, or failed
// with the reason. The UI is required to handle all three. Rendering nothing is
// acceptable; rendering a plausible fiction is not.
const BASE =
  (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_URL ?? "http://localhost:8787";

/** Generous, because a slow answer is still an answer. The old 2.5s budget was
 *  tuned to "fail fast into fixtures", which is no longer a thing we do. */
const TIMEOUT_MS = 8000;

/**
 * The outcome of a completed request: it either has data or it has a reason.
 * There is no third case and no fallback.
 */
export type Result<T> =
  | { status: "ok"; data: T; at: Date }
  | { status: "failed"; reason: string; code?: number };

/**
 * What a view holds. `loading` belongs to the component, not to the fetch —
 * a request that has returned is never loading, and typing it as though it
 * might forces every caller to handle a state that cannot occur.
 */
export type Loaded<T> = Result<T> | { status: "loading" };

export const loading = <T,>(): Loaded<T> => ({ status: "loading" });

/** Narrowing helper so views cannot read `.data` off a failed result. */
export function isOk<T>(r: Loaded<T>): r is { status: "ok"; data: T; at: Date } {
  return r.status === "ok";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: "include",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // ⛔ 403 is named rather than folded into a generic failure. It is the
      // single most common cause of a blank console (an expired session, or a
      // browser origin the API's CORS allowlist does not include) and it needs
      // a different message from "the server is down".
      const reason =
        res.status === 403 ? "not signed in as an operator"
        : res.status === 404 ? "not found"
        : `HTTP ${res.status}`;
      return { status: "failed", reason, code: res.status };
    }
    return { status: "ok", data: (await res.json()) as T, at: new Date() };
  } catch (err) {
    const reason =
      err instanceof DOMException && err.name === "TimeoutError"
        ? `no answer within ${TIMEOUT_MS / 1000}s`
        : "API unreachable";
    return { status: "failed", reason };
  }
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

// ── Payload shapes, mirroring @adw/opsview ────────────────────────────────
export type JobState = "never_run" | "ok" | "stale" | "failing";
export type FamilyState = "unknown" | "not_applicable" | "unconfigured" | "ok" | "attention" | "stale";

export interface JobRow {
  name: string; intervalMs: number; state: JobState;
  lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  lastDurationMs: number | null; runsTotal: number; failuresTotal: number;
  consecutiveFailures: number; nextDueAt: string | null; cadencesLate: number | null;
}
export interface JobFailure { jobName: string; finishedAt: string; error: string; durationMs: number }

export interface WorkItem {
  key: string; source: string; severity: number; title: string; detail: string;
  customerId: string | null; customerName: string | null; waitingSince: string;
  ageHours: number; blocking: string | null; href: string;
}
export interface SourceCoverage { source: string; considered: number; waiting: number; ok: boolean; error?: string }
export interface Worklist {
  items: WorkItem[];
  coverage: SourceCoverage[];
  /** Items the server's cap dropped. Never omitted — zero means the list is complete. */
  truncated: number;
  asOf: string;
}

export interface Figure { cents: number; rows: number; capCents: number | null; window: string; source: string }
export interface SpendBoard {
  gatewayToday: Figure; gatewayMonth: Figure; assetsMonth: Figure;
  assetBudgets: { customerId: string; legalName: string; capCents: number; spentCents: number }[];
  activeSubscriptions: { count: number; monthlyCents: number };
  asOf: string;
  byRole?: RoleCost[];
}
export interface RoleCost { role: string; model: string; calls: number; costCents: number; perCallCents: number }

export interface FamilyCell {
  family: string; state: FamilyState; count: number; waiting: number;
  configured: number | null; note: string;
}
export interface CustomerRow {
  id: string; legalName: string; domain: string | null; status: string;
  vertical: string | null; regionCode: string; wonAt: string | null;
  cells: Record<string, FamilyCell>; attentionCount: number;
}
export interface CustomerBoard {
  rows: CustomerRow[]; totalCustomers: number; unresolvedVerticals: number; asOf: string;
}
export interface CustomerDetail {
  customer: CustomerRow;
  defines: { family: string; items: string[] }[];
  asOf: string;
}

/** Each board arrives independently tagged, so one failure does not blank the page. */
export type Band<T> = { ok: true; data: T } | { ok: false; error: string };
export interface NowPayload {
  asOf: string;
  worklist: Band<Worklist>;
  jobs: Band<JobRow[]>;
  recentFailures: Band<JobFailure[]>;
  spend: Band<SpendBoard>;
}

export interface KillSwitchRow {
  name: string; engaged: boolean; toggled_by: string | null; toggled_at: string | null;
  confirmedByGate: boolean;
}
export interface KillSwitchBoard {
  switches: KillSwitchRow[]; known: string[]; propagationSeconds: number; asOf: string;
}
export interface ToggleResult {
  ok: boolean; name: string; engaged: boolean;
  confirmedByGate: boolean; engagedSwitches: string[]; propagationSeconds: number;
}

export interface VaultEntry {
  vendorId: string; keyName: string; version: number;
  fingerprint: string; expiresAt: string | null; ref: string;
}
export interface VendorRow {
  id: string; name: string; tier: number; data_class: string;
  gate: string | null; state: string; probe_status: string | null; probe_last_ok: string | null;
}
export interface FleetBoard {
  asOf: string; window: string;
  assets: Record<string, unknown>[];
  deliverability: { sent: number; bounced: number; complained: number; bounceRate: number | null; complaintRate: number | null };
  retired: string;
}
export interface ModelsBoard {
  asOf: string; window: string;
  registry: Record<string, unknown>[];
  cost: RoleCost[];
}
export interface OpportunityRow {
  id: string; businessId: string; vertical: string; stage: string; stageLabel: string;
  targetFunction: string | null; quoteAmountCents: number | null; ownerEmail: string | null;
  nextStage: string | null; nextGate: string | null; missingEvidence: string[]; updatedAt: string;
}

// ── Agents ────────────────────────────────────────────────────────────────
export interface AgentContractRow {
  id: string; role: string; dataClass: string; capabilities: string[];
  maxTokensOut: number; budgetUsdPerPassingOutput: number;
  hasClamp: boolean; hasEscalation: boolean;
}
export interface AgentActivity {
  agentId: string; invocations: number; firstPassRate: number | null;
  escalations: number; injectionSuspected: number; costCents: number;
  medianDurationMs: number | null; lastRunAt: string | null; models: string[];
}
export interface AgentRow extends AgentContractRow { activity: AgentActivity; halted: boolean }
export interface AgentBoard {
  agents: AgentRow[]; windowDays: number; totalInvocations: number;
  neverInvoked: number; asOf: string;
}
export interface Invocation {
  id: string; agentId: string; role: string; model: string; dataClass: string;
  subjectId: string | null; traceId: string | null; costCents: number;
  firstPass: boolean; confidence: number | null; injectionSuspected: boolean;
  escalated: boolean; escalateReason: string | null; durationMs: number | null; createdAt: string;
}
export interface DeployedAgentRow {
  customerId: string; legalName: string; domain: string | null; vertical: string | null;
  live: boolean; blockedBy: string[]; packApproved: boolean; packVersion: number | null;
  pairCount: number; openGaps: number; sessions: number; turns: number;
  answeredFromPack: number; deflectionRate: number | null; escalations: number;
  unacknowledgedIncidents: number; lastSessionAt: string | null; medianLatencyMs: number | null;
}
export interface DeployedBoard {
  rows: DeployedAgentRow[]; totalCustomers: number; liveCount: number; asOf: string;
  totals: {
    live: number; sessions: number; turns: number;
    answeredFromPack: number; openGaps: number; deflectionRate: number | null;
  };
}

// ── Outreach ──────────────────────────────────────────────────────────────
export interface FunnelStage {
  key: string; label: string; count: number; source: string;
  ofPrevious: number | null; ofCohort: number | null;
  subsetOf: string | null; violatesSubset: boolean;
}
export interface OutreachFunnel { stages: FunnelStage[]; windowDays: number | null; asOf: string }
export interface DenialReason { ruleId: string; reason: string; count: number }
export interface GateSummary {
  total: number; allowed: number; denied: number; denialRate: number | null;
  reasons: DenialReason[]; asOf: string;
}
export interface OutreachPayload {
  asOf: string;
  funnel: Band<OutreachFunnel>;
  gate: Band<GateSummary>;
}
export interface BusinessRow {
  id: string; name: string; vertical: string | null; category: string | null; segment: string;
  countryCode: string; regionCode: string; city: string | null; websiteUrl: string | null;
  ingestedAt: string; hasProvenance: boolean; contacts: number; leads: number;
  messagesSent: number; gateAllowed: number; gateDenied: number;
  hasPreview: boolean; previewClaimed: boolean; isCustomer: boolean; suppressed: boolean;
}
export interface BusinessBoard {
  rows: BusinessRow[]; total: number; withoutProvenance: number; asOf: string;
}
export interface BusinessDetail {
  business: BusinessRow;
  contacts: { id: string; emailHash: string; verification: string | null; subscriberType: string | null; suppressed: boolean; suppressionReason: string | null }[];
  decisions: { id: string; allow: boolean; ruleId: string | null; reason: string | null; channel: string | null; messageClass: string | null; jurisdiction: string | null; legalBasis: string | null; decidedAt: string; configVersion: string | null }[];
  messages: { id: string; direction: string | null; subject: string | null; sentAt: string | null; gateDecisionId: string | null }[];
  provenance: { id: string; retrievedAt: string; legalBasis: string | null; sourceUrl: string | null; noCemStatement: boolean | null; reviewedBy: string | null }[];
  previews: { id: string; generatedAt: string; claimedAt: string | null; deployUrl: string | null; expiresAt: string | null; takedownAt: string | null }[];
  asOf: string;
}

export interface OpsUser { id: string; email: string; role: "superadmin" | "customer" }

export type LoginOutcome =
  | { ok: true; user: OpsUser }
  | { ok: false; reason: "invalid_credentials" | "totp_required" | "totp_invalid" | "unreachable" };

export const api = {
  health: () => get<{ ok: boolean; mode: string }>("/health"),

  async me(): Promise<OpsUser | null> {
    const r = await get<{ user: OpsUser }>("/auth/me");
    return isOk(r) ? r.data.user : null;
  },

  async login(email: string, password: string, totp?: string): Promise<LoginOutcome> {
    try {
      const res = await fetch(`${BASE}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, totp }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, user: ((await res.json()) as { user: OpsUser }).user };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const reason =
        body.error === "totp_required" || body.error === "totp_invalid" ? body.error : "invalid_credentials";
      return { ok: false, reason };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  },

  async logout(): Promise<void> {
    await post("/auth/logout").catch(() => undefined);
  },

  // ── The console's read model ────────────────────────────────────────────
  now: () => get<NowPayload>("/ops/now"),
  jobs: () => get<{ asOf: string; jobs: JobRow[]; recentFailures: JobFailure[] }>("/ops/jobs"),
  customers: (limit = 200) => get<CustomerBoard>(`/ops/customers?limit=${limit}`),
  customer: (id: string) => get<CustomerDetail>(`/ops/customers/${id}`),
  spend: () => get<SpendBoard>("/ops/spend"),
  models: () => get<ModelsBoard>("/ops/models"),
  fleet: () => get<FleetBoard>("/ops/fleet"),
  opportunities: () => get<{ pipeline: OpportunityRow[] }>("/ops/opportunities"),

  // ── Agents ──────────────────────────────────────────────────────────────
  agents: (days = 30) => get<AgentBoard>(`/ops/agents?days=${days}`),
  agentInvocations: (opts: { agentId?: string; injection?: boolean; escalated?: boolean; retried?: boolean; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.agentId !== undefined) p.set("agentId", opts.agentId);
    if (opts.injection === true) p.set("injection", "1");
    if (opts.escalated === true) p.set("escalated", "1");
    if (opts.retried === true) p.set("retried", "1");
    p.set("limit", String(opts.limit ?? 100));
    return get<{ asOf: string; invocations: Invocation[] }>(`/ops/agents/invocations?${p.toString()}`);
  },
  deployedAgents: (limit = 200) => get<DeployedBoard>(`/ops/deployed-agents?limit=${limit}`),

  // ── Outreach ────────────────────────────────────────────────────────────
  outreach: () => get<OutreachPayload>("/ops/outreach"),
  businesses: (q = "", limit = 100) =>
    get<BusinessBoard>(`/ops/businesses?q=${encodeURIComponent(q)}&limit=${limit}`),
  business: (id: string) => get<BusinessDetail>(`/ops/businesses/${id}`),

  // ── Controls ────────────────────────────────────────────────────────────
  killSwitches: () => get<KillSwitchBoard>("/killswitch"),
  toggleKillSwitch: (name: string, engage: boolean) =>
    post<ToggleResult>(`/killswitch/${encodeURIComponent(name)}`, { engage }),

  // ── Vendors and vault ───────────────────────────────────────────────────
  vendors: () => get<VendorRow[]>("/vendors"),
  vault: () => get<VaultEntry[]>("/vault"),
  depositCredential: (vendorId: string, keyName: string, secret: string) =>
    post<{ ok: boolean; ref?: string }>(`/vault/${vendorId}/${keyName}`, { secret }),

  // ── Search ──────────────────────────────────────────────────────────────
  search: (q: string) =>
    get<{ query: string; results: Record<string, Record<string, unknown>[]> }>(`/search?q=${encodeURIComponent(q)}`),
};
