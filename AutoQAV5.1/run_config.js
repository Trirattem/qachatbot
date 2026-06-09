#!/usr/bin/env node
/**
 * run_config.js — Chatbot QA Automation (v2 — Named Profiles)
 * ─────────────────────────────────────────────────────────────
 * รองรับ Named Profiles หลายชุด เก็บไว้ใน profiles/
 * เลือก target (Docs / Sheets) ก่อนเสมอถ้ามีทั้งคู่ใน .env
 *
 * คำสั่ง:
 *   node run_config.js           → เปิดเมนูหลัก
 *   node run_config.js --show    → แสดง profile ที่ active อยู่
 *   node run_config.js --verify  → ตรวจ target แล้วออก
 *   node run_config.js --list    → แสดงรายชื่อ profiles ทั้งหมด
 *   node run_config.js --reset   → รีเซ็ต active profile เป็น default
 */

import 'dotenv/config';
import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import config from './src/config/index.js';
import DocsClient from './src/modules/docsClient.js';
import SheetsClient from './src/modules/sheetsClient.js';
import ImageSyncTool from './src/modules/imageSyncTool.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));

// ─── paths ───────────────────────────────────────────────────
const PROFILES_DIR    = path.resolve(__dirname, 'profiles');
const ACTIVE_FILE     = path.resolve(__dirname, '.env.run');     // profile ที่ active อยู่
const CREDS_PATH      = path.resolve(
  __dirname,
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ??
  'credentials/chatbot-497504-0836c2cb62a2.json'
);

const DOC_ID     = process.env.GOOGLE_DOCUMENT_ID;
const SHEET_ID   = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME ?? 'TestCases';

// ─── defaults ────────────────────────────────────────────────
const DEFAULTS = {
  RUN_FROM:      '1',
  RUN_TO:        '0',
  RUN_DIRECTION: 'top_to_bottom',
  RUN_PARITY:    'all',
};

// ─── ANSI colors ─────────────────────────────────────────────
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
  cyan:    '\x1b[96m',
  green:   '\x1b[92m',
  yellow:  '\x1b[93m',
  blue:    '\x1b[94m',
  magenta: '\x1b[95m',
  red:     '\x1b[91m',
  bgPanel: '\x1b[48;5;237m',
  bgDark:  '\x1b[48;5;235m',
};

const W = 62;

// ─── print helpers ────────────────────────────────────────────
const print = (s = '') => process.stdout.write(s + '\n');
const clr   = (...a)   => a.join('') + c.reset;
const pad   = (s, n)   => String(s ?? '').padEnd(n).slice(0, n);
const blank = ()       => print();

function rule(char = '─') {
  print(clr(c.gray, '  ' + char.repeat(W)));
}

function title() {
  blank();
  print(clr(c.bold, c.cyan, '  ┌' + '─'.repeat(W) + '┐'));
  print(clr(c.bold, c.cyan, '  │', c.white, c.bold, pad('  QA Run Config  —  Named Profiles', W), c.cyan, '│'));
  print(clr(c.bold, c.cyan, '  │', c.gray,           pad('  Chatbot QA Automation v2', W), c.cyan,          '│'));
  print(clr(c.bold, c.cyan, '  └' + '─'.repeat(W) + '┘'));
  blank();
}

function sectionHead(icon, txt) {
  blank();
  print(clr(c.bold, c.yellow, `  ${icon}  ${txt}`));
  rule();
}

function row(label, value, valueColor = c.white) {
  print(clr(c.gray, '  ' + pad(label, 22)) + clr(valueColor, c.bold, value));
}

// ─── readline ─────────────────────────────────────────────────
let rl;
function getRL() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
const ask = (prompt) => new Promise(r => getRL().question(prompt, r));

async function askStyled(label, defaultVal) {
  const prompt =
    clr(c.gray, '  › ') +
    clr(c.white, label + ' ') +
    clr(c.dim, `[${defaultVal}]`) +
    clr(c.gray, ' : ');
  const ans = (await ask(prompt)).trim();
  return ans === '' ? String(defaultVal) : ans;
}

async function askConfirm(prompt) {
  const ans = (await ask(
    clr(c.gray, '  › ') + clr(c.white, prompt) + clr(c.gray, ' (y/n) : ')
  )).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

// ─── directions & parities ───────────────────────────────────
const DIRECTIONS = [
  { key: '1', label: 'บนลงล่าง',      code: 'top_to_bottom' },
  { key: '2', label: 'ล่างขึ้นบน',    code: 'bottom_to_top' },
  { key: '3', label: 'บน → กลาง',    code: 'top_to_mid'    },
  { key: '4', label: 'ล่าง → กลาง',  code: 'bottom_to_mid' },
  { key: '5', label: 'กลาง → บน',    code: 'mid_to_top'    },
  { key: '6', label: 'กลาง → ล่าง',  code: 'mid_to_bottom' },
];

const PARITIES = [
  { key: '1', label: 'ทุกแถว',       code: 'all'  },
  { key: '2', label: 'เลขคู่เท่านั้น', code: 'even' },
  { key: '3', label: 'เลขคี่เท่านั้น', code: 'odd'  },
];

const findDir = (code) => DIRECTIONS.find(d => d.code === code) ?? DIRECTIONS[0];
const findPar = (code) => PARITIES.find(p => p.code === code)   ?? PARITIES[0];

// ─── auto profile name ──────────────────────────────────────────
function autoProfileName(from, to, totalRows, dirCode, parCode) {
  const toLabel = (!to || to === '0') ? String(totalRows ?? '?') : to;
  const dir     = findDir(dirCode).label;
  const par     = findPar(parCode).label;
  return `Row_${from}-${toLabel} · ${dir} · ${par}`;
}

// safe filename (ลบ char พิเศษ)
function safeFilename(name) {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

// ─── profile I/O ─────────────────────────────────────────────
function ensureProfilesDir() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function listDatasets(targetType) {
  const targetSubdir = targetType === 'sheets' ? 'Google Sheets' : 'Google Docs';
  const dsDir = path.resolve(__dirname, 'datasets', targetSubdir);
  if (!fs.existsSync(dsDir)) return [];
  return fs.readdirSync(dsDir)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a))
    .map(f => path.join('datasets', targetSubdir, f).replace(/\\/g, '/'));
}

