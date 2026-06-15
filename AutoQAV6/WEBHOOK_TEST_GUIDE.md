# Webhook QA Test Runner — Guide

A standalone runner that tests the **PromptX (น้องรักษ์)** chatbot by sending
questions from the Google Sheet to the webhook gateway, scoring each answer
PASS/PARTIAL/FAIL, and saving the results to `output/`.

Script: [`run_webhook_test.js`](run_webhook_test.js)

---

## 1. Why this exists (vs `npm test`)

The gateway streams its answer as **Server-Sent Events (SSE)**, not plain JSON.
The project's built-in `src/modules/webhookClient.js` expects a JSON
`{ "answer": ... }` response, so it **cannot read this endpoint**. This runner
parses the SSE stream itself, and also:

- reads questions directly from **all tabs** of the sheet (auto-detecting columns,
  since the tabs have inconsistent layouts),
- reuses the project's own classifier (`src/modules/classifier.js`) for scoring,
- writes only to `output/` — it **never modifies your Google Sheet**.

---

## 2. How it works

```
Google Sheet (all tabs)
   │  read question + expected answer  (auto-detect columns per tab)
   ▼
For each question:
   │  POST to gateway:  { sessionId, sender, content, source }
   ▼
Gateway streams SSE:  data: {type:"stream_chunk", chunk:"..."} ...
   │  parse + concatenate chunks  →  the bot's answer
   ▼
Classifier:  compare answer vs expected  →  PASS / PARTIAL / FAIL + similarity
   ▼
Save to output/webhook_test_<timestamp>.json  (checkpointed every 25 calls)
```

### The webhook contract

**Request** (`POST https://uat-promptx.treasury.go.th/api_gateway/uat/send`):

```json
{
  "sessionId": "q1a2b3",
  "sender":    "qa-bot",
  "content":   "<the question text>",
  "source":    "external"
}
```

- `source` **must** be `"external"` or `"internal"` (nothing else is accepted).
- ⚠️ **`sessionId` must stay short (≤ ~45 characters).** The gateway returns
  `HTTP 500 "No response from webhook"` for longer sessionIds. The runner uses a
  short id (`q{runTag}{index}`, ~10 chars) to stay safely under this limit.
  *(This was the cause of the mass failures in early runs — long testIds like
  `State_Property__TRD_AI_123` pushed the sessionId over the limit.)*

**Response** is an SSE stream; the answer text is the concatenation of the
`stream_chunk` events' `chunk` fields.

### Scoring (classifier)

Each answer is scored against the sheet's *expected* answer using **bigram-recall
of the expected** (how much of the ground-truth content the bot covered — robust
to verbose answers), plus token/number containment.

| Verdict | Meaning |
|---|---|
| ✅ **PASS** | similarity ≥ `0.65` (set by `SIMILARITY_PASS_THRESHOLD` in `.env`) |
| ⚠️ **PARTIAL** | similarity ≥ `0.30`, OR answer has a wrong number/date, OR no expected answer in the sheet (needs manual review) |
| ❌ **FAIL** | similarity < `0.30`, an error/"no data" answer, or the request failed |

---

## 3. Prerequisites

1. **Node 22** (via nvs):
   ```powershell
   nvs use 22
   ```
2. **`.env`** in `AutoQAV6/` with at least:
   ```ini
   GOOGLE_SPREADSHEET_ID=1-TTKQrLLoXO4dgUBfqn0GKaFTvIKwGzAQUkTO-h175o
   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./credentials/<your-key>.json
   WEBHOOK_URL=https://uat-promptx.treasury.go.th/api_gateway/uat/send
   SIMILARITY_PASS_THRESHOLD=0.65
   SIMILARITY_PARTIAL_THRESHOLD=0.30
   ```
3. **Service-account key** at the path above, and the service account's
   `client_email` must have **read access** to the spreadsheet.

---

## 4. How to run

Run all commands from the `AutoQAV6/` folder.

### Smoke test (recommended first) — 5 questions per tab
```powershell
node run_webhook_test.js
```

### One tab only
```powershell
node run_webhook_test.js --tab="General"
node run_webhook_test.js --tab="General" --all      # every question in that tab
```

### Full run — every question, every tab
```powershell
node run_webhook_test.js --all
```

### Choose the source
```powershell
node run_webhook_test.js --all --source=internal    # internal only
node run_webhook_test.js --all --source=external     # external only (default)
node run_webhook_test.js --all --source=both         # test each question on both
```

