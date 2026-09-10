# Electromon API — Infrastructure

Docker Compose stack for the **API project**: PostgreSQL, Redis, RabbitMQ, MinIO, API, Caddy edge, and observability.

Run all commands from the **project root** (not from inside `infra/`).

**Full staging/prod playbook:** [DEPLOY.md](./DEPLOY.md)

---

## Quick start

### Without Docker for the API app (recommended)

```bash
cp infra/env/local.env.example .env
make infra-up          # start postgres, redis, rabbitmq, minio
make dev               # API on host :3001
```

### Full stack in Docker

```bash
cp infra/env/local.env.example .env
make infra-full        # deps + migrate + API container
```

---

## Compose profiles

| Makefile target | What runs |
|-----------------|-----------|
| `make infra-up` | `base.yml` + `local.yml` — **deps only** |
| `make infra-full` | deps + **migrate** + **api** container |
| `make infra-obs-up` | Prometheus, Grafana, Loki, … (local ports) |
| `make infra-staging-up` | Staging apps + **Caddy** + secure obs |
| `make infra-prod-up` | Production apps + **Caddy** + secure obs |
| `make infra-prod-external-up` | Managed Postgres/Spaces + redis/rabbitmq/api/caddy/obs |
| `make infra-backup` | `pg_dump` → `infra/backups/` |

---

## Services (local deps)

| Service | Host port | Notes |
|---------|-----------|--------|
| PostgreSQL | 5432 | `DATABASE_URL` in `.env` |
| Redis | 6379 | |
| RabbitMQ | 5672 | Management UI 15672 |
| MinIO (S3) | 9000 | Console 9001 |
| API (infra-full) | 3001 | NestJS in container |
| Grafana (obs) | 3030 | `admin` / `electromon` (change in staging/prod) |
| Prometheus (obs) | 9090 | |

Staging/production expose **only Caddy 80/443**. App ports stay on the Docker network.

---

## Layout

```
infra/
├── compose/
│   ├── base.yml
│   ├── local.yml / local.full.yml
│   ├── apps.yml
│   ├── edge.yml                 # Caddy TLS reverse proxy
│   ├── observability.yml
│   ├── observability.local.yml
│   ├── observability.secure.yml
│   ├── staging.yml / production.yml
│   ├── production.external.yml
│   └── dokploy.yml              # Dokploy: full stack including api (no Caddy)
├── caddy/Caddyfile
├── dockerfiles/
├── observability/
├── scripts/                     # migrate, deploy, backup, restore
├── backups/
├── env/
└── DEPLOY.md
```

---

## Environment

```bash
make env    # copies infra/env/local.env.example → .env
```

Templates: `local` · `staging` · `production` under `infra/env/`.

---

## Migrations in Docker

```bash
make infra-migrate     # run migrate service once
```

Migrate waits on the **host parsed from `DATABASE_URL`** (works for managed Postgres).

On host (typical dev):

```bash
pnpm db:migrate:deploy
pnpm db:seed                 # demo only
pnpm db:seed:production:apc  # production APC bootstrap
```

---

## Observability

```bash
make infra-up && make dev
make infra-obs-up
```

- Grafana: http://localhost:3030
- Prometheus: http://localhost:9090
- Slack: set `ALERT_SLACK_WEBHOOK_URL` in `.env`

Staging/prod: Grafana on `127.0.0.1` only — use an SSH tunnel.

---

## Web pairing

Start API staging/prod first (creates `COMPOSE_NETWORK_NAME`), then in **electromon-web**:

```bash
make infra-staging-up   # or infra-prod-up
```

Caddy on the API host terminates TLS for both `WEB_HOST` and `API_HOST`.
