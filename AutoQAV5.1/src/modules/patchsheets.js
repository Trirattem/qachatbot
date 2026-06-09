/**
 * patch_sheets.js
 * รันครั้งเดียวเพื่อ patch sheetsClient.js ให้มี batchWriteResults()
 * 
 * Usage: node patch_sheets.js
 */

import fs from 'fs';
import path from 'path';

const TARGET = path.resolve('src/modules/sheetsClient.js');

if (!fs.existsSync(TARGET)) {
  console.error('❌ ไม่พบ src/modules/sheetsClient.js');
  process.exit(1);
}

const src = fs.readFileSync(TARGET, 'utf8');

// ตรวจว่ามีแล้วหรือยัง
if (src.includes('batchWriteResults')) {
  console.log('✅ batchWriteResults มีอยู่แล้ว ไม่ต้อง patch');
  process.exit(0);
}

// หา closing brace ของ writeResult method แล้วแทรก batchWriteResults ต่อท้าย
// หา pattern:  async writeResult(...) { ... }  แล้วแทรกหลังจากนั้น

const INJECT_AFTER = `    logger.debug(\`Wrote result to row \${rowIndex}\`, { status: result.status });
  }`;

const INJECT_CODE = `

  // ── Batch write หลาย rows พร้อมกัน ────────────────────────
  async batchWriteResults(items) {
    if (items.length === 0) return;

    const cols     = config.google.columns;
    const startCol = cols.actual;
    const endCol   = cols.screenshot || cols.screenshotPath || 'G';

    const data = items.map(({ rowIndex, result }) => ({
      range:  \`\${config.google.sheetName}!\${startCol}\${rowIndex}:\${endCol}\${rowIndex}\`,
      values: [[
        result.actual         || '',
        result.status         || '',
        result.timestamp      || '',
        result.screenshotPath || '',
      ]],
    }));

    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.google.spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data,
      },
    });

    // color requests ทุก status cell พร้อมกัน
    const colorRequests = items
      .map(({ rowIndex, result }) => this._buildColorRequest(rowIndex, result.status))
      .filter(Boolean);

    if (colorRequests.length > 0) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.google.spreadsheetId,
        requestBody:   { requests: colorRequests },
      });
    }

    logger.info(\`Batch wrote \${items.length} results to Google Sheets\`);
  }`;

// ตรวจว่า _buildColorRequest มีไหม ถ้าไม่มีให้เพิ่มด้วย
const NEED_BUILD_COLOR = !src.includes('_buildColorRequest');

const COLOR_HELPER = `

  _buildColorRequest(rowIndex, status) {
    const STATUS_COLORS = {
      PASS:    { red: 0.204, green: 0.659, blue: 0.325 },
      PARTIAL: { red: 1.0,   green: 0.843, blue: 0.0   },
      FAIL:    { red: 0.918, green: 0.263, blue: 0.208 },
    };
    const color = STATUS_COLORS[status];
    if (!color) return null;

    // หา status column index
    const statusColLetter = config.google.columns.status || 'E';
    const statusColIndex  = statusColLetter.toUpperCase().charCodeAt(0) - 65;

    return {
      repeatCell: {
        range: {
          sheetId:          this.sheetId,
          startRowIndex:    rowIndex - 1,
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
  }`;

if (!src.includes(INJECT_AFTER)) {
  console.error('❌ ไม่พบ anchor point ใน sheetsClient.js');
  console.error('   ลองหา: logger.debug(`Wrote result to row');
  console.log('\n📋 วิธีแก้ manual: เปิด src/modules/sheetsClient.js แล้วเพิ่มโค้ดด้านล่างนี้');
  console.log('   ก่อน closing brace ของ class (บรรทัดสุดท้ายที่เป็น }):\n');
  console.log(INJECT_CODE);
  if (NEED_BUILD_COLOR) console.log(COLOR_HELPER);
  process.exit(1);
}

let patched = src.replace(
  INJECT_AFTER,
  INJECT_AFTER + INJECT_CODE + (NEED_BUILD_COLOR ? COLOR_HELPER : '')
);

// backup
fs.writeFileSync(TARGET + '.backup', src, 'utf8');
fs.writeFileSync(TARGET, patched, 'utf8');

console.log('✅ patch สำเร็จ!');
console.log('   backup เก็บไว้ที่: src/modules/sheetsClient.js.backup');
console.log('   รัน: npm run test:sheets-only:dry  เพื่อทดสอบ');