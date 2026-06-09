#!/usr/bin/env node
/**
 * write_to_sheets.js
 * ─────────────────────────────────────────────────────────────
 * อ่าน master_results.json (หรือ pass_results.json) แล้วเขียนลง
 * Google Sheets โดยอัปเดตผลลัพธ์ (Actual, Status, Timestamp, Screenshot)
 *
 * Usage:
 *   node write_to_sheets.js                       ← update ทุกสถานะลงชีต
 *   node write_to_sheets.js --input=pass_results  ← ใช้ pass_results.json
 *   node write_to_sheets.js --filter=PASS         ← กรองเฉพาะ PASS
 *   node write_to_sheets.js --dry-run             ← แสดงตารางจับคู่โดยไม่ write จริง
 *   node write_to_sheets.js --prefix=ratchaphatsadu --dry-run
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import SheetsClient from './src/modules/sheetsClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────
const OUTPUT_DIR  = path.resolve(__dirname, 'output');

// CLI flags
const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const prefixArg = argv.find(a => a.startsWith('--prefix='));
const PREFIX    = prefixArg ? prefixArg.split('=')[1] : (process.env.OUTPUT_PREFIX ?? '');
const prefixStr = PREFIX ? `${PREFIX}_` : '';

const inputArg = argv.find(a => a.startsWith('--input='));
let INPUT = 'master_results';
if (inputArg) {
  INPUT = inputArg.split('=')[1];
} else if (prefixStr) {
  INPUT = `${prefixStr}master_results`;
}

const filterArg = argv.find(a => a.startsWith('--filter='));
const FILTER   = filterArg ? filterArg.split('=')[1].toUpperCase() : null;

// ─────────────────────────────────────────────────────────────
function sep(ch = '─') { console.log(ch.repeat(60)); }
function h1(t) { sep('═'); console.log(` ${t}`); sep('═'); }
function h2(t) { console.log(`\n  ── ${t}`); }

function normalizeTestId(id) {
  if (!id) return '';
  const m = id.trim().match(/^TRD_AI_(\d+)$/i);
  if (m) {
    return `TRD_AI_${parseInt(m[1], 10)}`;
  }
  const m2 = id.trim().match(/^TC_(\d+)$/i);
  if (m2) {
    return `TRD_AI_${parseInt(m2[1], 10) - 1}`;
  }
  return id.trim().toUpperCase();
}

function getAltId(id) {
  if (!id) return null;
  const m = id.match(/^TRD_AI_(\d+)$/i);
  if (m) {
    const num = parseInt(m[1], 10);
    return `TC_${num + 1}`;
  }
  const m2 = id.match(/^TC_(\d+)$/i);
  if (m2) {
    const num = parseInt(m2[1], 10);
    return `TRD_AI_${String(num - 1).padStart(3, '0')}`;
  }
  return null;
}

function norm(text) {
  return (text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\u0e00-\u0e7f\u0020-\u007e]/g, '')
    .toLowerCase()
    .trim();
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  h1('AutoQA — Write Results to Google Sheets');

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error('❌ GOOGLE_SPREADSHEET_ID ไม่พบใน .env');
    process.exit(1);
  }

  // Load input JSON
  let inputFile = path.join(OUTPUT_DIR, `${INPUT}.json`);
  if (!fs.existsSync(inputFile) && prefixStr && !INPUT.startsWith(prefixStr)) {
    inputFile = path.join(OUTPUT_DIR, `${prefixStr}${INPUT}.json`);
  }
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ ไม่พบ input file: ${inputFile}`);
    console.error(`   รัน node consolidate.js ก่อน`);
    process.exit(1);
  }

  console.log(`  โหลดข้อมูลจาก: ${inputFile}`);
  const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  let entries = Array.isArray(raw.entries)
    ? raw.entries
    : Object.values(raw.entries ?? {});

  // Filter by status if requested
  if (FILTER) {
    const before = entries.length;
    entries = entries.filter(e => e.status === FILTER);
    console.log(`  Filter ${FILTER}: ${before} → ${entries.length} รายการ`);
  }

  // Remove entries without status
  const withStatus = entries.filter(e => e.status);
  console.log(`  รายการที่มี status: ${withStatus.length} / ${entries.length}`);

  if (withStatus.length === 0) {
    console.log('  ไม่มีข้อมูลสถานะที่จะเขียน');
    return;
  }

  if (DRY_RUN) console.log('\n  ⚠️  DRY RUN mode — แสดงความคืบหน้าแต่ไม่บันทึกลง Google Sheets จริง');

  // Initialize SheetsClient
  console.log('  กำลังเชื่อมต่อ Google Sheets...');
  const sheetsClient = new SheetsClient();
  await sheetsClient.init();

  // Load current cases from Sheet to construct mapping database
  console.log('  กำลังโหลดข้อมูลจาก Google Sheets เพื่อจับคู่ Row...');
  const sheetCases = await sheetsClient.getTestCases();
  console.log(`  โหลดได้ ${sheetCases.length} รายการจาก Google Sheets`);
  if (sheetCases.length > 0) {
    console.log('  ตัวอย่างข้อมูลแถวแรกจาก Sheet:', JSON.stringify(sheetCases[0]));
  }

  const rowIndexToCase = new Map();
  const testIdToCase = new Map();
  const questionToCase = new Map();

  for (const sc of sheetCases) {
    if (sc.rowIndex) rowIndexToCase.set(sc.rowIndex, sc);
    if (sc.testId) {
      testIdToCase.set(normalizeTestId(sc.testId), sc);
    }
    if (sc.question) {
      questionToCase.set(norm(sc.question), sc);
    }
  }

  console.log(`  จำนวนคีย์ใน map: testIdToCase=${testIdToCase.size}, questionToCase=${questionToCase.size}`);
  
  // Print some keys from testIdToCase and questionToCase
  if (testIdToCase.size > 0) {
    const keys = Array.from(testIdToCase.keys()).slice(0, 5);
    console.log('  ตัวอย่างคีย์ testId จาก Sheet:', keys);
  }
  if (questionToCase.size > 0) {
    const keys = Array.from(questionToCase.keys()).slice(0, 3);
    console.log('  ตัวอย่างคีย์คำถาม (norm) จาก Sheet:', keys.map(k => k.substring(0, 40)));
  }

  // Build updates mapping
  const updates = [];
  let matchedCount = 0;
  let skippedCount = 0;

  for (const entry of withStatus) {
    let matchedCase = null;

    // 1. Match by saved rowIndex
    if (entry.rowIndex && rowIndexToCase.has(entry.rowIndex)) {
      matchedCase = rowIndexToCase.get(entry.rowIndex);
    }

    // 2. Match by testId (exact or normalized)
    if (!matchedCase && entry.testId) {
      const normalizedJsonId = normalizeTestId(entry.testId);
      if (testIdToCase.has(normalizedJsonId)) {
        matchedCase = testIdToCase.get(normalizedJsonId);
      }
    }

    // 3. Match by normalized question
    if (!matchedCase && entry.question) {
      const qNorm = norm(entry.question);
      if (questionToCase.has(qNorm)) {
        matchedCase = questionToCase.get(qNorm);
      }
    }

    if (matchedCase) {
      updates.push({
        rowIndex: matchedCase.rowIndex,
        result: {
          actual: entry.actual ?? '',
          status: entry.status ?? '',
          timestamp: entry.timestamp ?? new Date().toISOString().replace('T', ' ').substring(0, 19),
          screenshotPath: entry.screenshotPath ?? '',
        }
      });
      matchedCount++;
    } else {
      skippedCount++;
      console.warn(`  ⚠️ ไม่พบแถวที่ตรงกับ: ${entry.testId} | คำถาม: ${entry.question?.substring(0, 40)}...`);
    }
  }

  console.log(`\n  สรุปการจับคู่ Row:`);
  console.log(`    - จับคู่สำเร็จ: ${matchedCount} รายการ`);
  console.log(`    - ไม่สามารถจับคู่ได้: ${skippedCount} รายการ`);

  if (updates.length === 0) {
    console.log('  ❌ ไม่มีรายการใดที่สามารถจับคู่และอัปเดตลง Sheets ได้');
    return;
  }

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] ตัวอย่าง 5 รายการแรกที่จะอัปเดต:');
    updates.slice(0, 5).forEach((u, i) => {
      console.log(`    - Row ${u.rowIndex} | Status: ${u.result.status} | Actual: ${(u.result.actual ?? '').slice(0, 60)}...`);
    });
    if (updates.length > 5) console.log(`      ... และอีก ${updates.length - 5} รายการ`);
    return;
  }

  // Execute batch updates
  console.log(`\n  กำลังอัปเดตข้อมูล ${updates.length} แถวลง Google Sheets แบบ Batch...`);
  await sheetsClient.batchWriteResults(updates);
  console.log('  ✅ บันทึกข้อมูลลง Google Sheets เรียบร้อยแล้ว!');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
