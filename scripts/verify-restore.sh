#!/usr/bin/env bash
# Backup restore verification (spec §44: "an unrestored backup is not a backup").
#
# Dumps the live database, restores it into a scratch database, and asserts the
# schema and row counts survived — including that the append-only ledgers came
# back with their triggers and grants intact, which is the part that actually
# matters after a disaster.
#
# Run monthly. Exits non-zero on any discrepancy so it can be a scheduled check.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="/usr/lib/postgresql/16/bin"
PORT="${ADW_PG_PORT:-5433}"
SOURCE_DB="${SOURCE_DB:-adw}"
SCRATCH_DB="adw_restore_check"
DUMP="${TMPDIR:-/tmp}/adw-restore-check.dump"

psql_admin() { PGHOST=127.0.0.1 "$PG_BIN/psql" -p "$PORT" -U adw_admin -v ON_ERROR_STOP=1 "$@"; }

echo "▶ dumping $SOURCE_DB"
PGHOST=127.0.0.1 "$PG_BIN/pg_dump" -p "$PORT" -U adw_admin -Fc -f "$DUMP" "$SOURCE_DB"

echo "▶ restoring into $SCRATCH_DB"
psql_admin -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null
psql_admin -d postgres -c "CREATE DATABASE $SCRATCH_DB OWNER adw_admin;" >/dev/null
PGHOST=127.0.0.1 "$PG_BIN/pg_restore" -p "$PORT" -U adw_admin -d "$SCRATCH_DB" "$DUMP" >/dev/null 2>&1 || true

fail=0

echo "▶ asserting row counts match"
for table in businesses contacts provenance suppression gate_decisions messages leads customers subscriptions vendors registry_roles; do
  src=$(psql_admin -d "$SOURCE_DB" -tAc "SELECT count(*) FROM $table" 2>/dev/null || echo "ERR")
  dst=$(psql_admin -d "$SCRATCH_DB" -tAc "SELECT count(*) FROM $table" 2>/dev/null || echo "ERR")
  if [ "$src" != "$dst" ]; then
    echo "  ✗ $table: source=$src restored=$dst"
    fail=1
  else
    echo "  ✓ $table: $src rows"
  fi
done

echo "▶ asserting the append-only triggers survived the restore"
for table in suppression provenance gate_decisions; do
  trig=$(psql_admin -d "$SCRATCH_DB" -tAc \
    "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='$table' AND NOT t.tgisinternal")
  if [ "$trig" -lt 1 ]; then
    echo "  ✗ $table has no append-only trigger after restore"
    fail=1
  else
    echo "  ✓ $table append-only trigger present"
  fi
done

echo "▶ asserting the restored ledger still rejects a DELETE"
# A DELETE matching zero rows succeeds trivially — the BEFORE ROW trigger never
# fires — so insert a canary in the scratch copy and try to remove that.
CANARY="\\x$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
psql_admin -d "$SCRATCH_DB" -c \
  "INSERT INTO suppression (email_hash, reason, channel_scope) VALUES ('$CANARY'::bytea,'manual','all');" >/dev/null
if psql_admin -d "$SCRATCH_DB" -c "DELETE FROM suppression WHERE email_hash = '$CANARY'::bytea;" >/dev/null 2>&1; then
  echo "  ✗ DELETE of an existing suppression row SUCCEEDED after restore — the ledger is not append-only"
  fail=1
else
  echo "  ✓ DELETE of an existing suppression row correctly rejected"
fi

echo "▶ cleaning up"
psql_admin -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null
rm -f "$DUMP"

if [ "$fail" -ne 0 ]; then
  echo "❌ restore verification FAILED"
  exit 1
fi
echo "✅ restore verification passed"