### Tuning flags

| Flag | Default | Purpose |
|---|---|---|
| `--limit=N` | `5` | questions per tab (ignored with `--all`) |
| `--all` | off | run every question (overrides `--limit`) |
| `--tab="Name"` | all tabs | restrict to one tab |
| `--source=` | `external` | `external` \| `internal` \| `both` |
| `--delay=ms` | `1500` | pause between calls (use `3000`+ for big runs) |
| `--timeout=ms` | `90000` | per-request timeout |
| `--retries=N` | `2` | retries per question on failure (exp. backoff) |
| `--cooldown-after=N` | `8` | failures-in-a-row before a cooldown pause |
| `--cooldown=ms` | `60000` | how long to pause when failing repeatedly |
| `--max-dead-cooldowns=N` | `2` | give up the run if the server won't recover |

**Recommended for a large run** (gentle + resilient):
```powershell
node run_webhook_test.js --all --source=internal --delay=3000
```

> The bot is slow (some answers take 30s+), so a full run takes a few hours.
> The runner **checkpoints every 25 calls** and **auto-stops** if the server
> stops responding, so progress is never lost and it won't run dead for hours.

---

## 5. Retry the failed questions

If a run was interrupted or some calls failed (server hiccup, timeout), you don't
re-run everything — use **retry mode**. It scans the prior result files, finds
every question that **never got a real answer**, skips the ones already answered,
and re-runs only the rest.

### Retry everything that failed (both sources)
```powershell
node run_webhook_test.js --retry-failed --delay=3000
```

### Retry only one source
```powershell
node run_webhook_test.js --retry-failed --source=internal --delay=3000
node run_webhook_test.js --retry-failed --source=external --delay=3000
```

**How it works:**
- It reads every `output/webhook_test_*.json` from full runs.
- A question counts as "answered" if it got a real response anywhere → **skipped**.
- A question counts as "failed" if it only ever had a request error / empty answer
  → **retried**.
- Results go to a **new** `output/webhook_test_<timestamp>.json`.
- **Re-runnable**: each retry re-scans all files (including previous retries), so
  you can run it repeatedly and it keeps shrinking the failed set until none remain.

Typical loop until everything is recovered:
```powershell
node run_webhook_test.js --retry-failed --source=internal --delay=3000
# ...wait for it to finish or auto-stop, then run again to pick up the rest:
node run_webhook_test.js --retry-failed --source=internal --delay=3000
```

---

## 6. Output files

Each run writes one file: `output/webhook_test_<timestamp>.json`

```jsonc
{
  "generatedAt": "2026-06-15T...",
  "endpoint":    "https://uat-promptx.treasury.go.th/api_gateway/uat/send",
  "sources":     ["internal"],
  "complete":    true,            // false if interrupted or auto-stopped early
  "progress":    "3145/3145",
  "summary": {                    // counts per source
    "internal": { "PASS": 0, "PARTIAL": 0, "FAIL": 0 }
  },
  "results": [
    {
      "tab": "General", "testId": "General__TRD_AI_01", "source": "internal",
      "question": "...", "expected": "...", "actual": "<bot answer>",
      "status": "PASS", "similarity": 0.9, "reason": "...",
      "latencyMs": 5300, "attempts": 1, "error": null
    }
  ]
}
```

- `error: null` + a non-empty `actual` → a **real, scored** result.
- `error` set (e.g. `HTTP 500...`, `Timeout`) → the call **failed**; this question
  is what `--retry-failed` will pick up next time.

To consolidate/merge multiple result files into a single report, see
[`consolidate.js`](consolidate.js).

---

## 7. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `HTTP 500 "No response from webhook"` on many calls | sessionId too long (fixed: runner now uses short ids) **or** the gateway is overloaded/down — wait and use `--retry-failed`. |
| `HTTP 422` | Payload missing/invalid field. The 4 required fields are `sessionId, sender, content, source`, and `source` must be `external`/`internal`. |
| All results `❌ Empty answer` / `Request failed` | Server is down. The run will auto-stop after 2 dead cooldowns — re-run later with `--retry-failed`. |
| `Missing required environment variable` | Set `GOOGLE_SPREADSHEET_ID` and key path in `.env`. |
| `node: command not found` | Activate Node first: `nvs use 22`. |
| Lots of PARTIAL "needs manual review" | Those rows have a **blank expected** answer in the sheet, so correctness can't be scored automatically. |
