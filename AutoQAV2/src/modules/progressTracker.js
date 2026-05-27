/**
 * src/modules/progressTracker.js
 * ─────────────────────────────────────────────────────────────
 * บันทึก checkpoint ลง JSON ทุกครั้งที่ test case เสร็จ
 * รองรับการ resume: ข้ามที่มี Status/Actual แล้ว หรือ
 * โหลด checkpoint ล่าสุดมารันต่อได้เลย
 *
 * ไฟล์: logs/progress_{documentId}.json
 * {
 *   "documentId": "...",
 *   "startedAt": "...",
 *   "updatedAt": "...",
 *   "lastCompletedTestId": "TRD_AI_007",
 *   "lastCompletedIndex": 6,   // 0-based index ใน casesToRun
 *   "completed": {
 *     "TRD_AI_001": { status, similarity, timestamp },
 *     ...
 *   }
 * }
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
        logger.info(`📂 โหลด checkpoint: ${this.filePath}`);
        logger.info(`   ทำไปแล้ว ${Object.keys(this.data.completed).length} test case`);
        logger.info(`   หยุดล่าสุดที่: ${this.data.lastCompletedTestId ?? '-'}`);
        return true; // มี checkpoint เดิม
      } catch (err) {
        logger.warn('อ่าน checkpoint ไม่ได้ เริ่มใหม่', { error: err.message });
      }
    }

    // สร้างใหม่
    this.data = {
      documentId: this.documentId,
      startedAt: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      updatedAt: null,
      lastCompletedTestId: null,
      lastCompletedIndex: -1,
      completed: {},
    };
    return false; // ไม่มี checkpoint
  }

  // บันทึกหลังทำ test case เสร็จแต่ละตัว
  save(testId, index, result) {
    this.data.updatedAt = dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.data.lastCompletedTestId = testId;
    this.data.lastCompletedIndex = index;
    this.data.completed[testId] = {
      status: result.status,
      similarity: result.similarity,
      timestamp: result.timestamp,
      screenshotPath: result.screenshotPath ?? '',
    };

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    logger.debug(`💾 checkpoint บันทึก: ${testId} (${result.status})`);
  }

  // ตรวจว่า test case นี้ทำไปแล้วหรือยัง
  isCompleted(testId) {
    return Boolean(this.data?.completed?.[testId]);
  }

  // ลบ checkpoint (เริ่มใหม่ทั้งหมด)
  reset() {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
      logger.info('🗑  ลบ checkpoint แล้ว');
    }
    this.data = {
      documentId: this.documentId,
      startedAt: dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      updatedAt: null,
      lastCompletedTestId: null,
      lastCompletedIndex: -1,
      completed: {},
    };
  }

  get completedCount() {
    return Object.keys(this.data?.completed ?? {}).length;
  }

  get lastTestId() {
    return this.data?.lastCompletedTestId ?? null;
  }
}

export default ProgressTracker;