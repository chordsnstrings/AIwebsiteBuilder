// API client for the customer dashboard.
//
// ⛔ THE OLD CLIENT HAD THREE METHODS AND A DANGEROUS FALLBACK. Nine of the
// twelve views rendered `demoCustomer` — a fixture business called Bright
// Plumbing, with 342 visits, 28 calls and two paid invoices — and the three
// live methods degraded to those same fixtures whenever a request failed. So a
// real owner on a bad connection, or against a downed API, saw a complete and
// entirely convincing dashboard belonging to somebody who does not exist.
//
// The rule now: FIXTURES ARE FOR THE DEMO ID ONLY. A signed-in customer either
// sees their own data or sees that it could not be loaded. There is no third
// state where the screen quietly shows someone else's numbers, because that
// state is indistinguishable from working.
const BASE =
  (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_URL ?? "http://localhost:8787";

const TIMEOUT_MS = 6000;

/** `ok` = the API accepted it. `live` = the API answered at all. */
export interface Sent {
  ok: boolean;
  live: boolean;
  round?: number;
}

async function post(path: string, body: unknown): Promise<Sent> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, live: true };
    const data = (await res.json().catch(() => ({}))) as { round?: number };
    return { ok: true, live: true, round: data.round };
  } catch {
    return { ok: false, live: false };
  }
}

/** Used when the dashboard is opened without a customer id (design review). */
export const DEMO_CUSTOMER_ID = "demo-customer";

/**
 * The signed-in customer is normally resolved from the session cookie; the id in
 * the URL lets an operator open one specific dashboard. The app uses a hash
 * router, so the parameter can live in either query string. Purely synchronous.
 */
export function customerIdFromUrl(loc: { search: string; hash: string } = window.location): string {
  const fromSearch = new URLSearchParams(loc.search).get("customer");
  if (fromSearch) return fromSearch;
  const hashQuery = loc.hash.includes("?") ? loc.hash.slice(loc.hash.indexOf("?")) : "";
  return new URLSearchParams(hashQuery).get("customer") ?? DEMO_CUSTOMER_ID;
}

/**
 * ⛔ The one predicate that decides whether a screen may show a fixture.
 * Anything other than the demo id is a real business, and a real business is
 * never shown invented numbers.
 */
export function isDemo(customerId: string = customerIdFromUrl()): boolean {
  return customerId === DEMO_CUSTOMER_ID;
}

/** A gap as the API returns it. Mirrors `openGaps` in @adw/concierge. */
export interface ApiGap {
  id: string;
  question: string;
  timesAsked: number;
  lastAskedAt: string;
  draftedAnswer: string | null;
  status: string;
}

export interface ApiEnquiry {
  id: string;
  name: string | null;
  need: string;
  contact: string;
  urgency: "emergency" | "urgent" | "normal";
  status: "open" | "contacted" | "closed";
  createdAt: string;
  notifiedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  sessionId: string | null;
}

export interface ApiBooking {
  id: string;
  start: string;
  end: string;
  contact: string | null;
  status: "held" | "confirmed" | "cancelled";
  resourceName: string | null;
  createdAt: string;
}

export interface ApiQueueItem {
  id: string;
  trigger: string;
  severity: number;
  context: unknown;
  systemAction: string;
  recommendation: string;
  createdAt: string;
  assignee: string | null;
  dueAt: string | null;
  acknowledgedAt: string | null;
  overdue: boolean;
}

export interface ApiOverview {
  customerId: string;
  businessName: string;
  siteUrl: string | null;
  status: string;
  vertical: string | null;
  wonAt: string;
  domain: { name: string; cutoverAt: string | null } | null;
  subscription: {
    planCode: string; amountCents: number; currency: string; interval: string;
    status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean;
  } | null;
  invoices: { id: string; amountCents: number; currency: string; status: string; issuedAt: string; paidAt: string | null }[];
  agent: { live: boolean; packVersion: number | null; approvedAt: string | null; calendarConnected: boolean };
  counts: {
    openEnquiries: number; emergencyEnquiries: number; upcomingBookings: number;
    openQueueItems: number; openGaps: number;
  };
  latestReport: { year: number; month: number; visits: number; calls: number; formSubmissions: number; bookings: number } | null;
}

