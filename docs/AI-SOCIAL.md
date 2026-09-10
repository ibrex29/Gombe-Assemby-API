# Social Listening

Captures posts about the campaign, classifies sentiment, and rolls the results
into time windows the triage engine can read.

**Status: the API, queue, and database writes are live. No platform fetcher is
implemented.** Nothing pulls from Facebook yet — that is the piece described
under *Implementing a fetcher* below, and it can be built without touching this
repository.

## Shape

```
fetcher (not built)  ──POST /ai/social/ingest──►  social_posts
                                                       │
                                              ai.social.analyze queue
                                                       │
                                              SocialAnalyzeWorker
                                                       │
                                    sentiment on the post + sentiment_snapshots
                                                       │
                                              triage engine (phase 2)
```

## Ingest

```
POST /api/v1/ai/social/ingest
Authorization: Bearer <SOCIAL_INGEST_TOKEN>

{
  "campaignId": "…",
  "posts": [
    {
      "platform": "FACEBOOK",
      "externalId": "1234567890",
      "sourceHandle": "danmodi2027",
      "authorHandle": "someuser",
      "text": "…",
      "lang": "en",
      "postedAt": "2026-08-20T09:15:00.000Z",
      "permalink": "https://…",
      "mediaUrls": [],
      "raw": {}
    }
  ]
}

→ { "ingested": 3, "updated": 0, "queued": 3, "rejected": [] }
```

Up to 200 posts per call. `sourceHandle` must match an active `SocialSource` for
that campaign; unknown handles are listed in `rejected` rather than silently
dropped, and a batch where nothing matches returns 422.

**Ingest is idempotent** on `(campaignId, platform, externalId)`. Re-sending a
post refreshes its text and raw payload but leaves the analysis columns alone, so
replays never discard results or trigger a second round of model spend. Only
posts that have not been analysed are queued.

### Why a service token

The fetcher is a headless process with no user session, so it authenticates with
`SOCIAL_INGEST_TOKEN` rather than a JWT — the same approach as `/metrics`. If the
variable is unset the endpoint returns 503, so it is off by default rather than
open by default.

## Sources

Managed over JWT by `CAMPAIGN_DIRECTOR`, `CANDIDATE`, `MEDIA_TEAM`, or
`DATA_ANALYST`:

```
GET   /api/v1/ai/social/sources?campaignId=…
POST  /api/v1/ai/social/sources     { campaignId, platform, handle, displayName, config? }
PATCH /api/v1/ai/social/sources/:id { displayName?, isActive?, config? }
GET   /api/v1/ai/social/posts?campaignId=…&sentiment=NEGATIVE&from=&to=&limit=
GET   /api/v1/ai/social/summary?campaignId=…
```

`config` is free-form for the fetcher (poll interval, keywords, which credential
to use). **Never put a raw secret in it** — keep secrets in environment
variables and reference them by name.

## Analysis

`SocialAnalyzeWorker` classifies a batch in one model call and writes
`sentiment`, `sentimentScore` (−1…1), `topics`, `entities`, `relevance`, and
`analyzedAt` onto each post, then recomputes the hourly `sentiment_snapshots` row
by re-querying the window — so a replayed job cannot double-count.

- **With `AI_SOCIAL_MODEL` unset**, posts are still stored, still queued, still
  marked analysed, with `sentiment: UNKNOWN` and `modelMeta.engine: 'NOOP'`. The
  whole pipeline is exercisable without a key.
- **Geography is not asked of the model.** Place names it extracts are matched
  against the campaign state's own LGA names; only a real match sets `lgaId`.
- **Post text is treated as hostile.** Social text is public and adversarial by
  definition, so the classifier runs with no tools, enum-constrained output, and
  an instruction that post content is data rather than instructions. Its output
  is parsed defensively — a malformed response degrades to UNKNOWN, never throws.

Queue behaviour follows the EC8A OCR queue (RabbitMQ when `RABBITMQ_URL` is set,
in-process events otherwise) with one deliberate difference: a failed job is
requeued **once** and then dead-lettered to `ai.social.dead`, rather than acked
and dropped. Analysis failures are usually transient rate limits, and a silently
discarded job is worse than a visible dead letter.

## Implementing a fetcher

Two options. **The first is recommended** — it needs no knowledge of this
codebase beyond the request body above.

### 1. External process (recommended)

Poll the platform wherever you like, then POST batches to `/ai/social/ingest`
with the service token. Because ingest is idempotent, the poller can be simple:
overlapping windows and re-sent posts are harmless.

For Facebook this means a Graph API client with:

- A long-lived Page access token per monitored page.
- The `/{page-id}/posts` and `/{post-id}/comments` edges.
- App credentials (`FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`) held by the
  fetcher, never sent here.
- Rate limits around 200 calls/hour/token — a poll interval of five minutes or
  more per source is a safe starting point.
- `externalId` set to the platform's own post id, so retries deduplicate.

### 2. In-process fetcher

Implement `SocialFetcher` (`social/social-fetcher.interface.ts`), register it
under the `SOCIAL_FETCHERS` token, and drive it from a scheduler that reads
`SocialSource.config` for cadence and uses the latest `fetchedAt` per source as
its cursor. Nothing implements this interface today; it exists so that choosing
this path does not require redesigning the module. Note that the API has no
scheduler at all right now, so this option means adding one.

## Configuration

| Variable | Effect when unset |
|---|---|
| `SOCIAL_INGEST_TOKEN` | Ingest endpoint returns 503 — the feature is off |
| `AI_SOCIAL_MODEL` | Posts stored and marked UNKNOWN; no model spend |
| `OPENROUTER_API_KEY` | Same as above |

## Feeding triage

`sentiment_snapshots` is the handoff to the phase-2 triage engine: it reads the
most recent window for a scope and turns negative share into one component of the
risk score. The component is designed to score **zero when no snapshot exists**,
so triage behaves identically before and after social listening goes live, and
turning it on requires no triage change.
