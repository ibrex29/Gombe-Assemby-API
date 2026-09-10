#!/usr/bin/env bash
# Deploy the national API on the SLUK droplet (local-full Compose stack).
#
# Usage (from repo root, after git pull):
#   ./infra/scripts/deploy-droplet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing in $ROOT"
  exit 1
fi

chmod +x infra/scripts/*.sh

API_CONTAINER="${API_CONTAINER:-electromon-local-api}"

echo "==> Building and restarting migrate + api..."
docker compose --project-directory . \
  -f infra/compose/base.yml \
  -f infra/compose/local.yml \
  -f infra/compose/local.full.yml \
  -f infra/compose/apps.yml \
  --profile apps \
  up -d --build migrate api

echo "==> Waiting for API health (${API_CONTAINER})..."
for _ in $(seq 1 45); do
  if docker exec "$API_CONTAINER" wget -qO- http://localhost:3001/api/v1/health/ready >/dev/null 2>&1; then
    echo "==> API ready"
    exit 0
  fi
  sleep 2
done

echo "ERROR: API health check failed"
docker logs "$API_CONTAINER" --tail 80 || true
exit 1
