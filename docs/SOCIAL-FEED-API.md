# Social Feed API — integration requirements

Draft for the **Daniel's team / social feed** meeting and **Usman's API requirements** handoff.

Electromon surfaces public mood and a live social feed under **Command Center → Public Mood** (`/dashboard/social`). The Intelligence Module (triage risk scoring + AI assistant) consumes a subset of the same data.

This document covers:

1. What Electromon needs from the external social provider
2. What Electromon exposes to the web app and other modules
3. Request/response shapes, auth, and data requirements per consumer

---

## Architecture at a glance

Electromon supports **two integration paths**. They are complementary — not duplicates.

```
Path A — Pull (live feed, mood panels, narratives)
──────────────────────────────────────────────────
Pulseforge (or equivalent provider)
        │  Bearer API key, JSON over HTTPS
        ▼
Electromon API  (/ai/social/feed, /mood, /narratives, …)
        │  proxied live OR synced snapshots
        ▼
Web dashboard + AI Assistant tools

Path B — Push (campaign-owned ingest)
─────────────────────────────────────
External fetcher (Daniel's team / platform scrapers)
        │  POST /ai/social/ingest  (service token)
        ▼
social_posts  →  ai.social.analyze queue  →  LLM classification
        │
        ▼
sentiment_snapshots  →  Triage engine ("Online mood" factor)
```

| Path | Best for | Stored locally? | Feeds triage risk score? |
|------|----------|-----------------|--------------------------|
| **A — Pull** | National feed, geo mood map, narratives, alerts, stance | Mood snapshots only (after manual sync) | Yes, **after** `POST /pulseforge/sync` |
| **B — Push** | Campaign-specific pages/handles the provider does not cover | Yes (`social_posts`) | Yes, via analyze worker hourly roll-ups |

**Important:** The live feed (`GET /feed`) is **not mirrored** in Electromon's database. Posts are proxied from the upstream provider and deep-linked back to the original platform.

---

## Meeting agenda — Daniel's team (Social Feed)

### 1. Social feed — scope

Electromon needs a **national-scale, geo-tagged post stream** covering Nigerian election conversation across:

| Platform | Priority | Notes |
|----------|----------|-------|
| X (Twitter) | High | Primary breaking-news channel |
| Facebook | High | Large rural reach |
| TikTok | Medium | Growing youth audience |
| WhatsApp | Low (Phase 2) | No public permalink model; discuss separately |
| Other | As available | Tag as `OTHER` |

Each post must be classifiable as **political vs non-political** and mappable to **state** and optionally **LGA**.

### 2. Data sources

Confirm which sources Daniel's team will operate:

| Source type | Owner | Electromon integration |
|-------------|-------|------------------------|
| Provider API (pull) | Daniel's team / Pulseforge | Electromon calls upstream; read-only key |
| Platform fetchers (push) | Daniel's team | POST batches to `/ai/social/ingest` |
| Monitored handles | Campaign ops | Registered via `POST /ai/social/sources`; fetcher must match `sourceHandle` |

**Open questions for the meeting:**

- Will Daniel's team **host the pull API** (Pulseforge-equivalent), **push ingest**, or **both**?
- What is the **geo resolution** guarantee (state only vs state + LGA)?
- What is the **historical backfill** window (e.g. 7 days, 30 days, full election cycle)?
- How are **state/LGA names normalised** — INEC codes, full names, or free text?
- What is the **refresh cadence** for sentiment aggregates (real-time, hourly, daily)?

### 3. Integration requirements

#### Authentication

| Direction | Method | Header |
|-----------|--------|--------|
| Provider → Electromon (ingest) | Service token | `Authorization: Bearer <SOCIAL_INGEST_TOKEN>` |
| Electromon → Provider (pull) | API key | `Authorization: Bearer <PULSEFORGE_API_KEY>` |

Ingest returns **503** when `SOCIAL_INGEST_TOKEN` is unset (off by default). Pull endpoints return `{ configured: false, … }` when the provider key is missing.

#### Idempotency (push path)

Ingest is idempotent on `(campaignId, platform, externalId)`. Re-sending a post refreshes text/raw but **preserves existing analysis** — safe for retries.

#### Rate limits (Electromon side)

| Endpoint | Limit |
|----------|-------|
| `POST /pulseforge/sync` | 6 / min |
| `GET /feed`, `/opinion`, `/voices`, `/narratives`, `/alerts` | 30 / min |
| `GET /stance` | 12 / min |

Provider should document its own limits so Electromon can tune sync frequency.

