#!/usr/bin/env node
/**
 * consolidate.js
 * ─────────────────────────────────────────────────────────────
 * รวมข้อมูลผล QA จาก 3 แหล่ง:
 *   1. JSON checkpoint (logs/progress_*.json)
 *   2. Google Sheets (columns D, E = actual, status)
 *   3. Google Docs (columns Actual Result, Status, Remark)
 *
 * Output:
 *   output/master_results.json   ← ทุก test case รวมกัน
 *   output/pass_results.json     ← เฉพาะ PASS
 *   output/fail_results.json     ← FAIL + PARTIAL
 *   output/consolidate_report.txt ← สรุป
 *
 * Priority เวลา merge (สูง → ต่ำ):
 *   Docs > Sheets > JSON checkpoint
 *
 * Usage:
 *   node consolidate.js
 *   node consolidate.js --checkpoint=logs/progress_xxx.json
 *   node consolidate.js --skip-docs     (ถ้า Docs ไม่มีข้อมูลเลย)
 *   node consolidate.js --skip-sheets
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────
const SPREADSHEET_ID  = process.env.GOOGLE_SPREADSHEET_ID;
const DOCUMENT_ID     = process.env.GOOGLE_DOCUMENT_ID;
const SHEET_NAME      = process.env.GOOGLE_SHEET_NAME     ?? 'TestCases';
const KEY_FILE        = path.resolve(__dirname,
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? './credentials/google-service-account.json');
const LOGS_DIR        = process.env.LOGS_DIR ?? './logs';
const OUTPUT_DIR      = path.resolve(__dirname, 'output');

// Column config for Sheets (0-based from col A)
const SHEET_COL_Q   = colIdx(process.env.SHEET_COL_QUESTION    ?? 'A'); // question
const SHEET_COL_E   = colIdx(process.env.SHEET_COL_EXPECTED    ?? 'B'); // expected
const SHEET_COL_D   = colIdx(process.env.SHEET_COL_ACTUAL      ?? 'D'); // actual result
const SHEET_COL_S   = colIdx(process.env.SHEET_COL_STATUS      ?? 'E'); // status
const SHEET_COL_T   = colIdx(process.env.SHEET_COL_TIMESTAMP   ?? 'F'); // timestamp
const SHEET_START   = parseInt(process.env.SHEET_DATA_START_ROW ?? '2', 10);

// Doc column header names
const DOC_HDR_STEPS    = process.env.DOC_COL_TEST_STEPS_HEADER  ?? 'Test Steps';
const DOC_HDR_EXPECTED = process.env.DOC_COL_EXPECTED_HEADER    ?? 'Expected Result';
const DOC_HDR_ACTUAL   = process.env.DOC_COL_ACTUAL_HEADER      ?? 'Actual Result';
const DOC_HDR_STATUS   = process.env.DOC_COL_STATUS_HEADER      ?? 'Status';
const DOC_HDR_REMARK   = process.env.DOC_COL_REMARK_HEADER      ?? 'Remark';
const DOC_HDR_TEST_ID  = process.env.DOC_COL_TEST_ID_HEADER     ?? 'Test case ID';

// CLI flags
const argv          = process.argv.slice(2);
const SKIP_DOCS     = argv.includes('--skip-docs');
const SKIP_SHEETS   = argv.includes('--skip-sheets');
const SKIP_JSON     = argv.includes('--skip-json');
const cpArg         = argv.find(a => a.startsWith('--checkpoint='));
const CHECKPOINT    = cpArg ? cpArg.split('=')[1] : null;
const prefixArg     = argv.find(a => a.startsWith('--prefix='));
const PREFIX        = prefixArg ? prefixArg.split('=')[1] : (process.env.OUTPUT_PREFIX ?? '');
const prefixStr     = PREFIX ? `${PREFIX}_` : '';


// ─────────────────────────────────────────────────────────────
function colIdx(letter) {
  if (!letter) return -1;
  return letter.toUpperCase().charCodeAt(0) - 65;
}

function sep(ch = '─') { console.log(ch.repeat(60)); }
function h1(t)  { sep('═'); console.log(` ${t}`); sep('═'); }
function h2(t)  { console.log(`\n  ── ${t}`); }

// ─────────────────────────────────────────────────────────────
// 1. READ CHECKPOINT JSON
// ─────────────────────────────────────────────────────────────
function readCheckpoints() {
  const results = {};

  if (SKIP_JSON) {
    console.log('  [JSON] skipped (--skip-json)');
    return results;
  }

  // หาไฟล์ checkpoint
  let files = [];
  if (CHECKPOINT) {
    files = [path.resolve(CHECKPOINT)];
  } else {
    if (fs.existsSync(LOGS_DIR)) {
      files = fs.readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('progress_') && f.endsWith('.json'))
        .map(f => path.join(LOGS_DIR, f));
    }
  }

  if (files.length === 0) {
    console.log('  [JSON] ไม่พบ checkpoint files');
    return results;
  }

  for (const fp of files) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const completed = data.completed ?? {};
      let count = 0;
      for (const [testId, entry] of Object.entries(completed)) {
        if (!results[testId]) {
          results[testId] = {
            testId,
            source: 'json',
            status:         entry.status        ?? '',
            actual:         entry.actual         ?? '',
            expected:       entry.expected        ?? '',
            question:       entry.question        ?? '',
            similarity:     entry.similarity      ?? 0,
            reason:         entry.reason          ?? '',
            timestamp:      entry.timestamp       ?? '',
            screenshotPath: entry.screenshotPath  ?? '',
            attempts:       entry.attempts        ?? 1,
            rowIndex:       null,
          };
          count++;
        }
      }
      console.log(`  [JSON] ${fp} → ${count} entries`);
    } catch (err) {
      console.warn(`  [JSON] อ่านไม่ได้: ${fp} — ${err.message}`);
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// 2. READ GOOGLE SHEETS
// ─────────────────────────────────────────────────────────────
async function readSheets(auth) {
  const results = {};

  if (SKIP_SHEETS || !SPREADSHEET_ID) {
    console.log('  [Sheets] skipped');
    return results;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const maxCol  = Math.max(SHEET_COL_Q, SHEET_COL_E, SHEET_COL_D, SHEET_COL_S, SHEET_COL_T) + 1;
    const endLetter = String.fromCharCode(65 + maxCol);
    const range   = `${SHEET_NAME}!A${SHEET_START}:${endLetter}`;

    const res  = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = res.data.values ?? [];
    let count = 0;

    rows.forEach((row, idx) => {
      const question = row[SHEET_COL_Q]?.trim() ?? '';
      const expected = row[SHEET_COL_E]?.trim() ?? '';
      const actual   = row[SHEET_COL_D]?.trim() ?? '';
      const status   = row[SHEET_COL_S]?.trim() ?? '';
      const ts       = row[SHEET_COL_T]?.trim() ?? '';
      const rowIndex = SHEET_START + idx;

      if (!question) return;

      // testId = TC_{rowIndex} (ตรงกับ sheetsClient.js ที่ใช้ auto-generate)
      const testId = `TC_${rowIndex}`;

      results[testId] = {
        testId,
        source:    'sheets',
        status:    status   || '',
        actual:    actual   || '',
        expected:  expected || '',
        question:  question || '',
        similarity: 0,
        reason:    '',
        timestamp: ts || '',
        screenshotPath: '',
        attempts:  1,
        rowIndex,
      };
      count++;
    });

    console.log(`  [Sheets] ${SHEET_NAME} → ${count} rows อ่านได้`);
    const withResults = Object.values(results).filter(r => r.status).length;
    console.log(`  [Sheets] มีผล (status ไม่ว่าง): ${withResults}`);
  } catch (err) {
    console.error(`  [Sheets] ERROR: ${err.message}`);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// 3. READ GOOGLE DOCS
// ─────────────────────────────────────────────────────────────
function getCellText(cell) {
  let text = '';
  for (const para of cell.content ?? []) {
    if (!para.paragraph) continue;
    for (const elem of para.paragraph.elements ?? []) {
      text += elem.textRun?.content ?? '';
    }
  }
  return text.replace(/\u00a0/g, ' ').replace(/\r?\n/g, '\n').trim();
}

function normalizeHeader(h) {
  return (h ?? '').replace(/\s+/g, '').toLowerCase();
}

function extractQuestion(testStepsText) {
  if (!testStepsText) return '';
  const lines = testStepsText.replace(/\r/g, '').split('\n');
  let extracted = null;
  for (const line of lines) {
    const m = line.trim().match(/^[-–—]\s*(.+)$/);
    if (m) {
      extracted = m[1].trim();
      break;
    }
  }
  if (!extracted) {
    const singleLineMatch = testStepsText.match(/(?:ถามด้วยคำถาม|ถามด้วยคำถาม\s*[-–—]|\s+[-–—]\s*)(.+?)(?:\s*\d+\.\s*กดปุ่มส่ง|$)/i);
    if (singleLineMatch) {
      extracted = singleLineMatch[1].trim().replace(/^[-–—]\s*/, '').trim();
    }
  }
  if (extracted && extracted !== testStepsText) {
    if (extracted.includes('ถามด้วยคำถาม') || extracted.includes('Bubble Chatbot')) {
      return extractQuestion(extracted);
    }
    return extracted;
  }
  return testStepsText.trim();
}

