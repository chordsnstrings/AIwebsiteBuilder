export type { Db, QueryResult, DbConfig } from "./client.ts";
export { createDb, getDb, resetDbSingleton } from "./client.ts";
export { migrate } from "./migrate.ts";
export type { MigrationResult } from "./migrate.ts";

import { createHash } from "node:crypto";

/** sha256(lower(email)) as a Buffer — the suppression/contact join key. */
export function emailHash(email: string): Buffer {
  return createHash("sha256").update(email.trim().toLowerCase()).digest();
}

/** sha256 of an E.164 phone number as a Buffer. */
export function phoneHash(phone: string): Buffer {
  return createHash("sha256").update(phone.replace(/\s+/g, "")).digest();
}
