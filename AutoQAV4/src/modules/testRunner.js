/**
 * src/modules/testRunner.js  — v4.1 Dynamic Follow-up
 * ─────────────────────────────────────────────────────────────
 * Key changes vs v4.0:
 *
 *  1. DYNAMIC QUESTION GENERATION
 *     - After getting a response to Q1, parse it with dynamicQuestionGenerator.
 *     - If the bot gave a numbered list, pick one item at random → that becomes Q2.
 *     - After Q2's response, repeat the process for Q3.
 *     - Fall back to the static question from the sheet if no list is found.
 *     - Stop the turn early if both dynamic extraction AND static fallback are empty.
 *
 *  2. RETRY FIX (timeout root-cause from v4.0)
 *     - Each send attempt snapshots getBubbleCount() BEFORE calling sendMessage().
 *     - On timeout the page is RELOADED (full widget re-init) before the next attempt.
 *     - This prevents the poller from being confused by stale bubbles.
 *
 *  3. DYNAMIC QUESTIONS WRITTEN BACK TO SHEETS
 *     - The `question` field in each step reflects the ACTUAL question sent
 *       (dynamic or static). SheetsClient writes it to the Q2/Q3 columns so
 *       you can see exactly what the automation asked.
 *     - `isDynamic` flag is stored in JSON state for traceability.
 *
 *  NO screenshots anywhere in this file.
 */

import fs               from 'fs';
import path             from 'path';
import { format as dateFormat } from 'date-fns';
import stringSimilarity from 'string-similarity';
import BrowserController          from './browserController.js';
import { resolveNextQuestion }    from '../utils/dynamicQuestionGenerator.js';
import logger                     from '../utils/logger.js';
import config                     from '../config/index.js';

// ── Constants ─────────────────────────────────────────────────
const MATCH_THRESHOLD = parseFloat(process.env.AB_MATCH_THRESHOLD ?? '0.65');
const MAX_STEPS       = 3;

const STATE_FILE = path.join(
  config.paths.logs,
  `ab_state_${(config.google.spreadsheetId ?? 'run').slice(0, 20)}.json`
);

class TestRunner {
  constructor(internalUrl, externalUrl) {
    this.internalUrl = internalUrl;
    this.externalUrl = externalUrl;
    this.state       = this._loadState();
  }

  // ── Public ────────────────────────────────────────────────

  async runAll(testCases) {
    const allResults = [];

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      logger.info(`\n[${i + 1}/${testCases.length}] Running: ${tc.testId}`);

      try {
        const result = await this._runOneCase(tc);
        allResults.push(result);
        this._saveState(tc.testId, result);
      } catch (err) {
        logger.error(`Fatal error on ${tc.testId}: ${err.message}`, { stack: err.stack });
        allResults.push(this._buildErrorResult(tc, err.message));
      }

      if (i < testCases.length - 1) await this._sleep(1000);
    }

