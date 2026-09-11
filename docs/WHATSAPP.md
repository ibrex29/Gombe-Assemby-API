# WhatsApp incident intake

Registered field agents can text, voice-note, or photo an incident to the
campaign WhatsApp Business number. Electromon creates the same `FieldReport`
records the dashboard already uses. Result sheets stay on **My Unit**.

**Live webhook:** Governorship API only
(`https://api.pantamiyya.alphabetandnumbers.com/api/v1/whatsapp/webhook`).
Incidents are campaign-scoped, so the Assembly dashboard reads them from the
shared database. Keep WhatsApp env vars **unset** on the Assembly droplet.

## Flow

```
agent WhatsApp  →  Meta Cloud API  →  POST /whatsapp/webhook
                                         │ HMAC + persist inbound
                                         ▼
                                  WhatsAppInboundWorker
                                         │ phone → membership
                                         ▼
                                  FieldReportsService.create
                                         │
                    voice ───────────────┼─────────────── text / caption
                    existing STT worker  │  shared classifier
                                         ▼
                                  Incident desk / map / notifications
```

The webhook returns 200 after persisting the inbound row. Classification and
media download happen asynchronously.

## Agent behaviour

| Inbound | Result |
|---------|--------|
| Text | Incident; type/severity classified from the message |
| Photo (+ optional caption) | `photoUrls`; caption classified when present |
| Voice note | `audioUrl`; existing voice STT + classifier |
| Location | lat/long on the report |
| `help` / `hi` / `start` | Instructions; no record |
| Unregistered number | “not registered” reply; no record |
| Video / document / sticker | Ask for text, photo, or voice |

Identity is the sender’s phone against `users.phoneNumber` (E.164 `+234…`).
Polling-unit agents get `pollingUnitId` from their membership. Duplicate Meta
`wamid` values are no-ops.

## Endpoints

Public (no JWT). Throttling skipped — Meta retries bursts.

### GET `/api/v1/whatsapp/webhook`

Meta hub challenge. Requires `WHATSAPP_VERIFY_TOKEN`.

### POST `/api/v1/whatsapp/webhook`

Signed with `X-Hub-Signature-256` (`WHATSAPP_APP_SECRET`). Requires
`WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` or returns 503.

## Environment

Set these on the **Governorship** droplet only:

```
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_GRAPH_VERSION=v21.0
# WHATSAPP_CAMPAIGN_ID=   # optional if a phone could match more than one campaign
```

Webhook URL in Meta: `https://api.pantamiyya.alphabetandnumbers.com/api/v1/whatsapp/webhook`
Subscribe to `messages`.

## Ops checklist

1. Meta Business + WhatsApp Cloud API number; app in Live mode.
2. Point the webhook at the Governorship URL; subscribe to `messages`.
3. Agent phones in Electromon must match WhatsApp (E.164).
4. Leave Assembly WhatsApp env unset.