function extractExpected(expectedText) {
  if (!expectedText) return '';
  const lines = expectedText.replace(/\r/g, '').split('\n');
  let extracted = null;
  for (const line of lines) {
    const m = line.trim().match(/^[-–—]\s*(.+)$/);
    if (m) {
      extracted = m[1].trim();
      break;
    }
  }
  if (!extracted) {
    const singleLineMatch = expectedText.match(/(?:ตอบคำถามถูกต้อง|ตอบคำถามถูกต้อง\s*[-–—]|\s+[-–—]\s*)(.+)$/i);
    if (singleLineMatch) {
      extracted = singleLineMatch[1].trim().replace(/^[-–—]\s*/, '').trim();
    }
  }
  if (extracted && extracted !== expectedText) {
    if (extracted.includes('ตอบคำถามถูกต้อง') || extracted.includes('สามารถตอบคำถาม')) {
      return extractExpected(extracted);
    }
    return extracted;
  }
  return expectedText.trim();
}

async function readDocs(auth) {
  const results = {};

  if (SKIP_DOCS || !DOCUMENT_ID) {
    console.log('  [Docs] skipped');
    return results;
  }

  try {
    const docsApi = google.docs({ version: 'v1', auth });
    const doc = await docsApi.documents.get({ documentId: DOCUMENT_ID });
    const body = doc.data.body.content;

    let tableCount = 0;
    let totalRows  = 0;

    for (const elem of body) {
      if (!elem.table) continue;
      tableCount++;

      const rows    = elem.table.tableRows ?? [];
      if (rows.length < 2) continue;

      // map headers
      const headerCells = rows[0].tableCells ?? [];
      const headers     = headerCells.map(c => normalizeHeader(getCellText(c)));

      const colId       = headers.findIndex(h => h.includes('testcase') || h.includes('testid'));
      const colSteps    = headers.findIndex(h => h.includes('teststeps') || h.includes('question'));
      const colExpected = headers.findIndex(h => h.includes('expected'));
      const colActual   = headers.findIndex(h => h.includes('actual') || h.includes('screenshot'));
      const colStatus   = headers.findIndex(h => h.includes('status'));
      const colRemark   = headers.findIndex(h => h.includes('remark'));

      if (colSteps === -1 && colExpected === -1) continue; // ไม่ใช่ตาราง test case

      for (let ri = 1; ri < rows.length; ri++) {
        const cells = rows[ri].tableCells ?? [];
        const getCol = (idx) => idx >= 0 ? getCellText(cells[idx] ?? {}) : '';

        const rawId       = getCol(colId);
        const rawSteps    = getCol(colSteps);
        const rawExpected = getCol(colExpected);
        const actual      = getCol(colActual);
        const status      = getCol(colStatus);
        const remark      = getCol(colRemark);

        if (!rawSteps && !rawExpected) continue;

        const question = extractQuestion(rawSteps);
        const expected = extractExpected(rawExpected);
        const testId   = rawId || `DOC_T${tableCount}_R${ri}`;

        results[testId] = {
          testId,
          source:    'docs',
          status:    status  || '',
          actual:    remark  || actual || '',   // Remark ใช้แทน Actual ใน V2/V3
          expected:  expected || '',
          question:  question || '',
          similarity: 0,
          reason:    '',
          timestamp: '',
          screenshotPath: '',
          attempts:  1,
          rowIndex:  ri,
          docTableOrdinal: tableCount - 1,
        };
        totalRows++;
      }
    }

    console.log(`  [Docs] ${tableCount} ตาราง, ${totalRows} rows อ่านได้`);
    const withResults = Object.values(results).filter(r => r.status).length;
    console.log(`  [Docs] มีผล (status ไม่ว่าง): ${withResults}`);
  } catch (err) {
    console.error(`  [Docs] ERROR: ${err.message}`);
  }

  return results;
}

