/**
 * src/utils/logger.js
 * ─────────────────────────────────────────────────────────────
 * Structured logger built on Winston.
 * - Writes coloured output to the console
 * - Writes JSON logs to  logs/combined.log
 * - Writes error-only logs to logs/error.log
 * - Rotates new file per run (timestamped filename)
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { format as dateFormat } from 'date-fns';
import config from '../config/index.js';

// Ensure the log directory exists
fs.mkdirSync(config.paths.logs, { recursive: true });

// ── Custom console format with colour ─────────────────────────
const { combine, timestamp, printf, colorize, errors } = winston.format;

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, testId, attempt, ...meta }) => {
    const prefix = testId ? ` [${testId}]` : '';
    const retry  = attempt !== undefined ? ` (attempt ${attempt})` : '';
    const extra  = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}${prefix}${retry}: ${message}${extra}`;
  })
);

// ── File format (JSON for easy parsing) ───────────────────────
const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  winston.format.json()
);

// ── Run-specific log file ─────────────────────────────────────
const runTimestamp = dateFormat(new Date(), 'yyyyMMdd_HHmmss');
const runLogPath   = path.join(config.paths.logs, `run_${runTimestamp}.log`);

const logger = winston.createLogger({
  level: 'debug',
  transports: [
    // Console — INFO and above
    new winston.transports.Console({
      level: 'info',
      format: consoleFormat,
    }),
    // Combined log — DEBUG and above
    new winston.transports.File({
      filename: path.join(config.paths.logs, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
    // Error-only log
    new winston.transports.File({
      filename: path.join(config.paths.logs, 'error.log'),
      level: 'error',
      format: fileFormat,
    }),
    // Per-run log
    new winston.transports.File({
      filename: runLogPath,
      format: fileFormat,
    }),
  ],
});

// Convenience: log a test result as a structured entry
logger.testResult = ({ testId, status, similarity, question, attempt }) => {
  logger.info(`Test result: ${status}`, { testId, status, similarity, question, attempt });
};

export default logger;
