// Unified DB client over node-postgres (real PG16, primary) and PGlite (embedded
// WASM Postgres, used for pure-logic unit tests). Same interface either way so
// callers never branch on backend. Prod swap is DATABASE_URL only.
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  readonly backend: "pg" | "pglite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgDb implements Db {
  readonly backend = "pg" as const;
  // deno-lint-ignore no-explicit-any
  constructor(private readonly pool: any, private readonly client?: any) {}

  private runner() {
    return this.client ?? this.pool;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.runner().query(sql, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T> {
    const res = await this.query<T>(sql, params);
    const row = res.rows[0];
    if (!row) throw new Error("Expected exactly one row, got none");
    return row;
  }

  async maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const res = await this.query<T>(sql, params);
    return res.rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.runner().query(sql);
  }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgDb(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }
}

class PgliteDb implements Db {
  readonly backend = "pglite" as const;
  // deno-lint-ignore no-explicit-any
  constructor(private readonly pg: any) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query(sql, params);
    return { rows: res.rows as T[], rowCount: res.affectedRows ?? res.rows.length };
  }

  async one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T> {
    const res = await this.query<T>(sql, params);
    const row = res.rows[0];
    if (!row) throw new Error("Expected exactly one row, got none");
    return row;
  }

  async maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const res = await this.query<T>(sql, params);
    return res.rows[0] ?? null;
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // PGlite is single-connection; emulate with savepoint-free BEGIN/COMMIT.
    await this.pg.query("BEGIN");
    try {
      const result = await fn(this);
      await this.pg.query("COMMIT");
      return result;
    } catch (err) {
      await this.pg.query("ROLLBACK");
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

export interface DbConfig {
  backend?: "pg" | "pglite";
  url?: string;
}

let singleton: Db | null = null;

export async function createDb(config: DbConfig = {}): Promise<Db> {
  const backend = config.backend ?? (process.env.ADW_DB === "pglite" ? "pglite" : "pg");
  if (backend === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    // deno-lint-ignore no-explicit-any
    const { citext } = await import("@electric-sql/pglite/contrib/citext").catch(() => ({ citext: undefined } as any));
    const pg = await PGlite.create({ extensions: citext ? { citext } : undefined });
    return new PgliteDb(pg);
  }
  const pg = await import("pg");
  const url = config.url ?? process.env.DATABASE_URL ?? "postgres://adw_app:adw@127.0.0.1:5433/adw";
  const pool = new pg.default.Pool({ connectionString: url, max: 10 });
  return new PgDb(pool);
}

export async function getDb(): Promise<Db> {
  if (!singleton) singleton = await createDb();
  return singleton;
}

export function resetDbSingleton(): void {
  singleton = null;
}
