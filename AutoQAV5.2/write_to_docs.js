#!/usr/bin/env node
/**
 * write_to_docs.js
 * ─────────────────────────────────────────────────────────────
 * อ่าน master_results.json (หรือ pass_results.json) แล้วเขียนลง
 * Google Docs โดย:
 *   1. ถ้า --fresh: สร้างตารางใหม่ท้าย doc (แนะนำ)
 *   2. ถ้าไม่มี --fresh: เขียนลงตารางที่มีอยู่แล้ว (update in-place)
 *
 * Usage:
 *   node write_to_docs.js                       ← update ตารางเดิม
 *   node write_to_docs.js --fresh               ← สร้างตารางใหม่
 *   node write_to_docs.js --input=pass_results  ← ใช้ pass_results.json
 *   node write_to_docs.js --filter=PASS         ← กรองเฉพาะ PASS
 *   node write_to_docs.js --dry-run             ← แสดงว่าจะทำอะไรโดยไม่ write จริง
 *   node write_to_docs.js --fresh --filter=PASS --dry-run
 *
 * Notes:
 *   - --fresh สร้าง section ใหม่ท้าย doc ไม่แตะตารางเดิม
 *   - ใช้วิธี "sort by index descending" ทำให้ batch ได้ทีเดียว
 *   - รองรับ rate limit: หยุดพัก 1s ทุก 50 requests
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────
const DOCUMENT_ID = process.env.GOOGLE_DOCUMENT_ID;
const KEY_FILE    = path.resolve(__dirname,
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? './credentials/google-service-account.json');
const OUTPUT_DIR  = path.resolve(__dirname, 'output');

// Doc column headers (ตรงกับที่ใช้ใน config)
const HDR_TEST_ID  = process.env.DOC_COL_TEST_ID_HEADER     ?? 'Test case ID';
const HDR_STEPS    = process.env.DOC_COL_TEST_STEPS_HEADER  ?? 'Test Steps';
const HDR_EXPECTED = process.env.DOC_COL_EXPECTED_HEADER    ?? 'Expected Result';
const HDR_ACTUAL   = process.env.DOC_COL_ACTUAL_HEADER      ?? 'Actual Result';
const HDR_STATUS   = process.env.DOC_COL_STATUS_HEADER      ?? 'Status';
const HDR_REMARK   = process.env.DOC_COL_REMARK_HEADER      ?? 'Remark';

// Colours (Docs uses 0–1 float RGB)
const STATUS_BG = {
  PASS:    { red: 0.204, green: 0.659, blue: 0.325 },
  PARTIAL: { red: 1.0,   green: 0.843, blue: 0.0   },
  FAIL:    { red: 0.918, green: 0.263, blue: 0.208  },
};
const STATUS_FG = {
  PASS:    { red: 0, green: 0, blue: 0 },
  PARTIAL: { red: 0, green: 0, blue: 0 },
  FAIL:    { red: 1, green: 1, blue: 1 },
};

// CLI flags
const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const FRESH    = argv.includes('--fresh');
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
const batchArg = argv.find(a => a.startsWith('--batch-size='));
const BATCH_SZ = batchArg ? parseInt(batchArg.split('=')[1], 10) : 100;


// ─────────────────────────────────────────────────────────────
function sep(ch = '─') { console.log(ch.repeat(60)); }
function h1(t) { sep('═'); console.log(` ${t}`); sep('═'); }
function h2(t) { console.log(`\n  ── ${t}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// Docs helpers
// ─────────────────────────────────────────────────────────────
function getCellText(cell) {
  let text = '';
  for (const para of cell?.content ?? []) {
    if (!para.paragraph) continue;
    for (const elem of para.paragraph.elements ?? []) {
      text += elem.textRun?.content ?? '';
    }
  }
  return text.replace(/\u00a0/g, ' ').replace(/\r?\n/g, ' ').trim();
}

function getCellWritableRange(cell) {
  const content = cell?.content ?? [];
  let startIdx = null, endIdx = null;
  for (const para of content) {
    if (!para.paragraph) continue;
    for (const elem of para.paragraph.elements ?? []) {
      const s = elem.startIndex;
      const e = elem.endIndex;
      if (s != null) { if (startIdx == null) startIdx = s; endIdx = e; }
    }
  }
  if (endIdx != null) endIdx = endIdx - 1;
  return { startIdx, endIdx };
}

function normalizeHeader(h) {
  return (h ?? '').replace(/\s+/g, '').toLowerCase();
}

// ─────────────────────────────────────────────────────────────
// Find existing table in Docs
// ─────────────────────────────────────────────────────────────
function findTestCaseTable(doc) {
  for (const elem of doc.body.content) {
    if (!elem.table) continue;
    const rows = elem.table.tableRows ?? [];
    if (rows.length < 1) continue;

    const headerCells = rows[0].tableCells ?? [];
    const headers = headerCells.map(c => normalizeHeader(getCellText(c)));

    const hasSteps    = headers.some(h => h.includes('teststeps') || h.includes('question'));
    const hasExpected = headers.some(h => h.includes('expected'));

    if (hasSteps || hasExpected) {
      const colMap = {
        testId:   headers.findIndex(h => h.includes('testcase') || h.includes('testid')),
        steps:    headers.findIndex(h => h.includes('teststeps') || h.includes('question')),
        expected: headers.findIndex(h => h.includes('expected')),
        actual:   headers.findIndex(h => h.includes('actual') || h.includes('screenshot')),
        status:   headers.findIndex(h => h.includes('status')),
        remark:   headers.findIndex(h => h.includes('remark')),
      };
      return { table: elem.table, tableElem: elem, colMap };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Build requests for one cell (delete + insert text)
// ─────────────────────────────────────────────────────────────
function cellTextRequests(cell, text) {
  const { startIdx, endIdx } = getCellWritableRange(cell);
  if (startIdx == null) return [];

  const reqs = [];
  if (endIdx != null && endIdx > startIdx) {
    reqs.push({ deleteContentRange: { range: { startIndex: startIdx, endIndex: endIdx } } });
  }
  if (text) {
    reqs.push({ insertText: { location: { index: startIdx }, text: String(text) } });
  }
  return reqs;
}

// ─────────────────────────────────────────────────────────────
// Build requests to colour a cell
// ─────────────────────────────────────────────────────────────
function cellColorRequest(tableStartIndex, rowIdx, colIdx, status) {
  const bg = STATUS_BG[status];
  if (!bg) return null;
  return {
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStartIndex },
          rowIndex: rowIdx,
          columnIndex: colIdx,
        },
        rowSpan: 1, columnSpan: 1,
      },
      tableCellStyle: { backgroundColor: { color: { rgbColor: bg } } },
      fields: 'backgroundColor',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Build text style request for status text
// ─────────────────────────────────────────────────────────────
function textStyleRequest(startIdx, text, status) {
  if (!text || startIdx == null) return null;
  const fg = STATUS_FG[status];
  if (!fg) return null;
  return {
    updateTextStyle: {
      range: { startIndex: startIdx, endIndex: startIdx + text.length },
      textStyle: { bold: true, foregroundColor: { color: { rgbColor: fg } } },
      fields: 'bold,foregroundColor',
    },
  };
}

// ─────────────────────────────────────────────────────────────
// --fresh mode: append a new table to end of doc
// ─────────────────────────────────────────────────────────────
async function freshTableMode(docsApi, entries, dryRun) {
  h2('โหมด --fresh: สร้างตารางใหม่ท้าย doc');

  const numCols = 8; // Test case ID | Description | Precondition | Test Steps | Expected Result | Actual Result | Status | Remark
  const numRows = entries.length + 1; // +1 header

  console.log(`  จะสร้างตาราง ${numRows} rows × ${numCols} cols`);
  console.log(`  สำหรับ ${entries.length} entries`);

  if (dryRun) {
    console.log('\n  [DRY RUN] จะสร้างตารางใหม่และ insert ข้อมูล:');
    entries.slice(0, 5).forEach(e => {
      console.log(`    ${e.testId} → ${e.status} | ${(e.actual ?? '').slice(0, 50)}`);
    });
    if (entries.length > 5) console.log(`    ... และอีก ${entries.length - 5} รายการ`);
    return;
  }

  // Step 1: หา end of doc
  const doc = await docsApi.documents.get({ documentId: DOCUMENT_ID });
  const bodyContent = doc.data.body.content;
  const lastElem = bodyContent[bodyContent.length - 1];
  const endOfDoc = lastElem.endIndex ?? 1;
  const insertAt = endOfDoc - 1; // before the final newline

  // Step 2: Insert heading
  console.log('  Step 1: Insert heading...');
  await docsApi.documents.batchUpdate({
    documentId: DOCUMENT_ID,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: insertAt },
            text: '\nAutoQA Results\n',
          },
        },
      ],
    },
  });
  await sleep(500);

  // Step 3: Insert table
  // Reload to get fresh indexes
  const doc2 = await docsApi.documents.get({ documentId: DOCUMENT_ID });
  const body2 = doc2.data.body.content;
  const last2 = body2[body2.length - 1];
  const insertTableAt = (last2.endIndex ?? 1) - 1;

  console.log(`  Step 2: insertTable at index ${insertTableAt}...`);
  await docsApi.documents.batchUpdate({
    documentId: DOCUMENT_ID,
    requestBody: {
      requests: [{
        insertTable: {
          rows: numRows,
          columns: numCols,
          location: { index: insertTableAt },
        },
      }],
    },
  });
  await sleep(1000);

  // Step 4: Fill in data — reload again to get cell indexes
  console.log('  Step 3: กำลังโหลด doc ใหม่เพื่อดึง index ของตาราง...');
  const doc3    = await docsApi.documents.get({ documentId: DOCUMENT_ID });
  const tableInfo = findTestCaseTable(doc3.data);

  if (!tableInfo) {
    console.error('  ❌ ไม่พบตารางที่เพิ่งสร้าง (อาจต้องรันอีกครั้ง)');
    return;
  }

  const { table, tableElem } = tableInfo;
  const tableStartIndex = tableElem.startIndex;

  console.log(`  Step 4: เขียนข้อมูล ${entries.length} rows...`);

  // --- Write header row ---
  const HEADERS = [HDR_TEST_ID, 'Description', 'Precondition', HDR_STEPS, HDR_EXPECTED, HDR_ACTUAL, HDR_STATUS, HDR_REMARK];
  const headerRow = table.tableRows[0];
  const headerRequests = [];
  HEADERS.forEach((hdr, ci) => {
    const cell = headerRow.tableCells[ci];
    headerRequests.push(...cellTextRequests(cell, hdr));
  });

  // Sort descending by index
  headerRequests.sort((a, b) => {
    const ia = a.deleteContentRange?.range?.startIndex ?? a.insertText?.location?.index ?? 0;
    const ib = b.deleteContentRange?.range?.startIndex ?? b.insertText?.location?.index ?? 0;
    return ib - ia;
  });

  await docsApi.documents.batchUpdate({
    documentId: DOCUMENT_ID,
    requestBody: { requests: headerRequests },
  });
  await sleep(300);

  // --- Write data rows in batches ---
  for (let i = 0; i < entries.length; i += BATCH_SZ) {
    const chunk = entries.slice(i, i + BATCH_SZ);
    const allReqs = [];
    const colorReqs = [];

    // Reload for fresh indexes
    const freshDoc = await docsApi.documents.get({ documentId: DOCUMENT_ID });
    const freshInfo = findTestCaseTable(freshDoc.data);
    if (!freshInfo) { console.error('  ❌ ตารางหายไป!'); break; }

    const freshTable = freshInfo.table;
    const freshStart = freshInfo.tableElem.startIndex;

    chunk.forEach((entry, ci) => {
      const rowIdx = i + ci + 1; // +1 for header
      if (rowIdx >= freshTable.tableRows.length) return;

      const row   = freshTable.tableRows[rowIdx];
      const cells = row.tableCells;

      // Format test steps text
      const stepsText = entry.question
        ? `1. เข้า Website กรมธนารักษ์\n2. คลิก Bubble Chatbot\n3. ถามด้วยคำถาม\n- ${entry.question}\n4. กดปุ่มส่ง`
        : '';
      // Format expected text
      const expText = entry.expected
        ? `AI Chatbot สามารถตอบคำถามถูกต้อง\n- ${entry.expected}`
        : '';

      const colData = [
        entry.testId      ?? '',
        'เปิดใช้ Chatbot',
        'เข้าเว็บไซต์ของกรมธนารักษ์',
        stepsText,
        expText,
        '',                         // Actual Result (ว่างไว้สำหรับรูป)
        entry.status      ?? '',
        entry.actual      ?? '',    // Remark = actual text
      ];

      colData.forEach((text, colI) => {
        if (colI < cells.length) {
          allReqs.push(...cellTextRequests(cells[colI], text));
        }
      });

      // Color status cell (col 6)
      if (cells[6] && entry.status) {
        colorReqs.push(cellColorRequest(freshStart, rowIdx, 6, entry.status));
      }
    });

    if (allReqs.length === 0) continue;

    // Sort descending
    allReqs.sort((a, b) => {
      const ia = a.deleteContentRange?.range?.startIndex ?? a.insertText?.location?.index ?? 0;
      const ib = b.deleteContentRange?.range?.startIndex ?? b.insertText?.location?.index ?? 0;
      return ib - ia;
    });

    console.log(`  batch ${Math.floor(i / BATCH_SZ) + 1}: เขียน ${chunk.length} rows (${allReqs.length} requests)...`);
    await docsApi.documents.batchUpdate({
      documentId: DOCUMENT_ID,
      requestBody: { requests: allReqs },
    });
    await sleep(500);

    // Apply colors
    const validColors = colorReqs.filter(Boolean);
    if (validColors.length > 0) {
      await docsApi.documents.batchUpdate({
        documentId: DOCUMENT_ID,
        requestBody: { requests: validColors },
      });
      await sleep(300);
    }
  }

  console.log('\n  ✅ เขียนตารางใหม่สำเร็จ!');
}

// ─────────────────────────────────────────────────────────────
// Default mode: update existing table
// ─────────────────────────────────────────────────────────────
async function updateExistingTable(docsApi, entries, dryRun) {
  h2('โหมด update: เขียนลงตารางที่มีอยู่แล้ว');

  // Load doc
  const doc = await docsApi.documents.get({ documentId: DOCUMENT_ID });
  const tableInfo = findTestCaseTable(doc.data);

  if (!tableInfo) {
    console.error('  ❌ ไม่พบตาราง Test Case ใน Doc กรุณาใช้ --fresh เพื่อสร้างใหม่');
    process.exit(1);
  }

  const { table, tableElem, colMap } = tableInfo;
  const tableStartIndex = tableElem.startIndex;
  const dataRows = table.tableRows.slice(1); // skip header

  console.log(`  พบตาราง: ${dataRows.length} data rows, ${Object.entries(colMap).filter(([,v]) => v >= 0).map(([k,v]) => `${k}=${v}`).join(', ')}`);

  if (colMap.status < 0 && colMap.actual < 0 && colMap.remark < 0) {
    console.error('  ❌ ไม่พบ column Status หรือ Actual Result ใน header');
    process.exit(1);
  }

  // Build map: question → row index (เพื่อ match กับ entries)
  // หรือ match โดย testId ถ้า colMap.testId >= 0
  const rowByTestId = {};
  const rowByQuestion = {};

  dataRows.forEach((row, idx) => {
    const cells = row.tableCells;
    if (colMap.testId >= 0) {
      const id = getCellText(cells[colMap.testId]);
      if (id) rowByTestId[id] = idx + 1; // +1 for header offset
    }
    if (colMap.steps >= 0) {
      const q = getCellText(cells[colMap.steps]);
      if (q) rowByQuestion[q] = idx + 1;
    }
  });

  if (dryRun) {
    console.log(`\n  [DRY RUN] จะ update ${entries.length} entries:`);
    entries.slice(0, 5).forEach(e => {
      const ri = rowByTestId[e.testId] ?? rowByQuestion[e.question];
      console.log(`    ${e.testId} → row ${ri ?? '?'} | ${e.status}`);
    });
    if (entries.length > 5) console.log(`    ... และอีก ${entries.length - 5}`);
    return;
  }

  let written = 0, skipped = 0;

  for (let i = 0; i < entries.length; i += BATCH_SZ) {
    const chunk = entries.slice(i, i + BATCH_SZ);

    // Must reload doc before each batch (indexes shift after writes)
    const freshDoc = await docsApi.documents.get({ documentId: DOCUMENT_ID });
    const freshInfo = findTestCaseTable(freshDoc.data);
    if (!freshInfo) { console.error('  ❌ ตารางหายไป!'); break; }

    const freshTable = freshInfo.table;
    const freshStart = freshInfo.tableElem.startIndex;
    const freshRows  = freshTable.tableRows.slice(1);

    const allReqs  = [];
    const colorReqs = [];

    for (const entry of chunk) {
      // Find matching row
      let rowDocIdx = rowByTestId[entry.testId];
      if (rowDocIdx == null && entry.question) rowDocIdx = rowByQuestion[entry.question];
      if (rowDocIdx == null) { skipped++; continue; }

      const row   = freshRows[rowDocIdx - 1];
      if (!row) { skipped++; continue; }
      const cells = row.tableCells;

      // Write actual (remark col) and status
      if (colMap.remark >= 0 && cells[colMap.remark]) {
        allReqs.push(...cellTextRequests(cells[colMap.remark], entry.actual ?? ''));
      }
      if (colMap.status >= 0 && cells[colMap.status]) {
        allReqs.push(...cellTextRequests(cells[colMap.status], entry.status ?? ''));
        colorReqs.push(cellColorRequest(freshStart, rowDocIdx, colMap.status, entry.status));
      }
      written++;
    }

    if (allReqs.length === 0) { await sleep(200); continue; }

    allReqs.sort((a, b) => {
      const ia = a.deleteContentRange?.range?.startIndex ?? a.insertText?.location?.index ?? 0;
      const ib = b.deleteContentRange?.range?.startIndex ?? b.insertText?.location?.index ?? 0;
      return ib - ia;
    });

    console.log(`  batch ${Math.floor(i / BATCH_SZ) + 1}: ${allReqs.length} requests...`);
    await docsApi.documents.batchUpdate({
      documentId: DOCUMENT_ID,
      requestBody: { requests: allReqs },
    });
    await sleep(800);

    const validColors = colorReqs.filter(Boolean);
    if (validColors.length > 0) {
      await docsApi.documents.batchUpdate({
        documentId: DOCUMENT_ID,
        requestBody: { requests: validColors },
      });
      await sleep(400);
    }
  }

  console.log(`\n  ✅ เขียนสำเร็จ: ${written}  ข้ามไป: ${skipped}`);
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  h1('AutoQA — Write Results to Google Docs');

  if (!DOCUMENT_ID) {
    console.error('❌ GOOGLE_DOCUMENT_ID ไม่พบใน .env');
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

  const raw  = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  // รองรับทั้ง { entries: {...} } (master) และ { entries: [...] } (pass/fail)
  let entries = Array.isArray(raw.entries)
    ? raw.entries
    : Object.values(raw.entries ?? {});

  // Filter by status if requested
  if (FILTER) {
    const before = entries.length;
    entries = entries.filter(e => e.status === FILTER);
    console.log(`  Filter ${FILTER}: ${before} → ${entries.length}`);
  }

  // Remove entries without status (nothing to write)
  const withStatus = entries.filter(e => e.status);
  console.log(`  Entries ที่มี status: ${withStatus.length} / ${entries.length}`);

  if (withStatus.length === 0) {
    console.log('  ไม่มีข้อมูลที่จะเขียน');
    return;
  }

  if (DRY_RUN) console.log('\n  ⚠️  DRY RUN mode — ไม่ write จริง');
  if (FRESH)   console.log('  📄 FRESH mode — สร้างตารางใหม่ท้าย doc');

  // Auth
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });
  const client = await auth.getClient();
  const docsApi = { documents: google.docs({ version: 'v1', auth: client }).documents };

  if (FRESH) {
    await freshTableMode(docsApi, withStatus, DRY_RUN);
  } else {
    await updateExistingTable(docsApi, withStatus, DRY_RUN);
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
