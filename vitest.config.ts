import { defineConfig } from "vitest/config";

// Root config used when running `vitest` from the repo root. Individual packages
// are also runnable in isolation. DB-backed tests connect to the adw_test
// database on the local Postgres server.
export default defineConfig({
  test: {
    include: ["packages/**/*.test.{ts,js}", "apps/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.pg/**"],
    testTimeout: 20000,
    hookTimeout: 30000,
    env: {
      DATABASE_ADMIN_URL: "postgres://adw_admin@127.0.0.1:5433/adw_test",
      DATABASE_APP_URL: "postgres://adw_app:adw@127.0.0.1:5433/adw_test",
      DATABASE_URL: "postgres://adw_admin@127.0.0.1:5433/adw_test",
      ADW_VAULT_MASTER_KEY: "0".repeat(64),
      ADW_DB: "pg",
      // The vault refuses the well-known demo key unless the environment
      // declares itself local/test. Tests must opt in explicitly.
      ADW_ENV: "test",
    },
  },
});
