/**
 * src/modules/webhookTestRunner.js
 * ─────────────────────────────────────────────────────────────
 * Runs one test case via Webhook API with hard backend timeout.
 * On timeout or error, logs and returns FAIL — never throws to caller.
 */

import { format as dateFormat } from 'date-fns';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { classify, classifyFailure, STATUS } from './classifier.js';
import WebhookClient from './webhookClient.js';
import { withTimeout, ProcessingTimeoutError } from '../utils/withTimeout.js';

class WebhookTestRunner {
  constructor(webhookClient = null) {
    this.webhook = webhookClient ?? new WebhookClient();
    this.processingTimeoutMs = config.queue.processingTimeoutMs;
  }

  /**
   * Process a single test case within the 2-minute backend timeout.
   * Always returns a result object — never throws.
   *
   * @param {object} testCase
   * @returns {Promise<object>}
   */
  async run(testCase) {
    const { testId, rowIndex, question, expected } = testCase;

    try {
      return await withTimeout(
        this._execute(testCase),
        this.processingTimeoutMs,
        { label: `test ${testId}`, testId }
      );
    } catch (err) {
      return this._buildErrorResult(testCase, err);
    }
  }

  async _execute(testCase) {
    const { testId, rowIndex, question, expected } = testCase;

    logger.info(`[WebhookRunner] Running ${testId}`);

    const { text: actual } = await this.webhook.sendQuestion(question, {
      testId,
      rowIndex,
      expected,
    });

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
      attempts: 1,
      selectedAttempt: 1,
      source: 'webhook',
    };

    logger.testResult({ testId, status, similarity, question, attempt: 1 });
    logger.info(
      `${testId} → ${status} (${((similarity ?? 0) * 100).toFixed(1)}%) [webhook]`
    );

    return result;
  }

  _buildErrorResult(testCase, err) {
    const { testId, rowIndex, question, expected } = testCase;
    const isTimeout = err instanceof ProcessingTimeoutError ||
      err.name === 'ProcessingTimeoutError' ||
      err.message?.toLowerCase().includes('timeout');

    const errType = isTimeout ? 'BACKEND_TIMEOUT' : (err.name || 'WEBHOOK_ERROR');

    logger.error(`[WebhookRunner] ${testId} ${errType}`, {
      error: err.message,
      timeoutMs: isTimeout ? this.processingTimeoutMs : undefined,
      stack: err.stack,
    });

    const { status, similarity, reason } = classifyFailure(
      isTimeout ? 'TIMEOUT' : errType
    );

    return {
      testId,
      rowIndex,
      status: status ?? STATUS.FAIL,
      similarity: similarity ?? 0,
      question,
      actual: `[${errType}] ${err.message}`,
      expected,
      screenshotPath: '',
      driveImageUrl: null,
      timestamp: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      reason: reason ?? err.message,
      attempts: 1,
      selectedAttempt: 1,
      source: 'webhook',
      error: {
        type: errType,
        message: err.message,
        timeoutMs: isTimeout ? this.processingTimeoutMs : null,
      },
    };
  }
}

export default WebhookTestRunner;
