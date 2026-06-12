/**
 * src/utils/withTimeout.js
 * ─────────────────────────────────────────────────────────────
 * Abort async work when it exceeds the configured deadline.
 */

export class ProcessingTimeoutError extends Error {
  constructor(message, { testId = null, timeoutMs = 0 } = {}) {
    super(message);
    this.name = 'ProcessingTimeoutError';
    this.testId = testId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a hard timeout.
 * Clears the timer when the wrapped work finishes first.
 *
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {{ label?: string, testId?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withTimeout(promise, timeoutMs, options = {}) {
  const { label = 'operation', testId = null } = options;

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ProcessingTimeoutError(
        `${label} exceeded ${timeoutMs}ms limit`,
        { testId, timeoutMs }
      ));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export default withTimeout;
