/**
 * src/modules/docsClient.js  (updated)
 * ─────────────────────────────────────────────────────────────
 * เพิ่ม:
 *  1. hasResult(testCase)  — ตรวจว่า Status/Actual/Remark มีข้อมูลแล้วหรือยัง
 *  2. _cachedDoc           — cache document หลัง getTestCases() เพื่อลด API call
 *     writeResult ใช้ cache นี้ก่อน reload เฉพาะตอนจำเป็น
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { STATUS } from './classifier.js';
import { googleApiLimiter } from '../utils/apiRateLimiter.js';

const STATUS_STYLES = {
  [STATUS.PASS]: {
    background: { red: 0.204, green: 0.659, blue: 0.325 },
    foreground: { red: 0, green: 0, blue: 0 },
  },
  [STATUS.PARTIAL]: {
    background: { red: 1, green: 0.843, blue: 0 },
    foreground: { red: 0, green: 0, blue: 0 },
  },
  [STATUS.FAIL]: {
    background: { red: 0.918, green: 0.263, blue: 0.208 },
    foreground: { red: 1, green: 1, blue: 1 },
  },
};

const HEADER_ALIASES = {
  testId: ['testcaseid', 'testid', 'tcid'],
  testSteps: ['teststeps', 'question', 'questions'],
  expected: ['expectedresult', 'expectedanswer', 'expected'],
  actual: ['actualresult', 'actual', 'screenshot'],
  status: ['status'],
  remark: ['remark', 'remarks'],
};

class DocsClient {
  constructor() {
    this.docs = null;
    this.drive = null;
    this.auth = null;
    this._cachedDoc = null; // cache ไว้ลด API call
  }

  async init() {
    logger.info('Authenticating with Google Docs API...');
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.keyFilePath,
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive.file',
      ],
    });

    this.auth = await auth.getClient();
    this.docs = google.docs({ version: 'v1', auth: this.auth });
    this.drive = google.drive({ version: 'v3', auth: this.auth });
    logger.info('Google Docs API ready', {
      documentId: config.google.documentId,
    });
  }

  async getTestCases() {
    const document = await this._loadDocument();
    // cache document ไว้ใช้ใน writeResult ครั้งแรก
    this._cachedDoc = document;

    const tables = this._findTables(document);
    const testCases = [];

    logger.info(`Found ${tables.length} table(s) in Google Docs document`);

    for (const tableInfo of tables) {
      const rows = tableInfo.table.tableRows ?? [];
      if (rows.length < 2) continue;

      const headerMap = this._mapHeaders(rows[0]);
      if (!this._hasRequiredColumns(headerMap)) {
        logger.debug(`Skipping table ${tableInfo.ordinal + 1}: required headers not found`);
        continue;
      }

      for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const testId = this._cellText(row, headerMap.testId)
          || `DOC_T${tableInfo.ordinal + 1}_R${rowIndex + 1}`;
        const rawTestSteps = this._cellText(row, headerMap.testSteps);
        const rawExpected = this._cellText(row, headerMap.expected);
        const question = extractTestStepsQuestion(rawTestSteps);
        const expected = extractExpectedResult(rawExpected);

        if (!rawTestSteps && !rawExpected) continue;

        if (!question) {
          logger.warn(`Skipping ${testId}: no question found after "-" in Test Steps`);
          continue;
        }

        // ── ดึงข้อมูล existing result จาก doc (เพื่อ skip ถ้ามีแล้ว) ──
        const existingActual = this._cellText(row, headerMap.actual);
        const existingStatus = this._cellText(row, headerMap.status);
        const existingRemark = this._cellText(row, headerMap.remark);

        testCases.push({
          rowIndex,
          testId,
          question,
          expected,
          rawTestSteps,
          rawExpected,
          // บอกว่า row นี้มีผลแล้วหรือยัง
          hasExistingResult: Boolean(existingStatus || existingActual || existingRemark),
          existingStatus,
          docLocation: {
            tableOrdinal: tableInfo.ordinal,
            rowIndex,
            columns: {
              actual: headerMap.actual,
              status: headerMap.status,
              remark: headerMap.remark,
            },
          },
        });
      }
    }

    logger.info(`Loaded ${testCases.length} test cases from Google Docs`);
    return testCases;
  }

  /**
   * ตรวจว่า row นี้มีผลลัพธ์อยู่แล้วหรือเปล่า
   * ใช้ข้อมูลที่โหลดตอน getTestCases() ไม่ต้องยิง API ใหม่
   */
  hasResult(testCase) {
    return testCase.hasExistingResult === true;
  }

  async writeResult(testCase, result) {
    // ใช้ fresh document เสมอเพื่อให้ index ถูกต้อง
    // (Docs index เปลี่ยนทุกครั้งที่แก้ไข)
    const location = await this._resolveCurrentLocation(testCase);
    const statusText = result.status ?? '';
    const remarkText = result.actual ?? '';

    const screenshotUri = null;

    const cellUpdates = [
      this._createCellTextUpdate(location.remarkCell, remarkText),
      screenshotUri
        ? this._createCellImageUpdate(location.actualCell, screenshotUri)
        : this._createCellTextUpdate(location.actualCell, ''),
      this._createCellTextUpdate(location.statusCell, statusText, {
        textStyle: this._statusTextStyle(statusText),
        tableCellStyle: this._statusTableCellStyle(location, statusText),
      }),
    ]
      .filter(Boolean)
      .sort((a, b) => b.insertIndex - a.insertIndex);

    const requests = cellUpdates.flatMap(update => update.requests);
    if (requests.length === 0) return;

    await googleApiLimiter.execute(() => this.docs.documents.batchUpdate({
      documentId: config.google.documentId,
      requestBody: { requests },
    }));

    logger.debug(`Wrote result to Docs row ${testCase.rowIndex + 1}`, {
      testId: testCase.testId,
      status: result.status,
    });
  }

  async batchWriteResults(testCasesWithResults) {
    if (testCasesWithResults.length === 0) return;

    // Load document once for building the base indexes
    const document = await this._loadDocument();
    const tables = this._findTables(document);

    const allCellUpdates = [];

    for (const { tc, result } of testCasesWithResults) {
      if (!tc.docLocation) continue;
      
      const tableInfo = tables[tc.docLocation.tableOrdinal];
      if (!tableInfo) continue;
      
      const row = tableInfo.table.tableRows?.[tc.docLocation.rowIndex];
      if (!row) continue;

      const { actual, status, remark } = tc.docLocation.columns;
      const actualCell = row.tableCells?.[actual];
      const statusCell = row.tableCells?.[status];
      const remarkCell = row.tableCells?.[remark];

      if (!actualCell || !statusCell || !remarkCell) continue;

      const location = {
        tableStartIndex: tableInfo.startIndex,
        rowIndex: tc.docLocation.rowIndex,
        statusColumnIndex: status,
      };

      const statusText = result.status ?? '';
      const remarkText = result.actual ?? '';
      const screenshotUri = result.driveImageUrl ?? null; // from Drive if available

      const updates = [
        this._createCellTextUpdate(remarkCell, remarkText),
        screenshotUri
          ? this._createCellImageUpdate(actualCell, screenshotUri)
          : this._createCellTextUpdate(actualCell, ''),
        this._createCellTextUpdate(statusCell, statusText, {
          textStyle: this._statusTextStyle(statusText),
          tableCellStyle: this._statusTableCellStyle(location, statusText),
        }),
      ].filter(Boolean);

      allCellUpdates.push(...updates);
    }

    // Sort descending by insertIndex to avoid index shifting problems
    allCellUpdates.sort((a, b) => b.insertIndex - a.insertIndex);
    const requests = allCellUpdates.flatMap(update => update.requests);

    if (requests.length === 0) return;

    // Send in chunks to avoid large payload limits
    const chunkSize = 500;
    for (let i = 0; i < requests.length; i += chunkSize) {
      const chunk = requests.slice(i, i + chunkSize);
      await googleApiLimiter.execute(() => this.docs.documents.batchUpdate({
        documentId: config.google.documentId,
        requestBody: { requests: chunk },
      }));
    }

    logger.debug(`Batch wrote ${testCasesWithResults.length} results to Docs`);
  }

  // ── Bulletproof Image Sync Logic ─────────────────────────────────
  async syncImagesToDocs(urlMap) {
    let document = await this._loadDocument();
    
    // Using a while loop to refresh doc after each insert to avoid shifting indexes
    let tableOrdinal = -1;
    let rowIndex = -1;
    
    let insertedCount = 0;
    let notFoundCount = 0;
    let blockedCount = 0;

    const testCasesToSync = Object.keys(urlMap);
    if (testCasesToSync.length === 0) return;

    logger.info(`📝 กำลัง sync รูปลง Docs... (รอสักครู่)`);

    // First scan to build a map of where each testcase is
    const initialTables = this._findTables(document);
    const tcLocations = [];
    
    for (const tableInfo of initialTables) {
      const rows = tableInfo.table.tableRows ?? [];
      if (rows.length < 2) continue;
      
      const headerMap = this._mapHeaders(rows[0]);
      if (!this._hasRequiredColumns(headerMap)) continue;
      
      for (let rIdx = 1; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        const testId = this._cellText(row, headerMap.testId) || `DOC_T${tableInfo.ordinal + 1}_R${rIdx + 1}`;
        if (urlMap[testId] && urlMap[testId].length > 0) {
           tcLocations.push({ testId, tableOrdinal: tableInfo.ordinal, rowIndex: rIdx, columns: headerMap });
        }
      }
    }

    logger.info(`พบ Test Cases ใน Docs ที่จะใส่รูปได้: ${tcLocations.length} ข้อ`);

    for (const loc of tcLocations) {
      // Reload document fresh for exact indexes
      document = await this._loadDocument();
      const tables = this._findTables(document);
      const tableInfo = tables[loc.tableOrdinal];
      if (!tableInfo) continue;
      
      const row = tableInfo.table.tableRows?.[loc.rowIndex];
      if (!row) continue;
      
      const tcCell = row.tableCells?.[loc.columns.testId];
      const arCell = row.tableCells?.[loc.columns.actual];
      const erCell = row.tableCells?.[loc.columns.expected];
      const stCell = row.tableCells?.[loc.columns.status];

      if (!arCell) continue;

      const imgs = urlMap[loc.testId];
      if (!imgs || imgs.length === 0) continue;

      // Check if already has an image
      if (this._cellHasImage(arCell)) {
        logger.info(`  [${loc.testId}] ⏭️ มีรูปอยู่แล้ว — ข้าม`);
        continue;
      }

      for (const imgInfo of imgs) {
        const insertIdx = this._getSafeInsertIndex(arCell, erCell, stCell);
        if (insertIdx === null) {
          logger.warn(`  [${loc.testId}] 🚫 ไม่พบตำแหน่ง index ที่ปลอดภัยในช่อง Actual Result`);
          blockedCount++;
          continue;
        }

        try {
          await googleApiLimiter.execute(() => this.docs.documents.batchUpdate({
            documentId: config.google.documentId,
            requestBody: { requests: [{
              insertInlineImage: {
                location: { index: insertIdx },
                uri: imgInfo.url,
                objectSize: { width: { magnitude: config.google.screenshotImageWidthPt || 280, unit: 'PT' } },
              }
            }]}
          }));
          logger.info(`  [${loc.testId}] ✅ แทรกรูปสำเร็จ`);
          insertedCount++;
          
          // Re-fetch document for the next image in the SAME cell (if any)
          document = await this._loadDocument();
          // We break here if there are multiple images for one test case because re-resolving 
          // the exact cell mid-loop is complex. Usually it's 1 image per test case anyway.
          break; 
        } catch (err) {
          logger.error(`  [${loc.testId}] ❌ ผิดพลาด: ${err.message}`);
        }
      }
    }

    logger.info(`🎉 สรุปการ Sync รูปไปยัง Docs: สำเร็จ ${insertedCount}, ข้าม/ไม่มีรูป ${notFoundCount}, บล็อก ${blockedCount}`);
  }

  _cellHasImage(cell) {
    for (const content of cell.content ?? []) {
      for (const elem of content.paragraph?.elements ?? []) {
        if (elem.inlineObjectElement) return true;
      }
    }
    return false;
  }

  _getSafeInsertIndex(arCell, erCell, stCell) {
    const arStart = arCell.startIndex ?? 0;
    const arEnd = arCell.endIndex ?? 0;
    const erEnd = erCell?.endIndex ?? -1;
    const stStart = stCell?.startIndex ?? Number.MAX_SAFE_INTEGER;

    const candidates = [];
    for (const content of arCell.content ?? []) {
      for (const elem of content.paragraph?.elements ?? []) {
        if (elem.startIndex !== undefined) {
          candidates.push(elem.startIndex);
        }
      }
    }

    if (candidates.length === 0) candidates.push(arEnd - 1);
    candidates.sort((a, b) => a - b);

    for (const idx of candidates) {
      if (idx >= arStart && idx < arEnd && idx > erEnd && idx < stStart) {
        return idx;
      }
    }
    return null;
  }

  async _loadDocument() {
    const response = await googleApiLimiter.execute(() => this.docs.documents.get({
      documentId: config.google.documentId,
    }));
    return response.data;
  }

  _findTables(document) {
    const content = document.body?.content ?? [];
    const tables = [];

    for (const element of content) {
      if (!element.table) continue;
      tables.push({
        ordinal: tables.length,
        startIndex: element.startIndex ?? element.table.startIndex,
        endIndex: element.endIndex ?? element.table.endIndex,
        table: element.table,
      });
    }

    return tables;
  }

  _mapHeaders(headerRow) {
    const headers = headerRow.tableCells?.map(cell => normalizeHeader(extractCellText(cell))) ?? [];
    const configured = config.google.docColumns;

    return {
      testId: findHeader(headers, configured.testId, HEADER_ALIASES.testId),
      testSteps: findHeader(headers, configured.testSteps, HEADER_ALIASES.testSteps),
      expected: findHeader(headers, configured.expected, HEADER_ALIASES.expected),
      actual: findHeader(headers, configured.actual, HEADER_ALIASES.actual),
      status: findHeader(headers, configured.status, HEADER_ALIASES.status),
      remark: findHeader(headers, configured.remark, HEADER_ALIASES.remark),
    };
  }

  _hasRequiredColumns(headerMap) {
    return [
      headerMap.testSteps,
      headerMap.expected,
      headerMap.actual,
      headerMap.status,
      headerMap.remark,
    ].every(index => Number.isInteger(index));
  }

  _cellText(row, columnIndex) {
    if (!Number.isInteger(columnIndex)) return '';
    const cell = row.tableCells?.[columnIndex];
    return cell ? extractCellText(cell) : '';
  }

  async _resolveCurrentLocation(testCase) {
    // โหลด fresh เสมอ เพราะ index เปลี่ยนหลังแต่ละ write
    const document = await this._loadDocument();
    const tables = this._findTables(document);
    const tableInfo = tables[testCase.docLocation.tableOrdinal];

    if (!tableInfo) {
      throw new Error(`Table ${testCase.docLocation.tableOrdinal + 1} no longer exists`);
    }
    if (!Number.isInteger(tableInfo.startIndex)) {
      throw new Error(`Table ${testCase.docLocation.tableOrdinal + 1} has no start index`);
    }

    const row = tableInfo.table.tableRows?.[testCase.docLocation.rowIndex];
    if (!row) {
      throw new Error(`Row ${testCase.docLocation.rowIndex + 1} no longer exists`);
    }

    const { actual, status, remark } = testCase.docLocation.columns;
    const actualCell = row.tableCells?.[actual];
    const statusCell = row.tableCells?.[status];
    const remarkCell = row.tableCells?.[remark];

    if (!actualCell || !statusCell || !remarkCell) {
      throw new Error(`Actual Result, Status, or Remark cell missing for ${testCase.testId}`);
    }

    return {
      tableStartIndex: tableInfo.startIndex,
      rowIndex: testCase.docLocation.rowIndex,
      actualColumnIndex: actual,
      statusColumnIndex: status,
      remarkColumnIndex: remark,
      actualCell,
      statusCell,
      remarkCell,
    };
  }

  _createCellTextUpdate(cell, text, options = {}) {
    const range = cellWritableRange(cell);
    if (!range) return null;

    const requests = [];
    if (range.endIndex > range.startIndex) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex },
        },
      });
    }

    const safeText = String(text ?? '');
    if (safeText.length > 0) {
      requests.push({
        insertText: {
          location: { index: range.startIndex },
          text: safeText,
        },
      });
    }

    if (options.textStyle && safeText.length > 0) {
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: range.startIndex,
            endIndex: range.startIndex + safeText.length,
          },
          textStyle: options.textStyle,
          fields: 'bold,foregroundColor',
        },
      });
    }

    if (options.tableCellStyle) {
      requests.push(options.tableCellStyle);
    }

    return { insertIndex: range.startIndex, requests };
  }

  _createCellImageUpdate(cell, uri) {
    const range = cellWritableRange(cell);
    if (!range) return null;

    const requests = [];
    if (range.endIndex > range.startIndex) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex },
        },
      });
    }

    requests.push({
      insertInlineImage: {
        location: { index: range.startIndex },
        uri,
        objectSize: {
          width: {
            magnitude: config.google.screenshotImageWidthPt,
            unit: 'PT',
          },
        },
      },
    });

    return { insertIndex: range.startIndex, requests };
  }

  _statusTextStyle(status) {
    const style = STATUS_STYLES[status] ?? STATUS_STYLES[STATUS.PASS];
    return {
      bold: true,
      foregroundColor: { color: { rgbColor: style.foreground } },
    };
  }

  _statusTableCellStyle(location, status) {
    const style = STATUS_STYLES[status];
    if (!style) return null;

    return {
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { index: location.tableStartIndex },
            rowIndex: location.rowIndex,
            columnIndex: location.statusColumnIndex,
          },
          rowSpan: 1,
          columnSpan: 1,
        },
        tableCellStyle: {
          backgroundColor: { color: { rgbColor: style.background } },
        },
        fields: 'backgroundColor',
      },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────

