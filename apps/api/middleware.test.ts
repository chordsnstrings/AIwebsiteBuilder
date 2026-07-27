import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  MemoryRateLimitStore,
  corsMiddleware,
  cookieSecure,
  rateLimitMiddleware,
  clientIp,
  type RateLimitRule,
} from "./src/middleware.ts";

const ORIGINS = ["https://app.adwsites.com", "http://localhost:5173"];

function corsApp() {
  const app = new Hono();
  app.use("*", corsMiddleware(ORIGINS));
  app.get("/x", (c) => c.json({ ok: true }));
  app.post("/x", (c) => c.json({ ok: true }));
  return app;
}

describe("CORS", () => {
  it("reflects a trusted origin and allows credentials", async () => {
    const res = await corsApp().request("/x", { headers: { origin: "https://app.adwsites.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.adwsites.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("does NOT reflect an untrusted origin", async () => {
    const res = await corsApp().request("/x", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("never echoes a wildcard while credentials are allowed", async () => {
    const res = await corsApp().request("/x", { headers: { origin: "https://app.adwsites.com" } });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("answers a preflight with the permitted methods and headers", async () => {
    const res = await corsApp().request("/x", {
      method: "OPTIONS",
      headers: { origin: "https://app.adwsites.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("passes through a request with no Origin (server-to-server)", async () => {
    const res = await corsApp().request("/x");
    expect(res.status).toBe(200);
  });
});

describe("rate limiting", () => {
  const rules: RateLimitRule[] = [{ prefix: "/auth/login", limit: 3, windowMs: 60_000 }];

  function limitedApp() {
    const app = new Hono();
    app.use("*", rateLimitMiddleware(rules, new MemoryRateLimitStore()));
    app.post("/auth/login", (c) => c.json({ ok: true }));
    app.get("/open", (c) => c.json({ ok: true }));
    return app;
  }

  it("allows up to the limit then returns 429 with Retry-After", async () => {
    const app = limitedApp();
    const headers = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/auth/login", { method: "POST", headers });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/auth/login", { method: "POST", headers });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("meters per client IP, so one abuser cannot lock out everyone", async () => {
    const app = limitedApp();
    for (let i = 0; i < 4; i++) {
      await app.request("/auth/login", { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" } });
    }
    const other = await app.request("/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.2" },
    });
    expect(other.status).toBe(200);
  });

  it("leaves unmatched routes unmetered", async () => {
    const app = limitedApp();
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/open", { headers: { "x-forwarded-for": "203.0.113.7" } });
      expect(res.status).toBe(200);
    }
  });

  it("resets after the window elapses", async () => {
    const store = new MemoryRateLimitStore();
    const key = "k";
    for (let i = 0; i < 5; i++) await store.hit(key, 1);
    await new Promise((r) => setTimeout(r, 5));
    const after = await store.hit(key, 60_000);
    expect(after.count).toBe(1);
  });

  it("takes the first hop of X-Forwarded-For", () => {
    const c = { req: { header: (h: string) => (h === "x-forwarded-for" ? "203.0.113.7, 10.0.0.1" : undefined) } };
    expect(clientIp(c as never)).toBe("203.0.113.7");
  });
});

describe("cookie policy", () => {
  it("is Secure everywhere except local/test, so a misconfigured deploy fails closed", () => {
    const original = process.env.ADW_ENV;
    try {
      process.env.ADW_ENV = "production";
      expect(cookieSecure()).toBe(true);
      process.env.ADW_ENV = "staging";
      expect(cookieSecure()).toBe(true);
      delete process.env.ADW_ENV;
      expect(cookieSecure()).toBe(true); // defaults to secure
      process.env.ADW_ENV = "local";
      expect(cookieSecure()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ADW_ENV;
      else process.env.ADW_ENV = original;
    }
  });
});
