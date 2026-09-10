# AI Assistant

Grounded natural-language Q&A over campaign data. The model writes its own
read-only SQL, which is validated and rewritten before it runs, and every figure
in the answer is traced back to a real query result before the user sees it.

**This is the national deployment** (37 states, 774 LGAs, ~8,800 wards, ~176,000
polling units). See *National scope* below for what differs from the single-state
build.

Adapted from a sibling project's assistant (`AI.md` in the workspace root). That
implementation's source was not available, so this is a reimplementation from its
specification, with the changes noted under **Differences from the reference**.

## Endpoint

```
POST /api/v1/ai/assistant/chat
Roles: CANDIDATE, CAMPAIGN_DIRECTOR, DATA_ANALYST
Rate limit: 10/min (global default is 100/min)

{ "message": "Which LGAs are we losing?", "history": [...], "stream": true }
```

There is no server-side conversation storage. The client resends the visible
transcript as `history` (the last 20 turns are used); the browser keeps it in
`sessionStorage`.

### Streaming contract

With `stream: true` the response is `application/x-ndjson` — one JSON object per
line:

```
{"type":"status","label":"Thinking"}
{"type":"status","label":"Querying the campaign database","tool":"run_sql"}
{"type":"final","reply":"…","grounded":true,"suppressed":false,"model":"…",
 "usage":{"inputTokens":0,"outputTokens":0,"totalTokens":0},
 "toolCalls":[{"tool":"run_sql","ok":true}]}
```

If the turn fails after the first byte, a `{"type":"error","message":"…"}` event
is emitted instead and the stream ends. Without `stream: true` the same final
payload is returned as a single JSON body.

**The answer text is never streamed token by token.** It is released only after
the grounding check has passed, because streaming would put unverified figures on
screen before suppression could catch them. Status events exist so the wait is
still legible.

## Request flow

1. Global `JwtAuthGuard` → `RolesGuard` → `ThrottlerGuard`.
2. `AssistantService.chat` returns 503 unless both `OPENROUTER_API_KEY` and
   `AI_READONLY_DATABASE_URL` are set, then checks campaign membership.
3. The agent loop runs: the model may call tools, results are fed back, up to
   6 tool round-trips.
4. `grounding.ts` checks the answer. If it fails, one corrective retry runs with
   the tool call forced; if it still fails, the answer is replaced by a fixed
   message and the suppression is written to `activity_logs`.
5. `AuditInterceptor` records the request itself as `ai.chat`.

## Tools

| Tool | Purpose |
|---|---|
| `get_race_summary` | Standings, margins, share, reporting coverage. Wraps `CollationBrowseService.getRaceAnalytics`, so it applies the same win/loss rules as the Situation Room. |
| `get_incident_hotspots` | Unresolved incidents per LGA, severity-weighted. Wraps the same aggregation the situation map uses. |
| `run_sql` | Anything else. One read-only SELECT, validated by the sandbox. |

The typed tools exist because the model reliably gets JSONB party arithmetic
wrong; routing standings questions through existing, tested code is both cheaper
and more accurate than letting it derive them in SQL.

## The SQL sandbox

`sql/sql-sandbox.ts` parses each query with `node-sql-parser`, validates it, and
re-serialises the validated AST. **What executes is the sandbox's regenerated
text, never the model's string.** In order:

1. One statement, and it must be a `SELECT`.
2. No writes at any depth — a generic walk over the whole AST rejects
   `insert`/`update`/`delete`/`create`/… wherever they appear, including inside
   CTEs, subqueries, and UNION arms.
3. No `SELECT *` (`COUNT(*)` is fine), no `SELECT … INTO`, no row locking.
4. Function allowlist, not a denylist.
5. Cast targets restricted to plain scalar types.
6. Operator allowlist — this is what permits `->` and `->>` for party votes while
   keeping containment operators out.
7. Table allowlist.
8. Column allowlist on the SELECT list.
9. `LIMIT` forced to 200 or below.

Anything the parser returns in an unrecognised shape is rejected rather than
passed through. A rejection is returned to the model as a tool error so it can
rewrite and retry.