function norm(text) {
  return (text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\u0e00-\u0e7f\u0020-\u007e]/g, '')
    .toLowerCase()
    .trim();
}

function merge(jsonData, sheetsData, docsData) {
  const master = {};
  const questionToId = {};

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

  function addOrMerge(entry) {
    let qNorm = entry.question ? norm(entry.question) : null;
    let existingId = qNorm ? questionToId[qNorm] : null;

    // Try finding by exact testId or alternative translated ID
    if (!existingId && entry.testId) {
      if (master[entry.testId]) {
        existingId = entry.testId;
      } else {
        const altId = getAltId(entry.testId);
        if (altId && master[altId]) {
          existingId = altId;
        }
      }
    }

    if (existingId) {
      const existing = master[existingId];
      let chosenId = existing.testId;

      // Choose the best testId (prefer TRD_AI_xxx format over TC_ format)
      if (entry.testId && (!chosenId || chosenId.startsWith('TC_') || chosenId.startsWith('DOC_T')) && (!entry.testId.startsWith('TC_') && !entry.testId.startsWith('DOC_T'))) {
        chosenId = entry.testId;
        delete master[existing.testId];
        master[chosenId] = existing;
        existing.testId = chosenId;
        if (qNorm) questionToId[qNorm] = chosenId;
      }

      // Priority: Docs (3) > Sheets (2) > JSON (1)
      const sourcePriority = { 'docs': 3, 'sheets': 2, 'json': 1 };
      const currentPriority = sourcePriority[existing.source] ?? 0;
      const incomingPriority = sourcePriority[entry.source] ?? 0;

      if (entry.status && (incomingPriority > currentPriority || !existing.status)) {
        existing.status = entry.status;
        existing.actual = entry.actual;
        existing.source = entry.source;
        if (entry.reason) existing.reason = entry.reason;
        if (entry.timestamp) existing.timestamp = entry.timestamp;
        if (entry.screenshotPath) existing.screenshotPath = entry.screenshotPath;
        if (entry.attempts) existing.attempts = entry.attempts;
      }

      // Fill missing fields
      if (!existing.question) existing.question = entry.question;
      if (!existing.expected) existing.expected = entry.expected;
      if (entry.rowIndex && !existing.rowIndex) existing.rowIndex = entry.rowIndex;
      if (entry.docTableOrdinal && !existing.docTableOrdinal) existing.docTableOrdinal = entry.docTableOrdinal;
    } else {
      // Create new entry
      // Prefer TRD_AI_xxx format right from creation if available
      let chosenId = entry.testId || `TC_${Object.keys(master).length + 2}`;
      if (chosenId.startsWith('TC_')) {
        const alt = getAltId(chosenId);
        if (alt) chosenId = alt;
      }
      master[chosenId] = { ...entry, testId: chosenId };
      if (qNorm) questionToId[qNorm] = chosenId;
    }
  }

  // 1. Process Sheets
  for (const entry of Object.values(sheetsData)) {
    addOrMerge(entry);
  }

  // 2. Process Docs
  for (const entry of Object.values(docsData)) {
    addOrMerge(entry);
  }

  // 3. Process JSON
  for (const entry of Object.values(jsonData)) {
    addOrMerge(entry);
  }

  return master;
}

