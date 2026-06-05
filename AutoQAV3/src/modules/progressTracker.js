/**
 * src/modules/progressTracker.js  (v3 — sheets + docs)
 * ─────────────────────────────────────────────────────────────
 * รองรับทั้ง writtenToSheets และ writtenToDocs
 * เพื่อ backward-compat กับ checkpoint เก่าที่ใช้ writtenToSheets
 */

import fs from 'fs';
import path from 'path';
import { format as dateFormat } from 'date-fns';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class ProgressTracker {
  constructor(documentId) {
    this.documentId = documentId;
    this.filePath = path.join(
      config.paths.logs,
      `progress_${documentId.slice(0, 20)}.json`
    );
    this.data = null;
  }

  // โหลด checkpoint เดิม หรือสร้างใหม่
  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));

        // ── migrate: writtenToSheets → writtenToDocs ──────────
        let migrated = 0;
        for (const entry of Object.values(this.data.completed ?? {})) {
          // ถ้ามี writtenToSheets แต่ยังไม่มี writtenToDocs → copy ค่ามา
          if (typeof entry.writtenToSheets === 'boolean' && typeof entry.writtenToDocs !== 'boolean') {
            entry.writtenToDocs = entry.writtenToSheets;
            migrated++;
          }
          // ถ้าไม่มีทั้งคู่ → ตั้งเป็น false
          if (typeof entry.writtenToDocs !== 'boolean') {
            entry.writtenToDocs = false;
            migrated++;
          }
        }
        if (migrated > 0) {
          logger.info(`🔄 Migrated ${migrated} checkpoint entries (writtenToSheets → writtenToDocs)`);
          this._flush();
        }

        const total   = Object.keys(this.data.completed).length;
        const written = Object.values(this.data.completed).filter(v => v.writtenToDocs).length;
        const pending = total - written;
        logger.info(`📂 โหลด checkpoint: ${this.filePath}`);
        logger.info(`   ทำไปแล้ว ${total} case  |  เขียนแล้ว ${written}  |  pending ${pending}`);
        logger.info(`   หยุดล่าสุดที่: ${this.data.lastCompletedTestId ?? '-'}`);
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
      startedAt:            dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      updatedAt:            null,
      lastCompletedTestId:  null,
      lastCompletedIndex:   -1,
      completed:            {},
    };
  }

  // บันทึกหลัง browser phase เสร็จแต่ละข้อ
  save(testId, index, result) {
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
    this._flush();
    logger.debug(`💾 checkpoint: ${testId} (${result.status})`);
  }

  // ทำเครื่องหมายว่า write ไปแล้ว (รองรับทั้ง docs และ sheets)
  markWrittenToDocs(testId) {
    if (this.data.completed[testId]) {
      this.data.completed[testId].writtenToDocs   = true;
      this.data.completed[testId].writtenToSheets = true; // sync ให้ตรงกัน
      this.data.updatedAt = dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss');
      this._flush();
    }
  }

  markWrittenToSheets(testId) {
    if (this.data.completed[testId]) {
      this.data.completed[testId].writtenToSheets = true;
      this.data.completed[testId].writtenToDocs   = true; // sync ให้ตรงกัน
      this.data.updatedAt = dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss');
      this._flush();
    }
  }

  // ดึงข้อมูลของ test case ที่เสร็จแล้ว
  getCompleted(testId) {
    return this.data?.completed?.[testId] ?? null;
  }

  // ตรวจว่า test case นี้ทำ browser phase ไปแล้วหรือยัง
  isCompleted(testId) {
    return Boolean(this.data?.completed?.[testId]);
  }

  // นับ pending (ยังไม่ได้ write)
  get pendingDocsCount() {
    return Object.values(this.data?.completed ?? {})
      .filter(v => !v.writtenToDocs && !v.writtenToSheets).length;
  }

  // ลบ checkpoint
  reset() {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
      logger.info('🗑  ลบ checkpoint แล้ว');
    }
    this._init();
  }

  get completedCount() {
    return Object.keys(this.data?.completed ?? {}).length;
  }

  get lastTestId() {
    return this.data?.lastCompletedTestId ?? null;
  }

  _flush() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

export default ProgressTracker;