#### Error contract

Electromon expects upstream responses wrapped as:

```json
{ "data": <payload> }
```

HTTP **401/403** on the provider key must be distinguishable from network/5xx failures (operator replaces key vs upstream outage).

### 4. Social intelligence → Intelligence Module

Not all social data affects the **triage risk score**. Boundaries:

| Data | Intelligence Module use | Affects risk score? |
|------|-------------------------|---------------------|
| Sentiment snapshots (state/LGA/campaign) | Triage "Online mood" factor (5% weight) | **Yes** |
| Live feed posts | Public Mood dashboard, context | No |
| Narratives | AI Assistant, dashboard panel | No |
| Alerts | AI Assistant, dashboard panel | No |
| Stance (pro/anti figures) | AI Assistant, dashboard panel | No |
| Voices / amplifiers | Dashboard panel | No |

**Triage rule:** absent social data is **excluded** from scoring — never treated as "calm". A state with no posts is "not measured", not "0% negative".

Thin-sample guard: fewer than ~20 classified posts → sentiment share is shown but **does not move the risk score**.

**AI Assistant tools** (internal, not public REST):

| Tool | Source |
|------|--------|
| `get_social_mood` | Stored snapshots |
| `get_narratives` | Live provider |
| `get_social_alerts` | Live provider |
| `get_stance` | Live provider |

Assistant system prompt instructs: report provider figures as given, carry coverage caveats, and note alerts are context only.

---

## Usman — API requirements

Base URL: `https://api.electromon.iexportcalc.com/api/v1`

All JWT routes require roles: `CAMPAIGN_DIRECTOR`, `CANDIDATE`, `MEDIA_TEAM`, or `DATA_ANALYST`.

---

### A. What the external provider must expose (pull contract)

Electromon currently integrates with **Pulseforge** at `https://pulseforge.vercel.app/api/v1`. Daniel's team can mirror this contract or propose deltas.

#### A1. Health

```
GET /meta/health
→ { "data": { "status": "ok", "latencyMs": 42 } }
```

#### A2. Posts feed (core social feed request)

```
GET /posts?state={state}&lga={lga}&limit={n}&cursor={cursor}&from={iso}
Authorization: Bearer <API_KEY>
```

**Query parameters**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `state` | string | No | State name or code filter |
| `lga` | string | No | LGA filter (within state) |
| `limit` | int | No | Page size (Electromon caps at 100) |
| `cursor` | string | No | Pagination cursor (**not yet exposed** on Electromon `/feed`; needed for infinite scroll) |
| `from` | ISO datetime | No | Posts after this time |

**Response — each post**

```json
{
  "data": [
    {
      "id": "pf_abc123",
      "postId": "platform-native-id",
      "platform": "X",
      "text": "Post body, max ~10k chars",
      "url": "https://x.com/user/status/123",
      "timestamp": "2026-09-07T00:15:00.000Z",
      "geo": { "state": "Lagos", "lga": "Ikeja" },
      "sentiment": 0.35,
      "language": "en",
      "keywords": ["election", "apc"],
      "isPolitical": true,
      "topic": "turnout",
      "author": {
        "username": "handle",
        "displayName": "Display Name",
        "verified": false
      },
      "engagement": { "likes": 120, "reposts": 45, "replies": 12 }
    }
  ]
}
```

**Field requirements**

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Stable provider-side ID |
| `platform` | Yes | `X`, `FACEBOOK`, `TIKTOK`, etc. |
| `text` | Yes | Full or excerpt; UI shows truncated |
| `url` | Strongly recommended | Must be a real platform permalink, not a placeholder |
| `timestamp` | Yes | ISO 8601 UTC |
| `geo.state` | Recommended | Enables state map + filters |
| `geo.lga` | Optional | Enables LGA drill-down |
| `sentiment` | Recommended | Float −1..+1 or 0..1 — document scale |
| `isPolitical` | Recommended | Filters noise in dashboard |
| `author` | Recommended | Display name + verified flag |

#### A3. Sentiment aggregates (mood sync)

```
GET /signals/sentiment?groupBy=state|lga&from={iso}&to={iso}
```

**Response row**

```json
{
  "state": "Kano",
  "lga": "Fagge",
  "posts": 842,
  "meanSentiment": 0.12,
  "distribution": { "positive": 210, "neutral": 380, "negative": 252 },
  "emotions": { "anger": 0.18, "hope": 0.22 }
}
```

Electromon maps `distribution` directly into `sentiment_snapshots` — no reverse-engineering from means.

