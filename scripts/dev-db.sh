#!/usr/bin/env bash
# ADW dev database — cold-starts the in-sandbox PostgreSQL 16 server, creates the
# roles (adw_admin superuser, adw_app least-privilege application role) and the
# adw / adw_test / adw_shadow databases. This is the P0 go/no-go check.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="/usr/lib/postgresql/16/bin"
PGDATA="$ROOT/.pg/data"
SOCK="$ROOT/.pg/sock"
LOG="$ROOT/.pg/log.txt"
PORT="${ADW_PG_PORT:-5433}"

as_pg() { runuser -u postgres -- "$@"; }
psql_admin() { PGHOST=127.0.0.1 "$PG_BIN/psql" -p "$PORT" -U adw_admin -d postgres -v ON_ERROR_STOP=1 "$@"; }

start() {
  if [ ! -d "$PGDATA" ]; then
    mkdir -p "$PGDATA" "$SOCK"
    chown -R postgres:postgres "$ROOT/.pg"
    as_pg "$PG_BIN/initdb" -D "$PGDATA" -A trust --auth-host=trust -U adw_admin >/dev/null
    echo "initdb: OK"
  fi
  if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
    echo "postgres already running on :$PORT"
  else
    chown -R postgres:postgres "$ROOT/.pg"
    as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" \
      -o "-p $PORT -k $SOCK -c listen_addresses='127.0.0.1'" -l "$LOG" start
    sleep 1
  fi
  bootstrap
  echo "postgres: UP on 127.0.0.1:$PORT"
}

bootstrap() {
  # Roles: adw_app is the least-privilege application role; migrations REVOKE
  # DELETE/UPDATE on the append-only tables from it (spec §43).
  psql_admin >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'adw_app') THEN
    CREATE ROLE adw_app LOGIN PASSWORD 'adw';
  END IF;
END \$\$;
SQL
  for db in adw adw_test adw_shadow; do
    if ! psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
      psql_admin -c "CREATE DATABASE $db OWNER adw_admin" >/dev/null
    fi
    PGHOST=127.0.0.1 "$PG_BIN/psql" -p "$PORT" -U adw_admin -d "$db" -v ON_ERROR_STOP=1 >/dev/null <<SQL
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT CONNECT ON DATABASE $db TO adw_app;
GRANT USAGE ON SCHEMA public TO adw_app;
SQL
  done
}

stop() {
  if [ -d "$PGDATA" ]; then
    as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast || true
  fi
}

reset() {
  stop || true
  rm -rf "$ROOT/.pg"
  start
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  *) echo "usage: dev-db.sh [start|stop|reset]"; exit 1 ;;
esac
