#!/usr/bin/env bash
# P0 Foundation acceptance gate. Binary: exits non-zero on any failure.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "▶ P0.1 Postgres cold-start"
bash scripts/dev-db.sh start >/dev/null

echo "▶ P0.2 migrations idempotent from empty"
DATABASE_URL="postgres://adw_admin@127.0.0.1:5433/adw_test" npx tsx scripts/migrate.ts >/dev/null

echo "▶ P0.3 typecheck"
npx turbo run typecheck >/dev/null

echo "▶ P0.4 lint (custom invariant rules)"
npx eslint . >/dev/null

echo "▶ P0.5 test suite (db grants, append-only, vault, config, lint rules)"
npx vitest run >/dev/null

echo "✅ P0 gate PASSED"
