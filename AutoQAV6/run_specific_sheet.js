import 'dotenv/config';
import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { format as dateFormat } from 'date-fns';
import logger from './src/utils/logger.js';
import config from './src/config/index.js';
import BrowserController from './src/modules/browserController.js';
import ScreenshotHandler from './src/modules/screenshotHandler.js';
import TestRunner from './src/modules/testRunner.js';

const SPREADSHEET_ID = '1kEHrYyF4JXvqsSFzSHEw_q_R-p26QOjQicxGwLRsGMk';
const GID = 1543615857;

// Graceful shutdown handling
let isShuttingDown = false;
process.on('SIGINT', () => {
  logger.warn('\n[System] ได้รับสัญญาณหยุดการทำงาน (SIGINT), กำลังหยุดอย่างปลอดภัย...');
  isShuttingDown = true;
});
process.on('SIGTERM', () => {
  logger.warn('\n[System] ได้รับสัญญาณหยุดการทำงาน (SIGTERM), กำลังหยุดอย่างปลอดภัย...');
  isShuttingDown = true;
});

async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(' Run QA Automation for Specific Sheet & Tab');
  logger.info(` Spreadsheet ID: ${SPREADSHEET_ID}`);
  logger.info(` Tab Grid ID: ${GID}`);
  logger.info('═══════════════════════════════════════════════');

  const KEY_FILE = path.resolve(config.google.keyFilePath || './credentials/google-service-account.json');
  logger.info(`Authenticating with Google API using: ${KEY_FILE}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // 1. Resolve sheet name from Grid ID
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tab = meta.data.sheets.find(s => s.properties.sheetId === GID);
  if (!tab) {
    throw new Error(`Sheet tab with GID ${GID} not found in spreadsheet.`);
  }
  const sheetName = tab.properties.title;
  logger.info(`Resolved GID ${GID} to tab title: "${sheetName}"`);

  // 2. Fetch all rows of columns A to H
  // Using A1:H1500 to fetch a reasonable range
  const range = `${sheetName}!A1:H1500`;
  logger.info(`Fetching rows in range: ${range}...`);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const rows = response.data.values || [];
  if (rows.length === 0) {
    logger.warn('No rows found in the sheet.');
    return;
  }

  // Identify matching rows (columns E, F, G, H are empty)
  // Rows starting from index 1 (row 2)
  const pendingCases = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    
    // Check columns E, F, G, H (indices 4, 5, 6, 7)
    const colE = row[4]?.trim() ?? '';
    const colF = row[5]?.trim() ?? '';
    const colG = row[6]?.trim() ?? '';
    const colH = row[7]?.trim() ?? '';

    // If E to H are all blank/empty
    if (!colE && !colF && !colG && !colH) {
      const testId = row[0]?.trim() ?? `TC_${i + 1}`;
      const question = row[1]?.trim() ?? '';
      const expected = row[2]?.trim() ?? '';

      // Skip row if question is empty
      if (!question) continue;

      pendingCases.push({
        rowIndex: i + 1, // 1-based row number
        testId,
        question,
        expected,
      });
    }
  }

  logger.info(`Found ${pendingCases.length} pending cases where E-H are empty.`);

  if (pendingCases.length === 0) {
    logger.info('No pending cases to run. Exiting.');
    return;
  }

  // 3. Initialize Browser & TestRunner
  const browser = new BrowserController();
  const screenshot = new ScreenshotHandler();
  const runner = new TestRunner(browser, screenshot);

  try {
    await browser.init();

    for (let idx = 0; idx < pendingCases.length; idx++) {
      if (isShuttingDown) {
        logger.info('Stopping due to interrupt signal...');
        break;
      }

      const tc = pendingCases[idx];
      logger.info(`\n[${idx + 1}/${pendingCases.length}] Processing Row ${tc.rowIndex} (ID: ${tc.testId})`);

      const result = await runner.run(tc);

      // Write results back to Google Sheet
      await writeResultToSheet(sheets, SPREADSHEET_ID, sheetName, tc.rowIndex, result);
      
      // Delay between questions
      if (idx < pendingCases.length - 1 && !isShuttingDown) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err) {
    logger.error('Error during execution', { error: err.message, stack: err.stack });
  } finally {
    await browser.close().catch(() => {});
  }

  logger.info('Execution completed.');
}

async function writeResultToSheet(sheets, spreadsheetId, sheetName, rowIndex, result) {
  // Column mapping (D, E, F, G, H):
  // D: result.actual
  // E: '' (keep blank)
  // F: result.status (PASS/PARTIAL/FAIL)
  // G: result.timestamp
  // H: result.screenshotPath
  const values = [[
    result.actual ?? '',
    '', // Expected Answer
    result.status ?? '',
    result.timestamp ?? dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss'),
    result.screenshotPath ?? '',
  ]];

  const startCol = 'D';
  const endCol = 'H';
  const range = `${sheetName}!${startCol}${rowIndex}:${endCol}${rowIndex}`;

  logger.info(`Writing results to row ${rowIndex}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  // Color Status cell in Column F (index 5)
  const STATUS_COLORS = {
    PASS:    { red: 0.204, green: 0.659, blue: 0.325 },  // #34A853 green
    PARTIAL: { red: 1.0,   green: 0.843, blue: 0.0   },  // #FFD700 yellow
    FAIL:    { red: 0.918, green: 0.263, blue: 0.208 },  // #EA4335 red
  };

  const color = STATUS_COLORS[result.status];
  if (color) {
    const statusColIndex = 5; // Column F is 5 (0-based)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: GID,
              startRowIndex: rowIndex - 1,
              endRowIndex: rowIndex,
              startColumnIndex: statusColIndex,
              endColumnIndex: statusColIndex + 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: color,
                textFormat: { bold: true },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          }
        }]
      }
    });
  }
}

main().catch(err => {
  logger.error('Fatal crash in main script', { error: err.message, stack: err.stack });
  process.exit(1);
});
