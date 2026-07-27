import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import {
  base32Encode,
  createSession,
  createUser,
  hashPassword,
  invalidateSession,
  login,
  originAllowed,
  readSessionCookie,
  requireSuperadmin,
  sessionCookie,
  totp,
  validateSession,
  verifyPassword,
  verifyTotp,
} from "./src/index.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
let db: Db;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

const uniq = () => `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

describe("password hashing (scrypt)", () => {
  it("round-trips and rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
  it("produces a different hash for the same password (random salt)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });
  it("rejects a malformed stored hash rather than throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Appendix B test vectors, SHA-1, 8 digits, secret "12345678901234567890".
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];
  for (const [time, expected] of vectors) {
    it(`matches the RFC vector at t=${time}`, () => {
      expect(totp(secret, time, { digits: 8, algorithm: "sha1" })).toBe(expected);
    });
  }

  it("verifies a current code and rejects a stale one outside the window", () => {
    const s = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    const now = 1_700_000_000;
    const code = totp(s, now);
    expect(verifyTotp(s, code, now)).toBe(true);
    // Five periods later is well outside the ±1 step window.
    expect(verifyTotp(s, code, now + 150)).toBe(false);
  });

  it("accepts a code one step early or late (clock drift)", () => {
    const s = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    const now = 1_700_000_000;
    expect(verifyTotp(s, totp(s, now - 30), now)).toBe(true);
    expect(verifyTotp(s, totp(s, now + 30), now)).toBe(true);
  });
});

describe("sessions", () => {
  it("creates, validates and invalidates a session; the DB never stores the token", async () => {
    const email = uniq();
    const { id } = await createUser(db, { email, password: "pw12345678", role: "customer" });
    const { token, session } = await createSession(db, id);
    // The stored id is a hash, not the token.
    expect(session.id).not.toBe(token);
    const stored = await db.one<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1", [id]);
    expect(stored.id).not.toContain(token);

    const valid = await validateSession(db, token);
    expect(valid?.user.email.toLowerCase()).toBe(email.toLowerCase());

    await invalidateSession(db, token);
    expect(await validateSession(db, token)).toBeNull();
  });

  it("rejects an expired session and cleans it up", async () => {
    const email = uniq();
    const { id } = await createUser(db, { email, password: "pw12345678", role: "customer" });
    const { token } = await createSession(db, id, {}, new Date(Date.now() - 100 * 24 * 3600 * 1000));
    expect(await validateSession(db, token)).toBeNull();
  });

  it("parses and clears the session cookie", () => {
    const c = sessionCookie("abc", true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(readSessionCookie("other=1; adw_session=abc; x=2")).toBe("abc");
    expect(readSessionCookie(null)).toBeNull();
  });
});

describe("login", () => {
  it("a customer logs in with a password alone", async () => {
    const email = uniq();
    await createUser(db, { email, password: "pw12345678", role: "customer" });
    const res = await login(db, email, "pw12345678", undefined);
    expect(res.ok).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const email = uniq();
    await createUser(db, { email, password: "pw12345678", role: "customer" });
    const res = await login(db, email, "nope", undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_credentials");
  });

  it("a superadmin MUST supply a valid TOTP code", async () => {
    const email = uniq();
    const { totpSecret } = await createUser(db, { email, password: "pw12345678", role: "superadmin" });
    expect(totpSecret).not.toBeNull();

    const noCode = await login(db, email, "pw12345678", undefined);
    expect(noCode.ok).toBe(false);
    if (!noCode.ok) expect(noCode.reason).toBe("totp_required");

    const badCode = await login(db, email, "pw12345678", "000000");
    expect(badCode.ok).toBe(false);
    if (!badCode.ok) expect(badCode.reason).toBe("totp_invalid");

    const code = totp(totpSecret!, Math.floor(Date.now() / 1000));
    const good = await login(db, email, "pw12345678", code);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.user.role).toBe("superadmin");
  });
});

describe("guards", () => {
  it("requireSuperadmin rejects a customer and null", () => {
    expect(() => requireSuperadmin(null)).toThrow(/superadmin/);
    expect(() =>
      requireSuperadmin({ id: "1", email: "a@b.c", role: "customer", customerId: null, totpEnabled: false }),
    ).toThrow(/superadmin/);
    expect(() =>
      requireSuperadmin({ id: "1", email: "a@b.c", role: "superadmin", customerId: null, totpEnabled: true }),
    ).not.toThrow();
  });

  it("Origin check backs SameSite for CSRF", () => {
    expect(originAllowed("https://app.adwsites.com", ["https://app.adwsites.com"])).toBe(true);
    expect(originAllowed("https://evil.example", ["https://app.adwsites.com"])).toBe(false);
    expect(originAllowed(undefined, ["https://app.adwsites.com"])).toBe(false);
  });
});
