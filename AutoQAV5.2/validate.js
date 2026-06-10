#!/usr/bin/env node
/**
 * validate.js
 * ─────────────────────────────────────────────────────────────
 * ตรวจสอบว่า JSON / Sheets / Docs คือข้อมูลชุดเดียวกัน
 * ก่อนรัน consolidate.js
 *
 * ตรวจ 4 ชั้น:
 *   Layer 0 — Config sanity (URL/ID ถูกไหม, sheet tab มีจริงไหม)
 *   Layer 1 — Count sanity (จำนวน rows สมเหตุสมผลไหม)
 *   Layer 2 — Question overlap (คำถามตรงกันกี่ %)
 *   Layer 3 — TestId overlap (testId ตรงกันกี่ %)
 *
 * Output:
 *   PASS  — ปลอดภัย รัน consolidate.js ได้
 *   WARN  — มีความไม่ตรงกันบางส่วน แต่ยังรันต่อได้ (แนะนำตรวจก่อน)
 *   FAIL  — ข้อมูลไม่ตรงกัน ห้าม merge จนกว่าจะแก้
 *
 * Usage:
 *   node validate.js
 *   node validate.js --strict    ← WARN ก็ให้ถือเป็น FAIL
 *   node validate.js --report    ← บันทึกผลลง output/validation_report.txt
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config (same as consolidate.js) ──────────────────────────
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const DOCUMENT_ID    = process.env.GOOGLE_DOCUMENT_ID;
const SHEET_NAME     = process.env.GOOGLE_SHEET_NAME ?? 'TestCases';
const KEY_FILE       = path.resolve(__dirname,
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? './credentials/google-service-account.json');
const LOGS_DIR       = process.env.LOGS_DIR ?? './logs';
const OUTPUT_DIR     = path.resolve(__dirname, 'output');

function colIdx(letter) { return !letter ? -1 : letter.toUpperCase().charCodeAt(0) - 65; }
const SHEET_COL_Q  = colIdx(process.env.SHEET_COL_QUESTION ?? 'A');
const SHEET_COL_E  = colIdx(process.env.SHEET_COL_EXPECTED ?? 'B');
const SHEET_COL_S  = colIdx(process.env.SHEET_COL_STATUS   ?? 'E');
const SHEET_START  = parseInt(process.env.SHEET_DATA_START_ROW ?? '2', 10);

const argv   = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const REPORT = argv.includes('--report');
const cpArg  = argv.find(a => a.startsWith('--checkpoint='));
const CHECKPOINT = cpArg ? cpArg.split('=')[1] : null;

// ─────────────────────────────────────────────────────────────
// Result accumulator
// ─────────────────────────────────────────────────────────────
const issues = [];   // { level: 'FAIL'|'WARN'|'INFO', msg: string }

function addIssue(level, msg) { issues.push({ level, msg }); }
function fail(msg) { addIssue('FAIL', msg); }
function warn(msg) { addIssue('WARN', msg); }
function info(msg) { addIssue('INFO', msg); }

function sep(ch = '─') { return ch.repeat(60); }
function printIssues() {
  const fails = issues.filter(i => i.level === 'FAIL');
  const warns = issues.filter(i => i.level === 'WARN');
  const infos = issues.filter(i => i.level === 'INFO');

  if (infos.length) {
    console.log('\n  ℹ️  INFO:');
    infos.forEach(i => console.log(`     ${i.msg}`));
  }
  if (warns.length) {
    console.log('\n  ⚠️  WARNINGS:');
    warns.forEach(i => console.log(`     ${i.msg}`));
  }
  if (fails.length) {
    console.log('\n  ❌ FAILURES:');
    fails.forEach(i => console.log(`     ${i.msg}`));
  }
}

// ─────────────────────────────────────────────────────────────
// Text normaliser for question comparison
// ─────────────────────────────────────────────────────────────
function norm(text) {
  return (text ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^\u0e00-\u0e7f\u0020-\u007e]/g, '')
    .toLowerCase()
    .trim();
}

function extractQuestion(text) {
  if (!text) return '';
  const lines = text.replace(/\r/g, '').split('\n');
  let extracted = null;
  for (const line of lines) {
    const m = line.trim().match(/^[-–—]\s*(.+)$/);
    if (m) {
      extracted = m[1].trim();
      break;
    }
  }
  if (!extracted) {
    const singleLineMatch = text.match(/(?:ถามด้วยคำถาม|ถามด้วยคำถาม\s*[-–—]|\s+[-–—]\s*)(.+?)(?:\s*\d+\.\s*กดปุ่มส่ง|$)/i);
    if (singleLineMatch) {
      extracted = singleLineMatch[1].trim().replace(/^[-–—]\s*/, '').trim();
    }
  }
  if (extracted && extracted !== text) {
    if (extracted.includes('ถามด้วยคำถาม') || extracted.includes('Bubble Chatbot')) {
      return extractQuestion(extracted);
    }
    return extracted;
  }
  return text.trim();
}