export interface ApiReport {
  customerId: string;
  month: { year: number; month: number };
  generatedAt: string;
  report: {
    visits: number; calls: number; formSubmissions: number; bookings: number;
    momDelta: { visits: number; calls: number; formSubmissions: number; bookings: number };
    suggestion: { text?: string } | null;
  };
}

/** `ok` false with a `reason` means the API refused it and said why. */
export interface Approved extends Sent {
  reason?: string;
}

/**
 * ⛔ Distinguishes "the API said no data" from "the API did not answer".
 * `null` used to mean both, and the callers turned both into demo fixtures.
 */
export type Fetched<T> = { live: true; data: T } | { live: false; data: null };

async function get<T>(path: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { live: false, data: null };
    return { live: true, data: (await res.json()) as T };
  } catch {
    return { live: false, data: null };
  }
}

const enc = encodeURIComponent;

export const dashboardApi = {
  /** File a plain-words change request; the API answers with the round number. */
  requestRevision: (customerId: string, requestText: string): Promise<Sent> =>
    post(`/customers/${enc(customerId)}/revisions`, { requestText }),

  /** Home, Domain, Payments and Billing, in one round trip. */
  overview: (customerId: string): Promise<Fetched<ApiOverview>> =>
    get(`/agent/${enc(customerId)}/overview`),

  listGaps: (customerId: string): Promise<Fetched<{ gaps: ApiGap[] }>> =>
    get(`/agent/${enc(customerId)}/gaps`),

  /**
   * ⛔ The read side that did not exist. `commitEnquiry` wrote these rows and
   * nothing anywhere selected from the table, so this screen showed fixtures
   * while real callers waited for a call back nobody knew about.
   */
  listEnquiries: (customerId: string, includeClosed = false): Promise<Fetched<{
    enquiries: ApiEnquiry[];
    summary: { open: number; emergency: number; unnotified: number };
  }>> => get(`/agent/${enc(customerId)}/enquiries${includeClosed ? "?includeClosed=true" : ""}`),

  markEnquiryContacted: (enquiryId: string): Promise<Sent> =>
    post(`/agent/enquiries/${enc(enquiryId)}/contacted`, {}),

  resolveEnquiry: (enquiryId: string): Promise<Sent> =>
    post(`/agent/enquiries/${enc(enquiryId)}/resolve`, {}),

  listBookings: (customerId: string): Promise<Fetched<{ bookings: ApiBooking[] }>> =>
    get(`/agent/${enc(customerId)}/bookings`),

  cancelBooking: (bookingId: string): Promise<Sent> =>
    post(`/agent/bookings/${enc(bookingId)}/cancel`, {}),

  /** The owner's queue — three worker jobs fill it and nothing used to read it. */
  listQueue: (customerId: string): Promise<Fetched<{ items: ApiQueueItem[] }>> =>
    get(`/agent/${enc(customerId)}/queue`),

  acknowledgeQueueItem: (itemId: string): Promise<Sent> =>
    post(`/agent/queue/${enc(itemId)}/acknowledge`, {}),

  resolveQueueItem: (itemId: string, resolution: string): Promise<Sent> =>
    post(`/agent/queue/${enc(itemId)}/resolve`, { resolution }),

  /** The monthly value report — generated for nobody until the sweep existed. */
  listReports: (customerId: string): Promise<Fetched<{ reports: ApiReport[] }>> =>
    get(`/agent/${enc(customerId)}/reports`),

  /**
   * Publish the owner's answer.
   *
   * The API can refuse it — the refusal policy applies to the owner's words
   * too, so "we guarantee we'll be there within the hour" comes back 422. That
   * reason has to reach the screen: showing it as saved when it was rejected is
   * the worst outcome, because the owner believes their agent now says
   * something it will never say.
   */
  approveGap: async (gapId: string, answer: string): Promise<Approved> => {
    try {
      const res = await fetch(`${BASE}/agent/gaps/${enc(gapId)}/approve`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, live: true };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, live: true, ...(body.error === undefined ? {} : { reason: body.error }) };
    } catch {
      return { ok: false, live: false };
    }
  },
};
