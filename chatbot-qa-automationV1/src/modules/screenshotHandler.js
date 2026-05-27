/**
 * src/modules/screenshotHandler.js
 * ─────────────────────────────────────────────────────────────
 * Manages screenshot capture and folder organisation.
 *
 * Folder layout:
 *   screenshots/
 *     pass/       ← not used (screenshots only for PARTIAL & FAIL)
 *     partial/    ← PARTIAL results
 *     fail/       ← FAIL results
 *
 * File naming: {testId}_{yyyyMMdd_HHmmss}.png
 */

import path from 'path';
import fs from 'fs';
import { format as dateFormat } from 'date-fns';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { STATUS } from './classifier.js';

class ScreenshotHandler {
  constructor() {
    // Ensure all subdirectories exist at startup
    for (const sub of ['pass', 'partial', 'fail']) {
      fs.mkdirSync(path.join(config.paths.screenshots, sub), { recursive: true });
    }
  }

  /**
   * Decide whether to take a screenshot and, if so, do it.
   *
   * Screenshots are taken ONLY for PARTIAL and FAIL.
   *
   * @param {BrowserController} browser - live browser instance
   * @param {string} testId             - e.g. "TC_001"
   * @param {string} status             - PASS | PARTIAL | FAIL
   * @returns {Promise<string>}         - relative path, or empty string
   */
  async capture(browser, testId, status) {
    // Skip screenshot for PASS
    if (status === STATUS.PASS) {
      logger.debug(`No screenshot for PASS: ${testId}`);
      return '';
    }

    const subfolder  = status.toLowerCase();   // 'partial' or 'fail'
    const timestamp  = dateFormat(new Date(), 'yyyyMMdd_HHmmss');
    const safeId     = testId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename   = `${safeId}_${timestamp}.png`;
    const absPath    = path.resolve(config.paths.screenshots, subfolder, filename);
    const relPath    = path.join('screenshots', subfolder, filename); // stored in Sheets

    try {
      await browser.takeScreenshot(absPath);
      logger.info(`Screenshot saved [${status}]: ${relPath}`);
      return relPath;
    } catch (err) {
      logger.error(`Screenshot failed for ${testId}`, { error: err.message });
      return '';
    }
  }
}

export default ScreenshotHandler;
