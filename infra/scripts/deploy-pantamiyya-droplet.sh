#!/usr/bin/env bash
# Deploy Pantamiyya (Gombe governorship) as a fully isolated stack on the SLUK droplet.
# Own Postgres, Redis, RabbitMQ, MinIO — does NOT touch the national API or its data.
#
# Repo: git@github.com:ibrex29/Asiwaju4Arewa-API.git branch Pantamiyya
# Droplet path: ~/Pantamiyya-API (git clone — not rsync)
#
# First-time clone on droplet:
#   ./infra/scripts/bootstrap-pantamiyya-droplet-git.sh
#
# First boot (creates DB + runs Gombe geography seed):
#   PANTAMIYYA_RUN_SEED=true PANTAMIYYA_SEED_ADMIN_PASSWORD='your-strong-password' \
#     ./infra/scripts/deploy-pantamiyya-droplet.sh
#
# Routine deploy (pull + rebuild):
#   cd ~/Pantamiyya-API && git pull origin Pantamiyya && ./infra/scripts/deploy-pantamiyya-droplet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PANTAMIYYA_GIT_BRANCH="${PANTAMIYYA_GIT_BRANCH:-Pantamiyya}"
PANTAMIYYA_GIT_REMOTE="${PANTAMIYYA_GIT_REMOTE:-origin}"

if [[ "${PANTAMIYYA_GIT_PULL:-true}" == "true" ]] && [[ -d .git ]]; then
  echo "==> Git pull (${PANTAMIYYA_GIT_REMOTE}/${PANTAMIYYA_GIT_BRANCH})..."
  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current_branch" != "$PANTAMIYYA_GIT_BRANCH" ]]; then
    echo "ERROR: expected branch ${PANTAMIYYA_GIT_BRANCH}, on ${current_branch}"
    echo "       Run: git checkout ${PANTAMIYYA_GIT_BRANCH}"
    exit 1
  fi
  git fetch "$PANTAMIYYA_GIT_REMOTE" "$PANTAMIYYA_GIT_BRANCH"
  git pull --ff-only "$PANTAMIYYA_GIT_REMOTE" "$PANTAMIYYA_GIT_BRANCH"
  echo "==> At $(git log -1 --oneline)"
elif [[ ! -d .git ]]; then
  echo "WARNING: ${ROOT} is not a git repo — deploy uses files on disk only."
  echo "         Run ./infra/scripts/bootstrap-pantamiyya-droplet-git.sh once to clone."
fi

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing in $ROOT (copy from national deploy or pantamiyya.env.example)"
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

PANTAMIYYA_API_PORT="${PANTAMIYYA_API_PORT:-5301}"
COMPOSE_FILE="infra/compose/pantamiyya.droplet.yml"
COMPOSE=(docker compose --project-name electromon-pantamiyya --project-directory . -f "$COMPOSE_FILE")

# Pantamiyya-specific secrets — fall back to national vars only for shared API keys (JWT, OCR, etc.)
export PANTAMIYYA_POSTGRES_USER="${PANTAMIYYA_POSTGRES_USER:-electromon}"
export PANTAMIYYA_POSTGRES_DB="${PANTAMIYYA_POSTGRES_DB:-electromon_pantamiyya}"
export PANTAMIYYA_POSTGRES_PASSWORD="${PANTAMIYYA_POSTGRES_PASSWORD:-${PANTAMIYYA_DB_PASSWORD:-}}"
export PANTAMIYYA_RABBITMQ_USER="${PANTAMIYYA_RABBITMQ_USER:-electromon}"
export PANTAMIYYA_RABBITMQ_PASSWORD="${PANTAMIYYA_RABBITMQ_PASSWORD:-${PANTAMIYYA_RABBIT_PASSWORD:-}}"
export PANTAMIYYA_S3_ACCESS_KEY="${PANTAMIYYA_S3_ACCESS_KEY:-electromon_pantamiyya}"
export PANTAMIYYA_S3_SECRET_KEY="${PANTAMIYYA_S3_SECRET_KEY:-${PANTAMIYYA_MINIO_PASSWORD:-}}"
export PANTAMIYYA_S3_BUCKET="${PANTAMIYYA_S3_BUCKET:-electromon-pantamiyya}"
export PANTAMIYYA_API_PUBLIC_URL="${PANTAMIYYA_API_PUBLIC_URL:-http://127.0.0.1:${PANTAMIYYA_API_PORT}}"
export IREV_FETCH_QUEUE="${IREV_FETCH_QUEUE:-irev.fetch.pantamiyya}"

if [[ -z "${PANTAMIYYA_POSTGRES_PASSWORD}" ]]; then
  echo "ERROR: Set PANTAMIYYA_POSTGRES_PASSWORD (or PANTAMIYYA_DB_PASSWORD) in .env"
  exit 1
fi
if [[ -z "${PANTAMIYYA_RABBITMQ_PASSWORD}" ]]; then
  echo "ERROR: Set PANTAMIYYA_RABBITMQ_PASSWORD (or PANTAMIYYA_RABBIT_PASSWORD) in .env"
  exit 1
fi
if [[ -z "${PANTAMIYYA_S3_SECRET_KEY}" ]]; then
  echo "ERROR: Set PANTAMIYYA_S3_SECRET_KEY (or PANTAMIYYA_MINIO_PASSWORD) in .env"
  exit 1
fi