// ─────────────────────────────────────────────────────────────
// Overlap calculation
// ─────────────────────────────────────────────────────────────
function overlapRate(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let count = 0;
  for (const v of setA) {
    if (setB.has(v)) count++;
  }
  return count / Math.min(setA.size, setB.size);
}

function overlapCount(setA, setB) {
  let count = 0;
  for (const v of setA) { if (setB.has(v)) count++; }
  return count;
}

// ─────────────────────────────────────────────────────────────
// Layer 0: Config sanity
// ─────────────────────────────────────────────────────────────
function validateConfig() {
  console.log('\n' + sep() + '\n  Layer 0: Config Sanity\n' + sep());

  // Key file
  if (!fs.existsSync(KEY_FILE)) {
    fail(`Service account key ไม่พบ: ${KEY_FILE}`);
  } else {
    info(`Service account key: ${KEY_FILE} ✓`);
  }

  // Document ID
  if (!DOCUMENT_ID) {
    fail('GOOGLE_DOCUMENT_ID ไม่ได้ตั้งค่าใน .env');
  } else {
    const docUrl = `https://docs.google.com/document/d/${DOCUMENT_ID}/edit`;
    info(`Docs ID     : ${DOCUMENT_ID}`);
    info(`└ URL       : ${docUrl}`);
  }

  // Spreadsheet ID
  if (!SPREADSHEET_ID) {
    warn('GOOGLE_SPREADSHEET_ID ไม่ได้ตั้งค่า (จะข้าม Sheets validation)');
  } else {
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
    info(`[READ] Sheets ID   : ${SPREADSHEET_ID}`);
    info(`└ URL       : ${sheetUrl}`);
    info(`[READ] Sheet Tab   : "${SHEET_NAME}"`);
  }
  
  const targetSheetId = process.env.TARGET_GOOGLE_SPREADSHEET_ID;
  const targetSheetName = process.env.TARGET_GOOGLE_SHEET_NAME;
  if (targetSheetId || targetSheetName) {
    const tId = targetSheetId || SPREADSHEET_ID;
    const tName = targetSheetName || SHEET_NAME;
    const tUrl = `https://docs.google.com/spreadsheets/d/${tId}/edit`;
    info(`[WRITE] Sheets ID  : ${tId}`);
    info(`└ URL       : ${tUrl}`);
    info(`[WRITE] Sheet Tab  : "${tName}"`);
  }

  // Logs dir
  if (!fs.existsSync(LOGS_DIR) && !CHECKPOINT) {
    warn(`LOGS_DIR ไม่พบ: ${LOGS_DIR} (จะข้าม JSON validation)`);
  }
}

// ─────────────────────────────────────────────────────────────
// Layer 1: Read sources and count
// ─────────────────────────────────────────────────────────────

