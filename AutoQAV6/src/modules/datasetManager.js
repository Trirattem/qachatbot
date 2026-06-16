import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import config from '../config/index.js';

export default class DatasetManager {
  constructor(datasetDir = './datasets') {
    this.datasetDir = datasetDir;
    
    // Ensure base directory and subdirectories exist
    if (!fs.existsSync(this.datasetDir)) {
      fs.mkdirSync(this.datasetDir, { recursive: true });
    }
    const sheetsDir = path.join(this.datasetDir, 'Google Sheets');
    const docsDir = path.join(this.datasetDir, 'Google Docs');
    if (!fs.existsSync(sheetsDir)) fs.mkdirSync(sheetsDir, { recursive: true });
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  }

  async exportTestCases(client, target) {
    logger.info(`[DatasetManager] กำลังโหลด test cases จาก ${target.toUpperCase()}...`);
    const rawTestCases = await client.getTestCases();
    
    if (rawTestCases.length === 0) {
      throw new Error('No test cases found to export.');
    }

    const validTestCases = this.validateDataset(rawTestCases);
    const hash = this.computeDatasetHash(validTestCases);
    
    const dataset = {
      hash,
      generatedAt: new Date().toISOString(),
      target,
      testCases: validTestCases,
    };

    const targetSubdir = target === 'sheets' ? 'Google Sheets' : 'Google Docs';
    
    // Determine the base name (Sheet Name or Doc placeholder)
    let baseName = target === 'sheets' 
      ? (process.env.GOOGLE_SHEET_NAME || 'Unknown_Sheet') 
      : 'Google_Docs_Export';
      
    // Clean up base name for valid filename
    baseName = baseName.replace(/[^a-zA-Z0-9_\u0e00-\u0e7f]/g, '_');
    
    // Generate timestamp in format YYYYMMDD_HHmmss
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    
    const filename = `${baseName}_${timestamp}.json`;
    const filePath = path.join(this.datasetDir, targetSubdir, filename);
    
    fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf8');

    logger.info(`[DatasetManager] บันทึก Snapshot dataset สำเร็จ: ${filePath} (${validTestCases.length} ข้อ)`);
    return filePath;
  }

  loadDataset(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Dataset snapshot not found at ${filePath}. Please select a dataset from run_config.js or run --extract-only first.`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  }

  validateDataset(testCases) {
    const valid = [];
    const seenIds = new Set();
    let malformedCount = 0;

    for (const tc of testCases) {
      if (!tc.testId || tc.testId.trim() === '') {
        malformedCount++;
        continue;
      }
      if (!tc.question || tc.question.trim() === '') {
        malformedCount++;
        continue;
      }
      if (seenIds.has(tc.testId)) {
        logger.warn(`[DatasetManager] พบ duplicate Test ID: ${tc.testId} (จะใช้ข้อแรกที่พบ)`);
        continue;
      }
      seenIds.add(tc.testId);
      valid.push(tc);
    }

    if (malformedCount > 0) {
      logger.warn(`[DatasetManager] พบข้อมูลไม่สมบูรณ์ (ไม่มี ID หรือคำถาม) จำนวน ${malformedCount} ข้อ (ถูกข้าม)`);
    }

    return valid;
  }

  filterDataset(dataset, runConfig) {
    if (!runConfig) return dataset.testCases;

    const maxQuestionsPerTopic = config.limits?.maxQuestionsPerTopic ?? 100;
    let selectedCases = [...dataset.testCases];

    if (maxQuestionsPerTopic > 0) {
      const perTopicCounts = new Map();
      selectedCases = selectedCases.filter(tc => {
        const topicKey = this._getTopicKey(tc);

        const used = perTopicCounts.get(topicKey) ?? 0;
        if (used >= maxQuestionsPerTopic) return false;
        perTopicCounts.set(topicKey, used + 1);
        return true;
      });

      logger.info(`[DatasetManager] จำกัดแต่ละ topic ไม่เกิน ${maxQuestionsPerTopic} ข้อ`);
    }

    // 1. Tag filtering / priority (if implemented in future)
    
    // 2. Add original 1-based index to trace parity
    selectedCases = selectedCases.map((tc, idx) => ({ ...tc, originalIndex: idx + 1 }));

    // 3. Apply range
    const from = Math.max(1, runConfig.from || 1);
    const to = runConfig.to === 0 ? selectedCases.length : Math.min(selectedCases.length, runConfig.to);
    selectedCases = selectedCases.slice(from - 1, to);

    // 4. Apply parity
    if (runConfig.parity === 'even') {
      selectedCases = selectedCases.filter(tc => tc.originalIndex % 2 === 0);
    } else if (runConfig.parity === 'odd') {
      selectedCases = selectedCases.filter(tc => tc.originalIndex % 2 !== 0);
    }

    // 5. Apply direction
    const N = selectedCases.length;
    const midIndex = Math.ceil(N / 2);

    if (runConfig.direction === 'bottom_to_top') {
      selectedCases.reverse();
    } else if (runConfig.direction === 'top_to_mid') {
      selectedCases = selectedCases.slice(0, midIndex);
    } else if (runConfig.direction === 'bottom_to_mid') {
      selectedCases = selectedCases.slice(midIndex).reverse();
    } else if (runConfig.direction === 'mid_to_top') {
      selectedCases = selectedCases.slice(0, midIndex).reverse();
    } else if (runConfig.direction === 'mid_to_bottom') {
      selectedCases = selectedCases.slice(midIndex);
    }

    logger.info(`[DatasetManager] กรองข้อมูลด้วย Range ${from}-${to === dataset.testCases.length ? '(ทั้งหมด)' : to}, Parity: ${runConfig.parity}, Direction: ${runConfig.direction}`);
    logger.info(`[DatasetManager] จำนวนที่รันได้: ${selectedCases.length} จาก ${dataset.testCases.length}`);

    return selectedCases.map(({ originalIndex, ...tc }) => tc);
  }

  _getTopicKey(tc) {
    const topic = (tc.topic ?? tc.sheetName ?? '').toString().trim();
    if (topic) return topic;

    if (Number.isInteger(tc.docLocation?.tableOrdinal)) {
      return `DOC_TABLE_${tc.docLocation.tableOrdinal + 1}`;
    }

    return 'DEFAULT_TOPIC';
  }

  splitDataset(testCases, totalInstances, instanceId) {
    if (totalInstances <= 1) return testCases;
    
    const count = testCases.length;
    const chunkSize = Math.ceil(count / totalInstances);
    const startIndex = (instanceId - 1) * chunkSize;
    const endIndex = Math.min(startIndex + chunkSize, count);
    
    logger.info(`[DatasetManager] Split dataset: Instance ${instanceId}/${totalInstances} (Rows ${startIndex + 1} - ${endIndex})`);
    
    return testCases.slice(startIndex, endIndex);
  }

  computeDatasetHash(testCases) {
    // Generate an MD5 hash of critical fields to detect changes
    const dataString = testCases.map(tc => `${tc.testId}|${tc.question}|${tc.expected}`).join('||');
    return crypto.createHash('md5').update(dataString).digest('hex');
  }
}