    return allResults;
  }

  // ── Per test-case orchestration ───────────────────────────

  async _runOneCase(testCase) {
    const { testId, rowIndex, questions } = testCase;
    const q1 = (questions[0] ?? '').trim();

    if (!q1) {
      logger.warn(`${testId}: Q1 is empty — skipping`);
      return { rowIndex, steps: this._emptySteps() };
    }

    // Static fallbacks from the sheet (may be empty strings)
    const staticQ2 = (questions[1] ?? '').trim();
    const staticQ3 = (questions[2] ?? '').trim();

    // ── INTERNAL run ─────────────────────────────────────────
    const { answers: intAnswers, actualQuestions: intQs } =
      await this._collectAnswers('internal', this.internalUrl, q1, staticQ2, staticQ3, testId);

    // ── EXTERNAL run ─────────────────────────────────────────
    // Use the SAME dynamically-generated questions that Internal used,
    // so both environments answer the identical conversation path.
    const { answers: extAnswers } =
      await this._collectAnswers('external', this.externalUrl, q1, intQs[1] ?? staticQ2, intQs[2] ?? staticQ3, testId, true);

    // ── Build result steps ────────────────────────────────────
    const steps = [];

    for (let idx = 0; idx < MAX_STEPS; idx++) {
      const stepIndex   = idx + 1;
      const question    = intQs[idx] ?? '';
      const ansInternal = intAnswers[idx] ?? '';
      const ansExternal = extAnswers[idx] ?? '';

      if (!question) {
        steps.push({ stepIndex, question: '', ansInternal: '', ansExternal: '', similarityScore: 0, resultMatch: '', isDynamic: false });
        continue;
      }

      const { score, label } = this._compare(ansInternal, ansExternal);
      logger.info(`${testId} step ${stepIndex}: ${(score * 100).toFixed(1)}% → ${label}`);

      steps.push({
        stepIndex,
        question,
        ansInternal,
        ansExternal,
        similarityScore: parseFloat(score.toFixed(4)),
        resultMatch:     label,
        isDynamic:       idx > 0, // Q1 is always static; Q2/Q3 may be dynamic
      });
    }

    return { rowIndex, steps };
  }

  /**
   * Open one browser environment, run up to MAX_STEPS turns with dynamic
   * follow-up generation, collect answers and the actual questions asked.
   *
   * @param {string}  envName
   * @param {string}  url
   * @param {string}  q1           - always static from the sheet
   * @param {string}  fallbackQ2   - static Q2 fallback (may be empty)
   * @param {string}  fallbackQ3   - static Q3 fallback (may be empty)
   * @param {string}  testId       - for logging
   * @param {boolean} [fixedQs]    - if true, skip dynamic generation (use fallbacks as-is)
   * @returns {{ answers: string[], actualQuestions: string[] }}
   */
  async _collectAnswers(envName, url, q1, fallbackQ2, fallbackQ3, testId, fixedQs = false) {
    const browser         = new BrowserController(envName);
    const answers         = [];   // bot responses in order
    const actualQuestions = [];   // questions actually sent (for sheet write-back)

    try {
      await browser.init(url);

      // ── Step 1: Q1 (always static) ──────────────────────────
      const ans1 = await this._sendWithRetry(browser, q1, 1, testId, envName);
      answers.push(ans1);
      actualQuestions.push(q1);

      // ── Step 2: Q2 (dynamic or static fallback) ─────────────
      let q2 = '';
      if (!fixedQs) {
        const resolved = resolveNextQuestion(ans1, fallbackQ2);
        if (resolved) {
          q2 = resolved.question;
          logger.info(`[${envName}] Q2 ${resolved.isDynamic ? '(dynamic)' : '(static fallback)'}: "${q2}"`);
        }
      } else {
        q2 = fallbackQ2;
      }

      if (q2) {
        const ans2 = await this._sendWithRetry(browser, q2, 2, testId, envName);
        answers.push(ans2);
        actualQuestions.push(q2);

        // ── Step 3: Q3 (dynamic or static fallback) ───────────
        let q3 = '';
        if (!fixedQs) {
          const resolved3 = resolveNextQuestion(ans2, fallbackQ3);
          if (resolved3) {
            q3 = resolved3.question;
            logger.info(`[${envName}] Q3 ${resolved3.isDynamic ? '(dynamic)' : '(static fallback)'}: "${q3}"`);
          }
        } else {
          q3 = fallbackQ3 || fallbackQ2; // External mirrors Internal's path
        }

        if (q3) {
          const ans3 = await this._sendWithRetry(browser, q3, 3, testId, envName);
          answers.push(ans3);
          actualQuestions.push(q3);
        } else {
          answers.push('');
          actualQuestions.push('');
          logger.info(`[${envName}] Q3 skipped — no list and no static fallback`);
        }
      } else {
        answers.push('', '');
        actualQuestions.push('', '');
        logger.info(`[${envName}] Q2/Q3 skipped — no list and no static fallback`);
      }

    } finally {
      await browser.close();
    }

    return { answers, actualQuestions };
  }

  /**
   * Send a question with per-attempt retry.
   * On each failure the page is fully reloaded (clears zombie session state)
   * and the bubble count is re-snapshotted before the next attempt.
   *
   * NOTE: Because we reload on failure, any PREVIOUS answers in the same
   * session are lost. This helper is therefore only called for Q1 (fresh page).
   * For Q2/Q3 we also reload, which means the bot loses prior context —
   * an acceptable trade-off because a timeout means the session is broken anyway.
   */
  async _sendWithRetry(browser, question, turnLabel, testId, envName) {
    const maxAttempts = config.maxRetries ?? 3;
    let lastErr       = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Snapshot bubble count BEFORE sending (critical fix)
        const before = await browser.getBubbleCount();
        const answer = await browser.sendMessage(question, before, turnLabel);
        return answer; // success
      } catch (err) {
        lastErr = err;
        logger.warn(
          `[${envName}] ${testId} Q${turnLabel} attempt ${attempt}/${maxAttempts} failed: ${err.message}`
        );

        if (attempt < maxAttempts) {
          logger.info(`[${envName}] Reloading page before retry…`);
          await this._sleep(config.timing.retryDelay ?? 3000);
          try {
            await browser.reload(); // full reload re-inits the widget
          } catch (reloadErr) {
            logger.error(`[${envName}] Reload failed: ${reloadErr.message}`);
          }
        }
      }
    }

    return `[ERROR] ${lastErr?.message ?? 'Unknown'}`;
  }

  // ── Comparison ────────────────────────────────────────────

  _compare(a, b) {
    if (!a && !b)  return { score: 1.0, label: 'MATCH' };
    if (!a || !b)  return { score: 0.0, label: 'MISMATCH' };
    if (a.startsWith('[ERROR]') || b.startsWith('[ERROR]')) {
      return { score: 0.0, label: 'MISMATCH' };
    }

    const na = this._normalise(a);
    const nb = this._normalise(b);

    const dice    = stringSimilarity.compareTwoStrings(na, nb);
    const wordsA  = new Set(na.split(/\s+/).filter(Boolean));
    const wordsB  = new Set(nb.split(/\s+/).filter(Boolean));
    const inter   = [...wordsA].filter(w => wordsB.has(w)).length;
    const union   = new Set([...wordsA, ...wordsB]).size;
    const jaccard = union > 0 ? inter / union : 0;
    const score   = dice * 0.60 + jaccard * 0.40;

    return { score, label: score >= MATCH_THRESHOLD ? 'MATCH' : 'MISMATCH' };
  }

  _normalise(text) {
    return (text ?? '')
      .replace(/[^\u0e00-\u0e7f\u0020-\u007e\u00a0-\u00ff]/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim();
  }

  // ── State management ─────────────────────────────────────

  _loadState() {
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        logger.info(`Loaded state: ${Object.keys(state.results ?? {}).length} case(s) — ${STATE_FILE}`);
        return state;
      } catch (err) {
        logger.warn('Could not read state — starting fresh', { error: err.message });
      }
    }
    return { lastRun: '', results: {} };
  }

  _saveState(testId, result) {
    this.state.lastRun         = dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.state.results[testId] = { steps: result.steps };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
    logger.debug(`State saved: ${testId}`);
  }

  // ── Helpers ───────────────────────────────────────────────

  _emptySteps() {
    return Array.from({ length: MAX_STEPS }, (_, i) => ({
      stepIndex: i + 1, question: '', ansInternal: '', ansExternal: '',
      similarityScore: 0, resultMatch: '', isDynamic: false,
    }));
  }

  _buildErrorResult(testCase, errMsg) {
    const steps = Array.from({ length: MAX_STEPS }, (_, i) => ({
      stepIndex:       i + 1,
      question:        testCase.questions?.[i] ?? '',
      ansInternal:     `[ERROR] ${errMsg}`,
      ansExternal:     `[ERROR] ${errMsg}`,
      similarityScore: 0,
      resultMatch:     'MISMATCH',
      isDynamic:       false,
    }));
    return { rowIndex: testCase.rowIndex, steps };
  }

  get stateFilePath() { return STATE_FILE; }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default TestRunner;