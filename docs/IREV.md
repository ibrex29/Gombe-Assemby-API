# IReV comparison module

Electromon compares **campaign agent captures** against **official INEC IReV (Result Viewing) scans** so operators can see where figures align, where INEC has published before agents reported, and where numbers diverge.

This module is **national-scale**: it works across all states, LGAs, wards, and polling units in the register.

**Product name in the app:** Command Center → **IReV QA**.

**Election-night job:** given ~176k polling units, *where should the next human look, how many of our votes are in dispute, and what evidence do they need in 60 seconds?* That loop is **IReV Attention**. It ranks review flags. It is not a fraud finding, a trust score, or a race forecast.

---

## What it does

| Layer | What it measures | Source |
|-------|------------------|--------|
| **Portal coverage** | How many PUs INEC has uploaded nationally | Live IReV API (`/result/stats`) |
| **Agent coverage** | How many PUs your field network has submitted | `collation_results` (PU level) |
| **PU reconciliation** | Same PU: agent figures vs official scan | Local fetch + OCR on IReV document |
| **Attention** | Which disagreements to look at first, and how many client-party votes sit in those gaps | `irevVerification` + `irev-attention.ts` |

These are **not the same metric**. Portal upload totals (e.g. 167k nationwide) must not be subtracted from agent totals (e.g. 432) to infer “gaps”. PU-level overlap only exists after we fetch and compare individual units.

---

## End-to-end flow

```
Agent submits PU result
        │
        ▼
CollationService emits irev.fetch job (RabbitMQ)
        │
        ▼
IrevFetchWorker
  1. Map ward → IReV geography (IrevGeoMapping / name match)
  2. Fetch ward PU list from IReV API
  3. Catalog every PU in that ward (document URL + hash → IrevPuSnapshot)
  4. Match local PU code → IReV document URL
  5. OCR the scan only when an agent result exists
  6. compareAgentToIrev() → write CollationResult.irevVerification JSON
     (status, diffs, OCR confidence, client-party gap, severity)
        │
        ▼
UI surfaces
  Brief  — votes in dispute, wards to look at, largest PU gaps
  Queue  — ranked evidence pack (agent sheet vs official scan)
  Map    — state choropleth
  Situation Room briefing strip + grounded assistant tool
```

Background **catalog crawl** (`IrevSweepService.enqueueCatalogBatch`) walks all wards on a timer and stores official document URLs even when no agent has submitted. That is what fills **INEC only**. OCR is not run for those rows until there is an agent capture (or a later compare job).

Manual re-check: `POST /irev/refresh/:resultId` re-queues a forced fetch for one PU. `POST /irev/refresh-pending` also catalogs the current geo scope (ward / LGA / a batch of the state).

---

## API surface

