/**
 * src/modules/testRunner.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrates the execution of a single test case with retry logic.
 *
 * Retry triggers:
 *  - No response (empty string returned)
 *  - Timeout error thrown by browserController
 *  - Any unexpected error
 *
 * After MAX_RETRIES exhausted → FAIL with reason = error type
 */

import { format as dateFormat } from 'date-fns';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { classify, classifyFailure, STATUS } from './classifier.js';

class TestRunner {
  /**
   * @param {BrowserController}   browser    - live playwright session
   * @param {ScreenshotHandler}   screenshot - screenshot utility
   */
  constructor(browser, screenshot) {
    this.browser    = browser;
    this.screenshot = screenshot;
  }

  /**
   * Run one test case with up to MAX_RETRIES attempts.
   *
   * @param {{ rowIndex, testId, question, expected }} testCase
   * @returns {Promise<{
   *   testId, rowIndex, status, similarity, actual,
   *   expected, screenshotPath, timestamp, reason, attempts
   * }>}
   */
  async run(testCase) {
    const { testId, rowIndex, question, expected } = testCase;
    const maxAttempts = config.maxRetries;

    let lastError   = null;
    let lastResult  = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(`Running test ${testId} — attempt ${attempt}/${maxAttempts}`);

      try {
        // ── Send message and get response ──────────────────────
        const actual = await this.browser.sendMessage(question, attempt);

        // ── Classify ───────────────────────────────────────────
        const { status, similarity, reason } = classify(expected, actual);

        lastResult = {
          testId,
          rowIndex,
          status,
          similarity,
          actual,
          expected,
          screenshotPath: '',    // filled below
          timestamp:      dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          reason,
          attempts: attempt,
        };

        // ── Take screenshot if PARTIAL or FAIL ─────────────────
        lastResult.screenshotPath = await this.screenshot.capture(
          this.browser, testId, status
        );

        // ── Log result ─────────────────────────────────────────
        logger.testResult({ testId, status, similarity, question, attempt });

        // ── Don't retry on PASS or PARTIAL — only FAIL ──────────
        // (PARTIAL means partial answer, retrying is unlikely to help)
        if (status !== STATUS.FAIL) {
          return lastResult;
        }

        // ── FAIL: log and possibly retry ───────────────────────
        logger.warn(`${testId} FAIL on attempt ${attempt}: ${reason}`);

        if (attempt < maxAttempts) {
          logger.info(`Retrying in ${config.timing.retryDelay}ms…`);
          await this._sleep(config.timing.retryDelay);
          // Reload the page between retries to reset chatbot state
          await this.browser.reload();
        }

      } catch (err) {
        lastError = err;
        const isTimeout = err.message?.toLowerCase().includes('timeout');
        const errType   = isTimeout ? 'TIMEOUT' : 'ERROR';

        logger.warn(`${testId} ${errType} on attempt ${attempt}: ${err.message}`);

        if (attempt < maxAttempts) {
          logger.info(`Retrying in ${config.timing.retryDelay}ms after ${errType}…`);
          await this._sleep(config.timing.retryDelay);
          try {
            await this.browser.reload();
          } catch (reloadErr) {
            logger.error('Page reload failed during retry', { error: reloadErr.message });
          }
        } else {
          // All attempts exhausted — build a FAIL result from the error
          const { status, similarity, reason } = classifyFailure(errType);
          lastResult = {
            testId,
            rowIndex,
            status,
            similarity,
            actual:         `[${errType}] ${err.message}`,
            expected,
            screenshotPath: '',
            timestamp:      dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
            reason,
            attempts:       attempt,
          };

          // Screenshot the error state
          lastResult.screenshotPath = await this.screenshot.capture(
            this.browser, testId, STATUS.FAIL
          );
        }
      }
    }

    // If we fell through all retries without a result (shouldn't happen)
    if (!lastResult) {
      const { status, similarity, reason } = classifyFailure('UNKNOWN_ERROR');
      lastResult = {
        testId,
        rowIndex,
        status,
        similarity,
        actual:         lastError?.message ?? 'Unknown error',
        expected,
        screenshotPath: '',
        timestamp:      dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        reason,
        attempts:       maxAttempts,
      };
    }

    return lastResult;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default TestRunner;
