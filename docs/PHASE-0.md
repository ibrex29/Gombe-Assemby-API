# Phase 0 — Foundation (Completed)

Electromon Phase 0 established the project foundation: database schema, authentication, core API endpoints, and the web dashboard shell.

**Status:** Complete  
**Date:** July 2026

> **Note:** Electromon is now **two independent Git repos** (API + web). This document describes the API repo; see [electromon-web](https://github.com/ibrex29/electromon-web) for the dashboard.

---

## Summary

Phase 0 took the project from an empty git repository to a working local development environment with:

- NestJS API + Next.js 16 frontend (now in `electromon-api/` and `electromon-web/`)
- Dockerized local infrastructure (Postgres/PostGIS, Redis, RabbitMQ, MinIO) in `infra/`
- Prisma 7.9.0 with a complete MVP database schema
- JWT authentication with RBAC guards
- Campaign and geographic structure APIs
- A login page and dashboard shell for all 9 MVP modules
- Makefile and documented setup workflow

---

## 1. Project structure (current)

```
Electromon/
├── electromon-api/                      Backend (NestJS + Prisma)
│   ├── src/                  NestJS application
│   ├── db/                   Prisma schema, migrations, seed
│   ├── shared/               Enums & types
│   ├── infra/                Docker Compose + observability
│   ├── test/
│   ├── Makefile
│   └── package.json
├── electromon-web/                      Frontend (Next.js)
│   ├── src/
│   ├── infra/                Web Docker deployment
│   ├── Makefile
│   └── package.json
├── docs/                     Documentation
├── Makefile                  Root shortcuts
└── README.md
```

### Package names

| Project | Package name | Purpose |
|---------|--------------|---------|
| API | `electromon-api` | NestJS backend |
| Web | `electromon-web` | Next.js frontend |
| DB (local) | `@electromon/db` | Prisma client (`db/`, `file:./db`) |
| Shared (local) | `@electromon/shared` | API enums/types (`shared/`) |

---

## 2. Commands (current)

Run from **`electromon-api/`** unless noted:

| Command | Description |
|---------|-------------|
| `make setup` (root) | Full first-time setup |
| `make dev` (root) | Start API + Web on host |
| `make infra-local-up` | Start Postgres, Redis, RabbitMQ, MinIO (alias: `make infra-up`) |
| `make dev` | Start NestJS on :3001 |
| `cd electromon-web && make dev` | Start Next.js on :3000 |
| `pnpm db:migrate` | Run Prisma migrate dev |
| `pnpm db:seed` | Seed Jigawa campaign data |
| `pnpm db:studio` | Open Prisma Studio |

---

## 3. Technology stack (implemented)

| Layer | Technology | Status |
|-------|-----------|--------|
| Frontend | Next.js 16 + TypeScript + Tailwind CSS 4 | ✅ |
| Backend | NestJS 11 + TypeScript | ✅ |
| Database | PostgreSQL 16 + PostGIS (Docker) | ✅ |
| ORM | Prisma 7.9 (`prisma-client-js`) | ✅ |
| DB adapter | `@prisma/adapter-pg` + `pg` | ✅ |
| Cache | Redis 7 | ✅ |
| Queue | RabbitMQ 3 | ✅ |
| Storage | MinIO (S3-compatible) | ✅ |
| Auth | JWT (access + refresh) + RBAC guards | ✅ |
| API docs | Swagger at `/docs` | ✅ |
| Realtime | Socket.IO | ⏳ Phase 3 |
| Maps | Leaflet / Mapbox | ⏳ Phase 2 |

---

## 4. Local infrastructure (`infra/`)

| Service | Image | Port | Credentials |
|---------|-------|------|-------------|
| PostgreSQL + PostGIS | `postgis/postgis:16-3.4` | 5432 | `electromon` / `electromon` |
| Redis | `redis:7-alpine` | 6379 | — |
| RabbitMQ | `rabbitmq:3-management-alpine` | 5672, 15672 | `electromon` / `electromon` |
| MinIO | `minio/minio` | 9000, 9001 | `electromon` / `electromonsecret` |

Start with: `make infra-up`

---

## 5. Database schema

### Migration

- `20260726012355_init` — initial schema for all MVP modules

### Models (22 tables)

**Auth & users:** `User`, `RefreshToken`, `ActivityLog`, `CampaignInvitation`

**Campaign:** `Campaign`, `CampaignMembership`

**Geographic hierarchy:** `State` → `SenatorialDistrict` → `LGA` → `Ward` → `PollingUnit`

**MVP modules:** `SupportGroup`, `Commitment`, `CommitmentProgress`, `Volunteer`, `VolunteerAssignment`, `VolunteerTask`, `FieldReport`, `SituationUpdate`

### Seed data

| Data | Count |
|------|-------|
| Nigerian states | 37 |
| Jigawa senatorial districts | 4 |
| Jigawa LGAs | 27 |
| Sample ward | Hadejia Ward A |
| Sample polling unit | JI-HD-001 |
| Campaign | Jigawa State Campaign 2027 |
| Default user | Campaign Director |

**Default login:** `+2348000000001` / `1234567890`

---

## 6. Backend API (`src/`)

### Layout

```
src/
├── main.ts
├── app.module.ts
├── common/                   Prisma, Redis, guards, audit, metrics
└── modules/
    ├── auth/
    ├── campaign/
    └── structure/            Phase 0 core modules
```

Phase 1+ modules (support-groups, commitments, volunteers, polling-units, situation-room, field-reports, analytics) were added after Phase 0 — see [API.md](./API.md).

### Global middleware & guards

- `JwtAuthGuard` — protects all routes by default; `@Public()` opts out
- `RolesGuard` — enforces `@Roles()` decorator
- `ThrottlerGuard` — rate limiting (100 req/min)
- `ValidationPipe` — DTO validation

### Phase 0 endpoints

Documented in [API.md](./API.md): Auth, Campaigns, Structure.

Swagger: http://localhost:3001/docs

---

## 7. Frontend (`web repo: src/`)

### Phase 0 pages

| Route | Phase 0 status |
|-------|----------------|
| `/` | Redirect to login |
| `/login` | Functional |
| `/dashboard` | Shell with KPI placeholders |

Subsequent phases added full CRUD UIs for support groups, commitments, volunteers, polling units, situation room, and analytics.

### UI features

- Dark theme (slate/green campaign branding)
- Sidebar navigation for all MVP modules
- JWT stored in `localStorage`
- API client in `web repo: src/lib/api.ts`

---

## 8. Shared types (`shared/`)

Enums and types used by the API. The web app defines matching unions locally in `web repo: src/lib/` — there is no cross-project npm package.

---

## 9. Prisma configuration (`db/`)

| File | Purpose |
|------|---------|
| `db/prisma.config.ts` | Database URL, migrations path, seed command |
| `db/prisma/schema.prisma` | Schema definition |
| `db/src/client.ts` | `createPgAdapter()` — PostgreSQL driver adapter |
| `db/dist/` | Compiled CommonJS output (gitignored) |

The API dev script builds `db/` automatically. Manual rebuild:

```bash
pnpm db:generate && pnpm db:build
```

---

## 10. Environment variables

Copy templates:

```bash
make env                    # from this repo
# or
cp infra/env/local.env.example .env
cd electromon-web && cp infra/env/local.env.example .env
```

| Variable | Project | Default | Description |
|----------|---------|---------|-------------|
| `DATABASE_URL` | api | `postgresql://electromon:...@localhost:5432/electromon` | Postgres |
| `JWT_ACCESS_SECRET` | api | (change in prod) | JWT signing |
| `API_PORT` | api | `3001` | NestJS port |
| `CORS_ORIGIN` | api | `http://localhost:3000` | Allowed frontend |
| `NEXT_PUBLIC_API_URL` | web | `http://localhost:3001` | Frontend API base |

---

## 11. Verified working flow

1. `make setup` — install, infra, migrate, seed
2. `make dev` — API on `:3001`, Web on `:3000`
3. Login at http://localhost:3000/login
4. Dashboard loads with live KPIs from analytics API

---

## 12. Known limitations (carried forward)

| Item | Notes |
|------|-------|
| MFA (TOTP) | Schema ready; not implemented |
| Scope guard | Geographic scoping partial in services |
| RabbitMQ consumers | Infrastructure ready; no consumers |
| S3 uploads | MinIO ready; presigned URL service pending |
| Socket.IO | Planned for Phase 3 |
| PostGIS spatial queries | Lat/lng as Float; spatial queries in Phase 2 |

---

## Quick reference

```bash
# First time
make setup

# Daily dev
make infra-up    # if not running
make dev                   # from this repo

# URLs
open http://localhost:3000          # Web
open http://localhost:3001/docs     # Swagger
open http://localhost:15672         # RabbitMQ
open http://localhost:9001          # MinIO
```