Base path: `/api/v1/irev` (JWT required).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/command-center` | Brief + ranked queue, geo drill-down, portal stats, attention payload |
| `GET` | `/pu/:pollingUnitId` | Snapshot + verification for one PU |
| `POST` | `/refresh/:resultId` | Force re-fetch and re-verify a submitted PU result |
| `POST` | `/refresh-pending` | Queue pending checks (and catalog) in the current geo scope |

### Command center query params

| Param | Description |
|-------|-------------|
| `view` | `overview` (director brief) or `triage` (ranked PU queue / geo drill-down) |
| `stateId`, `lgaId`, `wardId` | Geo scope for drill-down |
| `search` | PU / ward / LGA / state text search (jumps to PU results) |
| `status` | Queue filter: `INVESTIGATE`, `REPLACED`, `MATCH`, `MISMATCH`, `INEC_ONLY`, `CAMPAIGN_ONLY`, etc. |
| `page`, `limit` | PU queue pagination (when at ward level, searching, or `view=triage`) |

### Overview attention payload

`GET /command-center?view=overview` includes (in addition to corpus / portal race / state grid):

| Field | Meaning |
|-------|---------|
| `clientPartyCode` | Campaign party used for votes-in-dispute |
| `votesAtRisk` | Client-party votes where the **agent recorded more** than IReV, plus replaced-scan counts and the largest PU gaps |
| `clusters` | Top 8 wards ranked by votes in dispute, then replacements. Each has a one-line `headline` |
| `feed` | Last 20 minutes: new official scans, material mismatches, replacements, newly aligned |

Race analytics (`CollationBrowseService` Situation Room summary) exposes the same numbers as `summary.irevAttention`.

The grounded assistant tool `get_irev_attention` returns that brief. Language in the tool and UI: **review flags, not findings**.

### Geo navigation (`geoNav` in response)

Triage browse levels:

1. **State** — all states (national users)
2. **LGA** — LGAs in selected state
3. **Ward** — wards in selected LGA
4. **PU** — ranked queue + evidence inspector

At state/LGA/ward levels the API returns aggregate metrics per area. The PU queue loads at ward level, when `search` is set, or when `view=triage`.

---

## Verification model

Stored on `CollationResult.irevVerification` (JSON).

### Status

| Status | Meaning |
|--------|---------|
| `MATCH` | Agent figures align with OCR’d IReV scan |
| `MISMATCH` | Figures differ — investigate. UI chip: **IReV mismatch** |
| `IREV_MISSING` | No document on IReV for this PU yet |
| `PENDING` | Fetch or comparison in progress |
| `UNREADABLE` | Document exists but OCR could not extract figures |
| `REPLACED` | IReV published a different scan after we already read one — investigate even if the new sheet matches the agent |

### Recommendation

| Value | Typical action |
|-------|----------------|
| `ALIGNED` | No action |
| `INVESTIGATE` | Ward/LGA officer reviews both sheets |
| `WAIT_IREV` | INEC has not published; check again later |

Diffs are field-level (`votesCast`, `party:APC`, etc.) and power the side-by-side panel in the web UI.

### Attention fields on the JSON

`compareAgentToIrev()` also persists:

| Field | Meaning |
|-------|---------|
| `ocrConfidence` | Vision confidence for this extract (0–1) |
| `clientPartyCode` | Campaign party |
| `clientPartyAgent` / `clientPartyIrev` | That party’s votes on each sheet |
| `clientPartyDelta` | Agent minus IReV (internal). UI must **not** label this “delta” |
| `votesCastDelta` | Agent minus IReV valid votes |
| `material` | True if the party gap is ≥ 5 **or** valid-vote gap is ≥ 10 |
| `severity` | Rank key used to sort the queue |

Old rows without these fields are backfilled on read by `attachAttention()`.

### Attention ranking

The queue is ranked for election night, not by status chip alone. A 2-vote accredited mismatch is not a hold sheet.

Severity, high to low (`src/modules/irev/irev-attention.ts`):

1. `REPLACED_MATERIAL` — official scan replaced **and** a material client-party or valid-vote gap
2. `MISMATCH_HIGH_CONF` — material gap, OCR confidence ≥ 0.75
3. `REPLACED` — scan replaced, gap not material
4. `MISMATCH_LOW_CONF` — material gap, OCR weaker (likely OCR noise — still review)
5. `UNREADABLE`
6. `MISMATCH_IMMATERIAL`
7. `AWAITING` (`PENDING` / `IREV_MISSING`)
8. `ALIGNED`

Within a severity, larger absolute client-party gap sorts first.

**Votes in dispute** (`votesAtRisk`) sums only **positive** client-party gaps (agent higher than IReV) on comparable PUs. The other direction is `votesAgainst`. Both are review flags, not a finding of wrongdoing.

Template copy (`explainIrevAttention`) speaks in sheets, not “delta”: *Agent recorded X APC votes. Official scan shows Y. Official scan shows Z more than the agent.* Relative publish times are omitted when they span more than 48 hours (bad IReV timestamps).

---

## Database

| Model | Role |
|-------|------|
| `IrevElectionConfig` | Per-campaign IReV election ID and sync metadata |
| `IrevGeoMapping` | Ward → IReV ward/LGA/state IDs; `lastCatalogedAt` for the catalog crawl |
| `IrevPuSnapshot` | Cached IReV document URL, OCR extract, fetch status |
| `IrevScanRevision` | Previous official scan when INEC replaces a document |
| `CollationResult.irevVerification` | Comparison outcome attached to agent submission (includes attention fields) |
| `CollationResult.irevVerifiedAt` | Last verification timestamp |

Migrations: `20260830120000_irev_comparison`, `20260901010000_irev_scan_revisions`, `20260901130000_irev_ward_catalog`. Attention ranking did **not** need a new table — it rides on `irevVerification` JSON.

---

## Module layout (`src/modules/irev/`)

| File | Responsibility |
|------|----------------|
| `irev.client.ts` | HTTP client for IReV API; portal stats; API base discovery/fallback |
| `irev-official-stats.service.ts` | National portal race; state pro-rata estimates from national totals |
| `irev-attention.ts` | Severity, votes in dispute, ward clusters, 20-minute feed, explanations |
| `irev-command-center.service.ts` | Brief corpus, geo grids, ranked queue, `votesAtRisk` / `clusters` / `feed` |
| `irev-fetch.worker.ts` | Async fetch + OCR + verify pipeline (passes `campaign.clientPartyCode`) |
| `irev-queue.service.ts` | RabbitMQ `irev.fetch` consumer |
| `irev-verification.ts` | Diff builder, status/recommendation, `attachAttention` |
| `irev-geo.service.ts` | Ward → IReV geography resolution |
| `irev-mapper.ts` | PU code matching, document URL helpers |
| `irev-rate-limiter.ts` | Token-bucket limit for outbound IReV calls |
| `irev-sweep.service.ts` | Catalog crawl of all wards + re-fetch of `WAIT_IREV` agent rows |
| `irev.service.ts` | PU snapshot + manual refresh endpoints |
| `irev.controller.ts` | REST routes |

Submit hook: `CollationService` emits `IREV_FETCH_EVENT` when a PU result is saved.

Browse integration: `CollationBrowseService` includes `irevVerification` on ward/PU browse rows and `summary.irevAttention` on race analytics.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `IREV_ENABLED` | Yes | `true` to activate fetch, compare, and command center |
| `IREV_BASE_URL` | Recommended | IReV API base (e.g. `https://dolphin-app-sleqh.ondigitalocean.app/api/v1`) |
| `IREV_ELECTION_ID` | Yes | INEC election ID for API calls |
| `IREV_PORTAL_URL` | No | Public portal link base (default: `https://www.inecelectionresults.ng`) |
| `IREV_ELECTION_LABEL` | No | Display label in UI |
| `IREV_FETCH_RATE_LIMIT` | No | Max outbound IReV requests per minute (default: `30`) |
| `IREV_SWEEP_INTERVAL_MS` | No | Re-queue `WAIT_IREV` agent rows (default: `3600000`) |
| `IREV_CATALOG_INTERVAL_MS` | No | How often to enqueue uncataloged wards (default: `20000`) |
| `IREV_CATALOG_WARD_BATCH` | No | Wards queued per catalog tick (default: `8`) |
| `IREV_CATALOG_STALE_MS` | No | Recatalog a ward after this age (default: `21600000` = 6h) |
| `IREV_STATS_CACHE_MS` | No | Portal stats cache TTL (default: `300000`) |

