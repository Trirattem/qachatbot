/**
 * src/modules/progressTracker.js
 * ─────────────────────────────────────────────────────────────
 * Atomic writes, file locking (proper-lockfile), and optional
 * zlib compression for large checkpoints.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import lockfile from 'proper-lockfile';
import { format as dateFormat } from 'date-fns';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class ProgressTracker {
  constructor(documentId, instanceId = 1) {
    this.documentId = documentId;
    this.instanceId = instanceId;
    this.filePath = path.join(
      config.paths.logs,
      `progress_${documentId.slice(0, 20)}_inst${instanceId}.json`
    );
    this.gzFilePath = `${this.filePath}.gz`;
    this.data = null;
  }

  async load() {
    let content = null;
    let loadedPath = null;

    if (fs.existsSync(this.filePath)) {
      content = fs.readFileSync(this.filePath, 'utf8');
      loadedPath = this.filePath;
    } else if (fs.existsSync(this.gzFilePath)) {
      const buffer = fs.readFileSync(this.gzFilePath);
      content = zlib.gunzipSync(buffer).toString('utf8');
      loadedPath = this.gzFilePath;
    }

    if (content) {
      try {
        this.data = JSON.parse(content);

        let migrated = 0;
        for (const entry of Object.values(this.data.completed ?? {})) {
          if (typeof entry.writtenToSheets === 'boolean' && typeof entry.writtenToDocs !== 'boolean') {
            entry.writtenToDocs = entry.writtenToSheets;
            migrated++;
          }
          if (typeof entry.writtenToDocs !== 'boolean') {
            entry.writtenToDocs = false;
            migrated++;
          }
        }
        if (migrated > 0) {
          logger.info(`🔄 Migrated ${migrated} checkpoint entries`);
          await this._flush();
        }

        const total   = Object.keys(this.data.completed).length;
        const written = Object.values(this.data.completed).filter(v => v.writtenToDocs).length;
        const pending = total - written;
        logger.info(`📂 โหลด checkpoint: ${loadedPath}`);
        logger.info(`   ทำไปแล้ว ${total} case  |  เขียนแล้ว ${written}  |  pending ${pending}`);
        return true;
      } catch (err) {
        logger.warn('อ่าน checkpoint ไม่ได้ เริ่มใหม่', { error: err.message });
      }
    }
    this._init();
    return false;
  }

  _init() {
    this.data = {
      documentId:           this.documentId,
      spreadsheetId:        config.google.spreadsheetId || '',
      instanceId:           this.instanceId,
      startedAt:            dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      updatedAt:            null,
      lastCompletedTestId:  null,
      lastCompletedIndex:   -1,
      completed:            {},
    };
  }

  async save(testId, index, result) {
    this.data.updatedAt            = dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.data.lastCompletedTestId  = testId;
    this.data.lastCompletedIndex   = index;
    this.data.completed[testId]    = {
      status:          result.status,
      similarity:      result.similarity,
      timestamp:       result.timestamp,
      screenshotPath:  result.screenshotPath ?? '',
      actual:          result.actual ?? '',
      reason:          result.reason ?? '',
      attempts:        result.attempts ?? 1,
      selectedAttempt: result.selectedAttempt ?? 1,
      writtenToDocs:   false,
      writtenToSheets: false,
    };
    await this._flush();
    logger.debug(`💾 checkpoint: ${testId} (${result.status})`);
  }

  async markWrittenToDocs(testId) {
    if (this.data.completed[testId]) {
      this.data.completed[testId].writtenToDocs   = true;
      this.data.completed[testId].writtenToSheets = true;
      this.data.updatedAt = dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await this._flush();
    }
  }

  async markWrittenToSheets(testId) {
    await this.markWrittenToDocs(testId);
  }

  getCompleted(testId) {
    return this.data?.completed?.[testId] ?? null;
  }

  isCompleted(testId) {
    return Boolean(this.data?.completed?.[testId]);
  }

  reset() {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    if (fs.existsSync(this.gzFilePath)) fs.unlinkSync(this.gzFilePath);
    logger.info('🗑  ลบ checkpoint แล้ว');
    this._init();
  }

  async _flush() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Determine target file depending on compression logic
    const compressThreshold = config.system.checkpointCompressAfter || 200;
    const entriesCount = Object.keys(this.data.completed).length;
    const shouldCompress = entriesCount >= compressThreshold;
    
    const targetFile = shouldCompress ? this.gzFilePath : this.filePath;
    const tmpFile = `${targetFile}.tmp`;

    // Write to tmp atomically
    const jsonStr = JSON.stringify(this.data, null, 2);
    if (shouldCompress) {
      const gzipped = zlib.gzipSync(jsonStr);
      fs.writeFileSync(tmpFile, gzipped);
    } else {
      fs.writeFileSync(tmpFile, jsonStr, 'utf8');
    }

    // Ensure the target file exists for proper-lockfile to lock
    if (!fs.existsSync(targetFile)) {
       fs.writeFileSync(targetFile, shouldCompress ? zlib.gzipSync('{}') : '{}');
    }

    let release;
    try {
      release = await lockfile.lock(targetFile, { retries: 5 });
      fs.renameSync(tmpFile, targetFile);
      
      // Cleanup the other format if it exists to avoid confusion
      const otherFile = shouldCompress ? this.filePath : this.gzFilePath;
      if (fs.existsSync(otherFile)) fs.unlinkSync(otherFile);
    } catch (err) {
      logger.error('Failed to acquire lock or write checkpoint', { error: err.message });
    } finally {
      if (release) await release();
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); // fallback cleanup
    }
  }
}

export default ProgressTracker;