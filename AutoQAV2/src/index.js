/**
 * src/index.js  (updated)
 * ─────────────────────────────────────────────────────────────
 * เพิ่ม 3 ฟีเจอร์:
 *
 * 1. Resume อัตโนมัติจาก checkpoint JSON
 *    - โหลด logs/progress_<docId>.json
 *    - ข้าม test case ที่มี Status/Actual ใน Doc แล้ว
 *    - ข้าม test case ที่อยู่ใน checkpoint แล้ว
 *
 * 2. CLI flags:
 *    --resume                   รันต่อจาก checkpoint ล่าสุด
 *    --reset                    ลบ checkpoint แล้วเริ่มใหม่
 *    --start-from=TRD_AI_007    เริ่มจาก test ID นี้ (ไม่สนใจ checkpoint)
 *    --skip-done                ข้าม row ที่มีผลแล้วใน Doc (ไม่ต้องมี checkpoint)
 *    --dry-run                  ไม่ write กลับ Doc
 *
 * 3. บันทึก checkpoint ทุกครั้งที่ test case เสร็จ
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
const DRY_RUN    = argv.includes('--dry-run');
const DO_RESUME  = argv.includes('--resume');
const DO_RESET   = argv.includes('--reset');
const SKIP_DONE  = argv.includes('--skip-done') || DO_RESUME;

const START_FROM_ARG     = argv.find(a => a.startsWith('--start-from='));
const START_FROM_TEST_ID = START_FROM_ARG ? START_FROM_ARG.split('=')[1] : null;

// ── Graceful shutdown ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { reason: String(reason) });
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(' Chatbot QA Automation — Starting Run');
  if (DRY_RUN)           logger.info(' ⚠  DRY RUN — ไม่ write กลับ Google Docs');
  if (DO_RESUME)         logger.info(' ▶  RESUME MODE — รันต่อจาก checkpoint');
  if (DO_RESET)          logger.info(' 🔄 RESET — ลบ checkpoint แล้วเริ่มใหม่');
  if (START_FROM_TEST_ID) logger.info(` 📍 เริ่มจาก: ${START_FROM_TEST_ID}`);
  if (SKIP_DONE)         logger.info(' ⏭  ข้าม row ที่มีผลแล้วใน Doc');
  logger.info('═══════════════════════════════════════════════');

  const startTime = Date.now();

  const docs       = new DocsClient();
  const browser    = new BrowserController();
  const screenshot = new ScreenshotHandler();
  const runner     = new TestRunner(browser, screenshot);
  const reporter   = new Reporter();
  const tracker    = new ProgressTracker(config.google.documentId);

  const allResults = [];

  try {
    // ── Step 1: Google Docs ───────────────────────────────────
    await docs.init();

    // ── Step 2: Progress tracker ──────────────────────────────
    if (DO_RESET) {
      tracker.reset();
    } else {
      const hadCheckpoint = tracker.load();
      if (hadCheckpoint && !DO_RESUME) {
        logger.info('พบ checkpoint เดิม ถ้าต้องการรันต่อให้ใช้ --resume');
        logger.info('หรือ --reset เพื่อเริ่มใหม่ทั้งหมด');
      }
    }

    // ── Step 3: โหลด test cases ───────────────────────────────
    const testCases = await docs.getTestCases();

    if (testCases.length === 0) {
      logger.warn('ไม่พบ test case ใน Google Docs');
      return;
    }

    logger.info(`โหลดได้ ${testCases.length} test case`);

    // ── Step 4: กรอง test cases ที่จะรัน ─────────────────────
    let casesToRun = testCases;

    // 4a. start-from: เริ่มจาก test ID ที่ระบุ
    if (START_FROM_TEST_ID) {
      const idx = testCases.findIndex(tc => tc.testId === START_FROM_TEST_ID);
      if (idx === -1) {
        logger.error(`ไม่พบ test ID: ${START_FROM_TEST_ID}`);
        logger.info(`Test IDs ที่มี: ${testCases.map(t => t.testId).join(', ')}`);
        return;
      }
      casesToRun = testCases.slice(idx);
      logger.info(`เริ่มจาก ${START_FROM_TEST_ID} → ${casesToRun.length} case`);
    }

    // 4b. skip-done: ข้าม row ที่มีผลแล้วใน Doc
    if (SKIP_DONE) {
      const before = casesToRun.length;
      casesToRun = casesToRun.filter(tc => {
        // ข้ามถ้ามีอยู่ใน Doc แล้ว
        if (docs.hasResult(tc)) {
          logger.debug(`ข้าม ${tc.testId}: มีผลใน Doc แล้ว (${tc.existingStatus})`);
          return false;
        }
        // ข้ามถ้ามีใน checkpoint แล้ว
        if (tracker.isCompleted(tc.testId)) {
          logger.debug(`ข้าม ${tc.testId}: มีใน checkpoint แล้ว`);
          return false;
        }
        return true;
      });
      logger.info(`ข้ามไป ${before - casesToRun.length} case (มีผลแล้ว) → เหลือ ${casesToRun.length} case`);
    }

    if (casesToRun.length === 0) {
      logger.info('ไม่มี test case ที่ต้องรัน ทุก case มีผลแล้ว');
      return;
    }

    logger.info(`จะรัน ${casesToRun.length} test case`);

    // ── Step 5: Launch browser ────────────────────────────────
    await browser.init();

    // ── Step 6: รัน test cases ────────────────────────────────
    // วน reverse (จาก index.js เดิม) เพื่อให้ Docs index ถูกต้อง
    for (let i = casesToRun.length - 1; i >= 0; i--) {
      const tc = casesToRun[i];
      const runNo = casesToRun.length - i;
      logger.info(`\n[${runNo}/${casesToRun.length}] Test: ${tc.testId}`);

      const result = await runner.run(tc);
      allResults.push(result);

      // บันทึก checkpoint
      tracker.save(tc.testId, i, result);

      // copy screenshot ไป selected/
      if (result.screenshotPath) {
        const selectedDir = path.join(config.paths.screenshots, 'selected');
        fs.mkdirSync(selectedDir, { recursive: true });
        const dest = path.join(selectedDir, path.basename(result.screenshotPath));
        try {
          fs.copyFileSync(result.screenshotPath, dest);
        } catch (copyErr) {
          logger.warn(`copy screenshot ไม่ได้: ${copyErr.message}`);
        }
      }

      // Write กลับ Docs
      if (!DRY_RUN) {
        try {
          await docs.writeResult(tc, {
            actual:         result.actual,
            status:         result.status,
            timestamp:      result.timestamp,
            screenshotPath: result.screenshotPath,
          });
        } catch (docsErr) {
          logger.error(`write ผล ${tc.testId} ไม่ได้`, { error: docsErr.message });
        }
      } else {
        logger.info(`[DRY RUN] ${result.status} — ${result.reason}`);
      }

      // pause ระหว่าง test case
      if (i > 0) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

  } catch (err) {
    logger.error('Fatal error', { error: err.message, stack: err.stack });
  } finally {
    await browser.close().catch(() => {});

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
}

main();