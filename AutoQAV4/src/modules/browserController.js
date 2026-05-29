/**
 * src/modules/browserController.js  — v4.1
 * ─────────────────────────────────────────────────────────────
 * Fixes vs v4.0:
 *  - sendMessage() now requires `expectedBubbleCount` (snapshot BEFORE
 *    the send) so _waitForNewResponse knows the exact threshold to beat.
 *    This prevents false-positives from old bubbles in the same session.
 *  - Added getBubbleCount() so TestRunner can snapshot before each attempt.
 *  - On timeout the error propagates cleanly; TestRunner handles reload+retry.
 *  - Page JS errors demoted to debug (they are cosmetic on this site).
 *  - No screenshots anywhere.
 */

import { chromium } from 'playwright';
import logger from '../utils/logger.js';
import config from '../config/index.js';

const THINKING_PHRASES = [
  'คิดสักครู่นะคะ',
  'กำลังคิด',
  'กรุณารอสักครู่',
  'กำลังประมวลผล',
  'โปรดรอสักครู่',
  'typing',
  '...',
];

class BrowserController {
  constructor(envName = 'browser') {
    this.envName = envName;
    this.browser = null;
    this.context = null;
    this.page    = null;
    this.frame   = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async init(targetUrl) {
    logger.info(`[${this.envName}] Launching browser → ${targetUrl}`);

    this.browser = await chromium.launch({
      headless: config.browser.headless,
      slowMo:   config.browser.slowMo,
      args:     ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.context = await this.browser.newContext({
      viewport:          config.browser.viewport,
      ignoreHTTPSErrors: true,
    });

    this.page = await this.context.newPage();

    // Demote JS errors — cosmetic on this site
    this.page.on('pageerror', err =>
      logger.debug(`[${this.envName}] Page JS error: ${err.message}`)
    );

    await this.page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout:   config.timing.responseWaitTimeout,
    });

    await this._dismissPopup();
    await this._openChatWidget();
    logger.info(`[${this.envName}] Chatbot ready`);
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.page    = null;
      this.frame   = null;
      logger.info(`[${this.envName}] Browser closed`);
    }
  }

  async reload() {
    logger.info(`[${this.envName}] Reloading page…`);
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    this.frame = null;
    await this._dismissPopup();
    await this._openChatWidget();
    logger.info(`[${this.envName}] Page reloaded`);
  }

  // ── Messaging ────────────────────────────────────────────

  /**
   * Current number of bot-response bubbles in the DOM.
   * Call this BEFORE sendMessage() to get the snapshot count.
   */
  async getBubbleCount() {
    if (!this.frame) return 0;
    return this.frame
      .locator(config.chatbot.responseSelector)
      .count()
      .catch(() => 0);
  }

  /**
   * Send one message and wait for the next stable bot reply.
   *
   * @param {string} question
   * @param {number} expectedBubbleCount  - count snapshot taken BEFORE this send;
   *                                        we wait until count EXCEEDS this value.
   * @param {number} [turnLabel=1]        - used in log messages only
   * @returns {Promise<string>}           - bot reply text
   */
  async sendMessage(question, expectedBubbleCount, turnLabel = 1) {
    const { inputSelector, sendSelector, loadingSelector } = config.chatbot;

    logger.info(
      `[${this.envName}] Turn ${turnLabel}: "${question.slice(0, 80)}${question.length > 80 ? '…' : ''}"`
    );

    const input = this.frame.locator(inputSelector);
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click();
    await input.fill(question);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    await this._sleep(300);

    // Send
    try {
      const sendBtn = this.frame.locator(sendSelector);
      if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await sendBtn.click();
      } else {
        await input.press('Enter');
      }
    } catch {
      await input.press('Enter');
    }

    logger.debug(`[${this.envName}] Submitted — waiting for bubble count > ${expectedBubbleCount}`);

    // Wait for a new bubble (throws on timeout — caller reloads & retries)
    await this._waitForNewResponse(expectedBubbleCount, question, turnLabel);

    if (loadingSelector) {
      await this._waitForLoadingToFinish();
    }

    const text = await this._waitForStableResponse();

