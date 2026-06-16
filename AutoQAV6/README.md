# 🤖 Chatbot QA Automation v6

Automated chatbot testing via **Webhook API** + **Message Queue** + **Google Docs/Sheets**.

> อัปเกรดจาก v5.2: ส่งคำถามผ่าน API Webhook แทนการกรอกหน้าเว็บ Playwright (ยังรองรับโหมด browser ได้)

---

## 🆕 สิ่งที่เปลี่ยนใน v6

| ฟีเจอร์ | v5.2 | v6 |
|--------|------|-----|
| ส่งคำถาม | Playwright กรอกหน้าเว็บ | **HTTP Webhook API** |
| ควบคุมจังหวะ | พัก 500ms ระหว่างข้อ | **Message Queue 30 วินาที/ข้อ** |
| Timeout | ตาม RESPONSE_* config | **Hard cut 2 นาที/ข้อ** |
| Error handling | Retry + reload | **Log + ดึงคิวถัดไปต่อ (ไม่หยุดระบบ)** |

---

## 📁 Project Structure

```
AutoQAV6/
├── src/
│   ├── index.js                     ← Main entry (3 phases)
│   ├── config/index.js              ← .env loader
│   ├── modules/
│   │   ├── webhookClient.js         ← 🆕 ส่งคำถามผ่าน API
│   │   ├── webhookTestRunner.js     ← 🆕 รัน test + timeout 2 นาที
│   │   ├── messageQueue.js          ← 🆕 FIFO queue + rate limit 30s
│   │   ├── docsClient.js            ← Google Docs read/write
│   │   ├── sheetsClient.js          ← Google Sheets read/write
│   │   ├── browserController.js     ← Legacy Playwright mode
│   │   ├── testRunner.js            ← Legacy browser test runner
│   │   ├── classifier.js            ← PASS/PARTIAL/FAIL logic
│   │   └── ...
│   └── utils/
│       ├── withTimeout.js           ← 🆕 Hard timeout wrapper
│       └── logger.js
├── .env.example
└── package.json
```

---

## ⚙️ Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18.0.0 |
| npm | ≥ 9.0.0 |
| Google Account | Docs/Sheets API enabled |
| Chatbot Webhook API | URL + credentials (ใส่ภายหลัง) |

---

## 🚀 การติดตั้ง

```bash
cd AutoQAV6
npm install
cp .env.example .env
# แก้ไข .env ตามคำแนะนำด้านล่าง
```

---

## 🔧 การตั้งค่าระบบ (สำคัญ)

### 1. Webhook API (Phase 2 — ส่งคำถาม)

เมื่อได้รับ URL และรายละเอียด API จากทีม Backend ให้ตั้งค่าใน `.env`:

```dotenv
TRANSPORT_MODE=webhook
WEBHOOK_ENABLED=true
WEBHOOK_URL=https://your-api.example.com/chatbot/ask

# Authentication
WEBHOOK_AUTH_TYPE=bearer          # none | bearer | api-key | basic
WEBHOOK_AUTH_TOKEN=your_token_here

# Request/Response mapping
WEBHOOK_QUESTION_FIELD=question   # field ที่ส่งคำถาม
WEBHOOK_RESPONSE_FIELD=answer     # path ใน response (รองรับ dot notation เช่น data.answer)
WEBHOOK_METHOD=POST
```

**Custom payload** (ถ้า API ใช้ format พิเศษ):

```dotenv
WEBHOOK_PAYLOAD_TEMPLATE={"message":"{{question}}","sessionId":"{{sessionId}}","testId":"{{testId}}"}
WEBHOOK_SESSION_ID=qa-automation-session-001
```

**Extra headers**:

```dotenv
WEBHOOK_EXTRA_HEADERS={"X-Tenant-Id":"your-tenant","X-Request-Source":"autoqa-v6"}
```

### 2. Message Queue (Rate Limiting)

```dotenv
# ระยะห่าง 30 วินาทีระหว่างคำถาม (ค่าเริ่มต้น)
QUEUE_RATE_LIMIT_MS=30000

# Timeout 2 นาทีต่อคำถาม — ตัดทันทีถ้าเกิน
QUEUE_PROCESSING_TIMEOUT_MS=120000

# HTTP timeout ต่อ request (ต้อง < processing timeout)
WEBHOOK_REQUEST_TIMEOUT_MS=55000
```

### 3. Google Docs/Sheets (Phase 1 & 3)

ตั้งค่าเหมือน v5.2:

```dotenv
GOOGLE_DOCUMENT_ID=your_document_id
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./credentials/google-service-account.json
```

### 4. Limit questions per topic

To run only the first 100 questions per topic/table/sheet, keep the default:

```dotenv
MAX_QUESTIONS_PER_TOPIC=100
```

Set it to `0` if you want to disable the cap.

