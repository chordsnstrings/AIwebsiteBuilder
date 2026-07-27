#!/usr/bin/env bash
# P3 Engine + Agents + Workflows acceptance gate.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bash scripts/dev-db.sh start >/dev/null

echo "▶ P3.1 typecheck engine/agents/workflows"
npx turbo run typecheck --filter=@adw/workflows --filter=@adw/agents >/dev/null

echo "▶ P3.2 durable engine: 180-day cooldown via time-skip, crash/resume, signals"
npx vitest run packages/workflows/engine.test.ts >/dev/null

echo "▶ P3.3 agent constraints: discount clamp, intent parking, capability exclusions"
npx vitest run packages/agents >/dev/null

echo "▶ P3.4 walking skeleton: hard-fail + IP-flag both block deploy; lead lifecycle"
npx vitest run packages/workflows/definitions.test.ts >/dev/null

echo "✅ P3 gate PASSED"
