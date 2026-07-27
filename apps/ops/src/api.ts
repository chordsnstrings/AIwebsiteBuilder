// API client for the operator console. Every call degrades gracefully to the
// seeded demo fixtures when the API is not reachable, so the console renders
// meaningfully with nothing running — and switches to live data the moment the
// API is up. `live` tells the UI which it is looking at.
const BASE =
  (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_URL ?? "http://localhost:8787";

// Every request is bounded. A first paint must never wait on the network, and a
// hung API must never leave the console blank — it degrades to demo data.
const TIMEOUT_MS = 2500;

function withTimeout(init: RequestInit = {}): RequestInit {
  return { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) };
}

export interface ApiResult<T> {
  data: T;
  live: boolean;
}

async function get<T>(path: string, fallback: T): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, withTimeout({ credentials: "include" }));
    if (!res.ok) return { data: fallback, live: false };
    return { data: (await res.json()) as T, live: true };
  } catch {
    return { data: fallback, live: false };
  }
}

async function post<T>(path: string, body: unknown, fallback: T): Promise<ApiResult<T>> {
  try {
    const res = await fetch(
      `${BASE}${path}`,
      withTimeout({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) return { data: fallback, live: false };
    return { data: (await res.json()) as T, live: true };
  } catch {
    return { data: fallback, live: false };
  }
}

export interface VaultEntry {
  vendorId: string;
  keyName: string;
  version: number;
  fingerprint: string;
  expiresAt: string | null;
  ref: string;
}

export interface OpsUser {
  id: string;
  email: string;
  role: "superadmin" | "customer";
}

export type LoginOutcome =
  | { ok: true; user: OpsUser }
  | { ok: false; reason: "invalid_credentials" | "totp_required" | "totp_invalid" | "unreachable" };

export const api = {
  health: () => get<{ ok: boolean; mode: string }>("/health", { ok: false, mode: "demo" }),

  async me(): Promise<OpsUser | null> {
    try {
      const res = await fetch(`${BASE}/auth/me`, withTimeout({ credentials: "include" }));
      if (!res.ok) return null;
      return ((await res.json()) as { user: OpsUser }).user;
    } catch {
      return null;
    }
  },

  async login(email: string, password: string, totp?: string): Promise<LoginOutcome> {
    try {
      const res = await fetch(
        `${BASE}/auth/login`,
        withTimeout({
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, totp }),
        }),
      );
      if (res.ok) return { ok: true, user: ((await res.json()) as { user: OpsUser }).user };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const reason = body.error === "totp_required" || body.error === "totp_invalid" ? body.error : "invalid_credentials";
      return { ok: false, reason };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  },

  async logout(): Promise<void> {
    try {
      await fetch(`${BASE}/auth/logout`, withTimeout({ method: "POST", credentials: "include" }));
    } catch {
      /* already offline */
    }
  },

  vault: (fallback: VaultEntry[]) => get<VaultEntry[]>("/vault", fallback),
  depositCredential: (vendorId: string, keyName: string, secret: string) =>
    post<{ ok: boolean; ref?: string }>(`/vault/${vendorId}/${keyName}`, { secret }, { ok: false }),
  vendors: <T>(fallback: T) => get<T>("/vendors", fallback),
  registry: <T>(fallback: T) => get<T>("/registry", fallback),
  exceptions: <T>(fallback: T) => get<T>("/exceptions", fallback),
  killSwitches: <T>(fallback: T) => get<T>("/killswitch", fallback),
  toggleKillSwitch: (name: string, engage: boolean) =>
    post<{ ok: boolean; engaged: boolean }>(`/killswitch/${name}`, { engage }, { ok: false, engaged: engage }),
};