function extractCellText(cell) {
  return extractText(cell.content ?? [])
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function extractText(elements) {
  let text = '';
  for (const element of elements) {
    if (element.paragraph) {
      for (const part of element.paragraph.elements ?? []) {
        text += part.textRun?.content ?? '';
      }
    }
  }
  return text;
}

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function findHeader(headers, configuredName, aliases = []) {
  const targets = [configuredName, ...aliases].map(normalizeHeader).filter(Boolean);
  return headers.findIndex(header => targets.includes(header));
}

function extractTestStepsQuestion(value) {
  return extractDashBlock(value, {
    stopWhen: line => /^4\.\s*/.test(line.trim()),
  });
}

function extractExpectedResult(value) {
  return extractDashBlock(value);
}

function extractDashBlock(value, options = {}) {
  const lines = String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  let started = false;
  const collected = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      const match = trimmed.match(/^[-–—]\s*(.*)$/);
      if (!match) continue;
      started = true;
      if (match[1]) collected.push(match[1].trim());
      continue;
    }
    if (options.stopWhen?.(trimmed)) break;
    collected.push(trimmed);
  }

  return collapseText(collected.join('\n'));
}

function collapseText(value) {
  return String(value ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellWritableRange(cell) {
  const content = cell.content ?? [];
  const first = content.find(element => Number.isInteger(element.startIndex));
  const last = [...content].reverse().find(element => Number.isInteger(element.endIndex));
  if (!first || !last) return null;
  return {
    startIndex: first.startIndex,
    endIndex: Math.max(first.startIndex, last.endIndex - 1),
  };
}

export default DocsClient;