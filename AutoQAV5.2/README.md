# 🤖 Chatbot QA Automation

Automated chatbot testing system built with **Playwright** + **Node.js** + **Google Docs API**.

---

## 📁 Project Structure

```
chatbot-qa-automation/
├── src/
│   ├── index.js                  ← Main entry point
│   ├── config/
│   │   └── index.js              ← .env loader & config object
│   ├── modules/
│   │   ├── docsClient.js         ← Google Docs table read/write + colour
│   │   ├── browserController.js  ← Playwright session & chatbot interaction
│   │   ├── classifier.js         ← Similarity scoring & PASS/PARTIAL/FAIL logic
│   │   ├── screenshotHandler.js  ← Screenshot capture & folder routing
│   │   ├── testRunner.js         ← Retry orchestration per test case
│   │   └── reporter.js           ← Console summary + HTML report
│   └── utils/
│       └── logger.js             ← Winston structured logger
├── credentials/
│   └── google-service-account.json   ← ⚠ NOT committed to git
├── screenshots/
│   ├── pass/                     ← (unused — screenshots only for PARTIAL/FAIL)
│   ├── partial/
│   └── fail/
├── logs/
│   ├── combined.log
│   ├── error.log
│   └── run_YYYYMMDD_HHmmss.log   ← Per-run log
├── reports/
│   └── report_YYYYMMDD_HHmmss.html
├── .env                          ← Your config (copy from .env.example)
├── .env.example                  ← Template
├── .gitignore
└── package.json
```

---

## ⚙️ Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18.0.0 |
| npm | ≥ 9.0.0 |
| Google Account | with Docs API enabled |
| VPN | Connected manually before running |

---

## 🚀 Step-by-Step Installation Guide

### Step 1 — Clone / download the project

```bash
cd ~/projects
# If using git:
git clone <your-repo-url> chatbot-qa-automation
cd chatbot-qa-automation

# Or just navigate to the folder if you downloaded it manually
```

---

### Step 2 — Install Node.js dependencies

```bash
npm install
```

---

### Step 3 — Install Playwright browser (Chromium only)

```bash
npm run install:browsers
# This downloads the Chromium binary Playwright needs (~170 MB)
```

---

### Step 4 — Set up Google Docs API

#### 4a. Enable the Docs API
1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or select existing)
3. Navigate to **APIs & Services → Library**
4. Search **"Google Docs API"** → Click **Enable**

#### 4b. Create a Service Account
1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → Service Account**
3. Name it (e.g. `chatbot-qa-bot`) → Click **Done**
4. Click the service account → **Keys tab → Add Key → JSON**
5. Download the JSON file

#### 4c. Save the key file
```bash
mkdir -p credentials
# Move the downloaded JSON to:
mv ~/Downloads/your-key-file.json credentials/google-service-account.json
```

#### 4d. Share your Google Doc with the service account
1. Open your Google Doc
2. Click **Share**
3. Paste the service account email (looks like: `chatbot-qa-bot@your-project.iam.gserviceaccount.com`)
4. Set role to **Editor** → Click **Send**

---

### Step 5 — Prepare your Google Doc table

The script skips non-table content and reads the first tables with these headers:

| Test case ID | Description | Precondition | Test Steps | Expected Result | Actual Result | Status | Remark |
|---|---|---|---|---|---|---|---|
| TRD_AI_001 | เปิดใช้ Chatbot | เข้าเว็บไซต์ | 1. เข้า Website<br>2. คลิก Bubble Chatbot<br>3. ถามด้วยคำถาม<br>- คำถาม<br>4. กดปุ่มส่ง | AI Chatbot สามารถตอบคำถามถูกต้อง<br>- คำตอบที่คาดหวัง | | | |

`Test Steps` is parsed from the text after `-` and stops at the `4.` step in that same cell. `Expected Result` is parsed from the text after `-` until the end of that cell. Results are written to `Remark`, and status is written to `Status`.

---

### Step 6 — Configure the .env file

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```dotenv
# ── Required ──────────────────────────────────────────────────
# Get this from the document URL: /document/d/THIS_PART/edit
GOOGLE_DOCUMENT_ID=1WYdfrT_Xz0AirI-OcpDlAhtAjAlkeSqXyGghj-FENKo

CHATBOT_URL=https://your-chatbot.internal.example.com

# ── Chatbot selectors (inspect element to find these) ─────────
CHATBOT_INPUT_SELECTOR=textarea[placeholder*="พิมพ์"]
CHATBOT_SEND_SELECTOR=button[aria-label="Send"]
CHATBOT_RESPONSE_SELECTOR=.message.bot-message
CHATBOT_LOADING_SELECTOR=.typing-dots

# ── Tune these to your chatbot's speed ────────────────────────
RESPONSE_WAIT_TIMEOUT=30000
RESPONSE_FINISH_TIMEOUT=90000
RESPONSE_STABLE_DURATION=3000
MAX_RETRIES=3

# ── For production: headless=true, for debugging: headless=false
HEADLESS=true
```

