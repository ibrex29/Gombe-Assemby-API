#!/usr/bin/env bash
# Deploy Pantamiyya Assembly API against the shared Governorship Postgres.
#
# Does not start a second database. Does not seed. Does not enable IReV workers.
# Droplet path: ~/Pantamiyya-Assembly-API
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing in $ROOT (copy from ~/Pantamiyya-API/.env)"
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

PANTAMIYYA_ASSEMBLY_API_PORT="${PANTAMIYYA_ASSEMBLY_API_PORT:-5303}"
COMPOSE_FILE="infra/compose/pantamiyya-assembly.droplet.yml"
COMPOSE=(docker compose --project-name electromon-pantamiyya-assembly --project-directory . -f "$COMPOSE_FILE")

export PANTAMIYYA_POSTGRES_USER="${PANTAMIYYA_POSTGRES_USER:-electromon}"
export PANTAMIYYA_POSTGRES_DB="${PANTAMIYYA_POSTGRES_DB:-electromon_pantamiyya}"
export PANTAMIYYA_POSTGRES_PASSWORD="${PANTAMIYYA_POSTGRES_PASSWORD:-${PANTAMIYYA_DB_PASSWORD:-}}"
export PANTAMIYYA_S3_ACCESS_KEY="${PANTAMIYYA_S3_ACCESS_KEY:-electromon_pantamiyya}"
export PANTAMIYYA_S3_SECRET_KEY="${PANTAMIYYA_S3_SECRET_KEY:-${PANTAMIYYA_MINIO_PASSWORD:-}}"
export PANTAMIYYA_S3_BUCKET="${PANTAMIYYA_S3_BUCKET:-electromon-pantamiyya}"
export PANTAMIYYA_ASSEMBLY_S3_ENDPOINT="${PANTAMIYYA_ASSEMBLY_S3_ENDPOINT:-http://electromon-pantamiyya-minio:9000}"
export PANTAMIYYA_ASSEMBLY_REDIS_URL="${PANTAMIYYA_ASSEMBLY_REDIS_URL:-redis://electromon-pantamiyya-redis:6379/3}"
export PANTAMIYYA_ASSEMBLY_API_PUBLIC_URL="${PANTAMIYYA_ASSEMBLY_API_PUBLIC_URL:-https://assemblyapi.pantamiyyaa.alphabetandnumbers.com}"
export PANTAMIYYA_ASSEMBLY_CORS_ORIGIN="${PANTAMIYYA_ASSEMBLY_CORS_ORIGIN:-https://assembly.pantamiyyaa.alphabetandnumbers.com}"
export PANTAMIYYA_CLOUDINARY_FOLDER="${PANTAMIYYA_CLOUDINARY_FOLDER:-electromon/pantamiyya/uploads}"
export PANTAMIYYA_ASSEMBLY_API_PORT

if [[ -z "${PANTAMIYYA_POSTGRES_PASSWORD}" ]]; then
  echo "ERROR: Set PANTAMIYYA_POSTGRES_PASSWORD in .env"
  exit 1
fi
if [[ -z "${PANTAMIYYA_S3_SECRET_KEY}" ]]; then
  echo "ERROR: Set PANTAMIYYA_S3_SECRET_KEY (or PANTAMIYYA_MINIO_PASSWORD) in .env"
  exit 1
fi
if [[ -z "${JWT_ACCESS_SECRET:-}" || -z "${JWT_REFRESH_SECRET:-}" ]]; then
  echo "ERROR: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are required in .env"
  exit 1
fi

if ! docker inspect electromon-pantamiyya-postgres >/dev/null 2>&1; then
  echo "ERROR: electromon-pantamiyya-postgres is not running. Start Governorship first."
  exit 1
fi

