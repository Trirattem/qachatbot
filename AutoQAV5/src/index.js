/**
 * src/index.js  — Dataset Snapshot Architecture
 * ─────────────────────────────────────────────────────────────
 * Phase 1 (EXTRACTION): อ่าน Docs/Sheets ล่าสุด → save as dataset.json
 * Phase 2 (BROWSER)   : โหลด dataset.json → ถาม chatbot → save checkpoint
 * Phase 3 (WRITE)     : โหลด checkpoint → batch write กลับ Google Docs/Sheets
 *
 * CLI flags:
 *   --extract-only     ดึงข้อมูลจาก Docs/Sheets มาทำ Snapshot แล้วจบการทำงาน
 *   --skip-extract     ข้าม Phase 1 ไปรัน Phase 2 จาก Dataset เดิมที่มีอยู่
 *   --dry-run          ไม่ write กลับ Docs/Sheets
 *   --resume           รันต่อจาก checkpoint (ข้าม completed, implied --skip-extract)
 *   --reset            ลบ checkpoint แล้วเริ่มใหม่
 *   --start-from=ID    เริ่มจาก test ID นี้
 *   --skip-done        ข้าม row ที่มีผลแล้ว
 *   --docs-only        ข้าม Phase 2 (browser) → เฉพาะ batch write จาก checkpoint → Docs
 *   --sheets-only      ข้าม Phase 2 (browser) → เฉพาะ batch write จาก checkpoint → Sheets
 *   --browser-only     รัน Phase 2 เท่านั้น ไม่ write กลับ (จบแค่ checkpoint)
 *   --batch-size=50    write ทุก N ข้อ (default: ทีเดียวตอนจบ)
 *   --use-sheets       ใช้ Sheets แทน Docs สำหรับ Phase 3
 *   --merge-checkpoints รวม checkpoint จากหลาย terminal
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
import DatasetManager    from './modules/datasetManager.js';
import Notifier          from './modules/notifier.js';

// ── CLI flags ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const EXTRACT_ONLY = argv.includes('--extract-only');
const SKIP_EXTRACT = argv.includes('--skip-extract');
const DRY_RUN      = argv.includes('--dry-run');
const DO_RESUME    = argv.includes('--resume');
const DO_RESET     = argv.includes('--reset');
const SKIP_DONE    = argv.includes('--skip-done') || DO_RESUME;
const DOCS_ONLY    = argv.includes('--docs-only');
const SHEETS_ONLY  = argv.includes('--sheets-only');
const BROWSER_ONLY = argv.includes('--browser-only');
const USE_SHEETS   = argv.includes('--use-sheets') || SHEETS_ONLY;
const MERGE_CHECKPOINTS = argv.includes('--merge-checkpoints');

const START_FROM_ARG     = argv.find(a => a.startsWith('--start-from='));
const START_FROM_TEST_ID = START_FROM_ARG ? START_FROM_ARG.split('=')[1] : null;

const BATCH_SIZE_ARG  = argv.find(a => a.startsWith('--batch-size='));
const WRITE_BATCH_SIZE = BATCH_SIZE_ARG ? parseInt(BATCH_SIZE_ARG.split('=')[1], 10) : 0;

// Graceful shutdown handler
let isShuttingDown = false;
process.on('SIGINT', () => {
  logger.warn('\n[System] ได้รับสัญญาณหยุดการทำงาน (SIGINT), กำลังหยุดอย่างปลอดภัย...');
  isShuttingDown = true;
});
process.on('SIGTERM', () => {
  logger.warn('\n[System] ได้รับสัญญาณหยุดการทำงาน (SIGTERM), กำลังหยุดอย่างปลอดภัย...');
  isShuttingDown = true;
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { reason: String(reason) });
  if (!isShuttingDown) process.exit(1);
});

// ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(' Chatbot QA Automation — Dataset Snapshot Mode');
  if (config.runConfig.instanceId > 1) logger.info(` 🆔 INSTANCE ID: ${config.runConfig.instanceId}`);
  if (EXTRACT_ONLY) logger.info(' 📥 EXTRACT ONLY — สร้าง dataset แล้วจบงาน');
  if (SKIP_EXTRACT) logger.info(' ⏭  SKIP EXTRACT — ใช้ dataset เดิมที่มีอยู่');
  if (DRY_RUN)      logger.info(' ⚠  DRY RUN — ไม่ write กลับ');
  if (DO_RESUME)    logger.info(' ▶  RESUME — รันต่อจาก checkpoint');
  if (DO_RESET)     logger.info(' 🔄 RESET — ลบ checkpoint');
  if (DOCS_ONLY)    logger.info(' 📄 DOCS ONLY — ข้าม browser phase → write Docs');
  if (SHEETS_ONLY)  logger.info(' 📊 SHEETS ONLY — ข้าม browser phase → write Sheets');
  if (BROWSER_ONLY) logger.info(' 🌐 BROWSER ONLY — ไม่ write กลับ Docs/Sheets');
  if (USE_SHEETS)   logger.info(' 📊 TARGET: Google Sheets');
  else              logger.info(' 📄 TARGET: Google Docs');
  if (WRITE_BATCH_SIZE > 0) logger.info(` 📦 BATCH SIZE — write ทุก ${WRITE_BATCH_SIZE} ข้อ`);
  if (START_FROM_TEST_ID)   logger.info(` 📍 เริ่มจาก: ${START_FROM_TEST_ID}`);
  logger.info('═══════════════════════════════════════════════');

  const startTime = Date.now();

  const datasetManager = new DatasetManager();

  // Phase 1: EXTRACTION
  if (EXTRACT_ONLY || (!SKIP_EXTRACT && !DO_RESUME && !DOCS_ONLY && !SHEETS_ONLY)) {
    logger.info('');
    logger.info('━━━ PHASE 1: DATASET EXTRACTION ━━━━━━━━━━━━━━');
    const client = USE_SHEETS ? new SheetsClient() : new DocsClient();
    await client.init();
    await datasetManager.exportTestCases(client, USE_SHEETS ? 'sheets' : 'docs');
    
    if (EXTRACT_ONLY) {
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('✅ การดึงข้อมูล Snapshot เสร็จสมบูรณ์แล้ว!');
      logger.info('');
      logger.info('💡 คำแนะนำ: ขั้นตอนต่อไปคือการเลือก Dataset เพื่อนำไปรัน');
      logger.info('ให้รันคำสั่ง:  node run_config.js  และเลือกเมนูตั้งค่า');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      process.exit(0);
    }
  }

  // Load dataset
  let dataset;
  try {
    const targetDataset = process.env.SELECTED_DATASET;
    if (!targetDataset) {
      throw new Error('ยังไม่ได้เลือก Dataset Snapshot กรุณารัน `node run_config.js` เพื่อเลือกก่อน');
    }
    dataset = datasetManager.loadDataset(targetDataset);
    logger.info(`โหลด Dataset Snapshot สำเร็จ (Target: ${dataset.target}, File: ${targetDataset})`);
  } catch (err) {
    logger.error(`โหลด Dataset ไม่ได้: ${err.message}`);
    process.exit(1);
  }

  let testCases = datasetManager.filterDataset(dataset, config.runConfig);

  // ── Init clients ──────────────────────────────────────────
  const trackerId = USE_SHEETS
    ? (config.google.spreadsheetId || config.google.documentId)
    : config.google.documentId;

  const screenshot = new ScreenshotHandler();
  const reporter   = new Reporter();
  const tracker    = new ProgressTracker(trackerId, config.runConfig.instanceId);

  // ── Progress tracker ──────────────────────────────────────
  if (DO_RESET) {
    tracker.reset();
  } else {
    tracker.load();
  }

  if (MERGE_CHECKPOINTS) {
    logger.info('ฟีเจอร์นี้ยังไม่พร้อมใช้งาน (Merge Checkpoints)');
    process.exit(0);
  }

  if (testCases.length === 0) {
    logger.warn('ไม่มี test case ให้รัน หลังจากกรองตามเงื่อนไข');
    return;
  }

  // Filter casesToRun
  let casesToRun = filterCases(testCases, tracker, START_FROM_TEST_ID, SKIP_DONE);
  let allResults = [];

  // Phase 2: BROWSER
  if (!SHEETS_ONLY && !DOCS_ONLY) {
    allResults = await runBrowserPhase(casesToRun, screenshot, tracker);
  } else {
    allResults = buildResultsFromCheckpoint(tracker, testCases);
    logger.info(`โหลด ${allResults.length} result จาก checkpoint`);
  }

  // Stop here if graceful shutdown was triggered during Browser phase
  if (isShuttingDown) {
    logger.info('หยุดการทำงานชั่วคราวแล้ว คุณสามารถรัน --resume เพื่อทำต่อ');
    process.exit(0);
  }

  // Phase 3: WRITE
  if (!BROWSER_ONLY && !DRY_RUN) {
    if (USE_SHEETS) {
      const sheets = new SheetsClient();
      await sheets.init();
      await runSheetsPhase(sheets, tracker, testCases, DRY_RUN, WRITE_BATCH_SIZE);
    } else {
      const docs = new DocsClient();
      await docs.init();
      await runDocsPhase(docs, tracker, testCases, DRY_RUN, WRITE_BATCH_SIZE);
    }
  } else if (DRY_RUN) {
    logDryRun(allResults);
  }

  // Report & Summary
  if (allResults.length > 0) {
    const reportPath = await reporter.generate(allResults);
    
    // --- Notifications ---
    const notifier = new Notifier();
    await notifier.notifyCompletion(allResults);
  }
  
  logSummary(allResults, tracker, startTime);
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
    logger.info(`ข้ามไป ${before - cases.length} case (ทำไปแล้ว) → เหลือ ${cases.length} case`);
  }

  return cases;
}

// ─────────────────────────────────────────────────────────────
// Phase 2: Browser
// ─────────────────────────────────────────────────────────────
async function runBrowserPhase(casesToRun, screenshot, tracker) {
  const browser = new BrowserController();
  const runner  = new TestRunner(browser, screenshot);
  const results = [];

  logger.info('');
  logger.info('━━━ PHASE 2: BROWSER ━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`จะถาม chatbot ${casesToRun.length} ข้อ`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    await browser.init();

    for (let i = 0; i < casesToRun.length; i++) {
      if (isShuttingDown) {
        logger.info('Graceful shutdown: กำลังหยุดการรันคำถามถัดไป');
        break;
      }

      const tc   = casesToRun[i];
      logger.info(`\n[${i + 1}/${casesToRun.length}] ${tc.testId}`);

      const result = await runner.run(tc);
      results.push(result);
      await tracker.save(tc.testId, i, result);
      copyToSelected(result.screenshotPath);

      if (i < casesToRun.length - 1 && !isShuttingDown) {
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
  logger.info('━━━ PHASE 2 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(` PASS: ${counts.PASS ?? 0}  PARTIAL: ${counts.PARTIAL ?? 0}  FAIL: ${counts.FAIL ?? 0}`);
  logger.info(`Checkpoint: ${tracker.filePath}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return results;
}

// ─────────────────────────────────────────────────────────────
// Phase 3a: Sheets write
// ─────────────────────────────────────────────────────────────
async function runSheetsPhase(sheets, tracker, testCases, dryRun, batchSize) {
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
  logger.info('━━━ PHASE 3: SHEETS WRITE ━━━━━━━━━━━━━━━━━━━━');
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

  for (let start = 0; start < pending.length; start += effective) {
    if (isShuttingDown) break;

    const chunk = pending.slice(start, start + effective);
    const batchNum = Math.floor(start / effective) + 1;

    try {
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
          await tracker.markWrittenToSheets(tc.testId);
          written++;
        }
        logger.info(`[batch ${batchNum}] ✓ เขียน ${chunk.length} rows สำเร็จ`);
      } else {
        const { tc, result } = chunk[0];
        await sheets.writeResult(tc.rowIndex, {
          actual:         result.actual ?? '',
          status:         result.status,
          timestamp:      result.timestamp,
          screenshotPath: result.screenshotPath ?? '',
        });
        await tracker.markWrittenToSheets(tc.testId);
        written++;
        logger.info(`[${written}/${pending.length}] ✓ ${tc.testId} → ${result.status}`);
      }
    } catch (err) {
      errors += chunk.length;
      logger.error(`[batch ${batchNum}] ✗ ${err.message}`);
    }

    if (start + effective < pending.length && !isShuttingDown) {
      logger.info('... พัก 1s ...');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info('');
  logger.info('━━━ PHASE 3 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(` เขียนสำเร็จ: ${written}  ผิดพลาด: ${errors}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─────────────────────────────────────────────────────────────
// Phase 3b: Docs write
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
  logger.info('━━━ PHASE 3: DOCS WRITE ━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`จะ write ${pending.length} ผลลัพธ์ → Google Docs`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (dryRun) {
    for (const { tc, result } of pending) {
      logger.info(`[DRY RUN] ${tc.testId} → ${result.status}`);
    }
    return;
  }

  let written = 0;
  let errors  = 0;
  const effective = batchSize > 0 ? batchSize : pending.length;

  for (let start = 0; start < pending.length; start += effective) {
    if (isShuttingDown) break;

    const chunk = pending.slice(start, start + effective);
    const batchNum = Math.floor(start / effective) + 1;

    try {
      if (chunk.length > 1) {
        await docs.batchWriteResults(
          chunk.map(({ tc, result }) => ({ tc, result }))
        );
        for (const { tc } of chunk) {
          await tracker.markWrittenToDocs(tc.testId);
          written++;
        }
        logger.info(`[batch ${batchNum}] ✓ เขียน ${chunk.length} rows สำเร็จ`);
      } else {
        const { tc, result } = chunk[0];
        await docs.writeResult(tc, {
          actual:         result.actual,
          status:         result.status,
          timestamp:      result.timestamp,
          screenshotPath: result.screenshotPath ?? '',
        });
        await tracker.markWrittenToDocs(tc.testId);
        written++;
        logger.info(`[${written}/${pending.length}] ✓ ${tc.testId} → ${result.status}`);
      }
    } catch (err) {
      errors += chunk.length;
      logger.error(`[batch ${batchNum}] ✗ ${err.message}`);
    }

    if (start + effective < pending.length && !isShuttingDown) {
      logger.info('... พัก 1s ...');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logger.info('');
  logger.info(`━━━ PHASE 3 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
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