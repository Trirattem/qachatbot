/**
 * src/modules/testRunner.js  (updated v2)
 * รองรับ browserController ทั้งเวอร์ชั่นเก่า (return string)
 * และใหม่ (return { text, justFinishedThinking })
 */

import { format as dateFormat } from 'date-fns';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { classify, classifyFailure, STATUS } from './classifier.js';

class TestRunner {
  constructor(browser, screenshot) {
    this.browser    = browser;
    this.screenshot = screenshot;
  }

  async run(testCase) {
    const { testId, rowIndex, question, expected } = testCase;
    const maxAttempts = config.maxRetries;
    const attemptResults = [];
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(`Running test ${testId} - attempt ${attempt}/${maxAttempts}`);

      try {
        // รองรับทั้ง browserController เก่า (return string)
        // และใหม่ (return { text, justFinishedThinking })
        const raw = await this.browser.sendMessage(question, attempt);
        const actual              = (typeof raw === 'object' && raw !== null) ? raw.text : raw;
        const justFinishedThinking = (typeof raw === 'object' && raw !== null) ? (raw.justFinishedThinking ?? false) : false;

        const { status, similarity, reason } = classify(expected, actual, question);

        const result = {
          testId,
          rowIndex,
          status,
          similarity,
          question,
          actual,
          expected,
          screenshotPath: '',
          timestamp: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          reason,
          attempts: attempt,
          selectedAttempt: attempt,
        };

        // justFinishedThinking → แคปทันที (100ms)
        // ปกติ → รอ screenshotDelay
        const delay = justFinishedThinking ? 100 : config.timing.screenshotDelay;
        await this._sleep(delay);

        result.screenshotPath = await this.screenshot.capture(
          this.browser, testId, status, attempt
        );

        attemptResults.push(result);
        logger.testResult({ testId, status, similarity, question, attempt });

        // PASS → หยุดทันที
        if (status === STATUS.PASS) {
          logger.info(`${testId} PASS on attempt ${attempt} - done`);
          break;
        }

        // PARTIAL/FAIL → reload แล้ว retry
        if (attempt < maxAttempts) {
          logger.info(`Next attempt in ${config.timing.retryDelay}ms...`);
          await this._sleep(config.timing.retryDelay);
          try {
            await this.browser.reload();
          } catch (reloadErr) {
            logger.error('Page reload failed between attempts', { error: reloadErr.message });
          }
        }

      } catch (err) {
        lastError = err;
        const isTimeout = err.message?.toLowerCase().includes('timeout');
        const errType   = isTimeout ? 'TIMEOUT' : 'ERROR';
        const { status, similarity, reason } = classifyFailure(errType);

        logger.warn(`${testId} ${errType} on attempt ${attempt}: ${err.message}`);

        const result = {
          testId,
          rowIndex,
          status,
          similarity,
          question,
          actual: `[${errType}] ${err.message}`,
          expected,
          screenshotPath: '',
          timestamp: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          reason,
          attempts: attempt,
          selectedAttempt: attempt,
        };

        await this._sleep(config.timing.screenshotDelay);
        result.screenshotPath = await this.screenshot.capture(
          this.browser, testId, STATUS.FAIL, attempt
        );
        attemptResults.push(result);

        if (attempt < maxAttempts) {
          logger.info(`Retry in ${config.timing.retryDelay}ms after ${errType}…`);
          await this._sleep(config.timing.retryDelay);
          try {
            await this.browser.reload();
          } catch (reloadErr) {
            logger.error('Page reload failed', { error: reloadErr.message });
          }
        }
      }
    }

    let bestResult = this._selectBestResult(attemptResults);

    if (!bestResult) {
      const { status, similarity, reason } = classifyFailure('UNKNOWN_ERROR');
      bestResult = {
        testId,
        rowIndex,
        status,
        similarity,
        question,
        actual: lastError?.message ?? 'Unknown error',
        expected,
        screenshotPath: '',
        timestamp: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        reason,
        attempts: maxAttempts,
        selectedAttempt: maxAttempts,
      };
    }

    bestResult.attemptResults = attemptResults;
    bestResult.attempts = attemptResults.length || maxAttempts;

    logger.info(
      `${testId} → ${bestResult.status} ` +
      `(${((bestResult.similarity ?? 0) * 100).toFixed(1)}%) ` +
      `attempt ${bestResult.selectedAttempt}/${maxAttempts}`
    );

    return bestResult;
  }

  _selectBestResult(results) {
    return [...results].sort((a, b) => {
      const statusDelta = this._statusRank(b.status) - this._statusRank(a.status);
      if (statusDelta !== 0) return statusDelta;
      const simDelta = (b.similarity ?? 0) - (a.similarity ?? 0);
      if (simDelta !== 0) return simDelta;
      return (a.selectedAttempt ?? 0) - (b.selectedAttempt ?? 0);
    })[0] ?? null;
  }

  _statusRank(status) {
    return { [STATUS.PASS]: 3, [STATUS.PARTIAL]: 2, [STATUS.FAIL]: 1 }[status] ?? 0;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default TestRunner;