**Known limitation, inherited from the reference implementation:** columns used
only in `WHERE` / `JOIN` / `ORDER BY` are not checked against the column
allowlist. Their values are never returned, and the table grants plus RLS bound
what they can reach.

## Three layers of data protection

Column-level secrecy is enforced by the application, not the database — the
grants are table-level, so **removing a column from `ALLOWED_COLUMNS` is what
actually keeps it unreadable**.

1. **Allowlist** (`sql/allowlist.ts`) — omits personal contact details, all
   user-identifying foreign keys, and internal advisory JSON. `users`,
   `activity_logs`, `notifications`, `device_tokens`, `refresh_tokens`, and
   `campaign_invitations` are absent entirely.
2. **Prompt** — the schema description states outright that personal and account
   data is unavailable, and the system prompt repeats it independently.
3. **Query validation** — rejects a withheld column at the AST level, before any
   database call, even if the prompt were ignored or bypassed by injection.

Tenancy is separate, and enforced by Postgres. Migration
`20260821040000_ai_readonly_role_and_rls` creates `electromon_ai_readonly` with
`SELECT` on allowlisted tables only, and RLS policies keyed on
`current_setting('app.campaign_id')`. The executor sets that per transaction.
`current_setting(…, true)` returns NULL when unset, so a bug that skipped the set
would return **zero rows rather than every campaign**.

Per query: sandbox rewrite → table grants → role-level `default_transaction_read_only`
→ explicit `BEGIN TRANSACTION READ ONLY` → RLS → 5s statement timeout.

## Grounding — the enforced guardrail

The prompt asks the model not to invent numbers; `grounding/grounding.ts` is what
makes it true. Every comma-grouped number or run of 3+ digits in the answer must
appear in the JSON of a **successful** tool result from that turn. One- and
two-digit numbers are ignored as ordinary prose.

On failure: one retry with `tool_choice: required` on the first step, so the
model cannot restate the same answer without querying. Still failing, the reply
is replaced with a fixed message and an `ai.response_suppressed` row is written
to `activity_logs` with the untraceable figures, so the incident stays visible.

A consequence worth knowing: **arithmetic the model does itself is suppressed.**
If it adds two returned numbers and reports the total, that total appears in no
tool result and the answer is withheld. This is deliberate, and it is why the
prompt tells the model to report figures as returned.

## What this does not do

- It does not write to the database, ever.
- It does not see personal, contact, or account data, for any role.
- It does not see other campaigns' data.
- It does not stream the answer before verifying it.
- It does not remember conversations between sessions.
- It does not act. It answers questions; every decision stays with a person.

## Configuration

| Variable | Effect when unset |
|---|---|
| `OPENROUTER_API_KEY` | Endpoint returns 503 "not configured" |
| `AI_MODEL` | Falls back to a built-in default and logs a warning — set this explicitly |
| `AI_OCR_MODEL` | Vision model for EC8A photo reading (default `google/gemini-2.5-flash`) |
| `AI_READONLY_DATABASE_URL` | Endpoint returns 503 |
| `AI_READONLY_DB_PASSWORD` | Used only by `make db-ai-role` |

Setup:

```bash
pnpm db:migrate          # creates the role (NOLOGIN), grants, and policies
make db-ai-role          # grants LOGIN + password, then self-checks RLS
```

The role is created without a password on purpose — credentials do not belong in
migration SQL. `infra/scripts/setup-ai-readonly.sh` is idempotent and verifies
that an unknown campaign id returns zero rows before it exits.

## National scope

Three things behave differently here from the single-state deployment:

1. **Geography level follows the caller.** `get_race_summary` returns one row per
   STATE on a national campaign and one row per LGA once the caller is inside a
   state. It says which via `geographyLevel` and `unitLabel`, and the tool result
   names the rows `units` rather than `lgas` — calling them LGAs at national scope
   is exactly how a model ends up describing states as local governments.
   `get_incident_hotspots` rolls up the same way.

2. **Zones come from the database.** National rows carry `zone` (North West, North
   East, North Central, South West, South East, South South) sourced from
   `states.zone`, so regional roll-ups are data-derived. Without it the model
   assigns states to zones from memory, which is usually right and occasionally
   not — and never traceable.

