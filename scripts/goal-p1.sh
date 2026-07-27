#!/usr/bin/env bash
# P1 Gate + Provenance acceptance gate.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bash scripts/dev-db.sh start >/dev/null

echo "▶ P1.1 typecheck gate/compliance/provenance"
npx turbo run typecheck --filter=@adw/gate --filter=@adw/compliance --filter=@adw/provenance >/dev/null

echo "▶ P1.2 19-case gate suite (Phase 0 exit criterion)"
npx vitest run packages/gate/gate-suite.test.ts >/dev/null

echo "▶ P1.3 golden tests (brand-domain refusal, suppression, tos, gate_decision_id)"
npx vitest run packages/gate/golden.test.ts >/dev/null

echo "▶ P1.4 provenance pipeline (failure => opt-out-only, no-CEM detection)"
npx vitest run packages/provenance >/dev/null

echo "▶ P1.5 lint (no transport outside gate send layer)"
npx eslint . >/dev/null

echo "✅ P1 gate PASSED"
