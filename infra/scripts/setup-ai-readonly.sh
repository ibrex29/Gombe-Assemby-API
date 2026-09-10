#!/usr/bin/env bash
# Grant LOGIN + password to the AI assistant's read-only role, then prove RLS
# fails closed. The role itself (and its grants/policies) is created by the
# migration 20260820100000_ai_readonly_role_and_rls; passwords never live in
# migration SQL, so this runs once per environment.
#
# Usage:
#   AI_READONLY_DB_PASSWORD=... ./infra/scripts/setup-ai-readonly.sh
#   make db-ai-role
#
# Uses psql if it is installed. Otherwise it falls back to running psql inside
# the local Postgres container, so a developer machine does not need a client.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

ADMIN_URL="${DATABASE_URL:-}"
PASSWORD="${AI_READONLY_DB_PASSWORD:-}"

if [[ -z "$ADMIN_URL" ]]; then
  echo "DATABASE_URL is not set (needed as the admin connection)." >&2
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  echo "AI_READONLY_DB_PASSWORD is not set." >&2
  echo "Set it in .env (local) or the environment (staging/production)." >&2
  exit 1
fi

# Resolve how to reach psql. A container needs host names rewritten to localhost
# from its own perspective, which is what the container already is.
PG_CONTAINER="${AI_READONLY_PG_CONTAINER:-}"
if command -v psql >/dev/null 2>&1; then
  RUNNER="host"
else
  if [[ -z "$PG_CONTAINER" ]]; then
    PG_CONTAINER="$(docker ps --filter name=postgres --format '{{.Names}}' 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "$PG_CONTAINER" ]]; then
    echo "psql is not installed and no running Postgres container was found." >&2
    echo "Start one (make infra-up), or set AI_READONLY_PG_CONTAINER=<name>." >&2
    exit 1
  fi
  RUNNER="docker"
  echo "==> psql not found on PATH; using container '$PG_CONTAINER'"
fi

psql_admin() {
  # Prisma URLs carry ?schema=public, which libpq rejects as an unknown parameter.
  local admin_url="${ADMIN_URL%%\?*}"
  if [[ "$RUNNER" == "host" ]]; then
    psql "$admin_url" "$@"
  else
    docker exec -i "$PG_CONTAINER" psql -U "${POSTGRES_USER:-electromon}" -d "${POSTGRES_DB:-electromon}" "$@"
  fi
}

psql_readonly() {
  # Prisma URLs carry ?schema=public, which libpq rejects as an unknown
  # parameter, so it is stripped before psql sees the URL.
  local url="${1%%\?*}"; shift
  if [[ "$RUNNER" == "host" ]]; then
    psql "$url" "$@"
  else
    # Inside the container the server is always on localhost.
    docker exec -i "$PG_CONTAINER" psql "${url/@postgres:/@localhost:}" "$@"
  fi
}

echo "==> Granting LOGIN to electromon_ai_readonly"
# Sent over stdin rather than -c so the password never appears in the process
# arguments. Single quotes are doubled to escape them for the SQL literal.
ESCAPED_PASSWORD="${PASSWORD//\'/\'\'}"
printf "ALTER ROLE electromon_ai_readonly LOGIN PASSWORD '%s';\n" "$ESCAPED_PASSWORD" \
  | psql_admin -v ON_ERROR_STOP=1 -q

if [[ -z "${AI_READONLY_DATABASE_URL:-}" ]]; then
  echo "==> AI_READONLY_DATABASE_URL not set; skipping fail-closed self-check."
  echo "    Set it to verify the assistant can connect."
  exit 0
fi

echo "==> Self-check: unknown campaign must return zero rows (RLS fails closed)"
COUNT="$(psql_readonly "$AI_READONLY_DATABASE_URL" -tAX -v ON_ERROR_STOP=1 \
  -c "SELECT set_config('app.campaign_id', '__no_such_campaign__', false)" \
  -c "SELECT count(*) FROM campaigns" | tail -1)"

COUNT="$(echo "$COUNT" | tr -d '[:space:]')"
if [[ "$COUNT" == "0" ]]; then
  echo "    campaigns visible = 0  [ok] RLS fails closed"
else
  echo "    campaigns visible = $COUNT  [FAIL] expected 0 — RLS is NOT filtering" >&2
  exit 1
fi

echo "==> Self-check: excluded tables must be unreadable"
if psql_readonly "$AI_READONLY_DATABASE_URL" -tAX -c "SELECT count(*) FROM users" >/dev/null 2>&1; then
  echo "    users is readable  [FAIL] expected permission denied" >&2
  exit 1
fi
echo "    users -> permission denied  [ok]"

echo "Done. electromon_ai_readonly is ready."