    logger.info(
      `[${this.envName}] Reply (turn ${turnLabel}): "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`
    );
    return text;
  }

  // ── Private helpers ──────────────────────────────────────

  async _dismissPopup() {
    const closeSelectors = [
      config.chatbot.popupCloseSelector,
      'button.close',
      '[data-dismiss="modal"]',
      '.modal .close',
      '.modal-close',
      'button[aria-label="Close"]',
      '.modal-header .close',
      'a.close',
      'button:has-text("×")',
      'button:has-text("✕")',
    ].filter(Boolean);

    for (const sel of closeSelectors) {
      try {
        const btn     = this.page.locator(sel).first();
        const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await btn.click();
          logger.info(`[${this.envName}] Dismissed popup: ${sel}`);
          await this._sleep(500);
          return;
        }
      } catch { /* try next */ }
    }
    try { await this.page.keyboard.press('Escape'); } catch { /* ignore */ }
  }

  async _openChatWidget() {
    const iframeSelector = config.chatbot.iframeSelector || 'iframe';
    const toggleSelector = config.chatbot.toggleSelector || '.pmx-chat-head';
    const inputSelector  = config.chatbot.inputSelector  || 'textarea';

    logger.info(`[${this.envName}] Waiting for iframe: ${iframeSelector}`);
    await this.page.waitForSelector(iframeSelector, {
      state:   'attached',
      timeout: config.timing.responseWaitTimeout,
    });

    this.frame = this.page.frameLocator(iframeSelector);
    logger.info(`[${this.envName}] iframe attached`);

    const alreadyOpen = await this.frame
      .locator(inputSelector)
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (alreadyOpen) {
      logger.info(`[${this.envName}] Chat already open`);
    } else {
      logger.info(`[${this.envName}] Clicking toggle: ${toggleSelector}`);
      try {
        await this.frame.locator(toggleSelector).waitFor({
          state:   'visible',
          timeout: config.timing.responseWaitTimeout,
        });
        await this.frame.locator(toggleSelector).click();
      } catch (err) {
        logger.warn(`[${this.envName}] Toggle click failed: ${err.message}`);
      }

      await this.frame.locator(inputSelector).waitFor({
        state:   'visible',
        timeout: config.timing.responseWaitTimeout,
      });
      logger.info(`[${this.envName}] Chat input visible`);
    }

    await this._expandToFullscreen();
  }

  async _expandToFullscreen() {
    try {
      const alreadyFull = await this.frame
        .locator('button[title="Minimize to popup"]')
        .isVisible({ timeout: 1500 });
      if (alreadyFull) return;
    } catch { /* not expanded yet */ }

    const expandSelectors = [
      config.chatbot.expandSelector,
      'button[title="Expand to fullscreen"]',
      'button[aria-label="Expand to fullscreen"]',
      'button[title*="fullscreen" i]',
      'button[title*="expand" i]',
      '.pmx-layout-manager__control-btn:nth-child(2)',
    ].filter(Boolean);

    for (const sel of expandSelectors) {
      try {
        const btn     = this.frame.locator(sel).first();
        const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await btn.click();
          logger.info(`[${this.envName}] Expanded: ${sel}`);
          await this._sleep(800);
          return;
        }
      } catch { /* try next */ }
    }
    logger.warn(`[${this.envName}] Expand button not found — widget mode`);
  }

  async _waitForNewResponse(beforeCount, question, turnLabel) {
    const deadline = Date.now() + config.timing.responseWaitTimeout;
    const locator  = this.frame.locator(config.chatbot.responseSelector);

    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      if (count > beforeCount) {
        const latest = await this._getLastResponseText();
        if (latest && !this._isEcho(latest, question)) {
          logger.debug(`[${this.envName}] New bubble (count: ${count})`);
          return;
        }
      }
      await this._sleep(config.timing.pollInterval);
    }

    throw new Error(
      `[${this.envName}] Timeout: no new response within ` +
      `${config.timing.responseWaitTimeout}ms (turn ${turnLabel})`
    );
  }

  async _waitForLoadingToFinish() {
    const locator  = this.frame.locator(config.chatbot.loadingSelector);
    const deadline = Date.now() + config.timing.responseFinishTimeout;

    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      return;
    }

    while (Date.now() < deadline) {
      if (!await locator.isVisible().catch(() => false)) {
        logger.debug(`[${this.envName}] Loading gone`);
        return;
      }
      await this._sleep(config.timing.pollInterval);
    }
    logger.warn(`[${this.envName}] Loading persisted — proceeding`);
  }

  async _waitForStableResponse() {
    const { responseFinishTimeout, pollInterval, stableDuration } = config.timing;
    const deadline  = Date.now() + responseFinishTimeout;
    let lastText    = '';
    let stableSince = null;

    while (Date.now() < deadline) {
      const text = await this._getLastResponseText();

      const isThinking = THINKING_PHRASES.some(p =>
        text.toLowerCase().includes(p.toLowerCase())
      );
      if (isThinking) {
        lastText    = '';
        stableSince = null;
        await this._sleep(pollInterval);
        continue;
      }

      if (text !== lastText) {
        lastText    = text;
        stableSince = Date.now();
      } else if (stableSince !== null && Date.now() - stableSince >= stableDuration) {
        logger.debug(`[${this.envName}] Stable (${stableDuration}ms)`);
        return lastText;
      }

      await this._sleep(pollInterval);
    }

    if (lastText) {
      logger.warn(`[${this.envName}] Finish timeout — partial text used`);
      return lastText;
    }

    throw new Error(`[${this.envName}] Response finish timeout (${responseFinishTimeout}ms)`);
  }

  async _getLastResponseText() {
    try {
      const locator = this.frame.locator(config.chatbot.responseSelector);
      const count   = await locator.count();
      if (count === 0) return '';
      const raw = (await locator.nth(count - 1).innerText()).trim();
      return raw
        .replace(/[^\u0e00-\u0e7f\u0020-\u007e\u00a0-\u00ff\n]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      return '';
    }
  }

  _isEcho(responseText, question) {
    const a = (responseText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const b = (question     ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return Boolean(a && b && a === b);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default BrowserController;