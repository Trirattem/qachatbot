/**
 * src/config/index.js  — v4 A/B Testing
 * ─────────────────────────────────────────────────────────────
 * Centralised configuration loader.
 *
 * Changes from v3:
 *  - GOOGLE_DOCUMENT_ID is no longer required (Google Docs removed)
 *  - Added CHATBOT_INTERNAL_URL / CHATBOT_EXTERNAL_URL
 *  - Added AB_MATCH_THRESHOLD
 *  - Removed DOC_COL_* and screenshot-related keys
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ───────────────────────────────────────────────────
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
  // Google Sheets (only — no Docs in v4)
  google: {
    spreadsheetId: required('GOOGLE_SPREADSHEET_ID'),
    sheetName:     optional('GOOGLE_SHEET_NAME', 'TestCases'),
    keyFilePath:   path.resolve(
      __dirname, '../../',
      optional('GOOGLE_SERVICE_ACCOUNT_KEY_PATH', './credentials/google-service-account.json')
    ),
    dataStartRow:  optionalInt('SHEET_DATA_START_ROW', 2),
  },

  // Chatbot — dual environment URLs
  chatbot: {
    internalUrl:      optional('CHATBOT_INTERNAL_URL', ''),
    externalUrl:      optional('CHATBOT_EXTERNAL_URL', ''),
    // Fallback to CHATBOT_URL for backwards compatibility
    url:              optional('CHATBOT_URL', ''),
    toggleSelector:   optional('CHATBOT_TOGGLE_SELECTOR',   '.pmx-chat-head'),
    iframeSelector:   optional('CHATBOT_IFRAME_SELECTOR',    'iframe'),
    inputSelector:    optional('CHATBOT_INPUT_SELECTOR',     'textarea'),
    sendSelector:     optional('CHATBOT_SEND_SELECTOR',      'button[type="submit"]'),
    responseSelector: optional('CHATBOT_RESPONSE_SELECTOR',  '.chat-message.bot'),
    loadingSelector:  optional('CHATBOT_LOADING_SELECTOR',   ''),
    expandSelector:   optional('CHATBOT_EXPAND_SELECTOR',    ''),
    popupCloseSelector: optional('CHATBOT_POPUP_CLOSE_SELECTOR', ''),
  },

  // Timing
  timing: {
    responseWaitTimeout:   optionalInt('RESPONSE_WAIT_TIMEOUT',    30000),
    responseFinishTimeout: optionalInt('RESPONSE_FINISH_TIMEOUT',  60000),
    pollInterval:          optionalInt('RESPONSE_POLL_INTERVAL',   1500),
    stableDuration:        optionalInt('RESPONSE_STABLE_DURATION', 3000),
    retryDelay:            optionalInt('RETRY_DELAY',              3000),
  },

  // Retry
  maxRetries: optionalInt('MAX_RETRIES', 3),

  // A/B comparison
  abTest: {
    matchThreshold: optionalFloat('AB_MATCH_THRESHOLD', 0.65),
  },

  // Browser
  browser: {
    headless: optionalBool('HEADLESS', true),
    slowMo:   optionalInt('SLOW_MO', 0),
    viewport: {
      width:  optionalInt('VIEWPORT_WIDTH',  1280),
      height: optionalInt('VIEWPORT_HEIGHT', 800),
    },
  },

  // Paths
  paths: {
    logs:    optional('LOGS_DIR',    './logs'),
    reports: optional('REPORTS_DIR', './reports'),
  },
});

export default config;