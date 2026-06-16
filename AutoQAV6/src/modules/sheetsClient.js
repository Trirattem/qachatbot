/**
 * src/modules/sheetsClient.js  (v3 — updated)
 * ─────────────────────────────────────────────────────────────
 * Google Sheets API wrapper
 *
 * การเปลี่ยนแปลงจากเวอร์ชั่นเดิม:
 *  - getTestCases() อ่าน column A (question) และ B (expected) โดยตรง
 *    ไม่ต้องมี testId column แยกต่างหาก
 *    testId จะ auto-generate เป็น TC_2, TC_3, ... ตาม row number
 *  - writeResult() เขียนลง column D(actual), E(status), F(timestamp), G(screenshot)
 *  - screenshotPath column รองรับค่าว่างได้ไม่ error
 */

import { google } from 'googleapis';
import path from 'path';
import logger from '../utils/logger.js';
import config from '../config/index.js';

// ── Colour map (Google Sheets uses 0–1 float for RGB) ─────────
const STATUS_COLORS = {
  PASS:    { red: 0.204, green: 0.659, blue: 0.325 },  // #34A853 green
  PARTIAL: { red: 1.0,   green: 0.843, blue: 0.0   },  // #FFD700 yellow
  FAIL:    { red: 0.918, green: 0.263, blue: 0.208 },  // #EA4335 red
};

// ── Column letter → 0-based index helper ─────────────────────
function colToIndex(letter) {
  if (!letter) return -1;
  return letter.toUpperCase().charCodeAt(0) - 65; // 'A'=0, 'B'=1 …
}

// ── Build an A1 range string ──────────────────────────────────
function a1Range(sheetName, startCol, startRow, endCol, endRow) {
  return `${sheetName}!${startCol}${startRow}:${endCol}${endRow}`;
}

class SheetsClient {
  constructor() {
    this.sheets   = null;
    this.sourceSheetId  = null; // numeric gid for source
    this.targetSheetId  = null; // numeric gid for target
    this.auth     = null;
  }

  // ── Authenticate & initialise ──────────────────────────────
  async init() {
    logger.info('Authenticating with Google Sheets API…');
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.keyFilePath,
      scopes:  ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.auth   = await auth.getClient();
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
    
    if (config.google.spreadsheetId) {
      this.sourceSheetId = await this._resolveSheetId(config.google.spreadsheetId, config.google.sheetName);
    }
    if (config.google.targetSpreadsheetId) {
      if (config.google.targetSpreadsheetId === config.google.spreadsheetId && config.google.targetSheetName === config.google.sheetName) {
        this.targetSheetId = this.sourceSheetId;
      } else {
        this.targetSheetId = await this._resolveSheetId(config.google.targetSpreadsheetId, config.google.targetSheetName);
      }
    }
    
    logger.info('Google Sheets API ready', { sourceSheetId: this.sourceSheetId, targetSheetId: this.targetSheetId });
  }