#### A4. Supplementary intelligence endpoints

| Upstream route | Electromon route | Purpose |
|----------------|------------------|---------|
| `GET /indicators/opinion?state=` | `GET /ai/social/opinion` | Daily 0–100 opinion index |
| `GET /authors?state=&sortBy=followersCount` | `GET /ai/social/voices` | Top accounts |
| `GET /network?state=` | `GET /ai/social/voices` | Amplifier graph (centrality) |
| `GET /narratives?limit=` | `GET /ai/social/narratives` | Story clusters (national) |
| `GET /alerts` | `GET /ai/social/alerts` | Provider detections |
| `GET /entities` + stance signal | `GET /ai/social/stance` | Pro/anti/neutral toward figures |

---

### B. What Electromon exposes (push ingest — for fetchers)

#### B1. Ingest batch

```
POST /api/v1/ai/social/ingest
Authorization: Bearer <SOCIAL_INGEST_TOKEN>
Content-Type: application/json
```

**Request**

```json
{
  "campaignId": "clx…",
  "posts": [
    {
      "platform": "FACEBOOK",
      "externalId": "1234567890",
      "sourceHandle": "campaignPageHandle",
      "authorHandle": "commenterHandle",
      "text": "Post or comment text",
      "lang": "en",
      "postedAt": "2026-09-07T00:15:00.000Z",
      "permalink": "https://facebook.com/…",
      "mediaUrls": ["https://…"],
      "raw": { "originalPlatformPayload": "…" }
    }
  ]
}
```

| Constraint | Value |
|------------|-------|
| Max posts per request | 200 |
| `platform` enum | `FACEBOOK`, `X`, `TIKTOK`, `WHATSAPP`, `OTHER` |
| `sourceHandle` | Must match an active `SocialSource` for the campaign |
| `text` max length | 10,000 chars |
| `postedAt` | ISO 8601 |

**Response**

```json
{
  "ingested": 3,
  "updated": 0,
  "queued": 3,
  "rejected": [
    { "externalId": "…", "reason": "No matching source for handle foo" }
  ]
}
```

**Errors**

| Status | When |
|--------|------|
| 422 | Entire batch rejected (no matching sources) |
| 503 | `SOCIAL_INGEST_TOKEN` not configured |

#### B2. Source registration (JWT — campaign ops)

```
POST /api/v1/ai/social/sources
Authorization: Bearer <JWT>

{
  "campaignId": "clx…",
  "platform": "FACEBOOK",
  "handle": "campaignPageHandle",
  "displayName": "Campaign Official Page",
  "config": { "pollIntervalMinutes": 15, "keywords": ["asiwaju"] }
}
```

Fetcher must use the exact `handle` as `sourceHandle` on ingest.

---

### C. What the web app consumes (Electromon read API)

#### C1. Live feed

```
GET /api/v1/ai/social/feed?state=Lagos&lga=Ikeja&limit=40
Authorization: Bearer <JWT>
```

**Response**

```json
{
  "configured": true,
  "posts": [
    {
      "id": "pf_abc123",
      "platform": "X",
      "text": "…",
      "url": "https://x.com/…",
      "timestamp": "2026-09-07T00:15:00.000Z",
      "state": "Lagos",
      "lga": "Ikeja",
      "sentiment": 0.35,
      "author": "Display Name",
      "verified": false,
      "topic": "turnout",
      "isPolitical": true
    }
  ]
}
```

When provider is unconfigured: `{ "configured": false, "posts": [] }`.

#### C2. Mood board

```
GET /api/v1/ai/social/mood
GET /api/v1/ai/social/mood/state/:code
```

**Response (national board)**

```json
{
  "configured": true,
  "lastSyncedAt": "2026-09-07T00:00:00.000Z",
  "engine": "pulseforge-v1",
  "coverage": { "measured": 28, "total": 37 },
  "national": {
    "posts": 12400,
    "classified": 11800,
    "positive": 3200,
    "neutral": 5100,
    "negative": 3500,
    "negativeShare": 0.30
  },
  "rows": [
    {
      "scopeId": "…",
      "name": "Lagos",
      "stateCode": "LA",
      "posts": 2100,
      "classified": 1980,
      "positive": 600,
      "neutral": 800,
      "negative": 580,
      "negativeShare": 0.29,
      "avgScore": 0.08,
      "emotions": { "anger": 0.15 },
      "windowEnd": "2026-09-07T00:00:00.000Z"
    }
  ]
}
```

