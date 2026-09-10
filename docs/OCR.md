# How EC8A photo reading works

Electromon uses two checks on polling-unit results. They are **recommendations** for ward/LGA officers. Officers still approve or return by hand.

1. **Arithmetic** — always runs. It checks that typed figures obey EC8A identities (party totals = valid votes, used = spoiled + rejected + valid, and so on).
2. **AI photo reading** — optional. Uses the OpenRouter vision model (`AI_OCR_MODEL`) via the AI module to read digits from the EC8A photo and compare them to what the agent typed. This replaced Google Cloud Vision, which was too inaccurate on handwritten sheets.

If `OPENROUTER_API_KEY` is not set, agents see `AI photo reading is not configured` on **Read photo again**. Arithmetic chips still work.

---


## Two jobs photo reading does

| Job | When | What happens |
|-----|------|----------------|
| **Auto-fill** | Agent uploads a photo on **My Polling Unit** | API reads the image with AI and the web form fills **Check figures** |
| **Verify** | Agent submits the PU result | A background job reads the photo again and stores a chip: Match / Return / Check photo |

Auto-fill does **not** submit the result. The agent must still review, edit if needed, save, and submit.
---

## Agent flow (web)

```
Upload EC8A  →  POST /uploads
             →  PATCH /collation/results/:id/ec8a   (attach photo)
             →  POST /collation/ec8a/scan           { photoUrl }
             →  form auto-fills fields + party votes
             →  agent reviews on Check figures
             →  POST /collation/results             (draft)
             →  PATCH /collation/results/:id/submit
```

`POST /collation/ec8a/scan` takes a photo that is already on disk (`/uploads/...`). JPEG/PNG, wait up to ~25s. PDFs are not read.

### Mobile (one call)

```
POST /collation/ec8a/scan-file   multipart field `file` (max 5 MB)
→ { photoUrl, fields, partyResults, confidence, unreadable }
→ agent edits → POST /collation/results → PATCH .../submit
```

Base URL locally: `http://localhost:3001/api/v1`. On a phone, use the LAN URL printed at API boot.

---

## What the parser reads

Vision returns raw text. `ocr-ec8a-parse.ts` turns that into numbers.

### Summary boxes (#1–#8)

The form’s numbered boxes are clustered, then filled in order:

| Box | Field |
|-----|--------|
| #1 | Voters on the register |
| #2 | Accredited voters |
| #3 | Ballot papers issued |
| #4 | Unused ballot papers |
| #5 | Spoiled ballot papers |
| #6 | Rejected ballots |
| #7 | Total valid votes |
| #8 | Used ballot papers |

The parser does **not** treat a lone `#2` or a serial number as a vote count. It looks for the boxed group and for labels like “accredited voters”.

Vision also returns **word boxes** (x/y). When those are present, the parser reads the form as a grid: `#1`–`#8` values in the right-hand column, and each party row as serial → code → figures → words. That is how a slightly rotated, handwritten EC8A is read instead of flattening the table into one text blob.

### Party votes

Prefer the **IN WORDS** column (fifty-nine, one hundred and two, including OCR typos like `fiftinine`, `ninty`, `seventh four`, `tho`). If words are missing, fall back to the figures column next to party codes (APC, PDP, …). A handwritten `O` in a number box is 0.

Campaign tracked-party codes are used as a last pass so extra parties still get a number when the table parse is thin.

### Confidence

- `unreadable: true` if nothing useful was extracted (or Vision is off / timed out).
- Confidence is `1` only when EC8A identities hold on the extracted numbers (party sum = valid votes, or used = spoiled + rejected + valid). Otherwise it is capped at `0.65`.
- The agent form auto-fills only when confidence is **≥ 0.75**. A clear photo that still parses as serial numbers / LGA codes (party scores ≠ valid votes) is **not** written into Check figures — the agent must type them.

Party table parsing prefers **IN WORDS** over the figures column, and ignores a figure that is the row’s serial number (e.g. SN `4` / ADC / `4` with words ZERO is 0 votes, not 4). Location codes (`03`, `29`, `016`) are not used as register/accredited totals.

---

## Arithmetic identities

These run on **typed** figures (and on seed data) even without Vision:

