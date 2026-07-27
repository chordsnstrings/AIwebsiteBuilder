// Minimal in-house migrator. Numbered .sql files applied in order inside a
// transaction, tracked in schema_migrations, guarded by an advisory lock so
// concurrent runners don't collide. Idempotent from an empty database.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const ADVISORY_LOCK_KEY = 4820073; // arbitrary constant, stable across runs

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(db: Db): Promise<MigrationResult> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Advisory lock (real PG only; PGlite is single-connection so no-op is fine).
  if (db.backend === "pg") {
    await db.exec(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY});`);
  }
  try {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const done = new Set(
      (await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await db.tx(async (tx) => {
        await tx.exec(sql);
        await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      });
      applied.push(file);
    }
    return { applied, skipped };
  } finally {
    if (db.backend === "pg") {
      await db.exec(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY});`);
    }
  }
}
