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
    this.sheetId  = null; // numeric gid
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
    this.sheetId = await this._resolveSheetId();
    logger.info('Google Sheets API ready', { sheetId: this.sheetId });
  }

  // ── Resolve numeric sheetId ────────────────────────────────
  async _resolveSheetId() {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: config.google.spreadsheetId,
    });
    const tab = meta.data.sheets.find(
      s => s.properties.title === config.google.sheetName
    );
    if (!tab) {
      throw new Error(
        `Sheet tab "${config.google.sheetName}" not found. ` +
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
   * Returns: [{ rowIndex, testId, question, expected }]
   */
  async getTestCases() {
    const cols   = config.google.columns;
    const startRow = config.google.dataStartRow;

    // หา column ซ้ายสุดและขวาสุดที่ต้องอ่าน
    const readCols  = [cols.question, cols.expected].filter(Boolean);
    const sortedCols = readCols
      .map(c => c.toUpperCase())
      .sort();
    const startCol = sortedCols[0] || 'A';
    const endCol   = sortedCols[sortedCols.length - 1] || 'C';

    const range = a1Range(config.google.sheetName, startCol, startRow, endCol, 10000);

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: config.google.spreadsheetId,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = response.data.values ?? [];

    // offset ของแต่ละ column เทียบกับ startCol
    const baseIdx    = colToIndex(startCol);
    const questionIdx = colToIndex(cols.question) - baseIdx;
    const expectedIdx = colToIndex(cols.expected) - baseIdx;

    const testCases = rows
      .map((row, idx) => {
        const questionVal = row[questionIdx]?.trim() ?? '';
        const expectedVal = row[expectedIdx]?.trim() ?? '';

        if (!questionVal) return null; // ข้ามแถวว่าง

        const rowNumber = startRow + idx;
        return {
          rowIndex:  rowNumber,
          testId:    `TC_${rowNumber}`,
          question:  questionVal,
          expected:  expectedVal,
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

    logger.info(`Batch wrote ${items.length} results to Google Sheets`);
  }

  // ── Apply background colour to Status cell ─────────────────
  async _colorStatusCell(rowIndex, status) {
    const req = this._buildColorRequest(rowIndex, status);
    if (!req) return;
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.google.spreadsheetId,
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
          sheetId:          this.sheetId,
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
}

export default SheetsClient;