// --- JSON ---
function readJsonSummary() {
  const result = {
    found: false, fileCount: 0, entryCount: 0,
    testIds: new Set(), questions: new Set(),
    statusCounts: { PASS: 0, PARTIAL: 0, FAIL: 0, noStatus: 0 },
    files: [],
  };

  if (CHECKPOINT) {
    const resolvedPath = path.resolve(CHECKPOINT);
    if (!fs.existsSync(resolvedPath)) {
      warn(`[JSON] ไม่พบไฟล์ checkpoint ที่ระบุ: ${CHECKPOINT}`);
      return result;
    }
    result.found = true;
    result.fileCount = 1;
    result.files = [path.basename(resolvedPath)];
    try {
      const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
      for (const [testId, entry] of Object.entries(data.completed ?? {})) {
        result.testIds.add(testId);
        if (entry.question) result.questions.add(norm(entry.question));
        const s = entry.status ?? '';
        if      (s === 'PASS')    result.statusCounts.PASS++;
        else if (s === 'PARTIAL') result.statusCounts.PARTIAL++;
        else if (s === 'FAIL')    result.statusCounts.FAIL++;
        else                      result.statusCounts.noStatus++;
        result.entryCount++;
      }
    } catch (err) {
      warn(`[JSON] อ่านไฟล์ checkpoint ไม่สำเร็จ: ${err.message}`);
    }
    return result;
  }

  if (!fs.existsSync(LOGS_DIR)) return result;

  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('progress_') && f.endsWith('.json'));

  result.fileCount = files.length;
  if (files.length === 0) return result;

  result.found = true;
  result.files = files;

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'));
      for (const [testId, entry] of Object.entries(data.completed ?? {})) {
        result.testIds.add(testId);
        if (entry.question) result.questions.add(norm(entry.question));
        const s = entry.status ?? '';
        if      (s === 'PASS')    result.statusCounts.PASS++;
        else if (s === 'PARTIAL') result.statusCounts.PARTIAL++;
        else if (s === 'FAIL')    result.statusCounts.FAIL++;
        else                      result.statusCounts.noStatus++;
        result.entryCount++;
      }
    } catch { /* skip bad files */ }
  }

  return result;
}

