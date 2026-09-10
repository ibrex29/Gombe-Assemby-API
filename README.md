# Electromon API — National APC

NestJS API for **APC Nigeria 2027** (36 states + FCT).

| | |
|---|---|
| **Local URL** | http://localhost:3005 |
| **Swagger** | http://localhost:3005/docs |
| **Database** | `electromon_national` (Postgres via Docker) |
| **Web dashboard** | `electromon-web-national` on http://localhost:3004 |

---

## Prerequisites

- Node.js 18+ and **pnpm** (`corepack enable`)
- **Docker** (Postgres, Redis, RabbitMQ, MinIO)

---

## First time (one command)

```bash
cd electromon-api-national
make setup
make dev
```

`make setup` runs: install → `.env` → Docker infra → wait for Postgres → create DB → migrate → **demo seed** (~5 min).

For the **full INEC register** (~177k polling units, ~30+ min first run):

```bash
make setup-full
```

---

## Web (second terminal)

```bash
cd electromon-web-national
make setup
make dev
```

Open http://localhost:3004

Optional: add `NEXT_PUBLIC_MAPBOX_TOKEN=pk....` to web `.env` for Situation Room maps.

---

## Demo accounts

Login with **phone**. Director password: **`1234567890`**. Other seeded accounts: **`ChangeMe123!`**.

| Phone | Email | Role |
|-------|-------|------|
| `+2348000000001` | `director@electromon.ng` | Campaign director |
| `+2348000000002` | `pu.agent@electromon.ng` | Polling unit agent (FCT sample) |
| `+2348000000003` | `ward.coordinator@electromon.ng` | Ward coordinator (FCT) |
| `+2348000000004` | `lga.coordinator@electromon.ng` | LGA coordinator (FCT) |
| `+2348000000005` | `state.fc@electromon.ng` | State coordinator (FCT) |
| `+2348000000006` | `national.coordinator@electromon.ng` | National coordinator |

State coordinators: `state.{code}@electromon.ng` · phone `+23481{INEC}000001` (e.g. Lagos → `+2348124000001`).

---

## Useful commands

| Command | Purpose |
|---------|---------|
| `make setup` | First-time local (demo seed) |
| `make setup-full` | First-time + full INEC geography |
| `make dev` | Start API on :3005 |
| `make infra-up` / `make infra-down` | Start/stop Docker deps |
| `make db-seed` | Re-run full dev seed |
| `make db-seed-demo` | Re-run quick demo seed |
| `make db-seed-production-apc` | Production bootstrap (no fake results) |
| `make help` | All targets |

---

## Production deploy

```bash
make infra-deploy-prod
```

See [infra/DEPLOY.md](./infra/DEPLOY.md) for staging, Dokploy, and env details.
