/**
 * src/config/index.js
 * ─────────────────────────────────────────────────────────────
 * Centralised configuration loader.
 * Reads .env via dotenv, validates required keys, and exports
 * a single frozen config object used throughout the project.
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.run to override config values if it exists
const envRunPath = path.resolve(__dirname, '../../.env.run');
if (fs.existsSync(envRunPath)) {
  dotenv.config({ path: envRunPath, override: true });
}
// ── Helper ────────────────────────────────────────────────────
/**
 * Read an env variable and throw if it is not defined.
 * @param {string} key  - process.env key
 * @param {*} [fallback] - optional default value
 */
function required(key, fallback = undefined) {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key, fallback = '') {
  return process.env[key] ?? fallback;
}

function optionalInt(key, fallback) {
  const v = process.env[key];
  return v !== undefined ? parseInt(v, 10) : fallback;
}

function optionalFloat(key, fallback) {
  const v = process.env[key];
  return v !== undefined ? parseFloat(v) : fallback;
}

function optionalBool(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v.toLowerCase() === 'true';
}

function googleDocId() {
  const direct =
    optional('GOOGLE_DOCUMENT_ID') ||
    optional('GOOGLE_DOCS_DOCUMENT_ID');

  if (direct) return direct;

  const url = optional('GOOGLE_DOCUMENT_URL') || optional('GOOGLE_DOCS_URL');
  const match = url.match(/\/document\/d\/([^/]+)/);
  if (match?.[1]) return match[1];

  throw new Error(
    'Missing required environment variable: GOOGLE_DOCUMENT_ID ' +
    '(or GOOGLE_DOCUMENT_URL)'
  );
}

