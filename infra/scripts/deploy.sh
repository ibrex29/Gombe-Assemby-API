#!/usr/bin/env bash
# Deploy API stack on a host that already has Docker + .env configured.
#
# Usage:
#   ENV=staging ./infra/scripts/deploy.sh
#   ENV=production ./infra/scripts/deploy.sh
#   ENV=production EXTERNAL=1 ./infra/scripts/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_NAME="${ENV:-staging}"
EXTERNAL="${EXTERNAL:-0}"

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing. Copy infra/env/${ENV_NAME}.env.example and fill secrets."
  exit 1
fi

chmod +x infra/scripts/*.sh
set -a
# shellcheck disable=SC1091
source .env
set +a

case "$ENV_NAME" in
  staging)
    COMPOSE=(docker compose --project-directory .
      -f infra/compose/base.yml
      -f infra/compose/staging.yml
      -f infra/compose/apps.yml
      -f infra/compose/edge.yml
      -f infra/compose/observability.yml
      -f infra/compose/observability.secure.yml
      --profile apps --profile edge --profile observability)
    EXTRA_ARGS=()
    API_CONTAINER=electromon-staging-api
    ;;
  production|prod)
    ENV_NAME=production
    if [[ "$EXTERNAL" == "1" ]]; then
      COMPOSE=(docker compose --project-directory .
        -f infra/compose/base.yml
        -f infra/compose/production.yml
        -f infra/compose/production.external.yml
        -f infra/compose/apps.yml
        -f infra/compose/edge.yml
        -f infra/compose/observability.yml
        -f infra/compose/observability.secure.yml
        --profile apps --profile edge --profile observability)
      EXTRA_ARGS=(redis rabbitmq migrate api caddy prometheus alertmanager loki promtail grafana redis-exporter)
    else
      COMPOSE=(docker compose --project-directory .
        -f infra/compose/base.yml
        -f infra/compose/production.yml
        -f infra/compose/apps.yml
        -f infra/compose/edge.yml
        -f infra/compose/observability.yml
        -f infra/compose/observability.secure.yml
        --profile apps --profile edge --profile observability)
      EXTRA_ARGS=()
    fi
    API_CONTAINER=electromon-prod-api
    ;;
  *)
    echo "ERROR: ENV must be staging or production"
    exit 1
    ;;
esac

echo "==> Deploying API (${ENV_NAME})..."
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  "${COMPOSE[@]}" up -d --build --remove-orphans "${EXTRA_ARGS[@]}"
else
  "${COMPOSE[@]}" up -d --build --remove-orphans
fi

echo "==> Waiting for API health (${API_CONTAINER})..."
for i in $(seq 1 45); do
  if docker exec "$API_CONTAINER" wget -qO- http://localhost:3001/api/v1/health/ready >/dev/null 2>&1; then
    echo "==> API ready"
    exit 0
  fi
  sleep 2
done

echo "ERROR: API health check failed"
docker logs "$API_CONTAINER" --tail 80 || true
exit 1
