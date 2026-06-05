# 📊 AutoQA V3 — Sheets Support Upgrade Guide

## ไฟล์ที่ต้องแทนที่

ก็อปไฟล์เหล่านี้ทับของเดิม:

```
AutoQAV3_fix/
├── src/
│   ├── index.js                   → แทน src/index.js
│   └── modules/
│       ├── progressTracker.js     → แทน src/modules/progressTracker.js
│       └── sheetsClient.js        → แทน src/modules/sheetsClient.js
└── package.json                   → แทน package.json
```

---

## ปัญหาที่แก้ไข

1. **`writtenToSheets` vs `writtenToDocs`** — checkpoint เก่าของคุณใช้ `writtenToSheets`
   แต่โค้ดเดิมอ่าน `writtenToDocs` เลยไม่รู้ว่า write ไปแล้ว
   → ตอนนี้ `progressTracker.js` migrate อัตโนมัติตอน load

2. **`sheetsClient.js` ไม่ถูกเรียกใช้** — `index.js` เดิมใช้แค่ Docs
   → ตอนนี้มี `--use-sheets` / `--sheets-only` flag

3. **`batchWriteResults()`** — เพิ่มการ write หลาย row พร้อมกันใน 1 API call (เร็วกว่าเดิมมาก)

---

## วิธีใช้ทันที (มี checkpoint 300 ข้ออยู่แล้ว)

### ขั้นตอนเดียว — write ผลทั้งหมดเข้า Sheets:

```bash
npm run test:sheets-only
```

หรือ dry run ดูก่อน:
```bash
npm run test:sheets-only:dry
```

ถ้าอยากกำหนด batch size (ป้องกัน rate limit):
```bash
node src/index.js --sheets-only --batch-size=50
```

---

## ตรวจสอบ .env ก่อนรัน

ต้องมีครบ:

```dotenv
# Spreadsheet ID (จาก URL ของ Google Sheet)
GOOGLE_SPREADSHEET_ID=1RaRKgxmyaVZlEOJIjgA8Keg8UITDdAVSvBvHIEdHlYo

# ชื่อ tab
GOOGLE_SHEET_NAME=In_State_Property

# Column ที่ใช้อ่าน/เขียน
SHEET_COL_QUESTION=A
SHEET_COL_EXPECTED=B
SHEET_COL_ACTUAL=D
SHEET_COL_STATUS=E
SHEET_COL_TIMESTAMP=F
SHEET_COL_SCREENSHOT=G
SHEET_DATA_START_ROW=2
```

> **หมายเหตุ**: ใน `.env` ที่แชร์มา `SHEET_COL_TEST_ID` ว่างอยู่ — ไม่ต้องกำหนดก็ได้
> ระบบจะ auto-generate testId เป็น `TC_2`, `TC_3`, … ตาม row number

---

## Layout ของ Sheet ที่รองรับ

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| Question | Expected | *(ว่าง/อะไรก็ได้)* | Actual Result | Status | Timestamp | Screenshot |

---

## Scripts ใหม่ทั้งหมด

| Script | ความหมาย |
|--------|----------|
| `npm run test:sheets` | รัน browser + write Sheets |
| `npm run test:sheets:dry` | รัน browser, ไม่ write |
| `npm run test:sheets:resume` | รันต่อจาก checkpoint → write Sheets |
| `npm run test:sheets-only` | ข้าม browser, write Sheets จาก checkpoint ★ |
| `npm run test:sheets-only:dry` | ดู preview ว่าจะ write อะไรบ้าง |
| `npm run test:docs-only` | ข้าม browser, write Docs จาก checkpoint (เดิม) |

---

## Flow สำหรับ 300 ข้อที่รันไปแล้ว

```
checkpoint JSON (300 ข้อ)
       ↓
npm run test:sheets-only
       ↓  migrate writtenToSheets → writtenToDocs อัตโนมัติ
       ↓  โหลด test cases จาก Sheet (row 2-301)
       ↓  match กับ checkpoint โดย TC_2 = row 2, TC_3 = row 3 ...
       ↓  batchWrite ผล actual/status/timestamp/screenshot
       ↓  ทาสี status cell (เขียว/เหลือง/แดง)
Google Sheet อัปเดตสำเร็จ ✓
```

---

## หาก testId ใน checkpoint ไม่ตรงกับ row number

ตัวอย่าง: checkpoint มี `TC_2` แต่ใน sheet row 2 เป็นข้อมูลอื่น

แก้ได้โดยรัน dry-run ก่อน:
```bash
node src/index.js --sheets-only --dry-run
```
ดู log ว่า match กันถูกไหม แล้วแก้ `SHEET_DATA_START_ROW` ตาม
