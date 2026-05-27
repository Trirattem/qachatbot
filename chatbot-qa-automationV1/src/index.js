/**
 * src/index.js
 * ─────────────────────────────────────────────────────────────
 * Main entry point for the Chatbot QA Automation system.
 *
 * Execution flow:
 *  1. Load config & validate environment
 *  2. Connect to Google Sheets → read test cases
 *  3. Launch Playwright browser → navigate to chatbot
 *  4. For each test case: run → classify → screenshot → write result
 *  5. Generate HTML report
 *  6. Graceful shutdown
 */

import 'dotenv/config';
import logger from './utils/logger.js';
import config from './config/index.js';
import SheetsClient      from './modules/sheetsClient.js';
import BrowserController from './modules/browserController.js';
import ScreenshotHandler from './modules/screenshotHandler.js';
import TestRunner        from './modules/testRunner.js';
import Reporter          from './modules/reporter.js';

// ── Dry-run flag (node src/index.js --dry-run) ────────────────
const DRY_RUN = process.argv.includes('--dry-run');

// ── Graceful shutdown on unhandled errors ─────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise rejection', { reason: String(reason) });
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(' Chatbot QA Automation — Starting Run');
  if (DRY_RUN) logger.info(' ⚠  DRY RUN MODE — no results written to Sheets');
  logger.info('═══════════════════════════════════════════════');

  const startTime = Date.now();

  // ── Module instances ────────────────────────────────────────
  const sheets     = new SheetsClient();
  const browser    = new BrowserController();
  const screenshot = new ScreenshotHandler();
  const runner     = new TestRunner(browser, screenshot);
  const reporter   = new Reporter();

  const allResults = [];

  try {
    // ── Step 1: Connect to Google Sheets ──────────────────────
    await sheets.init();
    if (!DRY_RUN) await sheets.ensureHeaders();

    // ── Step 2: Load test cases ───────────────────────────────
    const testCases = await sheets.getTestCases();

    if (testCases.length === 0) {
      logger.warn('No test cases found in the sheet. Exiting.');
      return;
    }

    logger.info(`Starting ${testCases.length} test cases…`);

    // ── Step 3: Launch browser ────────────────────────────────
    await browser.init();
    // ── Step 4: Run each test case sequentially ───────────────
    //  Sequential (not parallel) to avoid chatbot rate-limiting
    //  and to maintain a clean conversation state.
    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      logger.info(`\n[${i + 1}/${testCases.length}] Test: ${tc.testId}`);

      // Run with retry logic
      const result = await runner.run(tc);
      allResults.push(result);

      // Write result back to Google Sheets (unless dry-run)
      if (!DRY_RUN) {
        try {
          await sheets.writeResult(tc.rowIndex, {
            actual:         result.actual,
            status:         result.status,
            timestamp:      result.timestamp,
            screenshotPath: result.screenshotPath,
          });
        } catch (sheetErr) {
          // Sheet write failure should not abort the whole run
          logger.error(`Failed to write result for ${tc.testId} to Sheets`, {
            error: sheetErr.message,
          });
        }
      } else {
        logger.info(`[DRY RUN] Would write: ${result.status} — ${result.reason}`);
      }

      // Small pause between test cases to avoid flooding the chatbot
      if (i < testCases.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

  } catch (err) {
    logger.error('Fatal error during test run', { error: err.message, stack: err.stack });
  } finally {
    // ── Step 5: Close browser ─────────────────────────────────
    await browser.close().catch(() => {});

    // ── Step 6: Generate HTML report ─────────────────────────
    if (allResults.length > 0) {
      await reporter.generate(allResults);
    }

    // ── Step 7: Final summary ─────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const counts  = allResults.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    logger.info('═══════════════════════════════════════════════');
    logger.info(` Run complete in ${elapsed}s`);
    logger.info(` PASS: ${counts.PASS ?? 0}  PARTIAL: ${counts.PARTIAL ?? 0}  FAIL: ${counts.FAIL ?? 0}`);
    logger.info('═══════════════════════════════════════════════');
  }
}

main();