States with **no upstream posts are absent from `rows`** — not shown as calm.

#### C3. Sync mood snapshots

```
POST /api/v1/ai/social/pulseforge/sync
Authorization: Bearer <JWT>
```

Pulls provider sentiment → writes `sentiment_snapshots` per matched state/LGA + campaign roll-up.

**Response**

```json
{
  "states": { "matched": 28, "unmatched": ["FCT", "Unknown State"] },
  "lgas": { "matched": 412, "unmatched": ["Badagry East"] },
  "campaign": true
}
```

Currently **manual** — no cron. Operators (or a future scheduler) must call sync before triage reads fresh mood data.

#### C4. Other dashboard panels

| Endpoint | Query | Response highlights |
|----------|-------|---------------------|
| `GET /ai/social/opinion` | `?state=` | `{ latest, change, series[] }` |
| `GET /ai/social/voices` | `?state=` | Top authors + network amplifiers |
| `GET /ai/social/narratives` | — | Story clusters (national) |
| `GET /ai/social/alerts` | — | Provider flags |
| `GET /ai/social/stance` | — | Pro/anti/neutral per tracked figure |

---

### D. Data requirements by module

| Module | Endpoints / tables | Minimum data needed |
|--------|-------------------|---------------------|
| **Public Mood dashboard** | `/mood`, `/feed`, `/opinion`, `/voices`, `/narratives`, `/alerts`, `/stance` | Geo-tagged posts + sentiment; sync for map |
| **Triage / risk scoring** | `sentiment_snapshots` | State/LGA `distribution` with post count ≥ 20 for score impact |
| **AI Assistant** | Tools above | Same as dashboard; snapshots for mood, live for narratives/alerts/stance |
| **Ingest pipeline** | `/ingest`, `social_posts`, analyze worker | Platform posts with handle match + text + timestamp |
| **Campaign source monitor** | `/sources`, `/posts`, `/summary` | Registered handles; classified ingest posts |

---

## Database models (reference)

| Table | Purpose |
|-------|---------|
| `social_sources` | Monitored page/handle per campaign |
| `social_posts` | Push-ingested posts + LLM analysis columns |
| `sentiment_snapshots` | Rolled-up mood per scope/window (`engineVersion`: `pulseforge-v1` or `social-v1`) |

---

## Environment variables

| Variable | Direction | Purpose |
|----------|-----------|---------|
| `PULSEFORGE_API_KEY` | Pull | Provider read key |
| `PULSEFORGE_BASE_URL` | Pull | Override default provider URL |
| `SOCIAL_INGEST_TOKEN` | Push | Fetcher authentication |
| `OPENROUTER_API_KEY` | Internal | LLM sentiment for ingest path |
| `AI_SOCIAL_MODEL` | Internal | Model ID for analyze worker |
| `RABBITMQ_URL` | Internal | Queue for `ai.social.analyze` |

---

## Gaps / open items for the meeting

| # | Item | Owner | Priority |
|---|------|-------|----------|
| 1 | Expose `cursor` pagination on `GET /ai/social/feed` | Usman / Electromon | High |
| 2 | Scheduled mood sync (cron) vs manual button | Usman / Electromon | Medium |
| 3 | Confirm provider URL, auth, and SLA | Daniel's team | High |
| 4 | State/LGA name → INEC code mapping table | Daniel's team + Electromon | High |
| 5 | WhatsApp / private-channel strategy | Daniel's team | Phase 2 |
| 6 | Historical backfill volume and cost | Daniel's team | Medium |
| 7 | Webhook push alternative to polling ingest | Daniel's team | Nice-to-have |
| 8 | Document sentiment scale (−1..1 vs 0..1) | Daniel's team | High |

---

## Related docs

- [`AI-SOCIAL.md`](./AI-SOCIAL.md) — ingest pipeline, queue, analyze worker (push path only)
- [`IREV.md`](./IREV.md) — style reference for module documentation
- Swagger: `/api/docs` → tag `ai` → `/ai/social/*`

---

## Appendix — sequence: operator views the feed

```
1. Operator opens /dashboard/social
2. Web calls GET /ai/social/mood          → stored snapshots (map colours)
3. Web calls GET /ai/social/feed?limit=40  → live provider proxy (post list)
4. Operator clicks "Sync mood" (optional)
   → POST /ai/social/pulseforge/sync
   → provider /signals/sentiment pulled
   → sentiment_snapshots updated
   → triage reads new mood on next sweep
5. Operator clicks a post → opens platform permalink in new tab
```