echo "==> Writing .env.pantamiyya-assembly (shared DB ${PANTAMIYYA_POSTGRES_DB}, port ${PANTAMIYYA_ASSEMBLY_API_PORT})..."
{
  grep -v -E '^(API_PORT=|API_PUBLIC_URL=|DATABASE_URL=|REDIS_URL=|RABBITMQ_URL=|S3_ENDPOINT=|S3_ACCESS_KEY=|S3_SECRET_KEY=|S3_BUCKET=|AI_READONLY_DATABASE_URL=|DEPLOYMENT_STATE_CODE=|DEPLOYMENT_CLIENT_PARTY_CODE=|PANTAMIYYA_API_PORT=|IREV_FETCH_QUEUE=|SUPPORTED_STATE_CODES=|IREV_ELECTION_ID=|IREV_ELECTION_LABEL=|IREV_ELECTION_TYPE=|IREV_BOOTSTRAP_|IREV_OCR_AFTER_CATALOG=|IREV_CATALOG_|IREV_OCR_BACKFILL_|IREV_ENABLED=|CORS_ORIGIN=|DEFAULT_CONTEST=|DISABLE_BACKGROUND_WORKERS=|CLOUDINARY_FOLDER=)' .env || true
  cat <<EOF
DEPLOYMENT_STATE_CODE=GO
DEPLOYMENT_CLIENT_PARTY_CODE=PDP
DEFAULT_CONTEST=assembly
DISABLE_BACKGROUND_WORKERS=true
IREV_ENABLED=false
IREV_BOOTSTRAP_ON_START=false
IREV_ELECTION_TYPE=ASSEMBLY
IREV_ELECTION_LABEL=Gombe State House of Assembly Election
IREV_FETCH_QUEUE=irev.fetch.pantamiyya.assembly
SUPPORTED_STATE_CODES=GO
PANTAMIYYA_ASSEMBLY_API_PORT=${PANTAMIYYA_ASSEMBLY_API_PORT}
PANTAMIYYA_POSTGRES_USER=${PANTAMIYYA_POSTGRES_USER}
PANTAMIYYA_POSTGRES_PASSWORD=${PANTAMIYYA_POSTGRES_PASSWORD}
PANTAMIYYA_POSTGRES_DB=${PANTAMIYYA_POSTGRES_DB}
PANTAMIYYA_S3_ACCESS_KEY=${PANTAMIYYA_S3_ACCESS_KEY}
PANTAMIYYA_S3_SECRET_KEY=${PANTAMIYYA_S3_SECRET_KEY}
PANTAMIYYA_S3_BUCKET=${PANTAMIYYA_S3_BUCKET}
PANTAMIYYA_ASSEMBLY_S3_ENDPOINT=${PANTAMIYYA_ASSEMBLY_S3_ENDPOINT}
PANTAMIYYA_ASSEMBLY_REDIS_URL=${PANTAMIYYA_ASSEMBLY_REDIS_URL}
API_PORT=3001
API_PUBLIC_URL=${PANTAMIYYA_ASSEMBLY_API_PUBLIC_URL}
CORS_ORIGIN=${PANTAMIYYA_ASSEMBLY_CORS_ORIGIN}
DATABASE_URL=postgresql://${PANTAMIYYA_POSTGRES_USER}:${PANTAMIYYA_POSTGRES_PASSWORD}@electromon-pantamiyya-postgres:5432/${PANTAMIYYA_POSTGRES_DB}?schema=public
REDIS_URL=${PANTAMIYYA_ASSEMBLY_REDIS_URL}
S3_ENDPOINT=${PANTAMIYYA_ASSEMBLY_S3_ENDPOINT}
S3_ACCESS_KEY=${PANTAMIYYA_S3_ACCESS_KEY}
S3_SECRET_KEY=${PANTAMIYYA_S3_SECRET_KEY}
S3_BUCKET=${PANTAMIYYA_S3_BUCKET}
CLOUDINARY_FOLDER=${PANTAMIYYA_CLOUDINARY_FOLDER}
EOF
} > .env.pantamiyya-assembly

chmod +x infra/scripts/*.sh

echo "==> Applying shared-DB migrations + SHA roster..."
"${COMPOSE[@]}" up --remove-orphans migrate
"${COMPOSE[@]}" up --exit-code-from sha-apply sha-apply

echo "==> Building and starting Assembly API on :${PANTAMIYYA_ASSEMBLY_API_PORT} (DB ${PANTAMIYYA_POSTGRES_DB})..."
"${COMPOSE[@]}" up -d --build --remove-orphans api

if docker inspect electromon-pantamiyya-assembly-postgres >/dev/null 2>&1; then
  echo "==> Stopping leftover Assembly Postgres (shared DB is electromon-pantamiyya-postgres)..."
  docker stop electromon-pantamiyya-assembly-postgres >/dev/null || true
  docker rm electromon-pantamiyya-assembly-postgres >/dev/null || true
fi

API_CONTAINER="${PANTAMIYYA_ASSEMBLY_API_CONTAINER:-electromon-pantamiyya-assembly-api}"

echo "==> Waiting for Assembly API health (${API_CONTAINER})..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PANTAMIYYA_ASSEMBLY_API_PORT}/api/v1/health/ready" >/dev/null 2>&1; then
    echo "==> Assembly API ready on http://127.0.0.1:${PANTAMIYYA_ASSEMBLY_API_PORT}"
    curl -fsS "http://127.0.0.1:${PANTAMIYYA_ASSEMBLY_API_PORT}/api/v1/health/live" | head -c 500 || true
    echo ""
    exit 0
  fi
  sleep 2
done

echo "ERROR: Assembly API health check failed"
docker logs "$API_CONTAINER" --tail 80 || true
exit 1
