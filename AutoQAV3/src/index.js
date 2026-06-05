/**
 * src/index.js  — Two-phase architecture (v3 + Sheets support)
 * ─────────────────────────────────────────────────────────────
 * Phase 1 (BROWSER)  : ถาม chatbot + แคปรูปทุกข้อ → เก็บใน JSON
 * Phase 2 (WRITE)    : batch write ผลลัพธ์กลับ Google Docs / Sheets
 *
 * CLI flags:
 *   --dry-run          ไม่ write กลับ Docs/Sheets
 *   --resume           รันต่อจาก checkpoint (ข้าม completed)
 *   --reset            ลบ checkpoint แล้วเริ่มใหม่
 *   --start-from=ID    เริ่มจาก test ID นี้
 *   --skip-done        ข้าม row ที่มีผลแล้ว
 *   --docs-only        ข้าม Phase 1 (browser) → เฉพาะ batch write จาก checkpoint → Docs
 *   --sheets-only      ข้าม Phase 1 (browser) → เฉพาะ batch write จาก checkpoint → Sheets ★ใหม่
 *   --browser-only     รัน Phase 1 เท่านั้น ไม่ write
 *   --batch-size=50    write ทุก N ข้อ (default: ทีเดียวตอนจบ)
 *   --use-sheets       ใช้ Sheets แทน Docs สำหรับ Phase 2 (ต้องมี GOOGLE_SPREADSHEET_ID)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import config from './config/index.js';
import DocsClient        from './modules/docsClient.js';
import SheetsClient      from './modules/sheetsClient.js';
import BrowserController from './modules/browserController.js';
import ScreenshotHandler from './modules/screenshotHandler.js';
import TestRunner        from './modules/testRunner.js';
import Reporter          from './modules/reporter.js';
import ProgressTracker   from './modules/progressTracker.js';

// ── CLI flags ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN      = argv.includes('--dry-run');
const DO_RESUME    = argv.includes('--resume');
const DO_RESET     = argv.includes('--reset');
const SKIP_DONE    = argv.includes('--skip-done') || DO_RESUME;
const DOCS_ONLY    = argv.includes('--docs-only');
const SHEETS_ONLY  = argv.includes('--sheets-only');  // ★ ใหม่
const BROWSER_ONLY = argv.includes('--browser-only');
const USE_SHEETS   = argv.includes('--use-sheets') || SHEETS_ONLY; // ★ ใช้ Sheets เป็น target

const START_FROM_ARG     = argv.find(a => a.startsWith('--start-from='));
const START_FROM_TEST_ID = START_FROM_ARG ? START_FROM_ARG.split('=')[1] : null;

const BATCH_SIZE_ARG  = argv.find(a => a.startsWith('--batch-size='));
const WRITE_BATCH_SIZE = BATCH_SIZE_ARG ? parseInt(BATCH_SIZE_ARG.split('=')[1], 10) : 0;

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { reason: String(reason) });
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(' Chatbot QA Automation — Two-Phase Mode');
  if (DRY_RUN)      logger.info(' ⚠  DRY RUN — ไม่ write กลับ');
  if (DO_RESUME)    logger.info(' ▶  RESUME — รันต่อจาก checkpoint');
  if (DO_RESET)     logger.info(' 🔄 RESET — ลบ checkpoint');
  if (DOCS_ONLY)    logger.info(' 📄 DOCS ONLY — ข้าม browser phase → write Docs');
  if (SHEETS_ONLY)  logger.info(' 📊 SHEETS ONLY — ข้าม browser phase → write Sheets');
  if (BROWSER_ONLY) logger.info(' 🌐 BROWSER ONLY — ไม่ write');
  if (USE_SHEETS)   logger.info(' 📊 TARGET: Google Sheets');
  else              logger.info(' 📄 TARGET: Google Docs');
  if (WRITE_BATCH_SIZE > 0) logger.info(` 📦 BATCH SIZE — write ทุก ${WRITE_BATCH_SIZE} ข้อ`);
  if (START_FROM_TEST_ID)   logger.info(` 📍 เริ่มจาก: ${START_FROM_TEST_ID}`);
  logger.info('═══════════════════════════════════════════════');

  const startTime = Date.now();

  // ── Init clients ──────────────────────────────────────────
  // เลือก tracker ID ตาม target
  const trackerId = USE_SHEETS
    ? (config.google.spreadsheetId || config.google.documentId)
    : config.google.documentId;

  const screenshot = new ScreenshotHandler();
  const reporter   = new Reporter();
  const tracker    = new ProgressTracker(trackerId);

  // ── Progress tracker ──────────────────────────────────────
  if (DO_RESET) {
    tracker.reset();
  } else {
    tracker.load();
  }

  let testCases = [];

  // ── Load test cases ───────────────────────────────────────
  if (USE_SHEETS) {
    // ── โหมด Sheets ─────────────────────────────────────────
    if (!config.google.spreadsheetId) {
      logger.error('ต้องกำหนด GOOGLE_SPREADSHEET_ID ใน .env เพื่อใช้ --use-sheets');
      process.exit(1);
    }
    const sheets = new SheetsClient();
    await sheets.init();
    testCases = await sheets.getTestCases();

    if (testCases.length === 0) {
      logger.warn('ไม่พบ test case ใน Google Sheets');
      return;
    }
    logger.info(`โหลดได้ ${testCases.length} test case จาก Sheets`);

    // ── Filter ────────────────────────────────────────────────
    let casesToRun = filterCases(testCases, tracker, START_FROM_TEST_ID, SKIP_DONE);

    let allResults = [];

    if (!SHEETS_ONLY && !DOCS_ONLY) {
      // Phase 1: Browser
      allResults = await runBrowserPhase(casesToRun, screenshot, tracker);
    } else {
      // โหลด results จาก checkpoint
      allResults = buildResultsFromCheckpoint(tracker, testCases);
      logger.info(`โหลด ${allResults.length} result จาก checkpoint`);
    }

    // Phase 2: Sheets write
    if (!BROWSER_ONLY && !DRY_RUN) {
      await runSheetsPhase(sheets, tracker, testCases, DRY_RUN, WRITE_BATCH_SIZE);
    } else if (DRY_RUN) {
      logDryRun(allResults);
    }

    if (allResults.length > 0) await reporter.generate(allResults);
    logSummary(allResults, tracker, startTime);

  } else {
    // ── โหมด Docs (เดิม) ─────────────────────────────────────
    const docs = new DocsClient();
    await docs.init();
    testCases = await docs.getTestCases();

    if (testCases.length === 0) {
      logger.warn('ไม่พบ test case ใน Google Docs');
      return;
    }
    logger.info(`โหลดได้ ${testCases.length} test case จาก Docs`);

    let casesToRun = filterCases(testCases, tracker, START_FROM_TEST_ID, SKIP_DONE,
      tc => docs.hasResult(tc));

    let allResults = [];

    if (!DOCS_ONLY) {
      allResults = await runBrowserPhase(casesToRun, screenshot, tracker);
    } else {
      allResults = buildResultsFromCheckpoint(tracker, testCases);
      logger.info(`โหลด ${allResults.length} result จาก checkpoint`);
    }

    if (!BROWSER_ONLY && !DRY_RUN) {
      await runDocsPhase(docs, tracker, testCases, DRY_RUN, WRITE_BATCH_SIZE);
    } else if (DRY_RUN) {
      logDryRun(allResults);
    } else {
      logger.info('[BROWSER ONLY] ข้าม Docs write phase');
    }

    if (allResults.length > 0) await reporter.generate(allResults);
    logSummary(allResults, tracker, startTime);
  }
}

// ─────────────────────────────────────────────────────────────
// Filter helper
// ─────────────────────────────────────────────────────────────
function filterCases(testCases, tracker, startFromId, skipDone, hasResultFn = null) {
  let cases = testCases;

  if (startFromId) {
    const idx = cases.findIndex(tc => tc.testId === startFromId);
    if (idx === -1) {
      logger.error(`ไม่พบ test ID: ${startFromId}`);
      process.exit(1);
    }
    cases = cases.slice(idx);
    logger.info(`เริ่มจาก ${startFromId} → ${cases.length} case`);
  }

  if (skipDone) {
    const before = cases.length;
    cases = cases.filter(tc => {
      if (hasResultFn?.(tc)) {
        logger.debug(`ข้าม ${tc.testId}: มีผลใน Doc/Sheet แล้ว`);
        return false;
      }
      if (tracker.isCompleted(tc.testId)) {
        logger.debug(`ข้าม ${tc.testId}: มีใน checkpoint แล้ว`);
        return false;
      }
      return true;
    });
    logger.info(`ข้ามไป ${before - cases.length} case → เหลือ ${cases.length} case`);
  }

  return cases;
}

// ─────────────────────────────────────────────────────────────
// Phase 1: Browser
// ─────────────────────────────────────────────────────────────
async function runBrowserPhase(casesToRun, screenshot, tracker) {
  const browser = new BrowserController();
  const runner  = new TestRunner(browser, screenshot);
  const results = [];

  logger.info('');
  logger.info('━━━ PHASE 1: BROWSER ━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`จะถาม chatbot ${casesToRun.length} ข้อ`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    await browser.init();

    for (let i = 0; i < casesToRun.length; i++) {
      const tc   = casesToRun[i];
      logger.info(`\n[${i + 1}/${casesToRun.length}] ${tc.testId}`);

      const result = await runner.run(tc);
      results.push(result);
      tracker.save(tc.testId, i, result);
      copyToSelected(result.screenshotPath);

      if (i < casesToRun.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err) {
    logger.error('Browser phase error', { error: err.message, stack: err.stack });
  } finally {
    await browser.close().catch(() => {});
  }

  const counts = summaryCounts(results);
  logger.info('');
  logger.info('━━━ PHASE 1 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(` PASS: ${counts.PASS ?? 0}  PARTIAL: ${counts.PARTIAL ?? 0}  FAIL: ${counts.FAIL ?? 0}`);
  logger.info(`Checkpoint: ${tracker.filePath}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return results;
}

// ─────────────────────────────────────────────────────────────
// Phase 2a: Sheets write  ★ ใหม่
// ─────────────────────────────────────────────────────────────
async function runSheetsPhase(sheets, tracker, testCases, dryRun, batchSize) {
  // รวม pending results จาก checkpoint ที่ยังไม่ได้ write
  const pending = [];
  for (const tc of testCases) {
    const completed = tracker.getCompleted(tc.testId);
    if (completed && !completed.writtenToSheets && !completed.writtenToDocs) {
      pending.push({ tc, result: completed });
    }
  }

  if (pending.length === 0) {
    logger.info('ไม่มี pending results ที่ต้องเขียนลง Sheets');
    return;
  }

  logger.info('');
  logger.info('━━━ PHASE 2: SHEETS WRITE ━━━━━━━━━━━━━━━━━━━━');
  logger.info(`จะ write ${pending.length} ผลลัพธ์ → Google Sheets`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (dryRun) {
    for (const { tc, result } of pending) {
      logger.info(`[DRY RUN] row ${tc.rowIndex} | ${tc.testId} → ${result.status}`);
    }
    return;
  }

  let written = 0;
  let errors  = 0;
  const effective = batchSize > 0 ? batchSize : pending.length;

  // แบ่งเป็น batch
  for (let start = 0; start < pending.length; start += effective) {
    const chunk = pending.slice(start, start + effective);
    const batchNum = Math.floor(start / effective) + 1;

    try {
      // ใช้ batchWrite ถ้า chunk > 1 (เร็วกว่า loop)
      if (chunk.length > 1) {
        await sheets.batchWriteResults(
          chunk.map(({ tc, result }) => ({
            rowIndex: tc.rowIndex,
            result: {
              actual:         result.actual ?? '',
              status:         result.status,
              timestamp:      result.timestamp,
              screenshotPath: result.screenshotPath ?? '',
            },
          }))
        );
        for (const { tc } of chunk) {
          tracker.markWrittenToSheets(tc.testId);
          written++;
        }
        logger.info(`[batch ${batchNum}] ✓ เขียน ${chunk.length} rows สำเร็จ`);
      } else {
        // chunk เดี่ยว
        const { tc, result } = chunk[0];
        await sheets.writeResult(tc.rowIndex, {
          actual:         result.actual ?? '',
          status:         result.status,
          timestamp:      result.timestamp,
          screenshotPath: result.screenshotPath ?? '',
        });
        tracker.markWrittenToSheets(tc.testId);
        written++;
        logger.info(`[${written}/${pending.length}] ✓ ${tc.testId} → ${result.status}`);
      }
    } catch (err) {
      errors += chunk.length;
      logger.error(`[batch ${batchNum}] ✗ ${err.message}`);
    }

    // pause ระหว่าง batch ป้องกัน rate limit
    if (start + effective < pending.length) {
      logger.info('... พัก 1s ...');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info('');
  logger.info('━━━ PHASE 2 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(` เขียนสำเร็จ: ${written}  ผิดพลาด: ${errors}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─────────────────────────────────────────────────────────────
// Phase 2b: Docs write (เดิม)
// ─────────────────────────────────────────────────────────────
async function runDocsPhase(docs, tracker, testCases, dryRun, batchSize) {
  const pending = [];
  for (const tc of testCases) {
    const completed = tracker.getCompleted(tc.testId);
    if (completed && !completed.writtenToDocs) {
      pending.push({ tc, result: completed });
    }
  }

  if (pending.length === 0) {
    logger.info('ไม่มี pending results ที่ต้องเขียนลง Docs');
    return;
  }

  logger.info('');
  logger.info('━━━ PHASE 2: DOCS WRITE ━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`จะ write ${pending.length} ผลลัพธ์ → Google Docs`);
  if (batchSize > 0) logger.info(`(ทีละ ${batchSize} ข้อ)`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let written = 0;
  let errors  = 0;

  for (let i = 0; i < pending.length; i++) {
    const { tc, result } = pending[i];

    if (!dryRun) {
      try {
        await docs.writeResult(tc, {
          actual:         result.actual,
          status:         result.status,
          timestamp:      result.timestamp,
          screenshotPath: result.screenshotPath ?? '',
        });
        tracker.markWrittenToDocs(tc.testId);
        written++;
        logger.info(`[${i + 1}/${pending.length}] ✓ ${tc.testId} → ${result.status}`);
      } catch (err) {
        errors++;
        logger.error(`[${i + 1}/${pending.length}] ✗ ${tc.testId}: ${err.message}`);
      }

      if (batchSize > 0 && (i + 1) % batchSize === 0 && i < pending.length - 1) {
        logger.info(`... พัก 2s หลัง batch ${Math.floor((i + 1) / batchSize)} ...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } else {
      logger.info(`[DRY RUN] ${tc.testId} → ${result.status}`);
      written++;
    }
  }

  logger.info('');
  logger.info(`━━━ PHASE 2 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(` เขียนสำเร็จ: ${written}  ผิดพลาด: ${errors}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function buildResultsFromCheckpoint(tracker, testCases) {
  const results = [];
  for (const tc of testCases) {
    const completed = tracker.getCompleted(tc.testId);
    if (completed) {
      results.push({
        testId:          tc.testId,
        rowIndex:        tc.rowIndex,
        question:        tc.question,
        expected:        tc.expected,
        actual:          completed.actual ?? '',
        status:          completed.status,
        similarity:      completed.similarity ?? 0,
        reason:          completed.reason ?? '',
        timestamp:       completed.timestamp,
        screenshotPath:  completed.screenshotPath ?? '',
        attempts:        completed.attempts ?? 1,
        selectedAttempt: completed.selectedAttempt ?? 1,
      });
    }
  }
  return results;
}

function copyToSelected(screenshotPath) {
  if (!screenshotPath) return;
  const selectedDir = path.join(config.paths.screenshots, 'selected');
  fs.mkdirSync(selectedDir, { recursive: true });
  const dest = path.join(selectedDir, path.basename(screenshotPath));
  try { fs.copyFileSync(screenshotPath, dest); } catch { /* ignore */ }
}

function summaryCounts(results) {
  return results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
}

function logDryRun(allResults) {
  logger.info('[DRY RUN] ข้าม write phase');
  for (const r of allResults) {
    logger.info(`  [DRY RUN] ${r.testId} → ${r.status} (${((r.similarity ?? 0) * 100).toFixed(1)}%)`);
  }
}

function logSummary(allResults, tracker, startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const counts  = summaryCounts(allResults);

  logger.info('═══════════════════════════════════════════════');
  logger.info(` เสร็จใน ${elapsed}s`);
  logger.info(` PASS: ${counts.PASS ?? 0}  PARTIAL: ${counts.PARTIAL ?? 0}  FAIL: ${counts.FAIL ?? 0}`);
  logger.info(` Checkpoint: ${tracker.filePath}`);
  logger.info('═══════════════════════════════════════════════');
}

main();