// ── Build Config ──────────────────────────────────────────────
const config = Object.freeze({
  // Google Docs
  google: {
    documentId:    googleDocId(),
    spreadsheetId: optional('GOOGLE_SPREADSHEET_ID', ''),
    sheetName:     optional('GOOGLE_SHEET_NAME', 'TestCases'),
    targetSpreadsheetId: optional('TARGET_GOOGLE_SPREADSHEET_ID', optional('GOOGLE_SPREADSHEET_ID', '')),
    targetSheetName:     optional('TARGET_GOOGLE_SHEET_NAME', optional('GOOGLE_SHEET_NAME', 'TestCases')),
    keyFilePath:   path.resolve(__dirname, '../../',
                     optional('GOOGLE_SERVICE_ACCOUNT_KEY_PATH',
                              './credentials/google-service-account.json')),
    docColumns: {
      testId:     optional('DOC_COL_TEST_ID_HEADER',     'Test case ID'),
      testSteps:  optional('DOC_COL_TEST_STEPS_HEADER',  'Test Steps'),
      expected:   optional('DOC_COL_EXPECTED_HEADER',    'Expected Result'),
      actual:     optional('DOC_COL_ACTUAL_HEADER',      'Actual Result'),
      status:     optional('DOC_COL_STATUS_HEADER',      'Status'),
      remark:     optional('DOC_COL_REMARK_HEADER',      'Remark'),
    },
    driveScreenshotFolderId: optional('GOOGLE_DRIVE_SCREENSHOT_FOLDER_ID', ''),
    screenshotImageWidthPt:  optionalInt('DOC_SCREENSHOT_IMAGE_WIDTH_PT', 280),
    columns: {
      testId:     optional('SHEET_COL_TEST_ID',     'A'),
      question:   optional('SHEET_COL_QUESTION',    'B'),
      expected:   optional('SHEET_COL_EXPECTED',    'C'),
      actual:     optional('SHEET_COL_ACTUAL',      'D'),
      status:     optional('SHEET_COL_STATUS',      'E'),
      timestamp:  optional('SHEET_COL_TIMESTAMP',   'F'),
      screenshot: optional('SHEET_COL_SCREENSHOT',  'G'),
    },
    dataStartRow: optionalInt('SHEET_DATA_START_ROW', 2),
  },

  // Chatbot selectors & URL
  chatbot: {
    url:              required('CHATBOT_URL'),
    toggleSelector:   optional('CHATBOT_TOGGLE_SELECTOR', '.pmx-chat-head'),
    iframeSelector:   optional('CHATBOT_IFRAME_SELECTOR',  'iframe'),
    inputSelector:    optional('CHATBOT_INPUT_SELECTOR',    'textarea'),
    sendSelector:     optional('CHATBOT_SEND_SELECTOR',     'button[type="submit"]'),
    responseSelector: optional('CHATBOT_RESPONSE_SELECTOR', '.chat-message.bot'),
    loadingSelector:  optional('CHATBOT_LOADING_SELECTOR',  ''),
    expandSelector:   optional('CHATBOT_EXPAND_SELECTOR',   ''),
    popupCloseSelector: optional('CHATBOT_POPUP_CLOSE_SELECTOR', ''),
    bubbleStrategy:   optional('CHATBOT_BUBBLE_STRATEGY', 'last'),
    thinkingPhrases:  optional('CHATBOT_THINKING_PHRASES', 'คิดสักครู่นะคะ,กำลังคิด,typing,...').split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
  },

  // Timing
  timing: {
    responseWaitTimeout:   optionalInt('RESPONSE_WAIT_TIMEOUT',   30000),
    responseFinishTimeout: optionalInt('RESPONSE_FINISH_TIMEOUT', 60000),
    pollInterval:          optionalInt('RESPONSE_POLL_INTERVAL',  1500),
    stableDuration:        optionalInt('RESPONSE_STABLE_DURATION', 3000),
    retryDelay:            optionalInt('RETRY_DELAY',             3000),
    screenshotDelay:       optionalInt('SCREENSHOT_DELAY',        1000),
  },

  // Retry
  maxRetries: optionalInt('MAX_RETRIES', 3),

  // Classification
  classification: {
    mode:             optional('CLASSIFIER_MODE', 'rule'),
    anthropicApiKey:  optional('ANTHROPIC_API_KEY', ''),
    passThreshold:    optionalFloat('SIMILARITY_PASS_THRESHOLD',    0.65),
    partialThreshold: optionalFloat('SIMILARITY_PARTIAL_THRESHOLD', 0.30),
    failKeywords:     optional('FAIL_KEYWORDS',
      'ไม่มีข้อมูล,ไม่พบข้อมูล,ขออภัย ไม่สามารถ,sorry i don\'t know,i don\'t have information')
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean),
  },

  // Browser
  browser: {
    headless:  optionalBool('HEADLESS', true),
    slowMo:    optionalInt('SLOW_MO', 0),
    viewport: {
      width:  optionalInt('VIEWPORT_WIDTH',  1280),
      height: optionalInt('VIEWPORT_HEIGHT', 800),
    },
  },

  // Paths
  paths: {
    screenshots: optional('SCREENSHOTS_DIR', './screenshots'),
    logs:        optional('LOGS_DIR',        './logs'),
    reports:     optional('REPORTS_DIR',     './reports'),
  },

  // Run Configuration (from .env.run)
  runConfig: {
    instanceId: optionalInt('INSTANCE_ID', 1),
    from:      optionalInt('RUN_FROM', 1),
    to:        optionalInt('RUN_TO', 0),
    direction: optional('RUN_DIRECTION', 'top_to_bottom'),
    parity:    optional('RUN_PARITY', 'all'),
  },

  // Notification
  notification: {
    lineNotifyToken: optional('LINE_NOTIFY_TOKEN', ''),
    slackWebhookUrl: optional('SLACK_WEBHOOK_URL', ''),
    notifyOnComplete: optionalBool('NOTIFY_ON_COMPLETE', true),
    notifyFailThreshold: optionalFloat('NOTIFY_FAIL_THRESHOLD', 0.5),
  },

  // API Limits & Storage
  system: {
    googleApiMaxRequestsPerMin: optionalInt('GOOGLE_API_MAX_REQUESTS_PER_MIN', 50),
    checkpointCompressAfter: optionalInt('CHECKPOINT_COMPRESS_AFTER', 200),
    imgbbApiKey: optional('IMGBB_API_KEY', ''),
  }
});

export default config;
