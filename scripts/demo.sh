#!/usr/bin/env bash
# Boot the full demo: Postgres, vault key, migrations, seed data, then run the
# end-to-end pipeline and the nightly evals. Fully keyless. Optionally starts the
# API + the four apps if `serve` is passed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgres://adw_admin@127.0.0.1:5433/adw}"
# The vault refuses the well-known demo key unless the environment says local.
export ADW_ENV="${ADW_ENV:-local}"
if [ -z "${ADW_VAULT_MASTER_KEY:-}" ]; then
  export ADW_VAULT_MASTER_KEY="$(node -e "console.log('0'.repeat(64))")"
fi

echo "▶ starting Postgres"
bash scripts/dev-db.sh start >/dev/null

echo "▶ seeding demo data"
npx tsx scripts/seed-demo.ts

echo "▶ running end-to-end pipeline"
npx tsx scripts/demo-e2e.ts

echo "▶ running nightly evals"
npx tsx scripts/eval-nightly.ts

if [ "${1:-}" = "serve" ]; then
  echo "▶ starting API on :8787 and apps (ops:5173 web:5174 preview:5175 dashboard:5176)"
  (cd apps/api && PORT=8787 npx tsx src/server.ts &)
  (cd apps/ops && npx vite --port 5173 &)
  (cd apps/web && npx vite --port 5174 &)
  (cd apps/preview && npx vite --port 5175 &)
  (cd apps/dashboard && npx vite --port 5176 &)
  echo "Press Ctrl-C to stop."
  wait
fi