// ─────────────────────────────────────────────────────────────
// 5. REPORT
// ─────────────────────────────────────────────────────────────
function generateReport(master, jsonCount, sheetsCount, docsCount) {
  const all    = Object.values(master);
  const pass   = all.filter(r => r.status === 'PASS');
  const partial = all.filter(r => r.status === 'PARTIAL');
  const fail   = all.filter(r => r.status === 'FAIL');
  const noStatus = all.filter(r => !r.status);

  const bySource = all.reduce((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});

  const lines = [
    '═'.repeat(60),
    ' CONSOLIDATION REPORT',
    '═'.repeat(60),
    '',
    '── Sources Read ───────────────────────────────────────',
    `  JSON checkpoint : ${jsonCount} entries`,
    `  Google Sheets   : ${sheetsCount} rows`,
    `  Google Docs     : ${docsCount} rows`,
    '',
    '── After Merge ────────────────────────────────────────',
    `  Total unique    : ${all.length}`,
    `  PASS            : ${pass.length}`,
    `  PARTIAL         : ${partial.length}`,
    `  FAIL            : ${fail.length}`,
    `  No status yet   : ${noStatus.length}`,
    '',
    '── Source of truth per entry ───────────────────────────',
    ...Object.entries(bySource).map(([src, cnt]) => `  ${src.padEnd(12)}: ${cnt}`),
    '',
    '── Files written ───────────────────────────────────────',
    '  output/master_results.json',
    '  output/pass_results.json',
    '  output/fail_partial_results.json',
    '  output/no_status_results.json',
    '═'.repeat(60),
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  h1('AutoQA Consolidate — รวมข้อมูลจาก 3 แหล่ง');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Auth
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
    ],
  });
  const client = await auth.getClient();

  // Read all sources
  h2('อ่าน JSON checkpoint');
  const jsonData   = readCheckpoints();

  h2('อ่าน Google Sheets');
  const sheetsData = await readSheets(client);

  h2('อ่าน Google Docs');
  const docsData   = await readDocs(client);

  // Merge
  h2('Merge ข้อมูล');
  const master = merge(jsonData, sheetsData, docsData);
  const all    = Object.values(master);
  console.log(`  รวมได้ ${all.length} unique test cases`);

  // Split
  const pass         = all.filter(r => r.status === 'PASS');
  const failPartial  = all.filter(r => r.status === 'FAIL' || r.status === 'PARTIAL');
  const noStatus     = all.filter(r => !r.status);

  // Write outputs
  h2('เขียนผลลัพธ์');

  const masterFile  = path.join(OUTPUT_DIR, `${prefixStr}master_results.json`);
  const passFile    = path.join(OUTPUT_DIR, `${prefixStr}pass_results.json`);
  const failFile    = path.join(OUTPUT_DIR, `${prefixStr}fail_partial_results.json`);
  const noStatFile  = path.join(OUTPUT_DIR, `${prefixStr}no_status_results.json`);
  const reportFile  = path.join(OUTPUT_DIR, `${prefixStr}consolidate_report.txt`);

  fs.writeFileSync(masterFile, JSON.stringify({ generatedAt: new Date().toISOString(), total: all.length, entries: master }, null, 2));
  fs.writeFileSync(passFile,   JSON.stringify({ generatedAt: new Date().toISOString(), total: pass.length, entries: pass }, null, 2));
  fs.writeFileSync(failFile,   JSON.stringify({ generatedAt: new Date().toISOString(), total: failPartial.length, entries: failPartial }, null, 2));
  fs.writeFileSync(noStatFile, JSON.stringify({ generatedAt: new Date().toISOString(), total: noStatus.length, entries: noStatus }, null, 2));

  const report = generateReport(master,
    Object.keys(jsonData).length,
    Object.keys(sheetsData).length,
    Object.keys(docsData).length);

  fs.writeFileSync(reportFile, report, 'utf8');

  sep();
  console.log(report);
  console.log(`\n  ✅ ไฟล์ทั้งหมดอยู่ใน: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
