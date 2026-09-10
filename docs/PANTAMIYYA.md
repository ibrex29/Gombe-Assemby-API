# Pantamiyya — Gombe-only API deployment

This branch deploys Electromon API scoped to **Gombe State (GO)** governorship tracking. It runs as a **fully isolated stack** — own Postgres, Redis, RabbitMQ, and MinIO — separate from the national A4A API.

## How it works

`DeploymentScopeService` locks all geo-scoped endpoints to one state:

- Default: **Gombe (`GO`)** when `DEPLOYMENT_STATE_CODE` is unset
- IReV election: **Gombe governorship** (`6407d9bfce35006e92156f2e`)

Verify after deploy:

```bash
curl -s http://127.0.0.1:5301/api/v1/health/live | jq .deployment
# → { "scoped": true, "deployment": "Pantamiyya", "stateCode": "GO", "electionType": "GOVERNORSHIP", ... }
```

## Isolated infrastructure

| Service | Pantamiyya | National (A4A) |
|---------|------------|----------------|
| Postgres DB | `electromon_pantamiyya` | `electromon` |
| Redis | `electromon-pantamiyya-redis` | `electromon-local-redis` |
| RabbitMQ | `electromon-pantamiyya-rabbitmq` | `electromon-local-rabbitmq` |
| MinIO bucket | `electromon-pantamiyya` | `electromon` |
| IReV queue | `irev.fetch.pantamiyya` | `irev.fetch` |
| Docker network | `electromon-pantamiyya` | `electromon-production` |
| API port | `:5301` | `:5300` |

No data is shared. Presidential IReV snapshots and national collation results do not appear in Pantamiyya.

## IReV elections (Gombe governorship + assembly)

```
IREV_ELECTION_ID=6407d9bfce35006e92156f2e
IREV_ELECTION_LABEL=Gombe Governorship Election
IREV_ELECTION_TYPE=GOVERNORSHIP
IREV_ASSEMBLY_ELECTION_ID=
IREV_ASSEMBLY_ELECTION_LABEL=Gombe State House of Assembly Election
```

Switch contests in the dashboard (`?contest=governorship|assembly`). Edit SHA ward lists in `db/prisma/gombe-sha-constituencies.ts`, then `pnpm --dir db sha:validate` and `pnpm --dir db sha:apply`.

After first deploy, run an IReV **catalog sweep** for Gombe wards (~2,988 PUs on the INEC portal).

## Deploy

1. Check out branch `Pantamiyya` locally and push to `origin`
2. On the droplet, **clone once** (not rsync):

```bash
cd ~
./Pantamiyya-API/infra/scripts/bootstrap-pantamiyya-droplet-git.sh
# or if no repo yet:
git clone -b Pantamiyya git@github.com:ibrex29/Asiwaju4Arewa-API.git Pantamiyya-API
cp infra/env/pantamiyya.env.example Pantamiyya-API/.env   # then edit secrets
```

3. First boot with seed:

```bash
PANTAMIYYA_RUN_SEED=true \
PANTAMIYYA_SEED_ADMIN_PASSWORD='your-strong-password' \
  ./infra/scripts/deploy-pantamiyya-droplet.sh
```

4. Routine updates:

```bash
cd ~/Pantamiyya-API
git pull origin Pantamiyya
./infra/scripts/deploy-pantamiyya-droplet.sh
```

The deploy script runs `git pull` automatically when `.git` exists (`PANTAMIYYA_GIT_PULL=false` to skip).

Seed creates:
- All Nigeria states/LGAs + **full Gombe** wards/PUs
- Campaign `pantamiyya-gombe-governorship`
- Director login (`PANTAMIYYA_SEED_ADMIN_EMAIL` / phone)

Local seed (without Docker):

```bash
SEED_DETAIL_STATES=GO pnpm db:seed:production:pantamiyya
```

## Public URL (nginx)

**https://api.pantamiyya.alphabetandnumbers.com** → host `:5301`

```bash
sudo cp infra/nginx/api.pantamiyya.alphabetandnumbers.com.conf \
  /etc/nginx/conf.d/api.pantamiyya.alphabetandnumbers.com.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.pantamiyya.alphabetandnumbers.com
```

## Reverting to national

Unset `DEPLOYMENT_STATE_CODE` **and** remove the `PANTAMIYYA_DEFAULT_STATE_CODE` default in `deployment-scope.service.ts` before running on the national stack.