**Docker:** pass these through `infra/compose/apps.yml` (`x-api-env`) so the API container receives them from `.env`.

Example production block:

```bash
IREV_ENABLED=true
IREV_BASE_URL=https://dolphin-app-sleqh.ondigitalocean.app/api/v1
IREV_ELECTION_ID=63f8f25b594e164f8146a213
IREV_FETCH_RATE_LIMIT=30
IREV_SWEEP_INTERVAL_MS=3600000
IREV_CATALOG_INTERVAL_MS=20000
IREV_CATALOG_WARD_BATCH=8
IREV_CATALOG_STALE_MS=21600000
IREV_STATS_CACHE_MS=300000
```

---

## Web dashboard (separate repo)

Routes in `electromon-web-national`:

| Route | Screen |
|-------|--------|
| `/dashboard/irev` | **IReV QA** — Brief (default) and Queue |
| `/dashboard/irev/map` | State choropleth: INEC publish %, agent capture %, local gaps, sheets aligned |

### Brief (`view=overview`)

Built for directors who need the gist in five seconds:

1. Giant **votes in dispute** number (client party), plus compared-sheets aligned %, PUs to review, replaced scans, wards lighting up
2. **Start here** — hottest ward headline; click opens that ward in the queue
3. **Where to look** — eight wards ranked by votes in dispute
4. **Largest polling-unit gaps** — five PUs, click opens the evidence pack
5. Slim coverage strip; full portal race and state scoreboard sit behind collapsed rows

