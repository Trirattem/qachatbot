/**
 * src/modules/sheetsClient.js  — v4 A/B Testing
 * ─────────────────────────────────────────────────────────────
 * Google Sheets API wrapper for dual-environment (Internal vs External) QA.
 *
 * Column layout (1-based, A=1):
 *   A  TestID
 *   B  Question 1     C  Ans_Internal 1   D  Ans_External 1   E  Result 1
 *   F  Question 2     G  Ans_Internal 2   H  Ans_External 2   I  Result 2
 *   J  Question 3     K  Ans_Internal 3   L  Ans_External 3   M  Result 3
 *
 * Key design decisions:
 *  - getTestCases() reads columns A, B, F, J only (questions + IDs).
 *  - batchWriteResults() sends ONE batchUpdate call with all ValueRanges
 *    so the sheet is only touched once at the very end of the run.
 *  - No colour / formatting calls (kept simple for this use-case).
 *  - No screenshot logic.
 */

import { google } from 'googleapis';
import logger from '../utils/logger.js';
import config from '../config/index.js';

// ── Column constants (0-based index in the row array) ─────────
const COL = {
  TEST_ID:       0,  // A
  QUESTION_1:    1,  // B
  ANS_INT_1:     2,  // C
  ANS_EXT_1:     3,  // D
  RESULT_1:      4,  // E
  QUESTION_2:    5,  // F
  ANS_INT_2:     6,  // G
  ANS_EXT_2:     7,  // H
  RESULT_2:      8,  // I
  QUESTION_3:    9,  // J
  ANS_INT_3:     10, // K
  ANS_EXT_3:     11, // L
  RESULT_3:      12, // M
};

// Column letter helpers
function indexToCol(idx) {
  // 0→A, 1→B … 12→M
  return String.fromCharCode(65 + idx);
}

function a1(row, colIndex) {
  return `${config.google.sheetName}!${indexToCol(colIndex)}${row}`;
}

class SheetsClient {
  constructor() {
    this.sheets  = null;
    this.auth    = null;
  }

  // ── Authenticate ──────────────────────────────────────────
  async init() {
    logger.info('Authenticating with Google Sheets API…');
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.keyFilePath,
      scopes:  ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.auth   = await auth.getClient();
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
    logger.info('Google Sheets API ready');
  }

  // ── Read test cases ────────────────────────────────────────
  /**
   * Returns an array of objects:
   * {
   *   rowIndex: number,       // 1-based sheet row
   *   testId:   string,
   *   questions: [q1, q2, q3] // up to 3; empty string if cell is blank
   * }
   */
  async getTestCases() {
    const startRow = config.google.dataStartRow ?? 2;

    // Read the full A:M range so we capture all relevant columns at once
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId:     config.google.spreadsheetId,
      range:             `${config.google.sheetName}!A${startRow}:M10000`,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = response.data.values ?? [];

    const testCases = rows
      .map((row, idx) => {
        const testId   = (row[COL.TEST_ID]    ?? '').toString().trim();
        const question1 = (row[COL.QUESTION_1] ?? '').toString().trim();
        const question2 = (row[COL.QUESTION_2] ?? '').toString().trim();
        const question3 = (row[COL.QUESTION_3] ?? '').toString().trim();

        // Skip blank rows
        if (!testId && !question1) return null;

        return {
          rowIndex:  startRow + idx,
          testId:    testId || `TC_${startRow + idx}`,
          questions: [question1, question2, question3],
        };
      })
      .filter(Boolean);

    logger.info(`Loaded ${testCases.length} test cases from Google Sheets`);
    return testCases;
  }

  // ── Batch-write all results in ONE API call ────────────────
  /**
   * @param {Array} allResults  - output of TestRunner, array of:
   * {
   *   rowIndex: number,
   *   steps: [
   *     { stepIndex: 1, ansInternal, ansExternal, resultMatch },
   *     { stepIndex: 2, ansInternal, ansExternal, resultMatch },
   *     { stepIndex: 3, ansInternal, ansExternal, resultMatch },
   *   ]
   * }
   */
  async batchWriteResults(allResults) {
    if (!allResults || allResults.length === 0) {
      logger.info('Nothing to write — skipping batch update');
      return;
    }

    // Step-index → [ansInternal col, ansExternal col, result col] (0-based)
    const STEP_COLS = {
      1: [COL.ANS_INT_1, COL.ANS_EXT_1, COL.RESULT_1],
      2: [COL.ANS_INT_2, COL.ANS_EXT_2, COL.RESULT_2],
      3: [COL.ANS_INT_3, COL.ANS_EXT_3, COL.RESULT_3],
    };

    const data = []; // ValueRange array for batchUpdate

    for (const { rowIndex, steps } of allResults) {
      for (const step of steps) {
        const cols = STEP_COLS[step.stepIndex];
        if (!cols) continue;

        const [intCol, extCol, resCol] = cols;

        data.push({
          range:  a1(rowIndex, intCol),
          values: [[step.ansInternal ?? '']],
        });
        data.push({
          range:  a1(rowIndex, extCol),
          values: [[step.ansExternal ?? '']],
        });
        data.push({
          range:  a1(rowIndex, resCol),
          values: [[step.resultMatch ?? '']],
        });
      }
    }

    if (data.length === 0) {
      logger.info('No value ranges to write');
      return;
    }

    logger.info(`Sending batch update: ${data.length} cells across ${allResults.length} rows…`);

    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.google.spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data,
      },
    });

    logger.info('Batch update complete');
  }

  // ── Write column headers (idempotent helper) ───────────────
  async ensureHeaders() {
    const headers = [
      'Test ID',
      'Question 1', 'Ans_Internal 1', 'Ans_External 1', 'Result 1',
      'Question 2', 'Ans_Internal 2', 'Ans_External 2', 'Result 2',
      'Question 3', 'Ans_Internal 3', 'Ans_External 3', 'Result 3',
    ];

    await this.sheets.spreadsheets.values.update({
      spreadsheetId:   config.google.spreadsheetId,
      range:           `${config.google.sheetName}!A1:M1`,
      valueInputOption: 'USER_ENTERED',
      requestBody:     { values: [headers] },
    });

    logger.debug('Header row verified/written');
  }
}

export default SheetsClient;