3. **`campaigns.isNational` is not a geography filter.** When it is true,
   `campaigns."stateId"` is only the campaign's base state. The schema description
   says so explicitly, because joining through it would silently report one state
   as if it were the country.

The system prompt also gains a SCALE section on national campaigns telling the
model to answer at the coarsest level that fits — states and zones first, LGAs
once a state is named, wards or polling units only when the question narrows that
far. A query that tries to list polling units nationwide hits the 200-row cap and
produces a confidently wrong answer.

## Running it locally

From a clean checkout, in `electromon-api`:

```bash
pnpm install                 # also installs db/ and shared/
make infra-up                # Postgres (also creates .env from the local example)
pnpm db:migrate:deploy       # applies the RLS + social migrations
make db-ai-role              # gives electromon_ai_readonly LOGIN, then self-checks RLS
pnpm db:seed                 # demo campaign, geography, users
pnpm dev                     # http://localhost:3001, docs at /docs
```

`make db-ai-role` prints the fail-closed proof. Expect:

```
    campaigns visible = 0  [ok] RLS fails closed
    users -> permission denied  [ok]
```

It uses `psql` if installed and otherwise runs it inside the Postgres container,
so no client install is required.

Then in `electromon-web`:

```bash
pnpm install
pnpm dev                     # http://localhost:3000
```

Sign in as `+2348000000001` / `1234567890` (the seeded director) and open
**AI Assistant** in the sidebar.

Default local ports for this repo are API `3005` and web `3004`, against the
`electromon_national` database — so it can run alongside a single-state stack
without clashing.

### Smoke tests

Without `OPENROUTER_API_KEY`, the assistant is expected to refuse — that is the
wiring working, not a failure:

```bash
curl -s -X POST localhost:3001/api/v1/ai/assistant/chat \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"Which LGAs are we losing?"}'
# {"statusCode":503,"message":"AI assistant is not configured", ...}
```

Set `OPENROUTER_API_KEY` and `AI_MODEL` in `.env`, restart, and add
`"stream": true` to watch the NDJSON status events arrive before the answer.

To exercise social listening end to end, set `SOCIAL_INGEST_TOKEN`, create a
source, then POST the same batch twice — the second call must report
`ingested: 0, updated: N, queued: 0`, which is the idempotency guarantee.

### Choosing a model

`AI_MODEL` takes an OpenRouter model slug. This workload is tool-calling with
strict instruction-following, so a strong reasoning model pays for itself — a
weak one writes invalid SQL, burns retries, and trips the grounding check more
often. Confirm the exact slug against OpenRouter's model list before setting it.

## Differences from the reference implementation

| Reference | Here | Why |
|---|---|---|
| Mastra `Agent` + Vercel AI SDK | Direct OpenRouter HTTP client (`core/llm/`) | The AI SDK and its OpenRouter provider are ESM-only; this service compiles to CommonJS and runs on `node:20-alpine`, where `require()` of ESM is not reliably available. The client is ~180 lines and the loop is explicit. |
| Grants `SELECT` on all tables | Grants only allowlisted tables | Nothing needs the others. |
| No tenancy isolation | Postgres RLS per campaign | This system is multi-campaign; prompt-level scoping would not be enough. |
| One `run-sql` tool | Plus two typed domain tools | JSONB party arithmetic in generated SQL is error-prone. |
| No streaming | NDJSON status events | A turn can take 10s+; silence reads as a hang. |

## Decision log

- **Answer withheld until verified, not streamed.** Streaming tokens would show
  figures before the grounding check could suppress them.
- **RLS over query rewriting.** Injecting campaign predicates into model-authored
  SQL is fragile; the database enforcing it is not.
- **Typed tools alongside raw SQL.** Reuses aggregation the Situation Room
  already trusts, so the assistant and the dashboards cannot disagree.
- **`DATA_ANALYST` allowed on collation browse.** The role existed but was
  unreachable on every route; the assistant reads race analytics on its behalf.
  This widened existing `GET /collation/browse/*` endpoints to a read-only
  analytics role — flagged for review.
- **Stateless chat.** Avoids a thread schema and per-message retention questions
  for a first release; the transcript lives in `sessionStorage`.
