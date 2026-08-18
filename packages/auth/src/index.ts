// Auth: scrypt passwords, sha256-indexed sessions, RFC 6238 TOTP (mandatory for
// the superadmin), magic-link claim tokens and an Origin-based CSRF check.
// Zero native dependencies — everything runs on node:crypto.
import type { Db } from "@adw/db";
import { hashPassword, verifyPassword } from "./password.ts";
import { createSession, type SessionUser } from "./session.ts";
import { generateSecret, verifyTotp } from "./totp.ts";

export * from "./password.ts";
export * from "./session.ts";
export * from "./totp.ts";

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; reason: "invalid_credentials" | "totp_required" | "totp_invalid" };

/**
 * Password (+ TOTP where enabled) login. The superadmin always requires TOTP —
 * a superadmin account without TOTP enrolled cannot complete a login.
 */
export async function login(
  db: Db,
  email: string,
  password: string,
  totpCode: string | undefined,
  ctx: { ip?: string; userAgent?: string; now?: Date } = {},
): Promise<LoginResult> {
  const now = ctx.now ?? new Date();
  const row = await db.maybeOne<{
    id: string;
    email: string;
    password_hash: string | null;
    role: string;
    customer_id: string | null;
    totp_secret: string | null;
    totp_enabled: boolean;
  }>(
    "SELECT id, email, password_hash, role, customer_id, totp_secret, totp_enabled FROM users WHERE email = $1",
    [email],
  );
  if (!row?.password_hash) return { ok: false, reason: "invalid_credentials" };
  if (!(await verifyPassword(password, row.password_hash))) {
    return { ok: false, reason: "invalid_credentials" };
  }

  const needsTotp = row.totp_enabled || row.role === "superadmin";
  if (needsTotp) {
    if (!row.totp_secret) return { ok: false, reason: "totp_required" };
    if (!totpCode) return { ok: false, reason: "totp_required" };
    if (!verifyTotp(row.totp_secret, totpCode, Math.floor(now.getTime() / 1000))) {
      return { ok: false, reason: "totp_invalid" };
    }
  }

  const { token } = await createSession(db, row.id, ctx, now);
  return {
    ok: true,
    token,
    user: {
      id: row.id,
      email: row.email,
      role: row.role === "superadmin" ? "superadmin" : "customer",
      customerId: row.customer_id,
      totpEnabled: row.totp_enabled,
    },
  };
}

/** Create a user. Superadmins are enrolled in TOTP at creation, never later. */
export async function createUser(
  db: Db,
  input: { email: string; password: string; role: "superadmin" | "customer"; customerId?: string },
): Promise<{ id: string; totpSecret: string | null }> {
  const passwordHash = await hashPassword(input.password);
  const totpSecret = input.role === "superadmin" ? generateSecret() : null;
  // ⛔ Returns the STORED secret, not the one just generated. On the conflict
  // path the existing user keeps their original secret — so returning the fresh
  // one would hand the caller a QR code that enrols an authenticator against a
  // secret nothing checks, and the user would be locked out at the next login
  // with no indication why.
  const row = await db.one<{ id: string; totp_secret: string | null }>(
    `INSERT INTO users (email, password_hash, role, customer_id, totp_secret, totp_enabled)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, totp_secret`,
    [input.email, passwordHash, input.role, input.customerId ?? null, totpSecret, totpSecret !== null],
  );
  return { id: row.id, totpSecret: row.totp_secret };
}

/** Guard used by the API: require an authenticated superadmin. */
export function requireSuperadmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user || user.role !== "superadmin") {
    throw new Error("FORBIDDEN: superadmin required");
  }
}
