# Electromon deployment playbook

One path for **local**, **staging**, and **production**. API and web are separate repos that share a Docker network and a Caddy edge on the API host.

---

## Architecture

```
Internet → Caddy (:80/:443)
              ├─ WEB_HOST  → web:3000
              └─ API_HOST  → api:3001
Deps: Postgres · Redis · RabbitMQ · MinIO (or managed Postgres + Spaces)
Obs: Prometheus · Grafana (loopback) · Loki · Alertmanager → Slack
```

Shared network name: `COMPOSE_NETWORK_NAME` (e.g. `electromon-staging`).

---

## Dokploy

`infra/compose/base.yml` is **deps only** (Postgres, Redis, RabbitMQ, MinIO). The Nest API is not in that file, so Dokploy cannot attach a domain to it.

Use the single-file stack instead:

1. Compose service → Compose file: **`infra/compose/dokploy.yml`**
2. Isolated Deployments: **On**
3. **Advanced → Command: delete any custom command** (do not use `base.yml` + `production.yml` + `--profile apps`). That command interpolates `${JWT_ACCESS_SECRET:?}` before Dokploy’s `.env` is loaded and the deploy fails.
4. Environment: paste `infra/env/dokploy.env.example` with real secrets. You **must** set `DATABASE_URL`, `RABBITMQ_DEFAULT_PASS` (same as `RABBITMQ_PASSWORD`), and `MINIO_ROOT_PASSWORD` (same as `S3_SECRET_KEY`).
5. Domains → Add Domain → service **`api`**, container port **`3002`**, HTTPS on
6. Do not deploy `edge.yml` / Caddy on the same host (Traefik already binds 80/443)

Services in that file: `postgres`, `redis`, `rabbitmq`, `minio`, `minio-init`, `migrate`, **`api`**.

---

## Local (developer laptop)

```bash
# API
cd electromon-api
cp infra/env/local.env.example .env
make setup          # deps + migrate + demo seed
make dev            # :3001

# Web
cd electromon-web
cp infra/env/local.env.example .env
make dev            # :3000
```

Optional full Docker API: `make infra-full`  
Optional obs: `make infra-obs-up` → Grafana http://localhost:3030

---

## Staging (first-time host setup)

1. DNS: `staging.electromon.ng` + `api-staging.electromon.ng` → VPS
2. Open only **80/443** (and 22 for SSH). Do not expose 3000/3001/5432.
3. On the host:

```bash
# API
cd /opt/electromon-api
cp infra/env/staging.env.example .env
# fill every CHANGE_ME_* — JWT, METRICS_TOKEN, GRAFANA_PASSWORD, DB passwords
make infra-staging-up

# Web (same host; joins COMPOSE_NETWORK_NAME)
cd /opt/electromon-web
cp infra/env/staging.env.example .env
make infra-staging-up
```

4. Smoke: `curl -fsS https://api-staging.electromon.ng/api/v1/health/ready`

Or: `ENV=staging ./infra/scripts/deploy.sh` from the API repo after `.env` is ready.

---

## Production

```bash
cd /opt/electromon-api
cp infra/env/production.env.example .env
# set secrets, WEB_HOST=app.electromon.ng, API_HOST=api.electromon.ng

# Self-hosted Postgres + MinIO:
make infra-prod-up

# Managed Postgres + Spaces:
# set DATABASE_URL + Spaces keys, then:
make infra-prod-external-up

# One-time APC bootstrap (no demo results):
SEED_ADMIN_PASSWORD='...' pnpm db:seed:production:apc

cd /opt/electromon-web
cp infra/env/production.env.example .env
make infra-prod-up
```

---

## CI/CD (GitHub Actions)

| Workflow | Trigger | Action |
|----------|---------|--------|
| `ci.yml` | PR / push | lint + test + build |
| `publish.yml` | main / tags | push images to GHCR |
| `deploy-staging.yml` | after publish | SSH → `deploy.sh` / `make infra-staging-up` |
| `deploy-production.yml` | `v*` tags | SSH → production deploy |

### Required GitHub secrets

**API & web (per environment):**

- `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_KEY`
- `STAGING_API_PATH` / `STAGING_WEB_PATH`
- `PRODUCTION_HOST`, `PRODUCTION_USER`, `PRODUCTION_SSH_KEY`
- `PRODUCTION_API_PATH` / `PRODUCTION_WEB_PATH`

**Web publish vars (optional):** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`

Create GitHub Environments `staging` and `production` with protection rules for prod.

---

## Backups

```bash
make infra-backup
# → infra/backups/electromon-YYYYMMDDTHHMMSSZ.sql.gz

./infra/scripts/restore-postgres.sh infra/backups/electromon-….sql.gz
```

Cron example (daily 02:15 UTC):

```cron
15 2 * * * cd /opt/electromon-api && ./infra/scripts/backup-postgres.sh >> /var/log/electromon-backup.log 2>&1
```

Restore drill: restore into a scratch DB quarterly; document RTO/RPO.

For managed Postgres, prefer provider automated backups + the script as an extra dump.

---

## Observability

- Grafana: SSH tunnel `ssh -L 3030:127.0.0.1:3030 user@host` → http://127.0.0.1:3030
- Set `ALERT_SLACK_WEBHOOK_URL` for Slack paging
- Set `METRICS_TOKEN` (required in staging/prod); Prometheus sends it as Bearer

---

## Secrets hygiene (do this once)

API `.gitignore` previously allowed `.env` to be tracked. After pulling these changes:

```bash
cd electromon-api
git rm --cached .env db/.env 2>/dev/null || true
# rotate every secret that was ever committed (JWT, DB, S3, etc.)
# commit the gitignore + index update
```

Never commit `.env`. Use `*.env.example` only.

---

## Rollback

1. `git checkout <previous-tag>`
2. Re-run `ENV=production ./infra/scripts/deploy.sh` (API) and `make infra-prod-up` (web)
3. If a bad migration shipped: restore DB backup, then redeploy last known-good tag

---

## Checklist before election day

- [ ] DNS + TLS green on web + API hosts
- [ ] `METRICS_TOKEN` + Grafana password set
- [ ] Slack alerts firing (test alert)
- [ ] Backup cron verified; restore drill done
- [ ] `RUN_SEED=false` in production
- [ ] APC production seed applied once
- [ ] Only 80/443/22 open on firewall
