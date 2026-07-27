#!/usr/bin/env bash
# Generates a 32-byte vault master key for demo mode and writes it to .env.local.
# In production this key comes from a real KMS/secrets backend, never a file.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
touch "$ROOT/.env.local"
if grep -q '^ADW_VAULT_MASTER_KEY=' "$ROOT/.env.local" 2>/dev/null; then
  echo "vault master key already present in .env.local"
else
  echo "ADW_VAULT_MASTER_KEY=$KEY" >> "$ROOT/.env.local"
  echo "vault master key written to .env.local"
fi
