import 'dotenv/config';
import { google } from 'googleapis';
import path from 'path';

async function check() {
  const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
  const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'ด้านที่ราชพัสดุ (In_State_Property)';
  const KEY_FILE = path.resolve('./credentials/chatbot-497504-0836c2cb62a2.json');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:Z5`,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  console.log(JSON.stringify(res.data.values, null, 2));
}

check().catch(console.error);