| Check | Meaning |
|-------|---------|
| Accredited ≤ registered | Cannot accredit more people than are on the register |
| Sum of party scores = total valid votes | EC8A party table vs box #7 |
| Used = spoiled + rejected + valid | Box #8 vs #5 + #6 + #7 |
| Issued = used + unused | Box #3 vs #8 + #4 |
| Accredited = used ballots | Box #2 vs #8 |

A failed check sets `recommendation: RETURN` and fills `suggestedRejectReason` for the ward return form.

---

## Stored verification (`ocrVerification` JSON)

Saved on `CollationResult` with `ocrVerifiedAt`.

| Field | Values |
|-------|--------|
| `status` | `MATCH` · `MISMATCH` · `UNREADABLE` · `PENDING` |
| `recommendation` | `APPROVE` · `RETURN` · `CHECK_PHOTO` |
| `engine` | `ARITHMETIC` (typed identities only) or `OCR` (photo compared) |

**Recommendations**

- **APPROVE** — figures line up (and photo matches, if OCR ran).
- **RETURN** — identities fail, or typed numbers disagree with the photo. Ward UI prefills the return reason.
- **CHECK_PHOTO** — no figures yet, photo unreadable, Vision missing, or OCR still queued.

On submit, if there is a photo and arithmetic is not already `RETURN`, status is set to `PENDING` / `CHECK_PHOTO` (`OCR_PENDING`) until the worker finishes.

---

## Background OCR (after submit)

```
submit PU result
  → ocrVerificationWrite(..., awaitingOcr: true)
  → publish job to RabbitMQ queue `ocr.verify`
  → OcrVerifyWorker:
       arithmetic on typed row
       Vision on attached photos
       mergeVisionWithArithmetic()
       persist JSON
```

If RabbitMQ is down, the same worker still runs in-process via the event bus.

Merge rules:

- Arithmetic diffs always stay.
- If Vision is unreadable / not configured, keep arithmetic; recommendation is `CHECK_PHOTO` unless arithmetic already says `RETURN`.
- If Vision reads a field (or party) that differs from typed, add an OCR mismatch diff.

Ward and LGA screens sort flagged PUs first (`RETURN`, then `CHECK_PHOTO`, then match).

---

## Code map

| Piece | Path |
|-------|------|
| Photo reader (AI) | `src/modules/collation/ec8a-photo-reader.service.ts` |
| OpenRouter client | `src/modules/ai/core/llm/openrouter.client.ts` (`task: 'ocr'`) |
| Legacy text/layout parser | `src/modules/collation/ocr-ec8a-parse.ts` (still used to merge AI extract vs typed) |
| Text → fields / parties | `src/modules/collation/ocr-ec8a-parse.ts` |
| Identities + JSON shape | `src/modules/collation/ocr-verification.ts` |
| Scan + submit + queue | `src/modules/collation/collation.service.ts` |
| HTTP | `POST /collation/ec8a/scan`, `POST /collation/ec8a/scan-file` |
| Queue | `ocr-queue.service.ts`, `ocr-verify.worker.ts` |
| Agent UI | `electromon-web` → My Polling Unit → Upload EC8A / Check figures |
| Officer UI | `verification-chip.tsx`, ward PU panel, LGA review |

Prisma: `CollationResult.ocrVerification` (JSONB), `ocrVerifiedAt`.

---

## Environment

The API container must receive an OpenRouter key (Compose `apps.yml` passes these through):

```bash
OPENROUTER_API_KEY=sk-or-...
# Optional dedicated vision model (recommended):
AI_OCR_MODEL=google/gemini-2.5-flash
# Falls back to AI_MODEL, then google/gemini-2.5-flash
```

Without `OPENROUTER_API_KEY`, boot log:

`OPENROUTER_API_KEY is not set; EC8A photo reading is disabled`

With a key:

`EC8A photo reader ready (AI OCR model: google/gemini-2.5-flash)`

---

## What photo reading does not do

- It does not approve or reject a result.
- It does not skip the agent review step.
- It does not read PDFs.
- It is not a substitute for looking at the photo when the chip says **Check photo**.
- Seed demos (ATAFI `17-13-01-001` … `005`) use **arithmetic profiles** (match / party mismatch / used mismatch / accredited-over). They do not need AI photo reading.
