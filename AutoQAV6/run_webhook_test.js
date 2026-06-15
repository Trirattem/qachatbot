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
 *   node run_webhook_test.js --all           # every question in every tab
 *   node run_webhook_test.js --delay=1500    # ms between requests
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

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
const PER_TAB_LIMIT = RUN_ALL ? Infinity : parseInt(flag('limit', '5'), 10);
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    console.log(`  "${tab}" → took ${taken} question(s)`);
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
  console.log(`  Scope    : ${RUN_ALL ? 'ALL questions' : `${PER_TAB_LIMIT} per tab`}${ONLY_TAB ? ` (tab="${ONLY_TAB}")` : ''}`);
  console.log(`  Sources  : ${SOURCES.join(', ')}`);
  console.log(`  Delay    : ${DELAY_MS}ms between calls`);
  console.log(`  Retries  : ${RETRIES} (backoff ${RETRY_BACKOFF_MS}ms ↑) · cooldown ${COOLDOWN_MS / 1000}s after ${COOLDOWN_AFTER} fails\n`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();

  console.log('── Reading questions from sheet');
  const cases = await readQuestions(client);

  // Build the job list: every question × every requested source.
  const jobs = [];
  for (const c of cases) for (const source of SOURCES) jobs.push({ c, source });
  console.log(`\n  ${cases.length} question(s) × ${SOURCES.length} source(s) [${SOURCES.join(', ')}] = ${jobs.length} call(s)\n`);

  const results = [];
  const tally = {};                       // tally[source] = {PASS,PARTIAL,FAIL}
  for (const s of SOURCES) tally[s] = { PASS: 0, PARTIAL: 0, FAIL: 0 };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(OUTPUT_DIR, `webhook_test_${stamp}.json`);
  const flush = (done) => fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    endpoint: WEBHOOK_URL,
    scope: RUN_ALL ? 'all' : `${PER_TAB_LIMIT}/tab`,
    sources: SOURCES,
    complete: !!done,
    progress: `${results.length}/${jobs.length}`,
    total: results.length,
    summary: tally,
    results,
  }, null, 2));

  let consecutiveFails = 0;
  for (let i = 0; i < jobs.length; i++) {
    const { c, source } = jobs[i];
    const sessionId = `qa-${source}-${c.testId}-${Date.now()}`;
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
        console.log(`  ⏸  ${consecutiveFails} failures in a row — cooling down ${COOLDOWN_MS / 1000}s to let the server recover…`);
        flush(false);
        await sleep(COOLDOWN_MS);
        consecutiveFails = 0;
      }
    } else {
      consecutiveFails = 0;
    }

    if (results.length % 25 === 0) flush(false);   // periodic checkpoint
    if (i < jobs.length - 1) await sleep(DELAY_MS);
  }

  flush(true);   // final write

  console.log('\n' + '═'.repeat(60));
  console.log(` RESULTS: ${results.length} call(s) across ${cases.length} question(s)`);
  for (const s of SOURCES) {
    const t = tally[s];
    console.log(`   source="${s}"  →  ✅ ${t.PASS}   ⚠️ ${t.PARTIAL}   ❌ ${t.FAIL}`);
  }
  console.log('═'.repeat(60));
  console.log(`\n  📄 Saved: ${outFile}`);
}

main().catch(err => { console.error('\n❌ Error:', err.message); process.exit(1); });