### 5. Legacy Browser Mode (ถ้าต้องการใช้ Playwright)

```dotenv
TRANSPORT_MODE=browser
CHATBOT_URL=https://your-chatbot-url.example.com
CHATBOT_INPUT_SELECTOR=textarea
CHATBOT_SEND_SELECTOR=button[type="submit"]
CHATBOT_RESPONSE_SELECTOR=.message.bot
HEADLESS=true
```

---

## ▶️ การรัน

### Workflow มาตรฐาน (Webhook)

```bash
# 1. ดึง test cases จาก Google Docs/Sheets
npm test -- --extract-only

# 2. เลือก dataset
npm run config

# 3. รันเต็มรอบ (Webhook → Checkpoint → Write back)
npm test

# 4. รันต่อจาก checkpoint
npm run test:resume

# 5. รัน webhook เท่านั้น (ไม่ write กลับ)
npm run test:webhook-only
```

### คำสั่งอื่นๆ

```bash
npm run test:dry              # ไม่ write กลับ Docs/Sheets
npm run test:browser          # ใช้ Playwright แทน Webhook
npm run test:sheets           # ใช้ Google Sheets
npm run test:docs-only        # Write checkpoint → Docs เท่านั้น
```

### CLI Flags

| Flag | คำอธิบาย |
|------|----------|
| `--extract-only` | Phase 1 เท่านั้น |
| `--skip-extract` | ข้าม Phase 1 |
| `--resume` | รันต่อจาก checkpoint |
| `--reset` | ลบ checkpoint |
| `--webhook-only` | Phase 2 เท่านั้น |
| `--use-browser` | ใช้ Playwright (v5.2) |
| `--dry-run` | ไม่ write กลับ |
| `--start-from=ID` | เริ่มจาก test ID |

---

## 🔄 Architecture Flow

```
Phase 1: EXTRACTION
  Google Docs/Sheets → dataset.json

Phase 2: WEBHOOK + QUEUE
  ┌─────────────────────────────────────────┐
  │  MessageQueue (FIFO)                    │
  │  ├─ Job 1 → WebhookClient.sendQuestion()│
  │  │           └─ withTimeout(2 min)       │
  │  ├─ wait 30s (rate limit)              │
  │  ├─ Job 2 → ...                        │
  │  └─ on timeout/error → log FAIL → next │
  └─────────────────────────────────────────┘
  → checkpoint.json

Phase 3: WRITE
  checkpoint → Google Docs/Sheets
```

---

## ⏱ Timeout & Error Handling

เมื่อคำถามใดใช้เวลาเกิน **2 นาที**:

1. ระบบตัดการทำงานทันที (`ProcessingTimeoutError`)
2. บันทึก error ลง `logs/error.log` และ `logs/combined.log`
3. บันทึกผลเป็น **FAIL** ใน checkpoint
4. รอ **30 วินาที** แล้วประมวลผลคำถามถัดไป
5. ระบบ **ไม่หยุดชะงัก** — ดำเนินการต่อจนครบคิว

---

## 📊 Classification (เหมือน v5.2)

| Status | Condition |
|--------|-----------|
| **PASS** | Similarity ≥ 65% |
| **PARTIAL** | 30% ≤ similarity < 65% |
| **FAIL** | similarity < 30%, fail keyword, หรือ timeout |

---

## 📝 Logs

```
logs/
├── combined.log
├── error.log
└── run_YYYYMMDD_HHmmss.log
```

---

## 🐛 Troubleshooting

| ปัญหา | แก้ไข |
|-------|-------|
| `WEBHOOK_URL is not configured` | ใส่ URL ใน `.env` |
| `Backend timeout exceeded 120000ms` | ตรวจสอบ API backend หรือเพิ่ม `QUEUE_PROCESSING_TIMEOUT_MS` |
| `Webhook returned HTTP 401` | ตรวจสอบ `WEBHOOK_AUTH_TYPE` และ `WEBHOOK_AUTH_TOKEN` |
| `ยังไม่ได้เลือก Dataset` | รัน `npm run config` |
| ต้องการโหมดเดิม | ตั้ง `TRANSPORT_MODE=browser` และ `CHATBOT_URL` |

---

## 📋 Checklist ก่อน Production

- [ ] ใส่ `WEBHOOK_URL` และ auth credentials
- [ ] ทดสอบ payload/response mapping ด้วย 1–2 คำถาม
- [ ] ยืนยัน `QUEUE_RATE_LIMIT_MS=30000` ตรงตามข้อกำหนด API
- [ ] ตั้ง `GOOGLE_DOCUMENT_ID` และ share กับ service account
- [ ] รัน `npm test -- --extract-only` แล้ว `npm run config`
- [ ] รัน `npm run test:webhook-only` ทดสอบก่อน write กลับ
