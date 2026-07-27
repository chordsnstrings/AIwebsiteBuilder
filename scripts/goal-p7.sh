#!/usr/bin/env bash
# P7 final acceptance gate — the whole system, end to end.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export DATABASE_URL="${DATABASE_URL:-postgres://adw_admin@127.0.0.1:5433/adw}"
export ADW_ENV="${ADW_ENV:-local}"
export ADW_VAULT_MASTER_KEY="${ADW_VAULT_MASTER_KEY:-$(node -e "console.log('0'.repeat(64))")}"
bash scripts/dev-db.sh start >/dev/null

echo "▶ P7.1 typecheck (all packages + apps)"
npx turbo run typecheck >/dev/null

echo "▶ P7.2 lint (all spec-invariant rules)"
npx eslint . >/dev/null

echo "▶ P7.3 full test suite"
npx vitest run >/dev/null

echo "▶ P7.4 seed + end-to-end pipeline"
npx tsx scripts/seed-demo.ts >/dev/null
npx tsx scripts/demo-e2e.ts >/dev/null

echo "▶ P7.5 nightly evals + production invariants"
npx tsx scripts/eval-nightly.ts >/dev/null

echo "✅ P7 gate PASSED — system builds, verifies and runs end to end."
