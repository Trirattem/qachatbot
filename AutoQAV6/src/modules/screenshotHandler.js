/**
 * src/modules/screenshotHandler.js
 * ─────────────────────────────────────────────────────────────
 * Manages screenshot capture, sharp compression, and drive uploading
 */

import path from 'path';
import fs from 'fs';
import { format as dateFormat } from 'date-fns';
import sharp from 'sharp';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import driveUploader from './driveUploader.js';

class ScreenshotHandler {
  constructor() {
    for (const sub of ['pass', 'partial', 'fail']) {
      fs.mkdirSync(path.join(config.paths.screenshots, sub), { recursive: true });
    }
  }

  async capture(browser, testId, status, attempt = null) {
    const subfolder  = status.toLowerCase();
    const timestamp  = dateFormat(new Date(), 'yyyyMMdd_HHmmss');
    const safeId     = testId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix     = attempt ? `_attempt${attempt}` : '';
    const filename   = `${safeId}${suffix}_${timestamp}.jpg`; // save as jpeg
    const absPath    = path.resolve(config.paths.screenshots, subfolder, filename);
    const relPath    = path.join('screenshots', subfolder, filename);
    const tmpPath    = `${absPath}.tmp.png`;

    try {
      // Capture full view (uncompressed PNG)
      await browser.takeScreenshot(tmpPath);

      // Compress and convert to JPG using sharp
      await sharp(tmpPath)
        .resize({ width: 800, withoutEnlargement: true }) // resize to max 800px width
        .jpeg({ quality: 75, progressive: true }) // compress
        .toFile(absPath);

      // Clean up tmp file
      fs.unlinkSync(tmpPath);
      
      logger.info(`Screenshot saved [${status}]: ${relPath}`);

      // If configured to upload to drive, do it here
      let driveUrl = null;
      if (config.system.uploadScreenshotsToDrive && config.system.driveFolderId) {
        driveUploader.setFolder(config.system.driveFolderId);
        const driveResult = await driveUploader.uploadScreenshot(absPath, filename);
        if (driveResult && driveResult.webContentLink) {
          driveUrl = driveResult.webContentLink;
        }
      }

      // We can return an object to let caller know the drive link
      // But to be backwards compatible, we can just return relPath,
      // and let testRunner handle it if we modify it.
      // Wait, let's return an object if driveUrl is present. Actually, string is safer.
      // Let's modify the return signature if needed, or just return relPath and store drive link separately.
      // Let's just return relPath for now, or JSON string. Actually, let's return an object { relPath, driveUrl }.
      // But testRunner expects a string. Let's return just relPath here, and let testRunner call driveUploader directly if needed,
      // OR let's just return a string: if driveUrl exists, return that, otherwise relPath.
      // Actually, testRunner puts it in `result.screenshotPath`.
      // The `docsClient` uses `screenshotUri` from `result.driveImageUrl ?? null`.
      // Let's update testRunner to accept an object later, or just return an object here and fix testRunner.
      return { relPath, driveUrl };
    } catch (err) {
      logger.error(`Screenshot failed for ${testId}`, { error: err.message });
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      return { relPath: '', driveUrl: null };
    }
  }

  async captureTriple(browser, testId, attempt = null) {
    // Basic implementation just wraps capture
    return this.capture(browser, testId, 'pass', attempt);
  }
}

export default ScreenshotHandler;
