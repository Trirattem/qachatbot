/**
 * src/modules/messageQueue.js
 * ─────────────────────────────────────────────────────────────
 * FIFO message queue with rate limiting between jobs.
 * Ensures each question is spaced by QUEUE_RATE_LIMIT_MS (default 30s).
 */

import logger from '../utils/logger.js';
import config from '../config/index.js';

class MessageQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.rateLimitMs] - Minimum gap between completed jobs
   * @param {(item: object) => Promise<object>} [options.processor] - Job handler
   */
  constructor(options = {}) {
    this.rateLimitMs = options.rateLimitMs ?? config.queue.rateLimitMs;
    this.processor = options.processor ?? null;
    this.queue = [];
    this.isRunning = false;
    this.isPaused = false;
    this.shouldStop = false;
    this.lastCompletedAt = 0;
    this.stats = {
      enqueued: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
  }

  /**
   * @param {object} item - Test case or custom payload
   * @returns {Promise<object|null>} Result when processed, null if stopped early
   */
  enqueue(item) {
    this.stats.enqueued++;
    return new Promise((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      this._drain();
    });
  }

  /**
   * Bulk enqueue with sequential processing.
   * @param {object[]} items
   * @returns {Promise<object[]>}
   */
  async enqueueAll(items) {
    const results = [];
    for (const item of items) {
      if (this.shouldStop) break;
      results.push(await this.enqueue(item));
    }
    return results;
  }

  stop() {
    this.shouldStop = true;
    logger.warn('[MessageQueue] Stop requested — will finish current job then halt');
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
    this._drain();
  }

  getStats() {
    return {
      ...this.stats,
      pending: this.queue.length,
      isRunning: this.isRunning,
    };
  }

  async _waitForRateLimit() {
    if (this.lastCompletedAt === 0) return;

    const elapsed = Date.now() - this.lastCompletedAt;
    const remaining = this.rateLimitMs - elapsed;

    if (remaining > 0) {
      logger.info(`[MessageQueue] Rate limit — waiting ${Math.ceil(remaining / 1000)}s before next question`);
      await this._sleep(remaining);
    }
  }

  async _drain() {
    if (this.isRunning || this.isPaused || !this.processor) return;

    this.isRunning = true;

    while (this.queue.length > 0 && !this.shouldStop) {
      await this._waitForRateLimit();

      const job = this.queue.shift();
      if (!job) break;

      const { item, resolve, reject } = job;
      const label = item.testId ?? item.id ?? 'unknown';

      try {
        logger.debug(`[MessageQueue] Processing ${label} (${this.stats.processed + 1}/${this.stats.enqueued})`);
        const result = await this.processor(item);
        this.stats.processed++;
        this.stats.succeeded++;
        this.lastCompletedAt = Date.now();
        resolve(result);
      } catch (err) {
        this.stats.processed++;
        this.stats.failed++;
        this.lastCompletedAt = Date.now();

        // Never let a single failure stop the queue — resolve with error payload
        logger.error(`[MessageQueue] Job failed: ${label}`, {
          error: err.message,
          name: err.name,
        });

        resolve({
          _queueError: true,
          error: err,
          testId: item.testId ?? null,
        });
      }
    }

    this.isRunning = false;

    if (this.queue.length > 0 && !this.shouldStop && !this.isPaused) {
      this._drain();
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default MessageQueue;
