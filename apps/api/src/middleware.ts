// Production middleware: CORS, rate limiting and secure-cookie policy.
//
// Each of these is a go-live blocker rather than a nicety:
//   • The four frontends call this API cross-origin. With no CORS headers every
//     browser call fails — and because the clients fall back to demo fixtures on
//     error, the console would look fine while showing stale data. Silent.
//   • The public preview routes (claim, change request, takedown) and the login
//     route are unauthenticated by design and would otherwise be unmetered.
//   • A session cookie without Secure travels in clear text on any plain-HTTP
//     hop.
import type { Context, MiddlewareHandler, Next } from "hono";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * Allowed browser origins. Credentialed CORS cannot use a wildcard, so this is
 * an explicit allowlist echoed back per request. Configure via ADW_ALLOWED_ORIGINS
 * (comma-separated); the default covers local development only.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.ADW_ALLOWED_ORIGINS;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return [
    "http://localhost:5173", // ops
    "http://localhost:5174", // marketing
    "http://localhost:5175", // preview
    "http://localhost:5176", // dashboard
  ];
}

export function corsMiddleware(origins: string[] = allowedOrigins()): MiddlewareHandler {
  const allow = new Set(origins);
  return async (c: Context, next: Next) => {
    const origin = c.req.header("origin");
    // Only reflect an origin we actually trust — never echo an arbitrary one
    // while credentials are allowed.
    if (origin && allow.has(origin)) {
      c.header("access-control-allow-origin", origin);
      c.header("access-control-allow-credentials", "true");
      c.header("vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header("access-control-allow-headers", "content-type,x-adw-signature");
      c.header("access-control-max-age", "600");
      return c.body(null, 204);
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number }>;
}

/**
 * In-process fixed-window counter. Adequate for a single API replica; a
 * multi-replica deployment must swap this for a shared store (Redis INCR with
 * EXPIRE) or the effective limit multiplies by the replica count.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowMs: number): Promise<{ count: number }> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { count: 1 };
    }
    bucket.count++;
    // Opportunistic sweep so the map cannot grow without bound.
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
    }
    return { count: bucket.count };
  }
}

export interface RateLimitRule {
  /** Path prefix this rule applies to. */
  prefix: string;
  limit: number;
  windowMs: number;
}

/**
 * Default limits. Login is deliberately the tightest — it is the credential
 * -guessing surface — and the public preview routes are metered per IP because
 * they take no authentication at all.
 */
export const DEFAULT_RATE_LIMITS: RateLimitRule[] = [
  { prefix: "/auth/login", limit: 10, windowMs: 15 * 60_000 },
  { prefix: "/previews", limit: 60, windowMs: 60_000 },
  { prefix: "/suppression", limit: 120, windowMs: 60_000 },
  { prefix: "/gateway/complete", limit: 600, windowMs: 60_000 },
  { prefix: "/webhooks", limit: 600, windowMs: 60_000 },
];

export function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

export function rateLimitMiddleware(
  rules: RateLimitRule[] = DEFAULT_RATE_LIMITS,
  store: RateLimitStore = new MemoryRateLimitStore(),
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const path = c.req.path;
    const rule = rules.find((r) => path.startsWith(r.prefix));
    if (!rule) return next();
    const key = `${rule.prefix}:${clientIp(c)}`;
    const { count } = await store.hit(key, rule.windowMs);
    if (count > rule.limit) {
      c.header("retry-after", String(Math.ceil(rule.windowMs / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Cookie policy
// ---------------------------------------------------------------------------

/**
 * Whether session cookies carry Secure. True everywhere except local
 * development, so a misconfigured deploy fails closed (cookie rejected over
 * plain HTTP) rather than silently transmitting a session in clear text.
 */
export function cookieSecure(): boolean {
  const env = process.env.ADW_ENV ?? "production";
  return env !== "local" && env !== "test";
}
