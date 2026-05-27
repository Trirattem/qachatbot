/**
 * src/index.js  — Two-phase architecture
 * ─────────────────────────────────────────────────────────────
 * Phase 1 (BROWSER)  : ถาม chatbot + แคปรูปทุกข้อ → เก็บใน JSON
 * Phase 2 (DOCS)     : batch write ผลลัพธ์กลับ Google Docs ทีเดียว
 *
 * CLI flags:
 *   --dry-run          ไม่ write กลับ Docs
 *   --resume           รันต่อจาก checkpoint (ข้าม completed)
 *   --reset            ลบ checkpoint แล้วเริ่มใหม่
 *   --start-from=ID    เริ่มจาก test ID นี้
 *   --skip-done        ข้าม row ที่มีผลแล้วใน Doc
 *   --docs-only        ข้าม Phase 1 (browser) → เฉพาะ batch write จาก checkpoint
 *   --browser-only     รัน Phase 1 เท่านั้น ไม่ write Docs
 *   --batch-size=50    write Docs ทุก N ข้อ (default: ทีเดียวตอนจบ)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import config from './config/index.js';
import DocsClient        from './modules/docsClient.js';
import BrowserController from './modules/browserController.js';
import ScreenshotHandler from './modules/screenshotHandler.js';
import TestRunner        from './modules/testRunner.js';
import Reporter          from './modules/reporter.js';
import ProgressTracker   from './modules/progressTracker.js';

// ── CLI flags ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN     = argv.includes('--dry-run');
const DO_RESUME   = argv.includes('--resume');
const DO_RESET    = argv.includes('--reset');
const SKIP_DONE   = argv.includes('--skip-done') || DO_RESUME;
const DOCS_ONLY   = argv.includes('--docs-only');
const BROWSER_ONLY = argv.includes('--browser-only');

const START_FROM_ARG      = argv.find(a => a.startsWith('--start-from='));
const START_FROM_TEST_ID  = START_FROM_ARG ? START_FROM_ARG.split('=')[1] : null;

const BATCH_SIZE_ARG = argv.find(a => a.startsWith('--batch-size='));
// 0 = write ทีเดียวตอนจบ
const DOCS_BATCH_SIZE = BATCH_SIZE_ARG ? parseInt(BATCH_SIZE_ARG.split('=')[1], 10) : 0;

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { reason: String(reason) });
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(' Chatbot QA Automation — Two-Phase Mode');
  if (DRY_RUN)      logger.info(' ⚠  DRY RUN — ไม่ write กลับ Google Docs');
  if (DO_RESUME)    logger.info(' ▶  RESUME — รันต่อจาก checkpoint');
  if (DO_RESET)     logger.info(' 🔄 RESET — ลบ checkpoint');
  if (DOCS_ONLY)    logger.info(' 📄 DOCS ONLY — ข้าม browser phase');
  if (BROWSER_ONLY) logger.info(' 🌐 BROWSER ONLY — ไม่ write Docs');
  if (DOCS_BATCH_SIZE > 0) logger.info(` 📦 BATCH SIZE — write ทุก ${DOCS_BATCH_SIZE} ข้อ`);
  if (START_FROM_TEST_ID) logger.info(` 📍 เริ่มจาก: ${START_FROM_TEST_ID}`);
  logger.info('═══════════════════════════════════════════════');

  const startTime = Date.now();

  const docs       = new DocsClient();
  const screenshot = new ScreenshotHandler();
  const reporter   = new Reporter();
  const tracker    = new ProgressTracker(config.google.documentId);

  // ── Init Google Docs ──────────────────────────────────────
  await docs.init();

  // ── Progress tracker ──────────────────────────────────────
  if (DO_RESET) {
    tracker.reset();
  } else {
    const hadCheckpoint = tracker.load();
    if (hadCheckpoint && !DO_RESUME && !DOCS_ONLY) {
      logger.info('พบ checkpoint เดิม — ใช้ --resume เพื่อรันต่อ หรือ --reset เพื่อเริ่มใหม่');
    }
  }

  // ── Load test cases ───────────────────────────────────────
  const testCases = await docs.getTestCases();
  if (testCases.length === 0) {
    logger.warn('ไม่พบ test case ใน Google Docs');
    return;
  }
  logger.info(`โหลดได้ ${testCases.length} test case`);

  // ── Filter cases to run ───────────────────────────────────
  let casesToRun = testCases;

  if (START_FROM_TEST_ID) {
    const idx = testCases.findIndex(tc => tc.testId === START_FROM_TEST_ID);
    if (idx === -1) {
      logger.error(`ไม่พบ test ID: ${START_FROM_TEST_ID}`);
      return;
    }
    casesToRun = testCases.slice(idx);
    logger.info(`เริ่มจาก ${START_FROM_TEST_ID} → ${casesToRun.length} case`);
  }

  if (SKIP_DONE) {
    const before = casesToRun.length;
    casesToRun = casesToRun.filter(tc => {
      if (docs.hasResult(tc)) {
        logger.debug(`ข้าม ${tc.testId}: มีผลใน Doc แล้ว`);
        return false;
      }
      if (tracker.isCompleted(tc.testId)) {
        logger.debug(`ข้าม ${tc.testId}: มีใน checkpoint แล้ว`);
        return false;
      }
      return true;
    });
    logger.info(`ข้ามไป ${before - casesToRun.length} case → เหลือ ${casesToRun.length} case`);
  }

  if (casesToRun.length === 0) {
    logger.info('ไม่มี test case ที่ต้องรัน');
    // ถ้า DOCS_ONLY และมี pending ใน checkpoint ให้ write
    if (DOCS_ONLY || !BROWSER_ONLY) {
      await runDocsPhase(docs, tracker, testCases, DRY_RUN, DOCS_BATCH_SIZE);
    }
    return;
  }

  logger.info(`จะรัน ${casesToRun.length} test case`);

  // ══════════════════════════════════════════════════════════
  // PHASE 1: BROWSER — ถาม chatbot + แคปรูป
  // ══════════════════════════════════════════════════════════
  let allResults = [];

  if (!DOCS_ONLY) {
    allResults = await runBrowserPhase(casesToRun, screenshot, tracker);
  } else {
    // โหลด results จาก checkpoint
    allResults = buildResultsFromCheckpoint(tracker, testCases);
    logger.info(`โหลด ${allResults.length} result จาก checkpoint`);
  }

  // ══════════════════════════════════════════════════════════
  // PHASE 2: DOCS — batch write
  // ══════════════════════════════════════════════════════════
  if (!BROWSER_ONLY && !DRY_RUN) {
    await runDocsPhase(docs, tracker, testCases, DRY_RUN, DOCS_BATCH_SIZE);
  } else if (DRY_RUN) {
    logger.info('[DRY RUN] ข้าม Docs write phase');
    for (const r of allResults) {
      logger.info(`  [DRY RUN] ${r.testId} → ${r.status} (${(r.similarity*100).toFixed(1)}%)`);
    }
  } else {
    logger.info('[BROWSER ONLY] ข้าม Docs write phase');
  }

  // ── Report ────────────────────────────────────────────────
  if (allResults.length > 0) {
    await reporter.generate(allResults);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const counts  = allResults.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  logger.info('═══════════════════════════════════════════════');
  logger.info(` เสร็จใน ${elapsed}s`);
  logger.info(` PASS: ${counts.PASS ?? 0}  PARTIAL: ${counts.PARTIAL ?? 0}  FAIL: ${counts.FAIL ?? 0}`);
  logger.info(` Checkpoint: ${tracker.filePath}`);
  logger.info('═══════════════════════════════════════════════');
}

// ─────────────────────────────────────────────────────────────
// Phase 1: Browser — ถาม chatbot ทุกข้อ, แคปรูป, เก็บ JSON
// ─────────────────────────────────────────────────────────────
async function runBrowserPhase(casesToRun, screenshot, tracker) {
  const browser  = new BrowserController();
  const runner   = new TestRunner(browser, screenshot);
  const results  = [];

  logger.info('');
  logger.info('━━━ PHASE 1: BROWSER ━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`จะถาม chatbot ${casesToRun.length} ข้อ (ยังไม่ write Docs)`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  try {
    await browser.init();

    for (let i = 0; i < casesToRun.length; i++) {
      const tc   = casesToRun[i];
      const runNo = i + 1;
      logger.info(`\n[${runNo}/${casesToRun.length}] ${tc.testId}`);

      const result = await runner.run(tc);
      results.push(result);

      // บันทึก checkpoint ทันทีหลังแต่ละข้อ (สำหรับ resume)
      tracker.save(tc.testId, i, result);

      // copy screenshot ไป selected/
      copyToSelected(result.screenshotPath);

      // pause เล็กน้อยระหว่าง test case
      if (i < casesToRun.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

  } catch (err) {
    logger.error('Browser phase error', { error: err.message, stack: err.stack });
  } finally {
    await browser.close().catch(() => {});
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  logger.info('');
  logger.info('━━━ PHASE 1 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(` PASS: ${counts.PASS??0}  PARTIAL: ${counts.PARTIAL??0}  FAIL: ${counts.FAIL??0}`);
  logger.info(` Checkpoint: ${tracker.filePath}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return results;
}

// ─────────────────────────────────────────────────────────────
// Phase 2: Docs — batch write จาก checkpoint
// ─────────────────────────────────────────────────────────────
async function runDocsPhase(docs, tracker, testCases, dryRun, batchSize) {
  // รวม pending results จาก checkpoint ที่ยังไม่ได้ write
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
        logger.info(`[${i+1}/${pending.length}] ✓ ${tc.testId} → ${result.status}`);
      } catch (err) {
        errors++;
        logger.error(`[${i+1}/${pending.length}] ✗ ${tc.testId}: ${err.message}`);
      }

      // ทุก batchSize ข้อ ให้หยุดพักเล็กน้อย (ป้องกัน API rate limit)
      if (batchSize > 0 && (i + 1) % batchSize === 0 && i < pending.length - 1) {
        logger.info(`... พัก 2s หลัง batch ${Math.floor((i+1)/batchSize)} ...`);
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
        testId:        tc.testId,
        rowIndex:      tc.rowIndex,
        question:      tc.question,
        expected:      tc.expected,
        actual:        completed.actual ?? '',
        status:        completed.status,
        similarity:    completed.similarity ?? 0,
        reason:        completed.reason ?? '',
        timestamp:     completed.timestamp,
        screenshotPath: completed.screenshotPath ?? '',
        attempts:      completed.attempts ?? 1,
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
  try {
    fs.copyFileSync(screenshotPath, dest);
  } catch { /* ignore */ }
}

main();
