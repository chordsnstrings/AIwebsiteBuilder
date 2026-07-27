#!/usr/bin/env bash
# P2 Gateway + Registry + Evals acceptance gate.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bash scripts/dev-db.sh start >/dev/null

echo "▶ P2.1 typecheck (no dependency cycle)"
npx turbo run typecheck >/dev/null

echo "▶ P2.2 every role gets a champion backed by a stored eval run"
npx vitest run packages/evals-harness >/dev/null

echo "▶ P2.3 gateway: PAY rejected, escalation ladder, budget, attribution"
npx vitest run packages/gateway >/dev/null

echo "▶ P2.4 registry: pinning, champion requires eval run + audit"
npx vitest run packages/registry >/dev/null

echo "▶ P2.5 no model name in agents/workflows (grep mirror) + prompt portability"
npx vitest run packages/prompts >/dev/null

echo "▶ P2.6 lint (no vendor SDK outside adapters, no model names)"
npx eslint . >/dev/null

echo "✅ P2 gate PASSED"
