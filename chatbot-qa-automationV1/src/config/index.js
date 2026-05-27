/**
 * src/config/index.js
 * ─────────────────────────────────────────────────────────────
 * Centralised configuration loader.
 * Reads .env via dotenv, validates required keys, and exports
 * a single frozen config object used throughout the project.
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── Build Config ──────────────────────────────────────────────
const config = Object.freeze({
  // Google Sheets
  google: {
    spreadsheetId: required('GOOGLE_SPREADSHEET_ID'),
    sheetName:     optional('GOOGLE_SHEET_NAME', 'TestCases'),
    keyFilePath:   path.resolve(__dirname, '../../',
                     optional('GOOGLE_SERVICE_ACCOUNT_KEY_PATH',
                              './credentials/google-service-account.json')),
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
  },

  // Timing
  timing: {
    responseWaitTimeout:   optionalInt('RESPONSE_WAIT_TIMEOUT',   30000),
    responseFinishTimeout: optionalInt('RESPONSE_FINISH_TIMEOUT', 60000),
    pollInterval:          optionalInt('RESPONSE_POLL_INTERVAL',  1500),
    stableDuration:        optionalInt('RESPONSE_STABLE_DURATION', 3000),
    retryDelay:            optionalInt('RETRY_DELAY',             3000),
  },

  // Retry
  maxRetries: optionalInt('MAX_RETRIES', 3),

  // Classification
  classification: {
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
});

export default config;