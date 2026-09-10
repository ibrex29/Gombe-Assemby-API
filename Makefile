.PHONY: help install setup setup-full env dev build test test-e2e test-cov \
        infra-up infra-down infra-logs infra-ps infra-full infra-full-down \
        infra-obs-up infra-obs-down infra-staging-up infra-staging-down \
        infra-prod-up infra-prod-down infra-prod-external-up \
        infra-migrate infra-reset infra-backup infra-deploy-staging infra-deploy-prod \
        db-wait db-ensure db-generate db-migrate db-migrate-deploy db-seed db-seed-demo db-seed-production-apc db-ai-role db-studio db-reset

PNPM := COREPACK_ENABLE_STRICT=0 pnpm
# --project-directory . loads repo-root .env (COMPOSE_PROJECT_NAME, secrets, etc.)
DOCKER := docker compose --project-directory .

POSTGRES_CONTAINER ?= electromon-local-postgres
POSTGRES_USER ?= electromon
POSTGRES_DB ?= electromon_national

COMPOSE_LOCAL      := -f infra/compose/base.yml -f infra/compose/local.yml
COMPOSE_FULL       := $(COMPOSE_LOCAL) -f infra/compose/local.full.yml -f infra/compose/apps.yml --profile apps
COMPOSE_OBS        := $(COMPOSE_LOCAL) -f infra/compose/observability.yml -f infra/compose/observability.local.yml --profile observability
OBS_SERVICES       := prometheus alertmanager loki promtail grafana redis-exporter postgres-exporter
COMPOSE_STAGING    := -f infra/compose/base.yml -f infra/compose/staging.yml \
	-f infra/compose/apps.yml -f infra/compose/edge.yml \
	-f infra/compose/observability.yml -f infra/compose/observability.secure.yml \
	--profile apps --profile edge --profile observability
COMPOSE_PROD       := -f infra/compose/base.yml -f infra/compose/production.yml \
	-f infra/compose/apps.yml -f infra/compose/edge.yml \
	-f infra/compose/observability.yml -f infra/compose/observability.secure.yml \
	--profile apps --profile edge --profile observability
COMPOSE_PROD_EXT   := -f infra/compose/base.yml -f infra/compose/production.yml \
	-f infra/compose/production.external.yml -f infra/compose/apps.yml \
	-f infra/compose/edge.yml \
	-f infra/compose/observability.yml -f infra/compose/observability.secure.yml \
	--profile apps --profile edge --profile observability

help:
	@echo "Electromon API — National APC"
	@echo ""
	@echo "  make setup                     First-time local setup (demo seed, ~5 min)"
	@echo "  make setup-full                First-time + full INEC register (~177k PUs)"
	@echo "  make dev                       Start API on host (:3005)"
	@echo "  make infra-up                  Start Postgres, Redis, RabbitMQ, MinIO"
	@echo "  make infra-full                Run API + deps fully in Docker"
	@echo "  make infra-staging-up          Staging: apps + Caddy edge + obs"
	@echo "  make infra-prod-up             Production: apps + Caddy edge + obs"
	@echo "  make infra-prod-external-up    Prod with managed Postgres/Spaces"
	@echo "  make infra-backup              pg_dump → infra/backups/"
	@echo "  make infra-deploy-staging      Deploy script (staging)"
	@echo "  make infra-deploy-prod         Deploy script (production)"
	@echo "  make db-seed                   Full dev seed (all states, all PUs)"
	@echo "  make db-seed-demo              Quick demo seed (FCT + Lagos + Kano)"
	@echo "  make db-ai-role                Enable AI read-only Postgres login"
	@echo "  make db-seed-production-apc    Production APC bootstrap"

install:
	$(PNPM) install

