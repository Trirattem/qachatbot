/**
 * src/index.js  — v4 A/B Testing Entry Point
 * ─────────────────────────────────────────────────────────────
 * Two-phase execution:
 *   Phase 1 (BROWSER) : run Internal + External for every row → save JSON
 *   Phase 2 (SHEETS)  : single batchUpdate to write all results to Google Sheets
 *
 * CLI flags:
 *   --dry-run      Skip writing to Google Sheets
 *   --sheets-only  Skip browser phase, re-use existing JSON state
 *
 * Environment variables (add to .env):
 *   CHATBOT_INTERNAL_URL   https://uat-promptx.treasury.go.th/demo_internal/
 *   CHATBOT_EXTERNAL_URL   https://uat-promptx.treasury.go.th/demo_external/
 *   AB_MATCH_THRESHOLD     0.65  (optional, default 0.65)
 */

import 'dotenv/config';
import fs           from 'fs';
import path         from 'path';
import { format as dateFormat } from 'date-fns';
import logger       from './utils/logger.js';
import config       from './config/index.js';
import SheetsClient from './modules/sheetsClient.js';
import TestRunner   from './modules/testRunner.js';

// ── CLI flags ─────────────────────────────────────────────────
const argv        = process.argv.slice(2);
const DRY_RUN     = argv.includes('--dry-run');
const SHEETS_ONLY = argv.includes('--sheets-only');

// ── Environment URLs ──────────────────────────────────────────
const INTERNAL_URL = process.env.CHATBOT_INTERNAL_URL
  ?? 'https://uat-promptx.treasury.go.th/demo_internal/';
const EXTERNAL_URL = process.env.CHATBOT_EXTERNAL_URL
  ?? 'https://uat-promptx.treasury.go.th/demo_external/';

process.on('unhandledRejection', reason => {
  logger.error('Unhandled Promise rejection', { reason: String(reason) });
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(' Chatbot QA v4 — A/B Testing Mode');
  if (DRY_RUN)     logger.info(' ⚠  DRY RUN — will not write to Sheets');
  if (SHEETS_ONLY) logger.info(' 📄 SHEETS ONLY — skip browser phase');
  logger.info(` Internal: ${INTERNAL_URL}`);
  logger.info(` External: ${EXTERNAL_URL}`);
  logger.info('═══════════════════════════════════════════════');

  const startTime = Date.now();

  // ── Sheets client ─────────────────────────────────────────
  const sheets = new SheetsClient();
  await sheets.init();

  // ── Test runner ───────────────────────────────────────────
  const runner = new TestRunner(INTERNAL_URL, EXTERNAL_URL);

  // ── Load test cases ───────────────────────────────────────
  const testCases = await sheets.getTestCases();
  if (testCases.length === 0) {
    logger.warn('No test cases found — exiting');
    return;
  }
  logger.info(`Found ${testCases.length} test case(s)`);

  // ══════════════════════════════════════════════════════════
  // Phase 1: Browser
  // ══════════════════════════════════════════════════════════
  let allResults = [];

  if (!SHEETS_ONLY) {
    logger.info('');
    logger.info('━━━ PHASE 1: BROWSER ━━━━━━━━━━━━━━━━━━━━━━━━━');
    allResults = await runner.runAll(testCases);
    logger.info('━━━ PHASE 1 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`State file: ${runner.stateFilePath}`);
  } else {
    // Reconstruct from JSON state
    allResults = rebuildFromState(runner, testCases);
    logger.info(`Loaded ${allResults.length} result(s) from JSON state`);
  }

  // ══════════════════════════════════════════════════════════
  // Phase 2: Batch write to Google Sheets
  // ══════════════════════════════════════════════════════════
  if (!DRY_RUN) {
    logger.info('');
    logger.info('━━━ PHASE 2: SHEETS BATCH UPDATE ━━━━━━━━━━━━━━');
    await sheets.batchWriteResults(allResults);
    logger.info('━━━ PHASE 2 DONE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } else {
    logger.info('[DRY RUN] Skipping Sheets write — results below:');
    for (const r of allResults) {
      const testId = testCases.find(tc => tc.rowIndex === r.rowIndex)?.testId ?? `row${r.rowIndex}`;
      for (const s of r.steps) {
        if (!s.question) continue;
        logger.info(
          `  [DRY] ${testId} step ${s.stepIndex}: ` +
          `${(s.similarityScore * 100).toFixed(1)}% → ${s.resultMatch}`
        );
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  let matchCount = 0, mismatchCount = 0, totalSteps = 0;

  for (const r of allResults) {
    for (const s of r.steps) {
      if (!s.question) continue;
      totalSteps++;
      if (s.resultMatch === 'MATCH')    matchCount++;
      if (s.resultMatch === 'MISMATCH') mismatchCount++;
    }
  }

  logger.info('═══════════════════════════════════════════════');
  logger.info(` Done in ${elapsed}s`);
  logger.info(` Total steps: ${totalSteps}  MATCH: ${matchCount}  MISMATCH: ${mismatchCount}`);
  logger.info('═══════════════════════════════════════════════');
}

// ── Rebuild allResults from persisted JSON state ──────────────
function rebuildFromState(runner, testCases) {
  const stateRaw = fs.existsSync(runner.stateFilePath)
    ? JSON.parse(fs.readFileSync(runner.stateFilePath, 'utf8'))
    : { results: {} };

  return testCases
    .map(tc => {
      const saved = stateRaw.results?.[tc.testId];
      if (!saved) return null;
      return { rowIndex: tc.rowIndex, steps: saved.steps };
    })
    .filter(Boolean);
}

main();