function listProfiles() {
  ensureProfilesDir();
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
        return { filename: f, ...data };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

function loadProfile(filename) {
  const fp = path.join(PROFILES_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function saveProfile(profile) {
  ensureProfilesDir();
  const fp = path.join(PROFILES_DIR, profile.filename);
  fs.writeFileSync(fp, JSON.stringify(profile, null, 2), 'utf8');
}

function deleteProfile(filename) {
  const fp = path.join(PROFILES_DIR, filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

// ─── active profile (.env.run) ────────────────────────────────
function loadActiveConfig() {
  if (!fs.existsSync(ACTIVE_FILE)) return {};
  const cfg = {};
  for (const l of fs.readFileSync(ACTIVE_FILE, 'utf8').split('\n')) {
    const m = l.match(/^([^=]+)=(.*)$/);
    if (m) cfg[m[1].trim()] = m[2].trim();
  }
  return cfg;
}

function saveActiveConfig(profile) {
  const lines = [
    `RUN_FROM=${profile.runFrom}`,
    `RUN_TO=${profile.runTo}`,
    `RUN_DIRECTION=${profile.dirCode}`,
    `RUN_PARITY=${profile.parCode}`,
    `TOTAL_ROWS=${profile.totalRows ?? 0}`,
    `PROFILE_NAME=${profile.name}`,
    `PROFILE_FILE=${profile.filename}`,
    `TARGET=${profile.target}`,
    `SELECTED_DATASET=${profile.selectedDataset ?? ''}`,
    `UPDATED_AT=${profile.updatedAt ?? ''}`,
  ];
  fs.writeFileSync(ACTIVE_FILE, lines.join('\n') + '\n', 'utf8');
}

function getActiveProfileFile() {
  const cfg = loadActiveConfig();
  return cfg.PROFILE_FILE ?? null;
}

// ─── checkpoint status ────────────────────────────────────────
function getCheckpointStatus(profile) {
  // checkpoint อยู่ใน logs/progress_{trackerId...}.json
  // trackerId = spreadsheetId หรือ documentId ขึ้นกับ target
  const logsDir = path.resolve(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) return null;

  const targetId = profile.target === 'sheets' ? SHEET_ID : DOC_ID;
  if (!targetId) return null;

  const prefix = `progress_${targetId.slice(0, 20)}`;
  const files  = fs.readdirSync(logsDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  if (files.length === 0) return null;

  try {
    const data      = JSON.parse(fs.readFileSync(path.join(logsDir, files[0]), 'utf8'));
    const completed = Object.keys(data.completed ?? {}).length;
    const written   = Object.values(data.completed ?? {}).filter(v => v.writtenToDocs || v.writtenToSheets).length;
    const lastId    = data.lastCompletedTestId ?? null;
    const updatedAt = data.updatedAt ?? null;
    return { completed, written, lastId, updatedAt };
  } catch {
    return null;
  }
}

// ─── Google Docs info ─────────────────────────────────────────
function extractCellText(cell) {
  let text = '';
  for (const el of cell.content ?? []) {
    if (el.paragraph) {
      for (const part of el.paragraph.elements ?? []) {
        text += part.textRun?.content ?? '';
      }
    }
  }
  return text.replace(/\u00a0/g, ' ').replace(/\r?\n/g, ' ').trim();
}

async function getDocInfo() {
  if (!DOC_ID)                    throw new Error('GOOGLE_DOCUMENT_ID ไม่พบใน .env');
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`ไม่พบ credentials: ${CREDS_PATH}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/documents.readonly'],
  });
  const docs = google.docs({ version: 'v1', auth });
  const doc  = await docs.documents.get({ documentId: DOC_ID });
  const body = doc.data.body.content;

  const docTitle = doc.data.title ?? '(ไม่มีชื่อ)';
  const docUrl   = `https://docs.google.com/document/d/${DOC_ID}/edit`;

  let totalDataRows = 0, tableCount = 0;
  const previewRows = [];
  let   headers     = [];

  for (const el of body) {
    if (!el.table) continue;
    tableCount++;
    const rows = el.table.tableRows ?? [];
    if (rows.length > 1) totalDataRows += rows.length - 1;
    if (tableCount === 1 && rows.length > 0) {
      headers = (rows[0].tableCells ?? []).map(cell => extractCellText(cell));
      for (let i = 1; i <= Math.min(5, rows.length - 1); i++) {
        previewRows.push((rows[i].tableCells ?? []).map(cell => extractCellText(cell)));
      }
    }
  }
  return { docTitle, docUrl, totalDataRows, tableCount, headers, previewRows };
}

// ─── Google Sheets info ───────────────────────────────────────
async function getSheetInfo() {
  if (!SHEET_ID)                  throw new Error('GOOGLE_SPREADSHEET_ID ไม่พบใน .env');
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`ไม่พบ credentials: ${CREDS_PATH}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });

  const sheetTitle = meta.data.properties?.title ?? '(ไม่มีชื่อ)';
  const sheetUrl   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  const tabList    = meta.data.sheets?.map(s => s.properties?.title) ?? [];
  const tabExists  = tabList.includes(SHEET_NAME);

  let headers = [], previewRows = [], totalDataRows = 0;
  if (tabExists) {
    const rangeResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:Z6`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const values = rangeResp.data.values ?? [];
    if (values.length > 0) headers     = values[0];
    if (values.length > 1) previewRows = values.slice(1);

    const allResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    totalDataRows = Math.max(0, (allResp.data.values?.length ?? 1) - 1);
  }
  return { sheetTitle, sheetUrl, tabList, tabExists, headers, previewRows, totalDataRows };
}

// ─── draw preview table ───────────────────────────────────────
function drawPreviewTable(headers, rows) {
  if (!headers.length && !rows.length) {
    print(clr(c.dim, '  (ไม่มีข้อมูลให้แสดง)'));
    return;
  }
  const MAX_COL = 16;
  const tr = (s, n) => {
    const str = String(s ?? '').replace(/\n/g, ' ').trim();
    return str.length > n ? str.slice(0, n - 1) + '…' : str.padEnd(n);
  };
  const cols = headers.length || (rows[0]?.length ?? 0);
  const hdrs = headers.length ? headers : Array.from({ length: cols }, (_, i) => `Col${i+1}`);
  const colW = hdrs.map((h, i) => {
    const dataMax = Math.max(...rows.map(r => String(r[i] ?? '').length));
    return Math.min(MAX_COL, Math.max(8, h.length, dataMax));
  });
  const sep = '  ├─' + colW.map(w => '─'.repeat(w + 2)).join('─┼─') + '─┤';
  const top = '  ┌─' + colW.map(w => '─'.repeat(w + 2)).join('─┬─') + '─┐';
  const bot = '  └─' + colW.map(w => '─'.repeat(w + 2)).join('─┴─') + '─┘';
  print(clr(c.gray, top));
  print('  │ ' + hdrs.map((h, i) => clr(c.bold, c.cyan, tr(h, colW[i]))).join(clr(c.gray, ' │ ')) + clr(c.gray, ' │'));
  print(clr(c.gray, sep));
  rows.forEach((row, ri) => {
    const rc = ri % 2 === 0 ? c.white : c.dim;
    print('  │ ' + colW.map((w, i) => clr(rc, tr(row[i] ?? '', w))).join(clr(c.gray, ' │ ')) + clr(c.gray, ' │'));
  });
  print(clr(c.gray, bot));
}

// ─── connect & fetch target info ─────────────────────────────
async function connectTarget(targetType) {
  if (targetType === 'sheets') {
    process.stdout.write(clr(c.gray, '  กำลังเชื่อมต่อ Google Sheets'));
    try {
      const dots = setInterval(() => process.stdout.write(clr(c.gray, '.')), 400);
      const info = await getSheetInfo();
      clearInterval(dots);
      process.stdout.write('\n');
      print(clr(c.green, '  ✔  Sheets:') + clr(c.gray, ` ${info.sheetTitle} — ${SHEET_NAME} / ${info.totalDataRows} rows`));
      return { ok: true, info, totalRows: info.totalDataRows };
    } catch (err) {
      process.stdout.write('\n');
      print(clr(c.yellow, '  ⚠  ') + clr(c.dim, `เชื่อมต่อไม่ได้: ${err.message}`));
      return { ok: false, info: null, totalRows: 0 };
    }
  } else {
    process.stdout.write(clr(c.gray, '  กำลังเชื่อมต่อ Google Docs'));
    try {
      const dots = setInterval(() => process.stdout.write(clr(c.gray, '.')), 400);
      const info = await getDocInfo();
      clearInterval(dots);
      process.stdout.write('\n');
      print(clr(c.green, '  ✔  Docs:') + clr(c.gray, ` ${info.docTitle} — ${info.totalDataRows} test cases (${info.tableCount} ตาราง)`));
      return { ok: true, info, totalRows: info.totalDataRows };
    } catch (err) {
      process.stdout.write('\n');
      print(clr(c.yellow, '  ⚠  ') + clr(c.dim, `เชื่อมต่อไม่ได้: ${err.message}`));
      return { ok: false, info: null, totalRows: 0 };
    }
  }
}

// ─── show verify panel ────────────────────────────────────────
function showVerifyPanel(targetType, info) {
  if (!info) return;
  const borderColor = targetType === 'sheets' ? c.green : c.cyan;
  const icon        = targetType === 'sheets' ? '📊' : '📄';
  blank();
  print(clr(c.bold, borderColor, '  ┌' + '─'.repeat(W) + '┐'));
  print(clr(c.bold, borderColor, '  │', c.bold, c.white, pad(`  ${icon}  ยืนยัน ${targetType === 'sheets' ? 'Google Sheets' : 'Google Docs'} Target`, W), borderColor, '│'));
  print(clr(c.bold, borderColor, '  ├' + '─'.repeat(W) + '┤'));

  const line = (label, val, vc = c.white) =>
    print(clr(borderColor, '  │  ') + clr(c.gray, pad(label, 16)) + clr(vc, c.bold, pad(String(val), W - 20)) + clr(borderColor, '│'));

  if (targetType === 'sheets') {
    line('ชื่อ Spreadsheet', info.sheetTitle, c.white);
    line('Tab ที่ใช้',        SHEET_NAME, info.tabExists ? c.green : c.red);
    line('ลิงค์',             info.sheetUrl, c.cyan);
    line('จำนวนแถว',          info.tabExists ? `${info.totalDataRows} test cases` : '⚠ ไม่พบ tab', info.tabExists ? c.green : c.yellow);
  } else {
    line('ชื่อเอกสาร', info.docTitle, c.white);
    line('ลิงค์',      info.docUrl,   c.cyan);
    line('จำนวนแถว',   `${info.totalDataRows} test cases  (${info.tableCount} ตาราง)`, c.green);
  }
  print(clr(c.bold, borderColor, '  └' + '─'.repeat(W) + '┘'));
  blank();
  if (info.previewRows?.length > 0) {
    print(clr(c.bold, c.yellow, '  📋  Preview 5 แถวแรก'));
    blank();
    drawPreviewTable(info.headers, info.previewRows);
    blank();
  }
}

// ─── draw profile list ────────────────────────────────────────
function drawProfileList(profiles, activeFile, targetFilter) {
  const filtered = targetFilter
    ? profiles.filter(p => p.target === targetFilter)
    : profiles;

  if (filtered.length === 0) {
    print(clr(c.dim, '  (ยังไม่มี profile สำหรับ target นี้)'));
    return filtered;
  }

  filtered.forEach((p, i) => {
    const isActive = p.filename === activeFile;
    const idx      = String(i + 1).padStart(2);
    const ckpt     = getCheckpointStatus(p);

    const toLabel  = (!p.runTo || p.runTo === '0') ? String(p.totalRows ?? '?') : p.runTo;
    const rangeStr = `${p.runFrom}→${toLabel}`;
    const dirStr   = findDir(p.dirCode).label;
    const parStr   = findPar(p.parCode).label;
    const nameStr  = pad(p.name, 30);
    const detailStr = clr(c.dim, `[${rangeStr} · ${dirStr} · ${parStr}]`);

    let ckptStr = '';
    if (ckpt) {
      ckptStr = clr(c.dim, `  ckpt:${ckpt.completed}/${p.totalRows ?? '?'}`);
    }

    const lastRun = p.updatedAt
      ? clr(c.dim, `  ${p.updatedAt.slice(0, 16)}`)
      : '';

    if (isActive) {
      print(
        clr(c.bgPanel, c.yellow, c.bold, `  [${idx}]`) +
        clr(c.bgPanel, c.white,  c.bold, `  ${nameStr}`) +
        clr(c.bgPanel, c.cyan,  ' ✦ active') +
        c.reset
      );
      print(clr(c.bgPanel, c.dim, `       ${detailStr}  ${ckptStr}${lastRun}`) + c.reset);
    } else {
      print(clr(c.gray, `  [${idx}]`) + clr(c.white, `  ${nameStr}`));
      print(clr(c.dim,  `       `) + detailStr + ckptStr + lastRun);
    }
    blank();
  });

  return filtered;
}

// ─── configure range / direction / parity / dataset ─────────
async function configureProfile(defaults, totalRows, targetType) {
  sectionHead('🗂️', 'เลือก Dataset Snapshot');
  let datasets = listDatasets(targetType);
  let selectedDataset = defaults.selectedDataset ?? '';
  
  if (datasets.length === 0) {
    print(clr(c.dim, `  ⚠ ไม่พบ Dataset ในโฟลเดอร์ datasets/${targetType === 'sheets' ? 'Google Sheets' : 'Google Docs'}`));
    const rawAns = await askStyled('ต้องการดึง Dataset ตอนนี้เลยไหม? (Y/n)', 'y');
    if (rawAns.toLowerCase() !== 'n') {
      blank();
      print(clr(c.gray, '  กำลังสกัดข้อมูล... (กรุณารอซักครู่)'));
      const cmdArgs = ['src/index.js', '--extract-only'];
      if (targetType === 'sheets') cmdArgs.push('--use-sheets');
      
      await new Promise((resolve) => {
        const proc = spawn('node', cmdArgs, { stdio: 'inherit' });
        proc.on('close', resolve);
      });
      
      // Reload datasets after extraction
      datasets = listDatasets(targetType);
      blank();
    } else {
      print(clr(c.dim, '  ระบบจะข้ามการเลือก Dataset (กรุณารันโหมด --extract-only ก่อนรันจริง)'));
      blank();
    }
  } 

  if (datasets.length > 0) {
    for (let i = 0; i < datasets.length; i++) {
      const ds = datasets[i];
      const isDefault = (selectedDataset === ds) || (i === 0 && !selectedDataset);
      if (isDefault) selectedDataset = ds; // Set default if empty
      
      if (isDefault) {
         print(clr(c.bgPanel, c.cyan, c.bold, `  [${i+1}]`) + clr(c.bgPanel, c.white, c.bold, `  ${ds}`) + clr(c.bgPanel, c.cyan, ' ✦ ปัจจุบัน') + c.reset);
      } else {
         print(clr(c.gray, `  [${i+1}]`) + clr(c.dim, `  ${ds}`));
      }
    }
    blank();
    const curDsIdx = datasets.indexOf(selectedDataset) + 1;
    const rawDs = await askStyled('เลือก Dataset (1-' + datasets.length + ')', String(curDsIdx > 0 ? curDsIdx : 1));
    const dsIdx = parseInt(rawDs, 10) - 1;
    if (dsIdx >= 0 && dsIdx < datasets.length) {
      selectedDataset = datasets[dsIdx];
    }
  }

  sectionHead('❶', 'กำหนด Range');
  print(clr(c.dim, '  กด Enter เพื่อคงค่าเดิม  |  ใส่ 0 = ทั้งหมด'));
  blank();

  const rawFrom = await askStyled('เริ่มจากแถวที่', defaults.runFrom ?? '1');
  const rawTo   = await askStyled('ถึงแถวที่      ', defaults.runTo && defaults.runTo !== '0' ? defaults.runTo : String(totalRows));

  const runFrom = rawFrom === '0' ? '1' : rawFrom;
  const runTo   = (rawTo === '0' || rawTo === String(totalRows)) ? '0' : rawTo;

  sectionHead('❷', 'ทิศทางการรัน');
  blank();
  for (const d of DIRECTIONS) {
    const active = (defaults.dirCode ?? 'top_to_bottom') === d.code;
    if (active) {
      print(clr(c.bgPanel, c.cyan, c.bold, `  [${d.key}]`) + clr(c.bgPanel, c.white, c.bold, `  ${pad(d.label, 30)}`) + clr(c.bgPanel, c.cyan, ' ✦ ปัจจุบัน') + c.reset);
    } else {
      print(clr(c.gray, `  [${d.key}]`) + clr(c.dim, `  ${d.label}`));
    }
  }
  blank();

  const curDirKey = DIRECTIONS.find(d => d.code === (defaults.dirCode ?? 'top_to_bottom'))?.key ?? '1';
  const rawDir    = await askStyled('เลือกทิศทาง (1-6)', curDirKey);
  const dirChoice = DIRECTIONS.find(d => d.key === rawDir) ?? DIRECTIONS[0];

  sectionHead('❸', 'รูปแบบการรัน');
  blank();
  for (const p of PARITIES) {
    const active = (defaults.parCode ?? 'all') === p.code;
    if (active) {
      print(clr(c.bgPanel, c.cyan, c.bold, `  [${p.key}]`) + clr(c.bgPanel, c.white, c.bold, `  ${pad(p.label, 30)}`) + clr(c.bgPanel, c.cyan, ' ✦ ปัจจุบัน') + c.reset);
    } else {
      print(clr(c.gray, `  [${p.key}]`) + clr(c.dim, `  ${p.label}`));
    }
  }
  blank();

  const curParKey = PARITIES.find(p => p.code === (defaults.parCode ?? 'all'))?.key ?? '1';
  const rawPar    = await askStyled('เลือกรูปแบบ (1-3)', curParKey);
  const parChoice = PARITIES.find(p => p.key === rawPar) ?? PARITIES[0];

  return { runFrom, runTo, dirChoice, parChoice, selectedDataset };
}

// ─── ask profile name ─────────────────────────────────────────
async function askProfileName(autoName) {
  sectionHead('❹', 'ตั้งชื่อ Profile');
  print(clr(c.dim, `  ชื่อ auto-generate: ${autoName}`));
  print(clr(c.dim, '  กด Enter เพื่อใช้ชื่อนี้ หรือพิมพ์ชื่อเอง'));
  blank();
  const ans = (await ask(
    clr(c.gray, '  › ') + clr(c.white, 'ชื่อ Profile') + clr(c.gray, ' : ')
  )).trim();
  return ans === '' ? autoName : ans;
}

// ─── ask run mode ─────────────────────────────────────────────
async function askRunMode(targetType) {
  sectionHead('❺', 'เลือก Mode การรัน');
  blank();

  const modes = targetType === 'sheets'
    ? [
        { key: '1', label: 'รันปกติ (browser + write Sheets)',      cmd: 'npm run test:sheets'        },
        { key: '2', label: 'Dry Run (browser เท่านั้น ไม่ write)',   cmd: 'npm run test:sheets:dry'    },
        { key: '3', label: 'Resume (รันต่อจาก checkpoint)',          cmd: 'npm run test:sheets:resume' },
        { key: '4', label: 'Sheets Only (write จาก checkpoint)',      cmd: 'npm run test:sheets-only'   },
        { key: '5', label: 'Browser Only (รันแล้วไม่ write)',        cmd: 'npm run test:browser-only'  },
      ]
    : [
        { key: '1', label: 'รันปกติ (browser + write Docs)',         cmd: 'npm test'                   },
        { key: '2', label: 'Dry Run (browser เท่านั้น ไม่ write)',   cmd: 'npm run test:dry'           },
        { key: '3', label: 'Resume (รันต่อจาก checkpoint)',          cmd: 'npm run test:resume'        },
        { key: '4', label: 'Docs Only (write จาก checkpoint)',        cmd: 'npm run test:docs-only'     },
        { key: '5', label: 'Browser Only (รันแล้วไม่ write)',        cmd: 'npm run test:browser-only'  },
      ];

  for (const m of modes) {
    print(clr(c.gray, `  [${m.key}]`) + clr(c.white, `  ${m.label}`));
    print(clr(c.dim,  `       → ${m.cmd}`));
    blank();
  }

  const rawMode = (await ask(
    clr(c.gray, '  › ') + clr(c.white, 'เลือก mode') + clr(c.gray, ` [1-${modes.length}] : `)
  )).trim();
  return modes.find(m => m.key === rawMode) ?? modes[0];
}

// ─── profile summary card ─────────────────────────────────────
function showProfileCard(profile, borderColor = c.green) {
  blank();
  const toLabel = (!profile.runTo || profile.runTo === '0') ? String(profile.totalRows ?? '?') : profile.runTo;
  print(clr(c.bold, borderColor, '  ┌' + '─'.repeat(W) + '┐'));
  print(clr(c.bold, borderColor, '  │', c.bold, c.white, pad(`  ✔  ${profile.name}`, W), borderColor, '│'));
  print(clr(c.bold, borderColor, '  ├' + '─'.repeat(W) + '┤'));

  const line = (label, val, vc = c.cyan) =>
    print(clr(borderColor, '  │  ') + clr(c.gray, pad(label, 14)) + clr(vc, c.bold, pad(String(val), W - 18)) + clr(borderColor, '│'));

  line('Target',   profile.target === 'sheets' ? 'Google Sheets' : 'Google Docs', profile.target === 'sheets' ? c.green : c.cyan);
  line('Range',    `แถวที่ ${profile.runFrom}  →  ${toLabel}  (จาก ${profile.totalRows ?? '?'} แถว)`);
  line('ทิศทาง',  findDir(profile.dirCode).label);
  line('รูปแบบ',  findPar(profile.parCode).label);
  line('บันทึกเมื่อ', profile.updatedAt ?? '—', c.dim);
  print(clr(c.bold, borderColor, '  └' + '─'.repeat(W) + '┘'));
  blank();
}

// ══════════════════════════════════════════════════════════════
// TARGET SELECTION
// ══════════════════════════════════════════════════════════════
async function selectTarget() {
  const hasDoc   = Boolean(DOC_ID);
  const hasSheet = Boolean(SHEET_ID);

  if (!hasDoc && !hasSheet) {
    print(clr(c.red, c.bold, '  ✖  ไม่พบ GOOGLE_DOCUMENT_ID หรือ GOOGLE_SPREADSHEET_ID ใน .env'));
    process.exit(1);
  }

  // มีแค่อันเดียว → ใช้เลย
  if (hasDoc && !hasSheet) return 'docs';
  if (!hasDoc && hasSheet)  return 'sheets';

  // มีทั้งคู่ → ถาม
  blank();
  print(clr(c.bold, c.yellow, '  🎯  เลือก Target'));
  rule();
  blank();
  print(clr(c.gray, '  [1]') + clr(c.cyan,  c.bold, '  📄  Google Docs'));
  print(clr(c.dim,  `       ID: ${DOC_ID?.slice(0, 30)}…`));
  blank();
  print(clr(c.gray, '  [2]') + clr(c.green, c.bold, '  📊  Google Sheets'));
  print(clr(c.dim,  `       ID: ${SHEET_ID?.slice(0, 30)}…  Tab: ${SHEET_NAME}`));
  blank();

  const ans = (await ask(
    clr(c.gray, '  › ') + clr(c.white, 'เลือก target') + clr(c.gray, ' [1/2] : ')
  )).trim();

  return ans === '2' ? 'sheets' : 'docs';
}

// ══════════════════════════════════════════════════════════════
// PROFILE MANAGEMENT MENU
// ══════════════════════════════════════════════════════════════
async function profileMenu(targetType, totalRows, info) {
  while (true) {
    sectionHead('📁', `Profiles  (target: ${targetType === 'sheets' ? 'Google Sheets' : 'Google Docs'})`);
    blank();

    const profiles   = listProfiles();
    const activeFile = getActiveProfileFile();

    // filter ให้เห็นเฉพาะ target เดียวกัน ก่อน แต่ถ้าไม่มีเลยแสดงทั้งหมด
    const sameTarget = profiles.filter(p => p.target === targetType);
    const showAll    = sameTarget.length === 0 && profiles.length > 0;
    const displayed  = drawProfileList(showAll ? profiles : sameTarget, activeFile, null);

    print(clr(c.gray, '  [+]') + clr(c.white, '  สร้าง Profile ใหม่'));
    blank();
    if (displayed.length > 0) {
      print(clr(c.gray, '  [-]') + clr(c.dim,   '  ลบ Profile'));
      print(clr(c.gray, '  [e]') + clr(c.dim,   '  แก้ไขชื่อ Profile'));
      blank();
    }
    print(clr(c.gray, '  [q]') + clr(c.dim, '  กลับ'));
    blank();

    const ans = (await ask(
      clr(c.gray, '  › ') + clr(c.white, 'เลือก') + clr(c.gray, ' : ')
    )).trim().toLowerCase();

    if (ans === 'q' || ans === '') return null;

    // ── สร้างใหม่ ──────────────────────────────────────────────
    if (ans === '+') {
      const { runFrom, runTo, dirChoice, parChoice, selectedDataset } = await configureProfile(
        { runFrom: '1', runTo: '0', dirCode: 'top_to_bottom', parCode: 'all', selectedDataset: '' },
        totalRows,
        targetType
      );
      const autoName  = autoProfileName(runFrom, runTo, totalRows, dirChoice.code, parChoice.code);
      const finalName = await askProfileName(autoName);
      const filename  = safeFilename(finalName) + '.json';
      const now       = new Date().toLocaleString('th-TH', { hour12: false });

      const profile = {
        filename, name: finalName,
        target: targetType,
        runFrom, runTo,
        dirCode: dirChoice.code,
        parCode: parChoice.code,
        selectedDataset,
        totalRows,
        updatedAt: now,
        createdAt: now,
      };

      // ถ้ามีชื่อซ้ำถามว่าจะเขียนทับไหม
      if (fs.existsSync(path.join(PROFILES_DIR, filename))) {
        const overwrite = await askConfirm(`มี profile "${finalName}" แล้ว เขียนทับ?`);
        if (!overwrite) { print(clr(c.dim, '  ยกเลิก')); continue; }
      }

      saveProfile(profile);
      showProfileCard(profile);
      print(clr(c.green, '  ✔  บันทึก profile แล้ว'));

      const activate = await askConfirm('ตั้งเป็น active profile และเลือก mode การรัน?');
      if (activate) {
        return await activateAndRun(profile);
      }
      continue;
    }

    // ── ลบ ────────────────────────────────────────────────────
    if (ans === '-') {
      if (displayed.length === 0) { print(clr(c.dim, '  ไม่มี profile ให้ลบ')); continue; }
      blank();
      print(clr(c.bold, c.red, '  🗑  ลบ Profile'));
      rule();
      displayed.forEach((p, i) => print(clr(c.gray, `  [${i+1}]`) + clr(c.white, `  ${p.name}`)));
      blank();
      const delKey = (await ask(clr(c.gray, '  › ') + clr(c.white, 'เลือก profile ที่จะลบ (เลข หรือ Enter=ยกเลิก)') + clr(c.gray, ' : '))).trim();
      const delIdx = parseInt(delKey, 10) - 1;
      if (isNaN(delIdx) || delIdx < 0 || delIdx >= displayed.length) {
        print(clr(c.dim, '  ยกเลิก'));
        continue;
      }
      const toDelete = displayed[delIdx];
      const confirm  = await askConfirm(`ยืนยันลบ "${toDelete.name}"?`);
      if (!confirm) { print(clr(c.dim, '  ยกเลิก')); continue; }
      deleteProfile(toDelete.filename);
      // ถ้าลบ active ให้ล้าง .env.run ด้วย
      if (toDelete.filename === activeFile && fs.existsSync(ACTIVE_FILE)) {
        fs.unlinkSync(ACTIVE_FILE);
        print(clr(c.yellow, '  ⚠  ลบ active profile — .env.run ถูกล้างแล้ว'));
      }
      print(clr(c.green, `  ✔  ลบ "${toDelete.name}" แล้ว`));
      continue;
    }

    // ── แก้ไขชื่อ ─────────────────────────────────────────────
    if (ans === 'e') {
      if (displayed.length === 0) { print(clr(c.dim, '  ไม่มี profile')); continue; }
      blank();
      print(clr(c.bold, c.cyan, '  ✏  แก้ไขชื่อ Profile'));
      rule();
      displayed.forEach((p, i) => print(clr(c.gray, `  [${i+1}]`) + clr(c.white, `  ${p.name}`)));
      blank();
      const editKey = (await ask(clr(c.gray, '  › ') + clr(c.white, 'เลือก profile (Enter=ยกเลิก)') + clr(c.gray, ' : '))).trim();
      const editIdx = parseInt(editKey, 10) - 1;
      if (isNaN(editIdx) || editIdx < 0 || editIdx >= displayed.length) {
        print(clr(c.dim, '  ยกเลิก'));
        continue;
      }
      const toEdit  = displayed[editIdx];
      const newName = (await ask(
        clr(c.gray, '  › ') + clr(c.white, 'ชื่อใหม่') + clr(c.dim, ` [${toEdit.name}]`) + clr(c.gray, ' : ')
      )).trim();
      if (!newName) { print(clr(c.dim, '  ยกเลิก')); continue; }

      const oldFilepath = path.join(PROFILES_DIR, toEdit.filename);
      const newFilename = safeFilename(newName) + '.json';
      const newFilepath = path.join(PROFILES_DIR, newFilename);
      toEdit.name     = newName;
      toEdit.filename = newFilename;
      toEdit.updatedAt = new Date().toLocaleString('th-TH', { hour12: false });

      // ลบไฟล์เก่า เขียนไฟล์ใหม่
      if (fs.existsSync(oldFilepath)) fs.unlinkSync(oldFilepath);
      saveProfile(toEdit);

      // อัปเดต .env.run ถ้าเป็น active
      if (getActiveProfileFile() === toEdit.filename || getActiveProfileFile() === path.basename(oldFilepath)) {
        saveActiveConfig(toEdit);
        print(clr(c.cyan, '  ✔  อัปเดต active profile แล้ว'));
      }
      print(clr(c.green, `  ✔  เปลี่ยนชื่อเป็น "${newName}" แล้ว`));
      continue;
    }

    // ── เลือก profile ─────────────────────────────────────────
    const selIdx = parseInt(ans, 10) - 1;
    if (!isNaN(selIdx) && selIdx >= 0 && selIdx < displayed.length) {
      const selected = displayed[selIdx];
      showProfileCard(selected);

      blank();
      print(clr(c.gray, '  [1]') + clr(c.white, '  ✅  ใช้ profile นี้ + เลือก mode การรัน'));
      print(clr(c.gray, '  [2]') + clr(c.cyan,  '  ✏   แก้ไข config ของ profile นี้'));
      print(clr(c.gray, '  [3]') + clr(c.dim,   '  กลับ'));
      blank();

      const subAns = (await ask(clr(c.gray, '  › ') + clr(c.white, 'เลือก') + clr(c.gray, ' [1/2/3] : '))).trim();

      if (subAns === '1') {
        return await activateAndRun(selected);
      }
      if (subAns === '2') {
        // แก้ไข config
        const { runFrom, runTo, dirChoice, parChoice, selectedDataset } = await configureProfile(
          { runFrom: selected.runFrom, runTo: selected.runTo, dirCode: selected.dirCode, parCode: selected.parCode, selectedDataset: selected.selectedDataset },
          totalRows,
          targetType
        );
        selected.runFrom    = runFrom;
        selected.runTo      = runTo;
        selected.dirCode    = dirChoice.code;
        selected.parCode    = parChoice.code;
        selected.selectedDataset = selectedDataset;
        selected.totalRows  = totalRows;
        selected.updatedAt  = new Date().toLocaleString('th-TH', { hour12: false });
        saveProfile(selected);

        // อัปเดต .env.run ถ้าเป็น active
        if (selected.filename === getActiveProfileFile()) {
          saveActiveConfig(selected);
        }
        showProfileCard(selected);
        print(clr(c.green, '  ✔  อัปเดต profile แล้ว'));
      }
      continue;
    }

    print(clr(c.dim, '  ตัวเลือกไม่ถูกต้อง'));
  }
}

async function activateAndRun(profile) {
  saveActiveConfig(profile);
  print(clr(c.green, `  ✔  ตั้ง "${profile.name}" เป็น active profile แล้ว`));
  print(clr(c.dim,   `     บันทึกลง .env.run`));

  const mode = await askRunMode(profile.target);
  blank();
  print(clr(c.bold, c.white, '  ▶  Mode ที่เลือก: ') + clr(c.cyan, c.bold, mode.label));
  print(clr(c.bold, c.white, '  ▶  รันด้วยคำสั่ง: ') + clr(c.yellow, c.bold, mode.cmd));
  blank();
  return mode;
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  const argv       = process.argv.slice(2);
  const flagReset  = argv.includes('--reset');
  const flagShow   = argv.includes('--show');
  const flagVerify = argv.includes('--verify');
  const flagList   = argv.includes('--list');

  console.clear();
  title();

  // ── --list : แสดง profiles ทั้งหมดแล้วออก ────────────────
  if (flagList) {
    const profiles   = listProfiles();
    const activeFile = getActiveProfileFile();
    if (profiles.length === 0) {
      print(clr(c.dim, '  ยังไม่มี profile ใดๆ'));
    } else {
      print(clr(c.bold, c.yellow, '  📁  Profiles ทั้งหมด'));
      rule();
      blank();
      drawProfileList(profiles, activeFile, null);
    }
    getRL().close();
    return;
  }

  // ── --show : แสดง active profile แล้วออก ────────────────
  if (flagShow) {
    const activeCfg  = loadActiveConfig();
    const activeFile = activeCfg.PROFILE_FILE;
    if (!activeFile) {
      print(clr(c.yellow, '  ⚠  ยังไม่มี active profile (.env.run)'));
    } else {
      const p = loadProfile(activeFile);
      if (p) showProfileCard(p);
      else print(clr(c.yellow, `  ⚠  ไม่พบไฟล์ profile: ${activeFile}`));
    }
    getRL().close();
    return;
  }

  // ── --reset : รีเซ็ต active profile ─────────────────────
  if (flagReset) {
    if (fs.existsSync(ACTIVE_FILE)) fs.unlinkSync(ACTIVE_FILE);
    print(clr(c.yellow, '  ↺  ล้าง active profile (.env.run) แล้ว'));
    print(clr(c.dim,    '     รัน node run_config.js เพื่อเลือก profile ใหม่'));
    blank();
    getRL().close();
    return;
  }

  // ── เมนูหลัก ──────────────────────────────────────────────
  let mainMenuChoice = '';
  while (true) {
    sectionHead('🏠', 'Main Menu');
    print(clr(c.gray, '  [1]') + clr(c.white, c.bold, '  📁 จัดการ Profiles และสั่งรันบอท (Auto QA)'));
    print(clr(c.gray, '  [2]') + clr(c.white, c.bold, '  🖼️  อัปโหลดและแทรกรูปย้อนหลัง (Sync Images)'));
    print(clr(c.gray, '  [3]') + clr(c.white, c.bold, '  🛠️  เครื่องมือจัดการข้อมูล (Validate / Write)'));
    print(clr(c.gray, '  [q]') + clr(c.dim,   '  ออกจากโปรแกรม'));
    blank();
    const rawChoice = await askStyled('เลือกเมนู', '1');
    mainMenuChoice = rawChoice.toLowerCase();
    
    if (mainMenuChoice === 'q') {
      getRL().close();
      return;
    }
    if (['1', '2', '3'].includes(mainMenuChoice)) break;
  }
  blank();

  if (mainMenuChoice === '3') {
    sectionHead('🛠️', 'เครื่องมือจัดการข้อมูล (Validate / Manual Write)');
    print(clr(c.gray, '  [1]') + clr(c.white, c.bold, '  🔎 Validate Data') + clr(c.dim, ' (ตรวจสอบความตรงกันของ JSON, Sheets, Docs)'));
    print(clr(c.dim,  '       คำสั่ง: node validate.js'));
    blank();
    print(clr(c.gray, '  [2]') + clr(c.white, c.bold, '  📦 Consolidate Data') + clr(c.dim, ' (รวมผลลัพธ์จาก 3 แหล่งสร้างเป็น master_results)'));
    print(clr(c.dim,  '       คำสั่ง: node consolidate.js'));
    blank();
    print(clr(c.gray, '  [3]') + clr(c.white, c.bold, '  📊 Write to Sheets') + clr(c.dim, ' (เขียน master_results ลง Sheets)'));
    print(clr(c.dim,  '       คำสั่ง: node write_to_sheets.js'));
    blank();
    print(clr(c.gray, '  [4]') + clr(c.white, c.bold, '  📄 Write to Docs') + clr(c.dim, ' (เขียน master_results ลง Docs)'));
    print(clr(c.dim,  '       คำสั่ง: node write_to_docs.js'));
    blank();
    async function runWriteFlow(defaultTool) {
      blank();
      const askWrite = await askStyled('ต้องการรัน (Write) ต่อเลยไหม? (1=Sheets, 2=Docs, 3=รันทั้งคู่, N=ไม่)', defaultTool || 'n');
      const w = askWrite.toLowerCase();
      if (w === '1' || w === '2' || w === '3') {
        blank();
        print(clr(c.cyan, '  เลือกไฟล์ผลลัพธ์ที่จะเขียน:'));
        print(clr(c.gray, '  [1]') + ' master_results (ทั้งหมด)');
        print(clr(c.gray, '  [2]') + ' pass_results (เฉพาะ PASS)');
        print(clr(c.gray, '  [3]') + ' fail_partial_results (เฉพาะ FAIL/PARTIAL)');
        print(clr(c.gray, '  [4]') + ' no_status_results');
        const fileChoice = await askStyled('เลือกไฟล์ (1-4)', '1');
        
        const fileMap = {
          '1': 'master_results',
          '2': 'pass_results',
          '3': 'fail_partial_results',
          '4': 'no_status_results'
        };
        const inputName = fileMap[fileChoice] || 'master_results';

        if (w === '1' || w === '3') {
          await new Promise(resolve => spawn('node', ['write_to_sheets.js', `--input=${inputName}`], { stdio: 'inherit' }).on('close', resolve));
        }
        if (w === '2' || w === '3') {
          blank();
          const mode = await askStyled('ต้องการรันโหมด --fresh (สร้างตารางใหม่ท้าย Doc) ไหม? (y/N)', 'n');
          const args = ['write_to_docs.js', `--input=${inputName}`];
          if (mode.toLowerCase() === 'y') args.push('--fresh');
          await new Promise(resolve => spawn('node', args, { stdio: 'inherit' }).on('close', resolve));
        }
      }
    }

    const toolChoice = await askStyled('เลือกเครื่องมือ (1-4) หรือ q เพื่อออก', '1');
    if (toolChoice === '1') {
      const code = await new Promise(resolve => {
        const proc = spawn('node', ['validate.js'], { stdio: 'inherit' });
        proc.on('close', resolve);
      });
      if (code === 0) {
        blank();
        const runCon = await askStyled('ต้องการรัน node consolidate.js ต่อเลยไหม? (Y/n)', 'y');
        if (runCon.toLowerCase() !== 'n') {
          await new Promise(resolve => spawn('node', ['consolidate.js'], { stdio: 'inherit' }).on('close', resolve));
          await runWriteFlow('1');
        }
      }
    } else if (toolChoice === '2') {
      await new Promise(resolve => spawn('node', ['consolidate.js'], { stdio: 'inherit' }).on('close', resolve));
      await runWriteFlow('1');
    } else if (toolChoice === '3') {
      await runWriteFlow('1');
    } else if (toolChoice === '4') {
      await runWriteFlow('2');
    }
    getRL().close();
    return;
  }

  // ── เลือก target ─────────────────────────────────────────
  const targetType = await selectTarget();
  blank();

  // ── เชื่อมต่อ ─────────────────────────────────────────────
  const { ok, info, totalRows } = await connectTarget(targetType);

  // ── --verify : แสดง verify panel แล้วออก ────────────────
  if (flagVerify) {
    showVerifyPanel(targetType, info);
    if (!ok) print(clr(c.yellow, '  ⚠  เชื่อมต่อไม่สำเร็จ'));
    getRL().close();
    return;
  }

  // ── verify panel ──────────────────────────────────────────
  showVerifyPanel(targetType, info);

  if (!ok) {
    print(clr(c.yellow, '  ⚠  เชื่อมต่อไม่สำเร็จ — จะใช้ข้อมูลเดิมถ้ามี'));
  }

  // ── Branching by Main Menu ──────────────────────────────
  if (mainMenuChoice === '2') {
    sectionHead('☁️', 'เลือกช่องทางอัปโหลดรูปภาพ');
    print(clr(c.gray, '  [1]') + clr(c.white, c.bold, '  Google Drive') + clr(c.dim, ' (อิงจาก GOOGLE_DRIVE_SCREENSHOT_FOLDER_ID)'));
    print(clr(c.gray, '  [2]') + clr(c.white, c.bold, '  ImgBB') + clr(c.dim, ' (อิงจาก IMGBB_API_KEY)'));
    blank();
    let uploadMethod = 'drive';
    const rawUpload = await askStyled('เลือก (1-2)', '1');
    if (rawUpload === '2') uploadMethod = 'imgbb';

    const tool = new ImageSyncTool();
    await tool.run(targetType, uploadMethod);
  } else {
    // ── จัดการ Profiles ─────────────────────────────────────
    await profileMenu(targetType, totalRows, info);
  }

  getRL().close();
}

main().catch(err => {
  process.stdout.write('\n');
  print(clr(c.red, c.bold, '  ✖  Error: ') + clr(c.white, err.message));
  if (rl) rl.close();
  process.exit(1);
});
