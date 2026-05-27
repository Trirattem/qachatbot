/**
 * src/modules/screenshotHandler.js
 * ─────────────────────────────────────────────────────────────
 * Manages screenshot capture and folder organisation.
 *
 * Folder layout:
 *   screenshots/
 *     pass/       ← PASS results
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
   * Screenshots are taken after every attempt so the selected result has
   * a matching image for the Actual Result column.
   *
   * @param {BrowserController} browser - live browser instance
   * @param {string} testId             - e.g. "TC_001"
   * @param {string} status             - PASS | PARTIAL | FAIL
   * @param {number|null} attempt       - attempt number for filename uniqueness
   * @returns {Promise<string>}         - relative path, or empty string
   */
  async capture(browser, testId, status, attempt = null) {
    const subfolder  = status.toLowerCase();
    const timestamp  = dateFormat(new Date(), 'yyyyMMdd_HHmmss');
    const safeId     = testId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix     = attempt ? `_attempt${attempt}` : '';
    const filename   = `${safeId}${suffix}_${timestamp}.png`;
    const absPath    = path.resolve(config.paths.screenshots, subfolder, filename);
    const relPath    = path.join('screenshots', subfolder, filename);

    try {
      await browser.takeScreenshot(absPath);
      logger.info(`Screenshot saved [${status}]: ${relPath}`);
      return relPath;
    } catch (err) {
      logger.error(`Screenshot failed for ${testId}`, { error: err.message });
      return '';
    }
  }

  /**
   * Capture 3 screenshots in rapid succession and return the best one (largest file size).
   * Best for capturing PASS results with optimal clarity.
   *
   * @param {BrowserController} browser - live browser instance
   * @param {string} testId             - e.g. "TC_001"
   * @param {number|null} attempt       - attempt number for filename uniqueness
   * @returns {Promise<string>}         - relative path of best screenshot, or empty string
   */
  async captureTriple(browser, testId, attempt = null) {
    const subfolder = 'pass';
    const safeId = testId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const baseTimestamp = dateFormat(new Date(), 'yyyyMMdd_HHmmss');
    const suffix = attempt ? `_attempt${attempt}` : '';
    
    const screenshots = [];
    const delay = 100; // 100ms between captures

    try {
      // Capture 3 screenshots with slight delays between them
      for (let i = 0; i < 3; i++) {
        const timestamp = `${baseTimestamp}_${String(i + 1).padStart(2, '0')}`;
        const filename = `${safeId}${suffix}_${timestamp}.png`;
        const absPath = path.resolve(config.paths.screenshots, subfolder, filename);
        
        await browser.takeScreenshot(absPath);
        screenshots.push({ absPath, relPath: path.join('screenshots', subfolder, filename) });
        
        if (i < 2) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // Find the best screenshot (largest file size = typically best clarity)
      let bestScreenshot = screenshots[0];
      let bestSize = fs.statSync(bestScreenshot.absPath).size;

      for (let i = 1; i < screenshots.length; i++) {
        const size = fs.statSync(screenshots[i].absPath).size;
        if (size > bestSize) {
          bestSize = size;
          bestScreenshot = screenshots[i];
        }
      }

      logger.info(
        `Captured 3 screenshots for ${testId}. Selected: ${bestScreenshot.relPath} (${bestSize} bytes)`
      );

      // Clean up the non-selected screenshots
      for (const screenshot of screenshots) {
        if (screenshot.absPath !== bestScreenshot.absPath) {
          try {
            fs.unlinkSync(screenshot.absPath);
            logger.debug(`Removed duplicate screenshot: ${screenshot.relPath}`);
          } catch (err) {
            logger.warn(`Could not delete duplicate screenshot: ${err.message}`);
          }
        }
      }

      return bestScreenshot.relPath;

    } catch (err) {
      logger.error(`Triple screenshot capture failed for ${testId}`, { error: err.message });
      // Clean up any screenshots that were created
      for (const screenshot of screenshots) {
        try {
          if (fs.existsSync(screenshot.absPath)) {
            fs.unlinkSync(screenshot.absPath);
          }
        } catch (cleanupErr) {
          logger.warn(`Could not clean up screenshot: ${cleanupErr.message}`);
        }
      }
      return '';
    }
  }
}

export default ScreenshotHandler;
