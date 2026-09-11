# Electromon API Reference

> **Project:** run commands from this repo root. Start infrastructure with `make infra-up`.
>
> Full docs index: [docs/README.md](./README.md)

Base URL: `http://localhost:3001/api/v1`  
Swagger UI: http://localhost:3001/docs  
OpenAPI JSON: http://localhost:3001/docs/json  
Metrics: http://localhost:3001/api/v1/metrics

## Using Swagger UI

1. Start the API: `make infra-up && make dev`
2. Open http://localhost:3001/docs
3. Call `POST /auth/login` with the default credentials
4. Copy the `accessToken` from the response
5. Click **Authorize** (top right) and enter: `Bearer <accessToken>`
6. All protected endpoints are now callable from the UI

All endpoints except those marked **Public** require a Bearer token:

```
Authorization: Bearer <accessToken>
```

---

## Mobile PU agent (EC8A)

Dan-Modi/Jigawa base URL: `http://localhost:3001/api/v1`  
On a phone on the same Wi-Fi, use the LAN URL logged at API boot (e.g. `http://192.168.x.x:3001/api/v1`).  
Swagger: http://localhost:3001/docs · OpenAPI: http://localhost:3001/docs/json  
Demo password: `ChangeMe123!` — PU agent `+2348000000002`

How scan, arithmetic, and ward chips work: [OCR.md](./OCR.md).

### Flow

1. `POST /auth/login`
2. `GET /collation/dashboard`
3. `POST /collation/ec8a/scan-file` — multipart field **`file`** (JPEG/PNG, max 5 MB). Wait up to ~25s.
4. Show `fields` + `partyResults`; agent edits if needed
5. `POST /collation/results` — save draft, include `ec8aPhotoUrls: [photoUrl]`
6. `PATCH /collation/results/:id/submit`

### POST /collation/ec8a/scan-file

**Auth:** Bearer (role `POLLING_AGENT` or other collation roles)

```bash
curl -X POST http://localhost:3001/api/v1/collation/ec8a/scan-file \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@ec8a.jpg"
```

**Response (200):**
```json
{
  "photoUrl": "http://192.168.1.10:3001/uploads/….jpg",
  "url": "http://192.168.1.10:3001/uploads/….jpg",
  "filename": "….jpg",
  "mimeType": "image/jpeg",
  "size": 183879,
  "fields": {
    "registeredVoters": 289,
    "accreditedVoters": 210,
    "ballotPapersIssued": 289,
    "unusedBallotPapers": 79,
    "spoiledBallotPapers": 0,
    "invalidVotes": 3,
    "votesCast": 207,
    "usedBallotPapers": 210
  },
  "partyResults": { "APC": 159, "PDP": 40 },
  "confidence": 1,
  "unreadable": false
}
```

If `unreadable` is true, keep `photoUrl` and let the agent type figures. Then `POST /collation/ec8a/scan` with `{ "photoUrl" }` if you already uploaded via `POST /uploads`.

