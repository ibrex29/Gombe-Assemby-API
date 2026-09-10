#!/usr/bin/env bash
# Restore Postgres from a gzipped SQL dump produced by backup-postgres.sh.
# DANGEROUS — overwrites the target database.
#
# Usage:
#   ./infra/scripts/restore-postgres.sh infra/backups/electromon-YYYYMMDDTHHMMSSZ.sql.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Usage: $0 <path-to-electromon-*.sql.gz>"
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "WARNING: This will restore into the configured database."
echo "  Dump: $DUMP"
echo "  Press Ctrl-C within 5s to abort..."
sleep 5

echo "==> Restoring..."

if docker compose --project-directory . -f infra/compose/base.yml ps postgres 2>/dev/null | grep -q Up; then
  gunzip -c "$DUMP" | docker compose --project-directory . -f infra/compose/base.yml -f infra/compose/local.yml exec -T postgres \
    psql -U "${POSTGRES_USER:-electromon}" -d "${POSTGRES_DB:-electromon}"
elif [[ -n "${DATABASE_URL:-}" ]]; then
  gunzip -c "$DUMP" | docker run --rm -i --network host postgres:16-alpine \
    psql "$DATABASE_URL"
else
  echo "ERROR: No local postgres and DATABASE_URL unset"
  exit 1
fi

echo "==> Restore complete. Run migrations if schema drifted: pnpm db:migrate:deploy"
