#!/usr/bin/env node
/**
 * run_webhook_test.js
 * ─────────────────────────────────────────────────────────────
 * Standalone QA runner for the PromptX (น้องรักษ์) webhook gateway.
 *
 * Why standalone: the gateway streams its answer as Server-Sent Events
 * (SSE), so the project's built-in webhookClient.js (which expects a plain
 * JSON {answer} response) cannot be used. This script:
 *   1. reads questions straight from the Google Sheet (all tabs, auto-
 *      detecting columns like consolidate.js does),
 *   2. sends each question with the gateway's required payload,
 *   3. parses the SSE stream to recover the bot's answer,
 *   4. scores PASS/PARTIAL/FAIL with the project's own classifier,
 *   5. writes results to output/ (never touches the sheet).
 *
 * Usage:
 *   node run_webhook_test.js                 # 5 questions per tab (smoke test)
 *   node run_webhook_test.js --limit=5       # N questions per tab
 *   node run_webhook_test.js --tab="General" # only one tab
 *   node run_webhook_test.js --all           # every question in every tab, capped per tab
 *   node run_webhook_test.js --delay=1500    # ms between requests
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';

// config/index.js throws unless a document id exists; we only need Sheets +
// the classifier here, so satisfy it with a harmless placeholder.
process.env.GOOGLE_DOCUMENT_ID = process.env.GOOGLE_DOCUMENT_ID || 'placeholder-not-used';
const { classify } = await import('./src/modules/classifier.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const KEY_FILE = path.resolve(__dirname,
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? './credentials/google-service-account.json');
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://uat-promptx.treasury.go.th/api_gateway/uat/send';
const OUTPUT_DIR = path.resolve(__dirname, 'output');

// CLI flags
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};
const RUN_ALL = argv.includes('--all');
const MAX_QUESTIONS_PER_TOPIC = parseInt(process.env.MAX_QUESTIONS_PER_TOPIC || '1000', 10);
const PER_TAB_LIMIT = RUN_ALL ? MAX_QUESTIONS_PER_TOPIC : parseInt(flag('limit', '5'), 10);
const ONLY_TAB = flag('tab', null);
const DELAY_MS = parseInt(flag('delay', '1500'), 10);
const REQUEST_TIMEOUT_MS = parseInt(flag('timeout', '90000'), 10);
const RETRIES = parseInt(flag('retries', '2'), 10);          // retries per question on failure
const RETRY_BACKOFF_MS = parseInt(flag('backoff', '5000'), 10); // base backoff, doubles each retry
// If this many calls fail in a row, pause to let the server recover.
const COOLDOWN_AFTER = parseInt(flag('cooldown-after', '8'), 10);
const COOLDOWN_MS = parseInt(flag('cooldown', '60000'), 10);
// Which gateway "source" to test: external | internal | both
const SOURCE_ARG = (flag('source', 'external') || 'external').toLowerCase();
const SOURCES = SOURCE_ARG === 'both' ? ['external', 'internal'] : [SOURCE_ARG];
// Retry mode: re-run only questions that never got an answer in prior result files.
const RETRY_FAILED = argv.includes('--retry-failed');
// In retry mode, optionally restrict to one recorded source (e.g. --source=internal).
const SOURCE_FLAG_PRESENT = argv.some(x => x.startsWith('--source='));
const RETRY_SOURCE_FILTER = (SOURCE_FLAG_PRESENT && SOURCE_ARG !== 'both') ? SOURCE_ARG : null;
// Self-terminate when the server stops recovering: give up after this many
// cooldowns happen with no successful answer in between.
const MAX_DEAD_COOLDOWNS = parseInt(flag('max-dead-cooldowns', '2'), 10);
const EXPORT_EXCEL = !argv.includes('--no-excel');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sanitizeSheetName(name, usedNames) {
  const cleanedBase = (name || 'Topic')
    .toString()
    .replace(/[\\/*?:\[\]]/g, '_')
    .trim()
    .slice(0, 31) || 'Topic';

  let candidate = cleanedBase;
  let suffix = 1;
  while (usedNames.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${cleanedBase.slice(0, 31 - tail.length)}${tail}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function pct(n, d) {
  return d === 0 ? 0 : n / d;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

async function writeExcelReport(results, meta) {
  const outPath = path.join(OUTPUT_DIR, `webhook_test_${meta.stamp}_summary.xlsx`);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AutoQAV6';
  workbook.created = new Date();
  workbook.modified = new Date();

  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
  const headerFont = { color: { argb: 'FFFFFFFF' }, bold: true };
  const passFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'C6EFCE' } };
  const partialFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEB9C' } };
  const failFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F4CCCC' } };
  const border = {
    top: { style: 'thin', color: { argb: 'D0D7DE' } },
    left: { style: 'thin', color: { argb: 'D0D7DE' } },
    bottom: { style: 'thin', color: { argb: 'D0D7DE' } },
    right: { style: 'thin', color: { argb: 'D0D7DE' } },
  };

  const byTopic = new Map();
  for (const row of results) {
    const topic = row.tab || 'Unknown';
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(row);
  }

  const indexSheet = workbook.addWorksheet('Topics');
  indexSheet.columns = [
    { header: 'Topic', key: 'topic', width: 24 },
    { header: 'Sheet', key: 'sheet', width: 18 },
    { header: 'Total', key: 'total', width: 10 },
    { header: 'PASS', key: 'pass', width: 10 },
    { header: 'PARTIAL', key: 'partial', width: 10 },
    { header: 'FAIL', key: 'fail', width: 10 },
    { header: 'Accuracy', key: 'accuracy', width: 12 },
  ];
  indexSheet.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  indexSheet.views = [{ state: 'frozen', ySplit: 1 }];

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.addRow(['Webhook Test Summary']);
  summarySheet.getRow(1).font = { bold: true, size: 16 };
  summarySheet.addRow([`Source file: webhook_test_${meta.stamp}.json`]);
  summarySheet.addRow([`Generated at: ${meta.generatedAt}`]);
  summarySheet.addRow([`Endpoint: ${meta.endpoint}`]);
  summarySheet.addRow([`Scope: ${meta.scope}`]);
  summarySheet.addRow([]);
  summarySheet.addRow(['Metric', 'Value']);
  summarySheet.getRow(7).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
  });

  const overall = Object.values(meta.summary || {}).reduce((acc, sourceCounts) => {
    acc.PASS += Number(sourceCounts?.PASS) || 0;
    acc.PARTIAL += Number(sourceCounts?.PARTIAL) || 0;
    acc.FAIL += Number(sourceCounts?.FAIL) || 0;
    return acc;
  }, { PASS: 0, PARTIAL: 0, FAIL: 0 });
  const total = overall.PASS + overall.PARTIAL + overall.FAIL;
  const metrics = [
    ['Total',                   total,                                      false],
    ['PASS',                    overall.PASS,                               false],
    ['PARTIAL',                 overall.PARTIAL,                            false],
    ['FAIL',                    overall.FAIL,                               false],
    ['Accuracy (PASS only)',    pct(overall.PASS, total),                   true],
    ['Accuracy (PASS+PARTIAL)', pct(overall.PASS + overall.PARTIAL, total), true],
    ['Review Rate',             pct(overall.PARTIAL, total),                true],
    ['Fail Rate',               pct(overall.FAIL, total),                   true],
  ];
  for (const [label, value, isPercent] of metrics) {
    const r = summarySheet.addRow([label, value]);
    if (isPercent) r.getCell(2).numFmt = '0.00%';
  }
  summarySheet.views = [{ state: 'frozen', ySplit: 7 }];
  summarySheet.getColumn(1).width = 22;
  summarySheet.getColumn(2).width = 18;

  const resultsSheet = workbook.addWorksheet('Results');
  resultsSheet.columns = [
    { header: 'Topic', key: 'tab', width: 20 },
    { header: 'Test ID', key: 'testId', width: 28 },
    { header: 'Row', key: 'rowIndex', width: 8 },
    { header: 'Question', key: 'question', width: 50 },
    { header: 'Expected', key: 'expected', width: 50 },
    { header: 'Actual', key: 'actual', width: 60 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Similarity', key: 'similarity', width: 12 },
    { header: 'Reason', key: 'reason', width: 38 },
    { header: 'Latency (ms)', key: 'latencyMs', width: 14 },
    { header: 'Attempts', key: 'attempts', width: 10 },
    { header: 'Error', key: 'error', width: 20 },
  ];
  resultsSheet.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  resultsSheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of results) {
    const record = resultsSheet.addRow({
      ...row,
      rowIndex: safeNumber(row.rowIndex),
      similarity: safeNumber(row.similarity),
      latencyMs: safeNumber(row.latencyMs),
      attempts: safeNumber(row.attempts),
    });
    record.getCell('similarity').numFmt = '0.00%';  // Bug #4 fix: was '0.0000'
    const fill = row.status === 'PASS' ? passFill : row.status === 'PARTIAL' ? partialFill : failFill;
    record.eachCell(cell => {
      cell.border = border;
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.fill = fill;
    });
  }

  const usedNames = new Set(['Topics', 'Summary', 'Results']);
  // Bug #6 fix: use 'th' locale so Thai tab names sort correctly
  for (const [topic, rows] of [...byTopic.entries()].sort((a, b) => a[0].localeCompare(b[0], ['th', 'en']))) {
    const wsName = sanitizeSheetName(topic, usedNames);
    const sheet = workbook.addWorksheet(wsName);
    const counts = rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, { PASS: 0, PARTIAL: 0, FAIL: 0 });

    // Bug #3 fix: separate label row and data row so numFmt works on numeric cells
    sheet.addRow([`Topic: ${topic}`]);
    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.addRow(['Total', 'PASS', 'PARTIAL', 'FAIL', 'Accuracy (PASS only)', 'Accuracy (PASS+PARTIAL)']);
    sheet.getRow(2).eachCell(cell => { cell.font = { bold: true }; cell.border = border; });
    const statsRow = sheet.addRow([
      rows.length,
      counts.PASS,
      counts.PARTIAL,
      counts.FAIL,
      pct(counts.PASS, rows.length),
      pct(counts.PASS + counts.PARTIAL, rows.length),
    ]);
    statsRow.getCell(5).numFmt = '0.00%';
    statsRow.getCell(6).numFmt = '0.00%';
    statsRow.eachCell(cell => { cell.border = border; });

    sheet.addRow([]);
    sheet.addRow(['Test ID', 'Row', 'Question', 'Expected', 'Actual', 'Status', 'Similarity', 'Reason', 'Latency (ms)', 'Attempts', 'Error']);
    sheet.getRow(5).eachCell(cell => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.border = border;
    });
    sheet.views = [{ state: 'frozen', ySplit: 5 }];
    sheet.columns = [
      { key: 'testId', width: 28 },
      { key: 'rowIndex', width: 8 },
      { key: 'question', width: 50 },
      { key: 'expected', width: 50 },
      { key: 'actual', width: 60 },
      { key: 'status', width: 12 },
      { key: 'similarity', width: 12 },
      { key: 'reason', width: 38 },
      { key: 'latencyMs', width: 14 },
      { key: 'attempts', width: 10 },
      { key: 'error', width: 20 },
    ];

    for (const row of rows) {
      const record = sheet.addRow({
        testId: row.testId,
        rowIndex: safeNumber(row.rowIndex),
        question: row.question,
        expected: row.expected,
        actual: row.actual,
        status: row.status,
        similarity: safeNumber(row.similarity),
        reason: row.reason,
        latencyMs: safeNumber(row.latencyMs),
        attempts: safeNumber(row.attempts),
        error: row.error,
      });
      record.getCell('similarity').numFmt = '0.00%';  // Bug #4 fix: was '0.0000'
      const fill = row.status === 'PASS' ? passFill : row.status === 'PARTIAL' ? partialFill : failFill;
      record.eachCell(cell => {
        cell.border = border;
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.fill = fill;
      });
    }

    indexSheet.addRow({
      topic,
      sheet: wsName,
      total: rows.length,
      pass: counts.PASS,
      partial: counts.PARTIAL,
      fail: counts.FAIL,
      accuracy: pct(counts.PASS, rows.length),
    });
  }

  indexSheet.getColumn('accuracy').numFmt = '0.00%';
  for (let i = 2; i <= indexSheet.rowCount; i++) {
    const row = indexSheet.getRow(i);
    row.eachCell(cell => {
      cell.border = border;
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  }

  await workbook.xlsx.writeFile(outPath);
  console.log(`  📊 Excel summary saved: ${outPath}`);
}

// Build the retry job list from prior both-source run files: every question
// that never got a real answer (request error / empty), minus any that DID get
// answered in some file. Returns [{ c, source }] ready for the main loop.
function loadFailedJobs() {
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('webhook_test_') && f.endsWith('.json'))
    .map(f => path.join(OUTPUT_DIR, f));

  const answered = new Set();   // key = testId|source that got a real answer anywhere
  const failed = new Map();     // key -> job (deduped)
  let scanned = 0;
  for (const fp of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (!Array.isArray(data.sources)) continue;   // only the full both-source runs ("both days")
    scanned++;
    for (const r of data.results ?? []) {
      const source = r.source || 'external';
      const key = `${r.testId}|${source}`;
      if (r.actual && !r.error) { answered.add(key); continue; }
      if (!failed.has(key)) {
        failed.set(key, { c: { tab: r.tab, testId: r.testId, rowIndex: r.rowIndex, question: r.question, expected: r.expected }, source });
      }
    }
  }
  let jobs = [...failed.entries()].filter(([k]) => !answered.has(k)).map(([, j]) => j);
  if (RETRY_SOURCE_FILTER) jobs = jobs.filter(j => j.source === RETRY_SOURCE_FILTER);
  console.log(`  Scanned ${scanned} prior run file(s): ${answered.size} already answered, ${jobs.length} still-failed to retry`
    + (RETRY_SOURCE_FILTER ? ` (source="${RETRY_SOURCE_FILTER}" only)` : ''));
  return jobs;
}

// ── Column detection (same approach as consolidate.js) ─────────
function normalizeHeader(h) { return (h ?? '').toString().replace(/\s+/g, '').toLowerCase(); }
function pickHeaderCol(header, dataRows, predicates) {
  const cands = [];
  header.forEach((h, i) => { if (predicates.some(p => h.includes(p))) cands.push(i); });
  if (!cands.length) return -1;
  let best = cands[0], bestN = -1;
  for (const ci of cands) {
    const n = dataRows.reduce((a, r) => a + ((r[ci] ?? '').toString().trim() ? 1 : 0), 0);
    if (n > bestN) { bestN = n; best = ci; }
  }
  return best;
}
function detectValueCol(dataRows, re) {
  const counts = {};
  dataRows.forEach(r => r.forEach((cell, ci) => {
    if (re.test((cell ?? '').toString().trim())) counts[ci] = (counts[ci] ?? 0) + 1;
  }));
  let best = -1, bestN = 0;
  for (const [ci, n] of Object.entries(counts)) { if (n > bestN) { bestN = n; best = +ci; } }
  return best;
}
const TESTID_RE = /^(TRD_AI_|TC_)\w*$/i;

// ── Read questions from every tab ──────────────────────────────
async function readQuestions(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  let tabs = meta.data.sheets.map(s => s.properties.title);
  if (ONLY_TAB) tabs = tabs.filter(t => t.trim() === ONLY_TAB.trim());

  const cases = [];
  for (const tab of tabs) {
    let res;
    try {
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `'${tab}'!A1:Z`, valueRenderOption: 'FORMATTED_VALUE',
      });
    } catch (e) { console.log(`  [skip] "${tab}" read error: ${e.message}`); continue; }

    const rows = res.data.values ?? [];
    if (rows.length < 2) continue;
    const header = (rows[0] ?? []).map(normalizeHeader);
    const dataRows = rows.slice(1);

    const colQ = pickHeaderCol(header, dataRows, ['question', 'คำถาม']);
    if (colQ < 0) { console.log(`  [skip] "${tab}" (no question column — summary tab)`); continue; }
    const colExp = pickHeaderCol(header, dataRows, ['expected', 'answer', 'คำตอบ']);
    let colId = pickHeaderCol(header, dataRows, ['testcaseid', 'testid', 'testcase']);
    if (colId < 0) colId = detectValueCol(dataRows, TESTID_RE);

    const tabSlug = tab.trim().replace(/\s+/g, '_');
    let taken = 0;
    for (let i = 0; i < dataRows.length && taken < PER_TAB_LIMIT; i++) {
      const row = dataRows[i];
      const get = (ci) => ci >= 0 ? ((row[ci] ?? '').toString().trim()) : '';
      const question = get(colQ);
      if (!question) continue;
      const rawId = get(colId);
      cases.push({
        tab,
        testId: `${tabSlug}__${rawId || `R${i + 2}`}`,
        rowIndex: i + 2,
        question,
        expected: get(colExp),
      });
      taken++;
    }
    console.log(`  "${tab}" → took ${taken} question(s)${RUN_ALL && MAX_QUESTIONS_PER_TOPIC > 0 ? ` (cap ${MAX_QUESTIONS_PER_TOPIC})` : ''}`);
  }
  return cases;
}

// ── Webhook call + SSE parsing ─────────────────────────────────
function extractAnswerFromSSE(body) {
  const chunks = [];
  let lastAgentMessage = '';
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    const d = evt.data ?? {};
    if (evt.type === 'stream_chunk' && d.chunk) chunks.push(d.chunk);
    if (evt.type === 'message' && d.sender && d.sender !== 'user' && d.message) lastAgentMessage = d.message;
  }
  const joined = chunks.join('').trim();
  return joined || lastAgentMessage.trim();
}

async function askBot(question, sessionId, source) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ sessionId, sender: 'qa-bot', content: question, source }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, answer: '', latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    return { ok: true, answer: extractAnswerFromSSE(text), latencyMs, raw: text };
  } catch (e) {
    return { ok: false, answer: '', latencyMs: Date.now() - started, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Retry on transient failures (500 / fetch failed / timeout) with exponential
// backoff, so a momentary server hiccup isn't scored as a FAIL.
async function askBotWithRetry(question, sessionId, source) {
  let resp;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    resp = await askBot(question, `${sessionId}-a${attempt}`, source);
    if (resp.ok && resp.answer) return { ...resp, attempts: attempt + 1 };
    if (attempt < RETRIES) await sleep(RETRY_BACKOFF_MS * Math.pow(2, attempt));
  }
  return { ...resp, attempts: RETRIES + 1 };
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log(' Webhook QA Test — PromptX (น้องรักษ์) UAT gateway');
  console.log('═'.repeat(60));
  console.log(`  Endpoint : ${WEBHOOK_URL}`);
  console.log(`  Scope    : ${RUN_ALL ? `ALL questions up to ${PER_TAB_LIMIT} per tab` : `${PER_TAB_LIMIT} per tab`}${ONLY_TAB ? ` (tab="${ONLY_TAB}")` : ''}`);
  console.log(`  Mode     : ${RETRY_FAILED ? 'RETRY failed questions from prior runs' : 'normal'}`);
  console.log(`  Sources  : ${RETRY_FAILED ? 'as-recorded' : SOURCES.join(', ')}`);
  console.log(`  Delay    : ${DELAY_MS}ms between calls`);
  console.log(`  Retries  : ${RETRIES} (backoff ${RETRY_BACKOFF_MS}ms ↑) · cooldown ${COOLDOWN_MS / 1000}s after ${COOLDOWN_AFTER} fails · give up after ${MAX_DEAD_COOLDOWNS} dead cooldowns\n`);

  if (RUN_ALL && MAX_QUESTIONS_PER_TOPIC > 0) {
    console.log(`  Topic cap: ${MAX_QUESTIONS_PER_TOPIC} question(s) per tab/topic`);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Build the job list.
  let jobs;
  if (RETRY_FAILED) {
    console.log('── Loading failed questions from prior runs');
    jobs = loadFailedJobs();
  } else {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const client = await auth.getClient();
    console.log('── Reading questions from sheet');
    const cases = await readQuestions(client);
    jobs = [];
    for (const c of cases) for (const source of SOURCES) jobs.push({ c, source });
    console.log(`\n  ${cases.length} question(s) × ${SOURCES.length} source(s) [${SOURCES.join(', ')}] = ${jobs.length} call(s)`);
  }
  console.log(`\n  Total calls this run: ${jobs.length}\n`);

  const usedSources = [...new Set(jobs.map(j => j.source))];
  const results = [];
  const tally = {};                       // tally[source] = {PASS,PARTIAL,FAIL}
  for (const s of usedSources) tally[s] = { PASS: 0, PARTIAL: 0, FAIL: 0 };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(OUTPUT_DIR, `webhook_test_${stamp}.json`);
  const scope = RETRY_FAILED ? 'retry-failed' : (RUN_ALL ? `all (${PER_TAB_LIMIT}/tab)` : `${PER_TAB_LIMIT}/tab`);
  const flush = (done) => fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    endpoint: WEBHOOK_URL,
    scope,
    sources: usedSources,
    complete: !!done,
    progress: `${results.length}/${jobs.length}`,
    total: jobs.length,       // Bug #1 fix: total planned jobs, not results so far
    completed: results.length,
    summary: tally,
    results,
  }, null, 2));

  // The gateway 500s on sessionIds longer than ~48 chars, so keep them SHORT.
  // q + run tag (unique per run) + job index → unique but ~10 chars max.
  const runTag = Date.now().toString(36).slice(-4);
  let consecutiveFails = 0;
  let deadCooldowns = 0;       // cooldowns with no success since the last one
  let stoppedEarly = false;
  for (let i = 0; i < jobs.length; i++) {
    const { c, source } = jobs[i];
    const sessionId = `q${runTag}${i}`;
    const resp = await askBotWithRetry(c.question, sessionId, source);

    let verdict;
    if (!resp.ok) {
      verdict = { status: 'FAIL', similarity: 0, reason: `Request failed: ${resp.error}` };
    } else if (!resp.answer) {
      verdict = { status: 'FAIL', similarity: 0, reason: 'Empty answer from bot' };
    } else {
      verdict = classify(c.expected, resp.answer, c.question);
    }
    tally[source][verdict.status] = (tally[source][verdict.status] ?? 0) + 1;

    results.push({
      tab: c.tab, testId: c.testId, rowIndex: c.rowIndex, source,
      question: c.question, expected: c.expected, actual: resp.answer,
      status: verdict.status, similarity: verdict.similarity, reason: verdict.reason,
      latencyMs: resp.latencyMs, attempts: resp.attempts, error: resp.error ?? null,
    });

    const icon = verdict.status === 'PASS' ? '✅' : verdict.status === 'PARTIAL' ? '⚠️ ' : '❌';
    console.log(`  ${String(i + 1).padStart(4)}/${jobs.length} ${icon} [${source.slice(0, 3)}|${c.tab}] sim=${verdict.similarity}  ${c.question.slice(0, 42)}`);

    // Adaptive cooldown: if the server starts failing repeatedly, back off so
    // we let it recover instead of hammering it (what killed the last run).
    if (resp.error || !resp.answer) {
      consecutiveFails++;
      if (consecutiveFails >= COOLDOWN_AFTER) {
        deadCooldowns++;
        if (deadCooldowns >= MAX_DEAD_COOLDOWNS) {
          console.log(`  🛑 Server not recovering after ${deadCooldowns} cooldowns — stopping early. Re-run later to continue.`);
          stoppedEarly = true;
          break;
        }
        console.log(`  ⏸  ${consecutiveFails} failures in a row — cooling down ${COOLDOWN_MS / 1000}s to let the server recover…`);
        flush(false);
        await sleep(COOLDOWN_MS);
        consecutiveFails = 0;
      }
    } else {
      consecutiveFails = 0;
      deadCooldowns = 0;       // a success means the server came back — reset
    }

    if (results.length % 25 === 0) flush(false);   // periodic checkpoint
    if (i < jobs.length - 1) await sleep(DELAY_MS);
  }

  flush(!stoppedEarly);   // final write (complete=false if we bailed early)

  if (EXPORT_EXCEL) {
    await writeExcelReport(results, {
      stamp,
      generatedAt: new Date().toISOString(),
      endpoint: WEBHOOK_URL,
      scope,   // Bug #5 fix: reuse the same scope string as JSON output
      summary: tally,
    });
  }

  const answeredNow = results.filter(r => r.actual && !r.error).length;
  console.log('\n' + '═'.repeat(60));
  console.log(` RESULTS: ${results.length} call(s) made${stoppedEarly ? ' (stopped early — server down)' : ''}`);
  console.log(`   recovered (got an answer this run): ${answeredNow}`);
  for (const s of usedSources) {
    const t = tally[s];
    console.log(`   source="${s}"  →  ✅ ${t.PASS}   ⚠️ ${t.PARTIAL}   ❌ ${t.FAIL}`);
  }
  console.log('═'.repeat(60));
  console.log(`\n  📄 Saved: ${outFile}`);
}

main().catch(err => { console.error('\n❌ Error:', err.message); process.exit(1); });