---

### Step 7 — Find your chatbot's CSS selectors

Run this in your browser DevTools console while on the chatbot page:

```javascript
// 1. Find the input box
document.querySelector('textarea')       // try this first
document.querySelector('input[type=text]')

// 2. Find the send button
document.querySelector('button[type=submit]')
document.querySelector('button[aria-label*="send" i]')

// 3. Find response bubbles (pick the selector that matches BOT messages only)
document.querySelectorAll('.message')
document.querySelectorAll('[class*="bot"]')
document.querySelectorAll('[class*="response"]')
```

Copy the selectors into your `.env`.

---

## ▶️ Running the Tests

### Connect VPN first
```bash
# Connect your VPN manually (GlobalProtect, Cisco AnyConnect, etc.)
# Verify: ping your chatbot's internal IP
```

### Run all test cases
```bash
npm test
```

### Dry run (reads Google Docs but does NOT write results back)
```bash
npm run test:dry
```

---

## 📊 Understanding Results

### Classification Logic

| Status | Colour | Condition |
|--------|--------|-----------|
| **PASS** | 🟢 Green | Blended similarity ≥ 65% |
| **PARTIAL** | 🟡 Yellow | 30% ≤ similarity < 65% |
| **FAIL** | 🔴 Red | similarity < 30% OR fail keyword detected OR timeout |

**Blended similarity** = Dice coefficient (50%) + Jaccard word-overlap (30%) + containment bonus (20%)

**Automatic FAIL keywords** (configurable in `.env`):
- `ไม่มีข้อมูล`
- `ไม่พบข้อมูล`
- `ขออภัย ไม่สามารถ`
- `sorry i don't know`
- `i don't have information`

### Retry Logic

```
Attempt 1 → FAIL/timeout → wait 3s → reload page
Attempt 2 → FAIL/timeout → wait 3s → reload page
Attempt 3 → FAIL/timeout → mark as FAIL (no more retries)
```

Retries are triggered by:
- Timeout waiting for response
- Empty response
- Any unexpected browser error

### Screenshots

| Status | Screenshot taken? | Saved to |
|--------|------------------|----------|
| PASS | ❌ No | – |
| PARTIAL | ✅ Yes | `screenshots/partial/` |
| FAIL | ✅ Yes | `screenshots/fail/` |

---

## 🐛 Troubleshooting

### "Missing required environment variable: GOOGLE_DOCUMENT_ID"
→ Make sure `.env` file exists and is not `.env.example`

### "Sheet tab 'TestCases' not found"
→ Change `GOOGLE_SHEET_NAME` in `.env` to match your actual tab name

### "Timeout: no new response appeared"
→ Increase `RESPONSE_WAIT_TIMEOUT` in `.env`
→ Check `CHATBOT_RESPONSE_SELECTOR` is correct

### Browser opens but chatbot not loading
→ Check VPN is connected
→ Set `HEADLESS=false` to watch the browser

### Google Docs write permission denied
→ Confirm the service account email has **Editor** access to the document

---

## 📝 Logs

```
logs/
├── combined.log        ← All logs (DEBUG+)
├── error.log           ← Errors only
└── run_20240526_143022.log  ← This specific run
```

---

## 🔧 Advanced Configuration

### Adjusting similarity thresholds

```dotenv
# Stricter — only very close answers pass
SIMILARITY_PASS_THRESHOLD=0.80
SIMILARITY_PARTIAL_THRESHOLD=0.50

# Looser — partial credit is more generous
SIMILARITY_PASS_THRESHOLD=0.55
SIMILARITY_PARTIAL_THRESHOLD=0.25
```

### Adding more fail keywords

```dotenv
FAIL_KEYWORDS=ไม่มีข้อมูล,ไม่พบข้อมูล,ขออภัย ไม่สามารถ,ระบบขัดข้อง,error occurred
```

### Debug mode (slow, visible browser)

```dotenv
HEADLESS=false
SLOW_MO=300
```
# testchatbot
