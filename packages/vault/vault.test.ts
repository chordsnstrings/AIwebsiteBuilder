import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "@adw/db";
import { LocalKeyWrapper, LocalPgBackend, parseRef } from "./src/index.ts";
import { isWeakMasterKey } from "./src/crypto.ts";
import { open, seal } from "./src/crypto.ts";

const URL = process.env.DATABASE_ADMIN_URL ?? "postgres://adw_admin@127.0.0.1:5433/adw_test";
const MASTER = "0".repeat(64);

let db: Db;
let backend: LocalPgBackend;

beforeAll(async () => {
  db = await createDb({ backend: "pg", url: URL });
  await migrate(db);
  backend = new LocalPgBackend(db, new LocalKeyWrapper(MASTER));
});

afterAll(async () => {
  await db?.close();
});

describe("envelope crypto", () => {
  it("round-trips a secret", () => {
    const w = new LocalKeyWrapper(MASTER);
    const sealed = seal("sk_live_secret", "aad", w);
    expect(open(sealed, "aad", w)).toBe("sk_live_secret");
  });
  it("fails to open with wrong AAD (tamper detection)", () => {
    const w = new LocalKeyWrapper(MASTER);
    const sealed = seal("x", "aad-a", w);
    expect(() => open(sealed, "aad-b", w)).toThrow();
  });
});

describe("vault backend", () => {
  it("deposit → resolve round trip, ref is opaque", async () => {
    const v = `vendor_${Date.now()}`;
    const ref = await backend.put(v, "api_key", "sk_test_12345");
    expect(ref).toMatch(/^cred:.+:api_key@v1$/);
    expect(await backend.resolve(ref)).toBe("sk_test_12345");
  });

  it("has() reflects credential presence (drives mock vs real)", async () => {
    const v = `vendor_has_${Date.now()}`;
    expect(await backend.has(v, "api_key")).toBe(false);
    await backend.put(v, "api_key", "x");
    expect(await backend.has(v, "api_key")).toBe(true);
  });

  it("list() returns fingerprint only, never plaintext", async () => {
    const v = `vendor_list_${Date.now()}`;
    await backend.put(v, "api_key", "super-secret-value");
    const list = await backend.list(v);
    expect(list).toHaveLength(1);
    expect(list[0]!.fingerprint).toMatch(/^sha256:/);
    expect(JSON.stringify(list[0])).not.toContain("super-secret-value");
  });

  it("re-deposit bumps version", async () => {
    const v = `vendor_ver_${Date.now()}`;
    const r1 = await backend.put(v, "api_key", "a");
    const r2 = await backend.put(v, "api_key", "b");
    expect(parseRef(r1).version).toBe(1);
    expect(parseRef(r2).version).toBe(2);
    expect(await backend.resolve(r2)).toBe("b");
  });
});

describe("master key production guard", () => {
  const withEnv = (env: string | undefined, fn: () => void) => {
    const original = process.env.ADW_ENV;
    try {
      if (env === undefined) delete process.env.ADW_ENV;
      else process.env.ADW_ENV = env;
      fn();
    } finally {
      if (original === undefined) delete process.env.ADW_ENV;
      else process.env.ADW_ENV = original;
    }
  };

  it("identifies well-known weak keys", () => {
    expect(isWeakMasterKey("0".repeat(64))).toBe(true);
    expect(isWeakMasterKey("f".repeat(64))).toBe(true);
    expect(isWeakMasterKey("ab".repeat(32))).toBe(true);
    expect(isWeakMasterKey("not-hex")).toBe(true);
    expect(isWeakMasterKey("0123456789abcdef".repeat(4))).toBe(false);
  });

  it("REFUSES the all-zeros demo key in production", () => {
    withEnv("production", () => {
      expect(() => new LocalKeyWrapper("0".repeat(64))).toThrow(/well-known demo key/);
    });
    withEnv(undefined, () => {
      // Unset ADW_ENV defaults to production — fail closed.
      expect(() => new LocalKeyWrapper("0".repeat(64))).toThrow(/well-known demo key/);
    });
  });

  it("permits the demo key only in local and test", () => {
    withEnv("local", () => expect(() => new LocalKeyWrapper("0".repeat(64))).not.toThrow());
    withEnv("test", () => expect(() => new LocalKeyWrapper("0".repeat(64))).not.toThrow());
  });

  it("accepts a real key in production", () => {
    withEnv("production", () => {
      expect(() => new LocalKeyWrapper("0123456789abcdef".repeat(4))).not.toThrow();
    });
  });
});
