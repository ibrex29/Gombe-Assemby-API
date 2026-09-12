# WhatsApp incident intake (Termii)

Registered field agents can text, voice-note, or photo an incident to the
campaign WhatsApp number hosted on **Termii**. Electromon creates the same
`FieldReport` records the dashboard already uses. Result sheets stay on **My Unit**.

**Live webhook:** Governorship API only
(`https://api.pantamiyya.alphabetandnumbers.com/api/v1/whatsapp/webhook`).
Keep Termii env vars **unset** on the Assembly droplet.

## Flow

```
agent WhatsApp  →  Termii  →  POST /whatsapp/webhook
                                 │ HMAC-SHA512 + persist inbound
                                 ▼
                          WhatsAppInboundWorker
                                 │ phone → membership
                                 ▼
                          FieldReportsService.create
```

## Environment (Governorship only)

```
TERMII_API_KEY=
TERMII_SECRET_KEY=          # dashboard secret; used to verify X-Termii-Signature
TERMII_DEVICE_ID=           # WhatsApp device name / ID on Termii (the `from` when we reply)
TERMII_BASE_URL=https://v3.api.termii.com
# WHATSAPP_CAMPAIGN_ID=     # optional if a phone could match more than one campaign
```

`TERMII_SECRET_KEY` is **not** the API key. Find it on the Termii dashboard
(API / secret key). If it is unset we fall back to signing with `TERMII_API_KEY`.

Do not commit keys. Rotate any key that was pasted in chat.

## Termii dashboard

1. Developer console → add webhook URL  
   `https://api.pantamiyya.alphabetandnumbers.com/api/v1/whatsapp/webhook`
2. Connect the WhatsApp device and copy its **device ID / name** into `TERMII_DEVICE_ID`.
3. Agents WhatsApp that number. Their Electromon phone must be E.164 `+234…`.

Replies use `POST /api/sms/send` with `channel: "whatsapp"`.

## Agent behaviour

| Inbound | Result |
|---------|--------|
| Text | Incident; type/severity classified from the message |
| Photo / media URL | `photoUrls` when Termii includes a media URL |
| Voice / audio URL | `audioUrl`; existing voice STT + classifier |
| `help` / `hi` / `start` | Instructions; no record |
| Unregistered number | “not registered” reply; no record |
| Delivery reports / device status | Ignored |

## Ops

1. Set env on the Governorship droplet and restart the API.
2. Apply the WhatsApp inbound migration if it is not already on the database.
3. Point Termii at the webhook URL above.
4. Leave Assembly Termii env unset.