Caveat on the brief: review flags, not findings of wrongdoing.

### Queue (`view=triage`)

Ranked evidence list + inspector. Copy uses **agent vs official scan**, not “delta”:

- Queue row: *Official has 52 more* (or *Agent has 52 more*)
- Inspector: two numbers — **Your agent** / **Official scan** — then the same sentence
- Status chip for disagreements stays **IReV mismatch**
- Empty filter chips are hidden
- Sheets: agent EC8A beside the IReV scan, plus lifecycle (submitted → official published → we received it → read)

### Situation Room

The governor briefing strip prefers votes in dispute (and the top ward headline) over a raw mismatch count. The tile is labeled **IReV QA** and links to `/dashboard/irev`.

### Shared pieces

- `src/lib/irev.ts` — types, `fetchIrevCommandCenter`, `describePartyGap`
- `src/components/irev/irev-command-center.tsx` — Brief, Queue, inspector
- `src/components/irev/irev-pu-comparison.tsx` — lifecycle + both scans
- `src/components/collation/irev-verification-chip.tsx` — **IReV mismatch** chips + party-figure table

Also wired into: **Ward review**, **My unit** (agent post-submit card).

---

## What this module does not ship

Do **not** add these without a new product decision:

- PU Trust Score 0–100
- National Health Index
- Expected-vs-observed turnout models
- IReV race forecasts
- A third “Intelligence Map” product
- An “AI Triage Officer” that decides for the human

The assistant may **explain** the existing attention brief (`get_irev_attention`). It must not call the flags fraud.

---

## Metrics

Prometheus counters (via `MetricsService`):

- `irev_fetch_total{status}` — `success`, `error`, `rate_limited`, `missing`, `unreadable`

---

## Operations notes

### Portal vs local counts

- **INEC published (portal)** comes from live national API — fast, election-night headline number.
- **INEC published (local)** counts `irev_pu_snapshots` where we have fetched a document — the catalog crawl fills this independently of agent submissions.
- **INEC only** is local snapshots with a document and no agent capture. It stays at 0 until the catalog has visited those wards.
- **Verified aligned** requires both agent submission and successful local IReV OCR on the same PU.

At 30 requests/minute, cataloguing ~8,800 wards takes several hours. The crawl starts on API boot and keeps going. OCR is reserved for PUs that have an agent result so we do not Vision-scan 167k sheets.

### Rate limiting

Outbound IReV calls are rate-limited to protect the upstream API and your server. Manual refresh returns `429` if the bucket is empty.

### State-level portal figures

When the IReV API does not expose per-state stats reliably, national totals are **pro-rata estimated** by PU count per state (`enrichStateGridWithPortalEstimates`). State map/ledger labels this as an estimate.

### Deploy checklist

1. Set `IREV_*` env vars on the API host.
2. Ensure `infra/compose/apps.yml` forwards IReV env into the API container.
3. Run migrations (`migrate` container or `pnpm db:migrate:deploy`).
4. Rebuild API: `docker compose … up -d --build migrate api` (droplet: `./infra/scripts/deploy-droplet.sh`). Push to `main` on `Asiwaju4Arewa-API` SSHs that script automatically.
5. Confirm logs: `Consuming irev.fetch` and `IREV_ENABLED=true` in container env.
6. Smoke: `GET /api/v1/irev/command-center?view=overview` (authenticated) — expect `votesAtRisk`, `clusters`, `feed`.

---

## Related docs

- [OCR.md](./OCR.md) — EC8A OCR pipeline reused for IReV scans
- [API.md](./API.md) — general REST conventions
- [../infra/DEPLOY.md](../infra/DEPLOY.md) — staging/production deploy
