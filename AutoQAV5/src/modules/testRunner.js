/**
 * src/modules/testRunner.js
 * Smart Retry Logic & Exponential Backoff
 */

import { format as dateFormat } from 'date-fns';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { classify, classifyFailure, STATUS } from './classifier.js';

class TestRunner {
  constructor(browser, screenshot) {
    this.browser = browser;
    this.screenshot = screenshot;
  }

  async run(testCase) {
    const { testId, rowIndex, question, expected } = testCase;
    const maxRetries = config.maxRetries;
    const attemptResults = [];
    let lastError = null;
    let attempt = 1;
    let contentRetryCount = 0; // limit content retries to 1
    
    // We can loop indefinitely but break on conditions
    while (attempt <= maxRetries) {
      logger.info(`Running test ${testId} - attempt ${attempt}`);

      try {
        const raw = await this.browser.sendMessage(question, attempt);
        const actual = (typeof raw === 'object' && raw !== null) ? raw.text : raw;
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
          driveImageUrl: null,
          timestamp: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          reason,
          attempts: attempt,
          selectedAttempt: attempt,
        };

        const delay = justFinishedThinking ? 100 : config.timing.screenshotDelay;
        await this._sleep(delay);

        // captureTriple is supported in screenshotHandler, but we'll capture normally. 
        const screenshotInfo = await this.screenshot.capture(
          this.browser, testId, status, attempt
        );
        result.screenshotPath = screenshotInfo?.relPath ?? '';
        result.driveImageUrl = screenshotInfo?.driveUrl ?? null;

        attemptResults.push(result);
        logger.testResult({ testId, status, similarity, question, attempt });

        // ── Smart Retry Decision ──
        if (status === STATUS.PASS) {
          logger.info(`${testId} PASS on attempt ${attempt} - done`);
          break;
        }

        // Check if Permanent Fail Keyword
        if (reason.startsWith('Cannot answer:')) {
          logger.info(`${testId} Permanent FAIL (keyword match) - no retry`);
          break; // Stop retrying
        }

        // Content fail/partial -> retry max 1 time
        if (status === STATUS.PARTIAL || status === STATUS.FAIL) {
          contentRetryCount++;
          if (contentRetryCount > 1) {
            logger.info(`${testId} Content FAIL/PARTIAL reached max content retries - stopping`);
            break;
          }
          logger.info(`Content mismatch. Retrying question (content retry ${contentRetryCount}/1)`);
          // Note: for content retry, we don't necessarily need to reload page unless it's stuck
          // We'll just ask again
        }

      } catch (err) {
        lastError = err;
        const errName = err.name || 'ERROR';
        const isTimeout = err.message?.toLowerCase().includes('timeout');
        const errType = isTimeout ? 'TIMEOUT' : (errName === 'SessionError' || errName === 'NetworkError' ? errName : 'ERROR');
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
          driveImageUrl: null,
          timestamp: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          reason,
          attempts: attempt,
          selectedAttempt: attempt,
        };

        await this._sleep(config.timing.screenshotDelay);
        const screenshotInfo = await this.screenshot.capture(
          this.browser, testId, STATUS.FAIL, attempt
        );
        result.screenshotPath = screenshotInfo?.relPath ?? '';
        result.driveImageUrl = screenshotInfo?.driveUrl ?? null;
        attemptResults.push(result);

        // Technical fail -> reload page and retry with exponential backoff
        if (attempt < maxRetries) {
          const backoffDelay = config.timing.retryDelay * Math.pow(2, attempt - 1);
          logger.info(`Technical error. Retry ${attempt + 1}/${maxRetries} in ${backoffDelay}ms after reload...`);
          await this._sleep(backoffDelay);
          try {
            await this.browser.reload();
          } catch (reloadErr) {
            logger.error('Page reload failed', { error: reloadErr.message });
          }
        }
      }

      attempt++;
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
        driveImageUrl: null,
        timestamp: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        reason,
        attempts: attemptResults.length,
        selectedAttempt: 1,
      };
    }

    bestResult.attemptResults = attemptResults;
    bestResult.attempts = attemptResults.length;

    logger.info(
      `${testId} → ${bestResult.status} ` +
      `(${((bestResult.similarity ?? 0) * 100).toFixed(1)}%) ` +
      `attempt ${bestResult.selectedAttempt}/${attemptResults.length}`
    );

    return bestResult;
  }

  _selectBestResult(results) {
    if (results.length === 0) return null;
    return [...results].sort((a, b) => {
      const statusDelta = this._statusRank(b.status) - this._statusRank(a.status);
      if (statusDelta !== 0) return statusDelta;
      const simDelta = (b.similarity ?? 0) - (a.similarity ?? 0);
      if (simDelta !== 0) return simDelta;
      // If same similarity and status, pick the newest attempt
      return (b.selectedAttempt ?? 0) - (a.selectedAttempt ?? 0);
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