  // ── Resolve numeric sheetId ────────────────────────────────
  async _resolveSheetId(spreadsheetId, sheetName) {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId,
    });
    const tab = meta.data.sheets.find(
      s => s.properties.title === sheetName
    );
    if (!tab) {
      throw new Error(
        `Sheet tab "${sheetName}" not found in spreadsheet ${spreadsheetId}. ` +
        `Available: ${meta.data.sheets.map(s => s.properties.title).join(', ')}`
      );
    }
    return tab.properties.sheetId;
  }

  // ── Read all test cases from sheet ────────────────────────
  /**
   * อ่านจาก sheet ตาม config columns
   * column ที่ใช้: question (A), expected (B)
   * testId จะ auto-generate เป็น TC_{rowNumber}
   *
   * @param {boolean} useTargetSheet - ถ้า true จะอ่านจาก TARGET_GOOGLE_SPREADSHEET_ID แทน
   * Returns: [{ rowIndex, testId, question, expected }]
   */
  async getTestCases(useTargetSheet = false) {
    const cols   = config.google.columns;
    const startRow = config.google.dataStartRow;
    
    const sid = useTargetSheet && config.google.targetSpreadsheetId ? config.google.targetSpreadsheetId : config.google.spreadsheetId;
    const sname = useTargetSheet && config.google.targetSheetName ? config.google.targetSheetName : config.google.sheetName;

    // หา column ซ้ายสุดและขวาสุดที่ต้องอ่าน
    const readCols  = [cols.testId, cols.question, cols.expected].filter(Boolean);
    const sortedCols = readCols
      .map(c => c.toUpperCase())
      .sort();
    const startCol = sortedCols[0] || 'A';
    const endCol   = sortedCols[sortedCols.length - 1] || 'C';

    const range = a1Range(sname, startCol, startRow, endCol, 10000);

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: sid,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = response.data.values ?? [];

    // offset ของแต่ละ column เทียบกับ startCol
    const baseIdx    = colToIndex(startCol);
    const testIdIdx  = cols.testId ? colToIndex(cols.testId) - baseIdx : -1;
    const questionIdx = colToIndex(cols.question) - baseIdx;
    const expectedIdx = colToIndex(cols.expected) - baseIdx;

    const testCases = rows
      .map((row, idx) => {
        const questionVal = row[questionIdx]?.trim() ?? '';
        const expectedVal = row[expectedIdx]?.trim() ?? '';
        const sheetTestId = testIdIdx >= 0 ? (row[testIdIdx]?.trim() ?? '') : '';

        if (!questionVal) return null; // ข้ามแถวว่าง

        const rowNumber = startRow + idx;
        const testId = sheetTestId || `TC_${rowNumber}`;
        
        return {
          rowIndex:  rowNumber,
          testId:    testId,
          question:  questionVal,
          expected:  expectedVal,
          topic:     sname,
        };
      })
      .filter(Boolean);

    logger.info(`Loaded ${testCases.length} test cases from Google Sheets`);
    return testCases;
  }

  // ── Write a single test result back to the sheet ───────────
  /**
   * @param {number} rowIndex    - 1-based sheet row
   * @param {object} result      - { actual, status, timestamp, screenshotPath }
   */
  async writeResult(rowIndex, result) {
    const cols      = config.google.columns;
    const startCol  = cols.actual;      // D
    const endCol    = cols.screenshot ?? cols.screenshotPath ?? 'G';

    const values = [[
      result.actual         ?? '',
      result.status         ?? '',
      result.timestamp      ?? '',
      result.screenshotPath ?? '',
    ]];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId:   config.google.spreadsheetId,
      range:           a1Range(config.google.sheetName, startCol, rowIndex, endCol, rowIndex),
      valueInputOption: 'USER_ENTERED',
      requestBody:     { values },
    });

    // Apply background colour to Status cell
    await this._colorStatusCell(rowIndex, result.status);

    logger.debug(`Wrote result to row ${rowIndex}`, { status: result.status });
  }

  // ── Batch write หลาย rows พร้อมกัน (เร็วกว่า loop writeResult) ──
  /**
   * @param {Array<{ rowIndex, result }>} items
   */
  async batchWriteResults(items) {
    if (items.length === 0) return;

    const cols     = config.google.columns;
    const startCol = cols.actual;
    const endCol   = cols.screenshot ?? cols.screenshotPath ?? 'G';

    // สร้าง valueRanges สำหรับแต่ละ row
    const data = items.map(({ rowIndex, result }) => ({
      range:  a1Range(config.google.sheetName, startCol, rowIndex, endCol, rowIndex),
      values: [[
        result.actual         ?? '',
        result.status         ?? '',
        result.timestamp      ?? '',
        result.screenshotPath ?? '',
      ]],
    }));

    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.google.spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data,
      },
    });

    // Color requests สำหรับทุก status cell พร้อมกัน
    const colorRequests = items
      .map(({ rowIndex, result }) => this._buildColorRequest(rowIndex, result.status))
      .filter(Boolean);

    if (colorRequests.length > 0) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.google.spreadsheetId,
        requestBody:   { requests: colorRequests },
      });
    }

    logger.debug(`Batch wrote ${items.length} results to Sheets`);
  }

  // ── Append new rows (สร้างแถวใหม่ถ้าหาไม่เจอ) ────────────────
  /**
   * @param {Array<object>} entries - { testId, question, expected, actual, status, timestamp, screenshotPath }
   */
  async appendResults(entries) {
    if (entries.length === 0) return;

    const cols = config.google.columns;
    const colKeys = ['testId', 'question', 'expected', 'actual', 'status', 'timestamp', 'screenshot'];
    let maxIdx = -1;
    for (const key of colKeys) {
        if (cols[key]) maxIdx = Math.max(maxIdx, colToIndex(cols[key]));
    }
    
    // สร้าง array 2 มิติสำหรับ append
    const values = entries.map(entry => {
        const row = new Array(maxIdx + 1).fill('');
        if (cols.testId) row[colToIndex(cols.testId)] = entry.testId ?? '';
        if (cols.question) row[colToIndex(cols.question)] = entry.question ?? '';
        if (cols.expected) row[colToIndex(cols.expected)] = entry.expected ?? '';
        if (cols.actual) row[colToIndex(cols.actual)] = entry.actual ?? '';
        if (cols.status) row[colToIndex(cols.status)] = entry.status ?? '';
        if (cols.timestamp) row[colToIndex(cols.timestamp)] = entry.timestamp ?? '';
        const screenshotCol = cols.screenshot ?? cols.screenshotPath;
        if (screenshotCol) row[colToIndex(screenshotCol)] = entry.screenshotPath ?? '';
        return row;
    });

    const res = await this.sheets.spreadsheets.values.append({
        spreadsheetId: config.google.targetSpreadsheetId,
        range: `${config.google.targetSheetName}!A2:G`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
    });

    // ล้างฟอร์แมตสีที่ติดมาจาก Header และระบายสี Status
    const appendedRange = res.data?.updates?.updatedRange;
    if (appendedRange) {
        const m = appendedRange.match(/!?[a-zA-Z]+(\d+):[a-zA-Z]+(\d+)/);
        if (m) {
            const startRow = parseInt(m[1], 10);
            const endRow = parseInt(m[2], 10);
            const batchRequests = [];

            // 1. Reset cell formatting (พื้นหลังขาว ตัวอักษรดำ ไม่หนา) สำหรับแถวใหม่ทั้งหมด
            batchRequests.push({
                repeatCell: {
                    range: {
                        sheetId: this.targetSheetId,
                        startRowIndex: startRow - 1, // 0-based
                        endRowIndex: endRow,
                        startColumnIndex: 0,
                        endColumnIndex: maxIdx + 1,
                    },
                    cell: {
                        userEnteredFormat: {
                            backgroundColor: { red: 1, green: 1, blue: 1 },
                            textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: false },
                        }
                    },
                    fields: "userEnteredFormat(backgroundColor,textFormat)",
                }
            });

            // 2. ระบายสี Status
            for (let i = 0; i < entries.length; i++) {
                const rowIndex = startRow + i;
                const req = this._buildColorRequest(rowIndex, entries[i].status);
                if (req) batchRequests.push(req);
            }

            if (batchRequests.length > 0) {
               await this.sheets.spreadsheets.batchUpdate({
                 spreadsheetId: config.google.targetSpreadsheetId,
                 requestBody: { requests: batchRequests },
               });
            }
        }
    }
    
    logger.info(`Appended ${entries.length} rows to Google Sheets`);
  }

  // ── Apply background colour to Status cell ─────────────────
  async _colorStatusCell(rowIndex, status) {
    const req = this._buildColorRequest(rowIndex, status);
    if (!req) return;
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.google.targetSpreadsheetId,
      requestBody:   { requests: [req] },
    });
  }

  _buildColorRequest(rowIndex, status) {
    const color = STATUS_COLORS[status];
    if (!color) return null;

    const statusColIndex = colToIndex(config.google.columns.status);
    if (statusColIndex < 0) return null;

    return {
      repeatCell: {
        range: {
          sheetId:          this.targetSheetId,
          startRowIndex:    rowIndex - 1, // 0-based
          endRowIndex:      rowIndex,
          startColumnIndex: statusColIndex,
          endColumnIndex:   statusColIndex + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: color,
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    };
  }

  // ── Write column headers (idempotent) ──────────────────────
  async ensureHeaders() {
    const cols      = config.google.columns;
    const headerRow = 1;
    const startCol  = cols.question ?? 'A';
    const endCol    = cols.screenshot ?? 'G';

    const values = [['Question', 'Expected Answer',
                     '', // column C ว่าง (ถ้า layout เป็น A,B,_,D,E,F,G)
                     'Actual Result', 'Status', 'Timestamp', 'Screenshot Path']];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId:    config.google.spreadsheetId,
      range:            a1Range(config.google.sheetName, startCol, headerRow, endCol, headerRow),
      valueInputOption: 'USER_ENTERED',
      requestBody:      { values },
    });

    logger.debug('Header row verified/written');
  }

  // ── Bulletproof Image Sync Logic ─────────────────────────────────
  async syncImagesToSheets(urlMap) {
    const testCasesToSync = Object.keys(urlMap);
    if (testCasesToSync.length === 0) return;

    logger.info(`📝 กำลัง sync รูปลง Sheets... (รอสักครู่)`);

    // Fetch all test cases to find their rows
    const testCases = await this.getTestCases();
    let insertedCount = 0;
    
    const items = [];

    for (const tc of testCases) {
      const imgs = urlMap[tc.testId];
      if (!imgs || imgs.length === 0) continue;

      // Sheets uses =IMAGE("url") to display inline images.
      // We will put the first image in the actual result column if it's empty, 
      // or append it if we just want to replace screenshot column.
      // But we'll just write it to the screenshot column.
      const imgUrl = imgs[0].url; // Take the first image
      
      const cols = config.google.columns;
      const screenshotCol = cols.screenshot ?? cols.screenshotPath ?? 'G';
      
      items.push({
        range: a1Range(config.google.sheetName, screenshotCol, tc.rowIndex, screenshotCol, tc.rowIndex),
        values: [[`=IMAGE("${imgUrl}", 1)`]] // 1 = scale to fit
      });
      insertedCount++;
    }

    if (items.length > 0) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: config.google.spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: items,
        },
      });
    }

    logger.info(`🎉 สรุปการ Sync รูปไปยัง Sheets: สำเร็จ ${insertedCount} แถว (ใช้สูตร =IMAGE)`);
  }
}

export default SheetsClient;