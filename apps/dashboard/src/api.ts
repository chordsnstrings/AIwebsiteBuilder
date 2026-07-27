// API client for the customer dashboard. Same contract as the operator console
// and preview clients: bounded requests, graceful degradation to demo behaviour,
// and no call on the render path — the dashboard must paint from local state
// alone, so every request here originates in an event handler.
const BASE =
  (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_URL ?? "http://localhost:8787";

const TIMEOUT_MS = 2500;

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

export const dashboardApi = {
  /** File a plain-words change request; the API answers with the round number. */
  requestRevision: (customerId: string, requestText: string): Promise<Sent> =>
    post(`/customers/${encodeURIComponent(customerId)}/revisions`, { requestText }),
};
