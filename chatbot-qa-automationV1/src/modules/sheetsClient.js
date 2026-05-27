/**
 * src/modules/sheetsClient.js
 * ─────────────────────────────────────────────────────────────
 * Google Sheets API wrapper.
 *
 * Responsibilities:
 *  1. Authenticate with a Service Account key file
 *  2. Read all test cases from the configured sheet
 *  3. Write results (actual answer, status, timestamp, screenshot)
 *  4. Apply background colour to the Status cell (GREEN/YELLOW/RED)
 *
 * Required Google API scopes:
 *   https://www.googleapis.com/auth/spreadsheets
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
  return letter.toUpperCase().charCodeAt(0) - 65; // 'A'=0, 'B'=1 …
}

// ── Build an A1 range string, e.g. "TestCases!A2:G50" ─────────
function range(startRow, endRow, startCol = 'A', endCol = 'G') {
  return `${config.google.sheetName}!${startCol}${startRow}:${endCol}${endRow}`;
}

class SheetsClient {
  constructor() {
    this.sheets     = null; // googleapis Sheets instance
    this.sheetId    = null; // numeric gid of the target tab
    this.auth       = null;
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

    // Resolve the numeric sheetId for batchUpdate (colour) calls
    this.sheetId = await this._resolveSheetId();
    logger.info('Google Sheets API ready', { sheetId: this.sheetId });
  }

  // ── Resolve numeric sheetId for the configured tab name ────
  async _resolveSheetId() {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: config.google.spreadsheetId,
    });
    const tab = meta.data.sheets.find(
      s => s.properties.title === config.google.sheetName
    );
    if (!tab) {
      throw new Error(
        `Sheet tab "${config.google.sheetName}" not found in spreadsheet. ` +
        `Available tabs: ${meta.data.sheets.map(s => s.properties.title).join(', ')}`
      );
    }
    return tab.properties.sheetId;
  }

  // ── Read all test cases ────────────────────────────────────
  /**
   * Returns an array of test case objects:
   * { rowIndex, testId, question, expected }
   * rowIndex is the 1-based Google Sheets row number.
   */
  async getTestCases() {
    const { testId, question, expected } = config.google.columns;
    const startRow = config.google.dataStartRow;

    // Use a wide range to capture all rows; empty trailing rows are filtered
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: config.google.spreadsheetId,
      range: range(startRow, 10000, testId, expected),
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = response.data.values ?? [];

    // Map each row to a structured object
    const testCases = rows
      .map((row, idx) => {
        const testIdVal  = row[0]?.trim() ?? '';
        const questionVal = row[1]?.trim() ?? '';
        const expectedVal = row[2]?.trim() ?? '';

        // Skip completely empty rows
        if (!testIdVal && !questionVal) return null;

        return {
          rowIndex: startRow + idx,   // actual sheet row number
          testId:   testIdVal   || `TC_${startRow + idx}`,
          question: questionVal,
          expected: expectedVal,
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
    const { actual, status, timestamp, screenshotPath } = config.google.columns;
    const startCol = actual;
    const endCol   = screenshotPath;

    const values = [[
      result.actual       ?? '',
      result.status       ?? '',
      result.timestamp    ?? '',
      result.screenshotPath ?? '',
    ]];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: config.google.spreadsheetId,
      range: range(rowIndex, rowIndex, startCol, endCol),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    // Apply background colour to the Status cell
    await this._colorStatusCell(rowIndex, result.status);

    logger.debug(`Wrote result to row ${rowIndex}`, { status: result.status });
  }

  // ── Apply background colour to the Status cell ─────────────
  async _colorStatusCell(rowIndex, status) {
    const color = STATUS_COLORS[status];
    if (!color) return; // unknown status — skip colouring

    const statusColIndex = colToIndex(config.google.columns.status);

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.google.spreadsheetId,
      requestBody: {
        requests: [{
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
        }],
      },
    });
  }

  // ── Write column headers (idempotent) ──────────────────────
  async ensureHeaders() {
    const headerRow = 1;
    const { testId, question, expected, actual, status, timestamp, screenshot } =
      config.google.columns;

    const values = [['Test Case ID', 'Question', 'Expected Answer',
                     'Actual Result', 'Status', 'Timestamp', 'Screenshot Path']];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: config.google.spreadsheetId,
      range: range(headerRow, headerRow, testId, screenshot),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    logger.debug('Header row verified/written');
  }
}

export default SheetsClient;
