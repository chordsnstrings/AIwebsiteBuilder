// API client for the preview page. Same shape as the operator console client:
// every call is bounded, every failure degrades to demo behaviour, and NOTHING
// here runs during render. The preview page is opened from a cold email on a
// phone on 3G — a first paint that waits on the network is a lost sale, so the
// only callers are event handlers.
const BASE =
  (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_URL ?? "http://localhost:8787";

const TIMEOUT_MS = 2500;

/** `ok` = the API accepted it. `live` = the API answered at all. */
export interface Sent {
  ok: boolean;
  live: boolean;
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
    return { ok: res.ok, live: true };
  } catch {
    return { ok: false, live: false };
  }
}

/** Used when the page is opened without a token (local dev, design review). */
export const DEMO_CLAIM_TOKEN = "demo-preview-token";

/**
 * The claim token is the capability that identifies this preview — it arrives
 * either as `?token=…` or as the last path segment of a pretty URL (`/p/<token>`).
 * Purely synchronous: safe to call during render.
 */
export function claimTokenFromUrl(loc: { search: string; pathname: string } = window.location): string {
  const fromQuery = new URLSearchParams(loc.search).get("token");
  if (fromQuery) return fromQuery;
  const segments = loc.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && !last.includes(".") && last !== "preview") return last;
  return DEMO_CLAIM_TOKEN;
}

export interface ClaimInput {
  smsConsent: boolean;
  phone?: string;
  /** The exact wording the customer saw next to the checkbox. */
  consentWording: string;
  /** Which version of this page was rendered. */
  pageVersion: string;
}

export const previewApi = {
  claim: (token: string, input: ClaimInput): Promise<Sent> =>
    post(`/previews/${encodeURIComponent(token)}/claim`, input),

  requestChanges: (token: string, requestText: string): Promise<Sent> =>
    post(`/previews/${encodeURIComponent(token)}/changes`, { requestText }),

  notForMe: (token: string): Promise<Sent> => post(`/previews/${encodeURIComponent(token)}/not-for-me`, {}),
};