// --- Sheets ---
async function readSheetsSummary(auth) {
  const result = {
    found: false, rowCount: 0, withStatus: 0,
    testIds: new Set(), questions: new Set(),
    sheetTitle: '', tabExists: false, tabList: [],
  };

  if (!SPREADSHEET_ID) return result;

  try {
    const sheets = google.sheets({ version: 'v4', auth });

    // Check tab exists
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    result.sheetTitle = meta.data.properties?.title ?? '(unknown)';
    result.tabList    = meta.data.sheets?.map(s => s.properties.title) ?? [];
    result.tabExists  = result.tabList.includes(SHEET_NAME);

    if (!result.tabExists) return result;

    // Read data
    const maxCol = Math.max(SHEET_COL_Q, SHEET_COL_E, SHEET_COL_S) + 1;
    const endLetter = String.fromCharCode(65 + maxCol);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${SHEET_START}:${endLetter}`,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = res.data.values ?? [];
    result.found = true;

    rows.forEach((row, idx) => {
      const q = row[SHEET_COL_Q]?.trim() ?? '';
      const s = row[SHEET_COL_S]?.trim() ?? '';
      if (!q) return;
      result.rowCount++;
      const testId = `TC_${SHEET_START + idx}`;
      result.testIds.add(testId);
      result.questions.add(norm(q));
      if (s) result.withStatus++;
    });
  } catch (err) {
    fail(`Sheets อ่านไม่ได้: ${err.message}`);
  }

  return result;
}

// --- Docs ---
function getCellText(cell) {
  let text = '';
  for (const para of cell?.content ?? []) {
    if (!para.paragraph) continue;
    for (const elem of para.paragraph.elements ?? []) {
      text += elem.textRun?.content ?? '';
    }
  }
  return text.replace(/\u00a0/g, ' ').replace(/\r?\n/g, '\n').trim();
}

async function readDocsSummary(auth) {
  const result = {
    found: false, rowCount: 0, withStatus: 0,
    testIds: new Set(), questions: new Set(),
    docTitle: '', tableCount: 0,
    tables: [],  // [{ ordinal, headerNames, rowCount }]
  };

  if (!DOCUMENT_ID) return result;

  try {
    const docsApi = google.docs({ version: 'v1', auth });
    const doc = await docsApi.documents.get({ documentId: DOCUMENT_ID });
    result.docTitle = doc.data.title ?? '(unknown)';

    for (const elem of doc.data.body.content) {
      if (!elem.table) continue;
      result.tableCount++;

      const rows = elem.table.tableRows ?? [];
      if (rows.length < 2) continue;

      const headerCells = rows[0].tableCells ?? [];
      const headerNames = headerCells.map(c => getCellText(c));
      const hNorm       = headerNames.map(h => (h ?? '').replace(/\s+/g, '').toLowerCase());

      const colSteps  = hNorm.findIndex(h => h.includes('teststeps') || h.includes('question'));
      const colStatus = hNorm.findIndex(h => h.includes('status'));
      const colId     = hNorm.findIndex(h => h.includes('testcase') || h.includes('testid'));

      result.tables.push({
        ordinal: result.tableCount,
        headerNames,
        rowCount: rows.length - 1,
        hasStepsCol: colSteps >= 0,
      });

      if (colSteps < 0) continue; // ไม่ใช่ตาราง test case

      result.found = true;
      for (let ri = 1; ri < rows.length; ri++) {
        const cells = rows[ri].tableCells ?? [];
        const stepsText = getCellText(cells[colSteps]);
        const statusText = colStatus >= 0 ? getCellText(cells[colStatus])?.trim() : '';
        const idText = colId >= 0 ? getCellText(cells[colId])?.trim() : '';

        if (!stepsText && !idText) continue;
        result.rowCount++;
        if (idText) result.testIds.add(idText);
        const q = norm(extractQuestion(stepsText));
        if (q) result.questions.add(q);
        if (statusText) result.withStatus++;
      }
    }
  } catch (err) {
    fail(`Docs อ่านไม่ได้: ${err.message}`);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Layer 1: Count sanity
// ─────────────────────────────────────────────────────────────
function validateCounts(jsonS, sheetsS, docsS) {
  console.log('\n' + sep() + '\n  Layer 1: Count Sanity\n' + sep());

  // JSON
  if (jsonS.found) {
    console.log(`  [JSON]   ${jsonS.fileCount} files, ${jsonS.entryCount} entries`);
    console.log(`           PASS: ${jsonS.statusCounts.PASS}  PARTIAL: ${jsonS.statusCounts.PARTIAL}  FAIL: ${jsonS.statusCounts.FAIL}  noStatus: ${jsonS.statusCounts.noStatus}`);
    if (jsonS.entryCount === 0) warn('[JSON] ไม่มี completed entries ใน checkpoint');
  } else {
    warn('[JSON] ไม่พบ checkpoint files');
  }

  // Sheets
  if (!SPREADSHEET_ID) {
    console.log('  [Sheets] ข้ามเพราะไม่ได้ตั้งค่า GOOGLE_SPREADSHEET_ID');
  } else if (!sheetsS.tabExists) {
    fail(`[Sheets] tab "${SHEET_NAME}" ไม่พบใน spreadsheet "${sheetsS.sheetTitle}"`);
    console.log(`         Tabs ที่มีอยู่: ${sheetsS.tabList.join(', ')}`);
  } else {
    console.log(`  [Sheets] "${sheetsS.sheetTitle}" > tab "${SHEET_NAME}"`);
    console.log(`           ${sheetsS.rowCount} rows อ่านได้, ${sheetsS.withStatus} มี status`);
  }

  // Docs
  if (!DOCUMENT_ID) {
    console.log('  [Docs]   ข้ามเพราะไม่ได้ตั้งค่า GOOGLE_DOCUMENT_ID');
  } else if (!docsS.found) {
    warn(`[Docs] "${docsS.docTitle}" — ไม่พบตาราง Test Case (${docsS.tableCount} ตารางทั้งหมด)`);
    if (docsS.tables.length > 0) {
      console.log('         ตารางที่พบ:');
      docsS.tables.forEach(t => {
        console.log(`           ตาราง ${t.ordinal}: ${t.rowCount} rows | headers: ${t.headerNames.slice(0, 4).join(' | ')}`);
      });
    }
  } else {
    console.log(`  [Docs]   "${docsS.docTitle}"`);
    console.log(`           ${docsS.rowCount} rows, ${docsS.withStatus} มี status`);
  }

  // Count ratio check
  const counts = [jsonS.entryCount, sheetsS.rowCount, docsS.rowCount].filter(n => n > 0);
  if (counts.length >= 2) {
    const maxC = Math.max(...counts);
    const minC = Math.min(...counts);
    const ratio = minC / maxC;
    if (ratio < 0.5) {
      warn(`จำนวน rows ต่างกันมาก: ${counts.join(' vs ')} (ratio ${(ratio * 100).toFixed(0)}%)`);
      warn('อาจเป็นคนละ dataset หรือ filter คนละแบบ — ตรวจสอบก่อน merge');
    } else {
      info(`จำนวน rows: ${counts.join(' / ')} (ต่างกัน ${(100 - ratio * 100).toFixed(0)}%)`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Layer 2: Question overlap
// ─────────────────────────────────────────────────────────────
function validateQuestionOverlap(jsonS, sheetsS, docsS) {
  console.log('\n' + sep() + '\n  Layer 2: Question Overlap\n' + sep());

  // Sheets vs Docs
  if (sheetsS.questions.size > 0 && docsS.questions.size > 0) {
    const rate = overlapRate(sheetsS.questions, docsS.questions);
    const count = overlapCount(sheetsS.questions, docsS.questions);
    const pct = (rate * 100).toFixed(1);
    console.log(`  Sheets ↔ Docs    overlap: ${count} คำถาม (${pct}%)`);

    if (rate < 0.5) {
      fail(`คำถามใน Sheets กับ Docs ตรงกันแค่ ${pct}% — น่าจะคนละ dataset!`);
      // Show sample mismatches
      const inSheetsNotDocs = [...sheetsS.questions].filter(q => !docsS.questions.has(q)).slice(0, 3);
      const inDocsNotSheets = [...docsS.questions].filter(q => !sheetsS.questions.has(q)).slice(0, 3);
      if (inSheetsNotDocs.length) {
        console.log('    ตัวอย่างคำถามใน Sheets ที่ไม่พบใน Docs:');
        inSheetsNotDocs.forEach(q => console.log(`      "${q.slice(0, 60)}"`));
      }
      if (inDocsNotSheets.length) {
        console.log('    ตัวอย่างคำถามใน Docs ที่ไม่พบใน Sheets:');
        inDocsNotSheets.forEach(q => console.log(`      "${q.slice(0, 60)}"`));
      }
    } else if (rate < 0.8) {
      warn(`คำถามตรงกัน ${pct}% — มีบางส่วนไม่ตรง (อาจเป็น partial dataset)`);
    } else {
      info(`คำถาม Sheets ↔ Docs ตรงกัน ${pct}% ✓`);
    }
  } else {
    info('ไม่มีข้อมูลพอสำหรับ Sheets ↔ Docs comparison');
  }

  // JSON vs Sheets
  if (jsonS.questions.size > 0 && sheetsS.questions.size > 0) {
    const rate = overlapRate(jsonS.questions, sheetsS.questions);
    const count = overlapCount(jsonS.questions, sheetsS.questions);
    const pct = (rate * 100).toFixed(1);
    console.log(`  JSON   ↔ Sheets  overlap: ${count} คำถาม (${pct}%)`);
    if (rate < 0.3) {
      fail(`คำถามใน JSON กับ Sheets ตรงกันแค่ ${pct}% — ตรวจสอบว่าเป็น dataset เดียวกัน`);
    } else if (rate < 0.7) {
      warn(`JSON ↔ Sheets overlap ${pct}% — อาจเป็น partial run`);
    }
  }

  // JSON vs Docs
  if (jsonS.questions.size > 0 && docsS.questions.size > 0) {
    const rate = overlapRate(jsonS.questions, docsS.questions);
    const count = overlapCount(jsonS.questions, docsS.questions);
    const pct = (rate * 100).toFixed(1);
    console.log(`  JSON   ↔ Docs    overlap: ${count} คำถาม (${pct}%)`);
    if (rate < 0.3) {
      fail(`คำถามใน JSON กับ Docs ตรงกันแค่ ${pct}% — ตรวจสอบก่อน merge`);
    } else if (rate < 0.7) {
      warn(`JSON ↔ Docs overlap ${pct}% — อาจเป็น partial run`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Layer 3: TestId format sanity
// ─────────────────────────────────────────────────────────────
function validateTestIdFormat(jsonS, sheetsS, docsS) {
  console.log('\n' + sep() + '\n  Layer 3: TestId Format & Overlap\n' + sep());

  // Show sample testIds from each source
  const jsonSample   = [...jsonS.testIds].slice(0, 5);
  const sheetsSample = [...sheetsS.testIds].slice(0, 5);
  const docsSample   = [...docsS.testIds].slice(0, 5);

  if (jsonSample.length)   console.log(`  [JSON]   sample IDs: ${jsonSample.join(', ')}`);
  if (sheetsSample.length) console.log(`  [Sheets] sample IDs: ${sheetsSample.join(', ')}`);
  if (docsSample.length)   console.log(`  [Docs]   sample IDs: ${docsSample.join(', ')}`);

  // Check if JSON uses TC_ prefix (matching Sheets auto-generate)
  if (jsonS.testIds.size > 0) {
    const tcPrefixCount = [...jsonS.testIds].filter(id => id.startsWith('TC_')).length;
    const docPrefixCount = [...jsonS.testIds].filter(id => id.startsWith('DOC_')).length;
    const pct = (tcPrefixCount / jsonS.testIds.size * 100).toFixed(0);
    if (tcPrefixCount > 0 && sheetsS.rowCount > 0) {
      info(`JSON มี ${tcPrefixCount} IDs แบบ TC_ (ตรงกับ Sheets auto-generate)`);
    }
    if (docPrefixCount > 0) {
      info(`JSON มี ${docPrefixCount} IDs แบบ DOC_ (มาจาก Docs)`);
    }
  }

  // ID overlap JSON vs Sheets
  if (jsonS.testIds.size > 0 && sheetsS.testIds.size > 0) {
    const rate = overlapRate(jsonS.testIds, sheetsS.testIds);
    const count = overlapCount(jsonS.testIds, sheetsS.testIds);
    const pct = (rate * 100).toFixed(1);
    console.log(`  JSON ↔ Sheets ID overlap: ${count} IDs (${pct}%)`);
    if (rate < 0.3) {
      warn(`TestId overlap ต่ำ (${pct}%) — อาจ match โดย question แทน`);
    }
  }

  // ID overlap JSON vs Docs
  if (jsonS.testIds.size > 0 && docsS.testIds.size > 0) {
    const rate = overlapRate(jsonS.testIds, docsS.testIds);
    const count = overlapCount(jsonS.testIds, docsS.testIds);
    const pct = (rate * 100).toFixed(1);
    console.log(`  JSON ↔ Docs   ID overlap: ${count} IDs (${pct}%)`);
    if (rate < 0.2 && count > 0) {
      info(`TestId format ต่างกัน — ระบบจะ match ผ่าน question text แทน`);
    } else if (count === 0 && docsS.testIds.size > 0) {
      info(`Docs ใช้ ID format: ${[...docsS.testIds].slice(0, 3).join(', ')} — จะ match ผ่าน question`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Final verdict
// ─────────────────────────────────────────────────────────────
function verdict() {
  const fails = issues.filter(i => i.level === 'FAIL');
  const warns = issues.filter(i => i.level === 'WARN');

  console.log('\n' + sep('═'));
  console.log('  VALIDATION RESULT');
  console.log(sep('═'));

  if (fails.length > 0) {
    console.log('\n  ❌ RESULT: FAIL');
    console.log(`     ${fails.length} critical issue(s) พบ`);
    console.log('\n  ⛔ ห้ามรัน consolidate.js จนกว่าจะแก้ปัญหาเหล่านี้:');
    fails.forEach((i, n) => console.log(`     ${n + 1}. ${i.msg}`));
    return false;
  }

  if (warns.length > 0 && STRICT) {
    console.log('\n  ❌ RESULT: FAIL (--strict mode)');
    console.log(`     ${warns.length} warning(s) ถือเป็น failure ใน strict mode`);
    warns.forEach((i, n) => console.log(`     ${n + 1}. ⚠️  ${i.msg}`));
    return false;
  }

  if (warns.length > 0) {
    console.log('\n  ⚠️  RESULT: WARN');
    console.log(`     ${warns.length} warning(s) — รัน consolidate.js ได้ แต่ตรวจสอบก่อน`);
    warns.forEach((i, n) => console.log(`     ${n + 1}. ${i.msg}`));
    console.log('\n  ✅ ถ้าแน่ใจแล้วว่าข้อมูลถูกต้อง รัน:');
    console.log('     node consolidate.js');
    return true;
  }

  console.log('\n  ✅ RESULT: PASS');
  console.log('     ข้อมูลทั้ง 3 แหล่งสอดคล้องกัน');
  console.log('\n  ▶  รัน: node consolidate.js');
  return true;
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log(sep('═'));
  console.log(' AutoQA Validator — ตรวจ JSON / Sheets / Docs');
  if (STRICT) console.log(' (--strict mode: WARN = FAIL)');
  console.log(sep('═'));

  // Layer 0: config
  validateConfig();

  // Early exit if no key file
  if (!fs.existsSync(KEY_FILE)) {
    console.log('\n❌ ไม่มี service account key — หยุดการตรวจสอบ');
    process.exit(1);
  }

  // Auth
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
    ],
  });
  const client = await auth.getClient();

  // Read summaries
  process.stdout.write('\n  กำลังอ่าน JSON...');
  const jsonS = readJsonSummary();
  console.log(` ${jsonS.entryCount} entries`);

  process.stdout.write('  กำลังอ่าน Sheets...');
  const sheetsS = await readSheetsSummary(client);
  console.log(` ${sheetsS.rowCount} rows`);

  process.stdout.write('  กำลังอ่าน Docs...');
  const docsS = await readDocsSummary(client);
  console.log(` ${docsS.rowCount} rows`);

  // Layers 1-3
  validateCounts(jsonS, sheetsS, docsS);
  validateQuestionOverlap(jsonS, sheetsS, docsS);
  validateTestIdFormat(jsonS, sheetsS, docsS);

  // Print all issues
  printIssues();

  // Verdict
  const ok = verdict();

  // Save report if requested
  if (REPORT) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const lines = [
      '='.repeat(60),
      'AutoQA Validation Report',
      new Date().toISOString(),
      '='.repeat(60),
      '',
      `JSON entries  : ${jsonS.entryCount}`,
      `Sheets rows   : ${sheetsS.rowCount}`,
      `Docs rows     : ${docsS.rowCount}`,
      '',
      'Issues:',
      ...issues.map(i => `  [${i.level}] ${i.msg}`),
      '',
      `Result: ${ok ? 'PASS/WARN' : 'FAIL'}`,
    ];
    const reportPath = path.join(OUTPUT_DIR, 'validation_report.txt');
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
    console.log(`\n  📄 Report saved: ${reportPath}`);
  }

  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