---

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health/live` | Public | Liveness probe |
| GET | `/health/ready` | Public | Readiness (DB + Redis) |
| GET | `/health` | Public | Alias for readiness |

---

## Auth

### POST /auth/login

**Public** — Authenticate with email and password.

**Request:**
```json
{
  "phoneNumber": "+2348000000001",
  "password": "1234567890"
}
```

**Response (200):**
```json
{
  "user": {
    "id": "cms147za8001xww9ktd46y7m0",
    "email": "director@electromon.ng",
    "firstName": "Campaign",
    "lastName": "Director",
    "role": "CAMPAIGN_DIRECTOR",
    "campaignId": "cms147z3t001www9ktkqgluw0",
    "mfaEnabled": false
  },
  "accessToken": "eyJhbG...",
  "refreshToken": "8074ffa2..."
}
```

### POST /auth/register

**Public** — Register a new user account.

### POST /auth/refresh

**Public** — Exchange a refresh token for new tokens.

### POST /auth/logout

Revoke a refresh token.

### GET /auth/session

Returns the current user's profile and campaign memberships.

---

## Campaigns

| Method | Path | Description |
|--------|------|-------------|
| GET | `/campaigns` | List campaigns for current user |
| GET | `/campaigns/:id` | Campaign details with geo tree |

---

## Structure

Geographic hierarchy aligned with INEC electoral geography:

```
State → SenatorialDistrict → LGA → Ward → PollingUnit
```

| Method | Path | Description |
|--------|------|-------------|
| GET | `/structure/states` | All Nigerian states |
| GET | `/structure/states/:stateId/lgas` | LGAs in a state |
| GET | `/structure/lgas/:lgaId/wards` | Wards in an LGA |
| GET | `/structure/wards/:wardId/polling-units` | Polling units in a ward |
| GET | `/structure/coverage?campaignId=:id` | Campaign coverage stats |

---

## Support Groups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/support-groups` | List (filterable) |
| GET | `/support-groups/:id` | Get by ID |
| POST | `/support-groups` | Create |
| PATCH | `/support-groups/:id` | Update |
| DELETE | `/support-groups/:id` | Delete |

---

## Commitments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/commitments` | List (filterable) |
| GET | `/commitments/:id` | Get by ID |
| POST | `/commitments` | Create |
| PATCH | `/commitments/:id` | Update |
| DELETE | `/commitments/:id` | Delete |

---

## Volunteers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/volunteers` | List (filterable) |
| GET | `/volunteers/:id` | Get by ID |
| POST | `/volunteers` | Create |
| PATCH | `/volunteers/:id` | Update |
| DELETE | `/volunteers/:id` | Delete |

---

## Polling Units

| Method | Path | Description |
|--------|------|-------------|
| GET | `/polling-units` | List intelligence records |
| GET | `/polling-units/:id` | Get by ID |
| POST | `/polling-units` | Create |
| PATCH | `/polling-units/:id` | Update |
| DELETE | `/polling-units/:id` | Delete |

---

## Situation Room

| Method | Path | Description |
|--------|------|-------------|
| GET | `/situation-room/updates` | List election-day updates |
| GET | `/situation-room/summary` | Aggregated status summary |
| POST | `/situation-room/updates` | Post update |
| PATCH | `/situation-room/updates/:id` | Update entry |

---

## Field Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | `/field-reports` | List reports |
| POST | `/field-reports` | Submit report |

## WhatsApp (public)

Meta Cloud API incident intake. HMAC on POST. See [WHATSAPP.md](./WHATSAPP.md).
Credentials stay unset on the Assembly droplet; the Governorship API is the live webhook.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/whatsapp/webhook` | Hub challenge |
| POST | `/whatsapp/webhook` | Inbound messages |

---

## Analytics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/analytics/overview` | Dashboard KPIs |

---

## Metrics

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/metrics` | Public | Prometheus exposition format |

---

## Error responses

| Status | Meaning |
|--------|---------|
| 400 | Validation error (invalid DTO) |
| 401 | Missing or invalid JWT |
| 403 | Insufficient role permissions |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

**Example (401):**
```json
{
  "statusCode": 401,
  "message": "Invalid or expired token"
}
```

---

## JWT payload

Access tokens contain:

```json
{
  "sub": "user-id",
  "email": "director@electromon.ng",
  "phoneNumber": "+2348000000001",
  "campaignId": "campaign-id",
  "role": "CAMPAIGN_DIRECTOR",
  "scopeType": "CAMPAIGN",
  "scopeId": "campaign-id",
  "iat": 1785029623,
  "exp": 1785030523
}
```

Access token expiry: 15 minutes  
Refresh token expiry: 7 days

---

## Default credentials

| Field | Value |
|-------|-------|
| Phone | `+2348000000001` |
| Email | `director@electromon.ng` |
| Password | `1234567890` |

Seed with: `pnpm db:seed`