env:
	@test -f .env || cp infra/env/local.env.example .env
	@cp .env db/.env 2>/dev/null || true
	@chmod +x infra/scripts/*.sh

# First-time local: deps + schema + demo data (FCT/Lagos/Kano + mature demo heatmap)
setup: install env infra-up db-wait db-ensure db-generate db-migrate-deploy db-seed-demo
	@echo ""
	@echo "==> API setup complete."
	@echo "    Start API:  make dev  →  http://localhost:3005"
	@echo "    Swagger:    http://localhost:3005/docs"
	@echo "    Login:      +2348000000001 / 1234567890"
	@echo "    Full INEC:  make setup-full  (or make db-seed after setup)"

# First-time with complete Nigeria polling-unit register (~30+ min first run)
setup-full: install env infra-up db-wait db-ensure db-generate db-migrate-deploy db-seed
	@echo ""
	@echo "==> API setup complete (full INEC register)."
	@echo "    Start API:  make dev  →  http://localhost:3005"

dev:
	$(PNPM) dev

build:
	$(PNPM) build

test:
	$(PNPM) test

test-e2e:
	$(PNPM) test:e2e

test-cov:
	$(PNPM) test:cov

infra-up:
	@chmod +x infra/scripts/*.sh
	@test -f .env || cp infra/env/local.env.example .env
	$(DOCKER) $(COMPOSE_LOCAL) up -d

infra-down:
	$(DOCKER) $(COMPOSE_LOCAL) down

infra-logs:
	$(DOCKER) $(COMPOSE_LOCAL) logs -f

infra-ps:
	$(DOCKER) $(COMPOSE_LOCAL) ps

infra-full:
	@chmod +x infra/scripts/*.sh
	$(DOCKER) $(COMPOSE_FULL) up -d --build

infra-full-down:
	$(DOCKER) $(COMPOSE_FULL) down

infra-obs-up:
	$(DOCKER) $(COMPOSE_OBS) up -d $(OBS_SERVICES)

infra-obs-down:
	$(DOCKER) $(COMPOSE_OBS) stop $(OBS_SERVICES)
	$(DOCKER) $(COMPOSE_OBS) rm -f $(OBS_SERVICES)

infra-staging-up:
	@chmod +x infra/scripts/*.sh
	$(DOCKER) $(COMPOSE_STAGING) up -d --build

infra-staging-down:
	$(DOCKER) $(COMPOSE_STAGING) down

infra-prod-up:
	@chmod +x infra/scripts/*.sh
	$(DOCKER) $(COMPOSE_PROD) up -d --build

infra-prod-down:
	$(DOCKER) $(COMPOSE_PROD) down

infra-prod-external-up:
	@chmod +x infra/scripts/*.sh
	$(DOCKER) $(COMPOSE_PROD_EXT) up -d --build redis rabbitmq migrate api caddy \
		prometheus alertmanager loki promtail grafana redis-exporter

infra-migrate:
	$(DOCKER) -f infra/compose/base.yml -f infra/compose/local.yml -f infra/compose/apps.yml --profile apps run --rm migrate

infra-backup:
	@chmod +x infra/scripts/backup-postgres.sh
	./infra/scripts/backup-postgres.sh

infra-deploy-staging:
	@chmod +x infra/scripts/deploy.sh
	ENV=staging ./infra/scripts/deploy.sh

infra-deploy-prod:
	@chmod +x infra/scripts/deploy.sh
	ENV=production ./infra/scripts/deploy.sh

db-wait:
	@echo "==> Waiting for Postgres ($(POSTGRES_CONTAINER))..."
	@for i in $$(seq 1 45); do \
		docker exec $(POSTGRES_CONTAINER) pg_isready -U $(POSTGRES_USER) >/dev/null 2>&1 && exit 0; \
		sleep 2; \
	done; \
	echo "ERROR: Postgres not ready. Check: docker ps | grep postgres"; exit 1

db-ensure:
	@echo "==> Ensuring database $(POSTGRES_DB) exists..."
	@docker exec $(POSTGRES_CONTAINER) psql -U $(POSTGRES_USER) -d postgres -tc \
		"SELECT 1 FROM pg_database WHERE datname = '$(POSTGRES_DB)'" | grep -q 1 \
		|| docker exec $(POSTGRES_CONTAINER) psql -U $(POSTGRES_USER) -d postgres \
		-c "CREATE DATABASE $(POSTGRES_DB);"
	@docker exec $(POSTGRES_CONTAINER) psql -U $(POSTGRES_USER) -d $(POSTGRES_DB) -c \
		"CREATE EXTENSION IF NOT EXISTS postgis;" >/dev/null 2>&1 || true

infra-reset:
	-$(DOCKER) $(COMPOSE_FULL) down -v --remove-orphans
	-$(DOCKER) $(COMPOSE_LOCAL) down -v --remove-orphans
	@for c in $$(docker ps -aq --filter name=electromon-local-); do docker rm -f $$c 2>/dev/null || true; done

db-generate:
	$(PNPM) db:generate

db-migrate:
	$(PNPM) db:migrate

db-migrate-deploy:
	$(PNPM) db:migrate:deploy

db-seed:
	$(PNPM) db:seed

db-seed-demo:
	$(PNPM) db:seed:demo

# Production APC bootstrap (geography + campaign + director). Requires SEED_ADMIN_PASSWORD.
# Does not invent collation results, incidents, or demo agents.
db-seed-production-apc:
	$(PNPM) db:seed:production:apc

# After migrate: grant LOGIN to electromon_ai_readonly (role created by migration).
# Requires AI_READONLY_DB_PASSWORD.
db-ai-role:
	@chmod +x infra/scripts/setup-ai-readonly.sh
	./infra/scripts/setup-ai-readonly.sh

db-studio:
	$(PNPM) db:studio

db-reset:
	cd db && $(PNPM) exec prisma migrate reset --force