echo "==> Writing .env.pantamiyya (isolated stack, port ${PANTAMIYYA_API_PORT}, DB ${PANTAMIYYA_POSTGRES_DB})..."
{
  grep -v -E '^(API_PORT=|API_PUBLIC_URL=|DATABASE_URL=|REDIS_URL=|RABBITMQ_URL=|S3_ENDPOINT=|S3_ACCESS_KEY=|S3_SECRET_KEY=|S3_BUCKET=|AI_READONLY_DATABASE_URL=|DEPLOYMENT_STATE_CODE=|DEPLOYMENT_CLIENT_PARTY_CODE=|PANTAMIYYA_API_PORT=|IREV_FETCH_QUEUE=|SUPPORTED_STATE_CODES=|IREV_ELECTION_ID=|IREV_ELECTION_LABEL=|IREV_ELECTION_TYPE=|IREV_BOOTSTRAP_|IREV_OCR_AFTER_CATALOG=|IREV_CATALOG_|IREV_OCR_BACKFILL_)' .env || true
  cat <<EOF
DEPLOYMENT_STATE_CODE=GO
DEPLOYMENT_CLIENT_PARTY_CODE=PDP
IREV_ELECTION_ID=6407d9bfce35006e92156f2e
IREV_ELECTION_LABEL=Gombe Governorship Election
IREV_ELECTION_TYPE=GOVERNORSHIP
IREV_FETCH_QUEUE=${IREV_FETCH_QUEUE}
IREV_BOOTSTRAP_ON_START=true
IREV_BOOTSTRAP_WARD_BATCH=200
IREV_OCR_AFTER_CATALOG=true
IREV_CATALOG_WARD_BATCH=50
IREV_CATALOG_INTERVAL_MS=15000
IREV_OCR_BACKFILL_INTERVAL_MS=10000
IREV_OCR_BACKFILL_BATCH=100
IREV_FETCH_RATE_LIMIT=45
SUPPORTED_STATE_CODES=GO
PANTAMIYYA_API_PORT=${PANTAMIYYA_API_PORT}
PANTAMIYYA_POSTGRES_USER=${PANTAMIYYA_POSTGRES_USER}
PANTAMIYYA_POSTGRES_PASSWORD=${PANTAMIYYA_POSTGRES_PASSWORD}
PANTAMIYYA_POSTGRES_DB=${PANTAMIYYA_POSTGRES_DB}
PANTAMIYYA_RABBITMQ_USER=${PANTAMIYYA_RABBITMQ_USER}
PANTAMIYYA_RABBITMQ_PASSWORD=${PANTAMIYYA_RABBITMQ_PASSWORD}
PANTAMIYYA_S3_ACCESS_KEY=${PANTAMIYYA_S3_ACCESS_KEY}
PANTAMIYYA_S3_SECRET_KEY=${PANTAMIYYA_S3_SECRET_KEY}
PANTAMIYYA_S3_BUCKET=${PANTAMIYYA_S3_BUCKET}
API_PORT=3001
API_PUBLIC_URL=${PANTAMIYYA_API_PUBLIC_URL}
DATABASE_URL=postgresql://${PANTAMIYYA_POSTGRES_USER}:${PANTAMIYYA_POSTGRES_PASSWORD}@postgres:5432/${PANTAMIYYA_POSTGRES_DB}?schema=public
REDIS_URL=redis://redis:6379
RABBITMQ_URL=amqp://${PANTAMIYYA_RABBITMQ_USER}:${PANTAMIYYA_RABBITMQ_PASSWORD}@rabbitmq:5672
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=${PANTAMIYYA_S3_ACCESS_KEY}
S3_SECRET_KEY=${PANTAMIYYA_S3_SECRET_KEY}
S3_BUCKET=${PANTAMIYYA_S3_BUCKET}
AI_READONLY_DATABASE_URL=postgresql://electromon_ai_readonly:${PANTAMIYYA_AI_READONLY_DB_PASSWORD:-${AI_READONLY_DB_PASSWORD}}@postgres:5432/${PANTAMIYYA_POSTGRES_DB}?schema=public
EOF
} > .env.pantamiyya

chmod +x infra/scripts/*.sh

echo "==> Starting Pantamiyya infra (postgres, redis, rabbitmq, minio)..."
"${COMPOSE[@]}" up -d postgres redis rabbitmq minio
"${COMPOSE[@]}" up minio-init migrate

if [[ "${PANTAMIYYA_RUN_SEED:-false}" == "true" ]]; then
  if [[ -z "${PANTAMIYYA_SEED_ADMIN_PASSWORD:-}" ]]; then
    echo "ERROR: PANTAMIYYA_SEED_ADMIN_PASSWORD is required when PANTAMIYYA_RUN_SEED=true"
    exit 1
  fi
  export PANTAMIYYA_SEED_ADMIN_PASSWORD
  echo "==> Bootstrap seed (Gombe geography + governorship campaign)..."
  "${COMPOSE[@]}" --profile bootstrap up --exit-code-from seed seed
fi

echo "==> Building and starting Pantamiyya API on :${PANTAMIYYA_API_PORT}..."
"${COMPOSE[@]}" up -d --build api

API_CONTAINER="${PANTAMIYYA_API_CONTAINER:-electromon-pantamiyya-api}"

echo "==> Waiting for Pantamiyya API health (${API_CONTAINER})..."
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${PANTAMIYYA_API_PORT}/api/v1/health/ready" >/dev/null 2>&1; then
    echo "==> Pantamiyya API ready on http://127.0.0.1:${PANTAMIYYA_API_PORT}"
    curl -fsS "http://127.0.0.1:${PANTAMIYYA_API_PORT}/api/v1/health/live" | head -c 500 || true
    echo ""
    echo "==> Isolated stack: postgres=${PANTAMIYYA_POSTGRES_DB} redis rabbitmq minio bucket=${PANTAMIYYA_S3_BUCKET} queue=${IREV_FETCH_QUEUE}"
    exit 0
  fi
  sleep 2
done

echo "ERROR: Pantamiyya API health check failed"
docker logs "$API_CONTAINER" --tail 80 || true
exit 1
