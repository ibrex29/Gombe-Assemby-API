#!/usr/bin/env bash
# Backup Postgres (local Compose or remote via DATABASE_URL / PG* vars).
# Usage:
#   ./infra/scripts/backup-postgres.sh
#   BACKUP_DIR=/var/backups/electromon ./infra/scripts/backup-postgres.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/infra/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/electromon-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "==> Writing backup to ${OUT}"

if docker compose --project-directory . -f infra/compose/base.yml ps postgres 2>/dev/null | grep -q healthy; then
  docker compose --project-directory . -f infra/compose/base.yml -f infra/compose/local.yml exec -T postgres \
    pg_dump -U "${POSTGRES_USER:-electromon}" -d "${POSTGRES_DB:-electromon}" --no-owner --format=plain \
    | gzip -9 > "$OUT"
elif [[ -n "${DATABASE_URL:-}" ]]; then
  docker run --rm --network host postgres:16-alpine \
    pg_dump "$DATABASE_URL" --no-owner --format=plain \
    | gzip -9 > "$OUT"
else
  echo "ERROR: No healthy local postgres and DATABASE_URL unset"
  exit 1
fi

BYTES="$(wc -c < "$OUT" | tr -d ' ')"
if [[ "$BYTES" -lt 100 ]]; then
  echo "ERROR: Backup looks empty (${BYTES} bytes)"
  rm -f "$OUT"
  exit 1
fi

echo "==> OK (${BYTES} bytes)"
find "$BACKUP_DIR" -name 'electromon-*.sql.gz' -type f -mtime "+${KEEP_DAYS}" -delete 2>/dev/null || true
ls -lh "$OUT"
