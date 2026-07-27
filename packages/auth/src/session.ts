// Session management (Lucia pattern). The session id stored in the database is
// sha256(token) — a database read never yields a usable credential. Cookies are
// HttpOnly/SameSite=Lax/Secure with a sliding expiry.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@adw/db";

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000; // slide when < 7 days left

export interface SessionUser {
  id: string;
  email: string;
  role: "superadmin" | "customer";
  customerId: string | null;
  totpEnabled: boolean;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(
  db: Db,
  userId: string,
  ctx: { ip?: string; userAgent?: string } = {},
  now = new Date(),
): Promise<{ token: string; session: Session }> {
  const token = newSessionToken();
  const id = hashToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.query(
    "INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)",
    [id, userId, expiresAt, ctx.ip ?? null, ctx.userAgent ?? null],
  );
  return { token, session: { id, userId, expiresAt } };
}

/** Validate a token, sliding the expiry when it is close. Returns null if invalid. */
export async function validateSession(
  db: Db,
  token: string,
  now = new Date(),
): Promise<{ user: SessionUser; session: Session } | null> {
  const id = hashToken(token);
  const row = await db.maybeOne<{
    id: string;
    user_id: string;
    expires_at: string;
    email: string;
    role: string;
    customer_id: string | null;
    totp_enabled: boolean;
  }>(
    `SELECT s.id, s.user_id, s.expires_at, u.email, u.role, u.customer_id, u.totp_enabled
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id],
  );
  if (!row) return null;
  const expiresAt = new Date(row.expires_at);
  if (expiresAt.getTime() <= now.getTime()) {
    await db.query("DELETE FROM sessions WHERE id = $1", [id]);
    return null;
  }
  let finalExpiry = expiresAt;
  if (expiresAt.getTime() - now.getTime() < RENEW_WITHIN_MS) {
    finalExpiry = new Date(now.getTime() + SESSION_TTL_MS);
    await db.query("UPDATE sessions SET expires_at = $2 WHERE id = $1", [id, finalExpiry]);
  }
  return {
    user: {
      id: row.user_id,
      email: row.email,
      role: row.role === "superadmin" ? "superadmin" : "customer",
      customerId: row.customer_id,
      totpEnabled: row.totp_enabled,
    },
    session: { id, userId: row.user_id, expiresAt: finalExpiry },
  };
}

export async function invalidateSession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE id = $1", [hashToken(token)]);
}

export async function invalidateAllUserSessions(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export function sessionCookie(token: string, secure = true): string {
  const attrs = [
    `adw_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie(): string {
  return "adw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

export function readSessionCookie(header: string | undefined | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === "adw_session" && v) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Magic-link claim tokens — how a prospect claims a preview without a password.
// ---------------------------------------------------------------------------
export function newClaimToken(): string {
  return randomBytes(24).toString("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// CSRF: SameSite=Lax plus an Origin check on state-changing requests.
// ---------------------------------------------------------------------------
export function originAllowed(origin: string | undefined | null, allowed: string[]): boolean {
  if (!origin) return false;
  return allowed.some((a) => origin === a);
}
