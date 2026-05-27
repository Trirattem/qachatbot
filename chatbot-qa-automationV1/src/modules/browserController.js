/**
 * src/modules/browserController.js
 * ─────────────────────────────────────────────────────────────
 * Chatbot widget lives inside a cross-origin iframe.
 * Uses Playwright frameLocator() to pierce it.
 *
 * Key fixes vs previous version:
 *  1. Dismiss popup modal on the HOST page before opening widget
 *  2. Toggle is only clicked when the input is NOT already visible
 *     (prevents clicking again on reload which would CLOSE the widget)
 *  3. "คิดลักครูนะคะ" / thinking animation is treated as loading —
 *     we wait for it to be REPLACED by real text before stabilising
 */

import { chromium } from 'playwright';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class BrowserController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page    = null;
    this.frame   = null;
  }

  // ── Launch browser and navigate to the chatbot ─────────────
  async init() {
    logger.info('Launching Playwright browser…');
    this.browser = await chromium.launch({
      headless: config.browser.headless,
      slowMo:   config.browser.slowMo,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this.context = await this.browser.newContext({
      viewport: config.browser.viewport,
      ignoreHTTPSErrors: true,
    });

    this.page = await this.context.newPage();
    this.page.on('pageerror', err =>
      logger.warn('Page JS error', { error: err.message })
    );

    logger.info(`Navigating to: ${config.chatbot.url}`);
    await this.page.goto(config.chatbot.url, {
      waitUntil: 'domcontentloaded',
      timeout:   config.timing.responseWaitTimeout,
    });

    // ── Dismiss any popup / modal on the HOST page ────────────
    await this._dismissPopup();

    // ── Attach to iframe and open chat widget ─────────────────
    await this._openChatWidget();

    logger.info('Chatbot ready');
  }

  // ── Close any popup modal on the main page ─────────────────
  async _dismissPopup() {
    // Common close button patterns: ×, ✕, close, .modal button, etc.
    const closeSelectors = [
      config.chatbot.popupCloseSelector,  // from .env if set
      'button.close',
      '[data-dismiss="modal"]',
      '.modal .close',
      '.modal-close',
      'button[aria-label="Close"]',
      // The × button visible in the screenshot
      '.modal-header .close',
      'a.close',
      // Generic: any visible × button NOT inside the chatbot iframe
      'button:has-text("×")',
      'button:has-text("✕")',
    ].filter(Boolean);

    for (const sel of closeSelectors) {
      try {
        const btn = this.page.locator(sel).first();
        const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await btn.click();
          logger.info(`Dismissed popup with: ${sel}`);
          await this._sleep(500);
          return;
        }
      } catch {
        // try next selector
      }
    }

    // Fallback: press Escape
    try {
      await this.page.keyboard.press('Escape');
      logger.debug('Pressed Escape to dismiss any popup');
    } catch { /* ignore */ }
  }

  // ── Attach frameLocator and open chat panel if needed ──────
  async _openChatWidget() {
    const iframeSelector = config.chatbot.iframeSelector  || 'iframe[src*="index_example.html"]';
    const toggleSelector = config.chatbot.toggleSelector  || '.pmx-chat-head';
    const inputSelector  = config.chatbot.inputSelector   || 'textarea#message-input';

    // Wait for iframe to exist in DOM
    logger.info(`Waiting for iframe: ${iframeSelector}`);
    await this.page.waitForSelector(iframeSelector, {
      state:   'attached',
      timeout: config.timing.responseWaitTimeout,
    });

    this.frame = this.page.frameLocator(iframeSelector);
    logger.info('iframe attached');

    // Check if chat input is already visible (widget already open)
    const alreadyOpen = await this.frame.locator(inputSelector)
      .isVisible({ timeout: 2000 }).catch(() => false);

    if (alreadyOpen) {
      logger.info('Chat panel already open — skipping toggle');
      return;
    }

    // Click toggle to open
    logger.info(`Clicking toggle: ${toggleSelector}`);
    try {
      await this.frame.locator(toggleSelector).waitFor({
        state:   'visible',
        timeout: config.timing.responseWaitTimeout,
      });
      await this.frame.locator(toggleSelector).click();
      logger.info('Toggle clicked');
    } catch (err) {
      logger.warn(`Toggle click failed: ${err.message}`);
    }

    // Wait for input to appear
    await this.frame.locator(inputSelector).waitFor({
      state:   'visible',
      timeout: config.timing.responseWaitTimeout,
    });
    logger.info('Chat input visible');

    // ── Click fullscreen / expand button ─────────────────────
    await this._expandToFullscreen();
  }

  // ── Click the expand-to-fullscreen button in the widget header
  async _expandToFullscreen() {
    // If already fullscreen, "Minimize to popup" button is visible — skip
    try {
      const alreadyFull = await this.frame
        .locator('button[title="Minimize to popup"]')
        .isVisible({ timeout: 1500 });
      if (alreadyFull) {
        logger.info('Already in fullscreen — skipping expand');
        return;
      }
    } catch { /* not fullscreen yet, continue */ }

    // Selectors for expand button (popup → fullscreen)
    const expandSelectors = [
      config.chatbot.expandSelector,                   // from .env
      'button[title="Expand to fullscreen"]',
      'button[aria-label="Expand to fullscreen"]',
      'button[title*="fullscreen" i]',
      'button[title*="expand" i]',
      'button[aria-label*="fullscreen" i]',
      '.pmx-layout-manager__control-btn:nth-child(2)', // 2nd control btn in header
    ].filter(Boolean);

    for (const sel of expandSelectors) {
      try {
        const btn = this.frame.locator(sel).first();
        const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await btn.click();
          logger.info(`Expanded to fullscreen with: ${sel}`);
          await this._sleep(800);
          return;
        }
      } catch { /* try next */ }
    }
    logger.warn('Expand button not found — continuing in widget mode');
  }

  // ── Send a question and return the chatbot's full response ──
  async sendMessage(question, attempt = 1) {
    const { inputSelector, sendSelector, responseSelector, loadingSelector } = config.chatbot;

    logger.info(`Sending (attempt ${attempt}): "${question.slice(0, 80)}…"`);

    // ── 1. Fill the question ──────────────────────────────────
    // Use fill() instead of type() — fill() sets the value atomically
    // which avoids Thai character truncation in React controlled inputs.
    const input = this.frame.locator(inputSelector);
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click();
    await input.fill(question);
    // Trigger React synthetic events so the send button activates
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    await this._sleep(200);

    // ── 2. Count existing bubbles BEFORE sending ──────────────
    const beforeCount = await this.frame.locator(responseSelector).count()
      .catch(() => 0);

    // ── 3. Send ───────────────────────────────────────────────
    try {
      const sendBtn = this.frame.locator(sendSelector);
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
      } else {
        await input.press('Enter');
      }
    } catch {
      await input.press('Enter');
    }

    logger.debug(`Submitted, waiting for response…`);

    // ── 4. Wait for a NEW bubble to appear ────────────────────
    await this._waitForNewResponse(beforeCount, attempt);

    // ── 5. Wait for loading indicator to disappear ───────────
    if (loadingSelector) {
      await this._waitForLoadingToFinish();
    }

    // ── 6. Wait for response text to stabilise ───────────────
    //    Also wait until the "thinking" placeholder is gone
    const finalText = await this._waitForStableResponse();

    logger.info(`Response (attempt ${attempt}): "${finalText.slice(0, 120)}…"`);
    return finalText;
  }

  // ── Wait until a new response bubble count increases ───────
  async _waitForNewResponse(beforeCount, attempt) {
    const deadline = Date.now() + config.timing.responseWaitTimeout;
    const locator  = this.frame.locator(config.chatbot.responseSelector);

    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      if (count > beforeCount) {
        logger.debug(`New bubble appeared (total: ${count})`);
        return;
      }
      await this._sleep(config.timing.pollInterval);
    }

    throw new Error(
      `Timeout: no new response within ${config.timing.responseWaitTimeout}ms (attempt ${attempt})`
    );
  }

  // ── Wait for loading / typing indicator to disappear ───────
  async _waitForLoadingToFinish() {
    const locator  = this.frame.locator(config.chatbot.loadingSelector);
    const deadline = Date.now() + config.timing.responseFinishTimeout;

    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      return; // Never appeared
    }

    while (Date.now() < deadline) {
      if (!await locator.isVisible().catch(() => false)) {
        logger.debug('Loading indicator gone');
        return;
      }
      await this._sleep(config.timing.pollInterval);
    }
    logger.warn('Loading indicator never disappeared — proceeding');
  }

  // ── Poll last bubble until text is stable AND not a placeholder
  async _waitForStableResponse() {
    const { responseFinishTimeout, pollInterval, stableDuration } = config.timing;

    // Phrases that mean "still thinking" — don't treat as final
    const thinkingPhrases = [
      'คิดลักครูนะคะ',
      'กำลังคิด',
      'กรุณารอสักครู่',
      'typing',
      '...',
    ];

    const deadline  = Date.now() + responseFinishTimeout;
    let lastText    = '';
    let stableSince = null;

    while (Date.now() < deadline) {
      const text = await this._getLastResponseText();

      // If still showing a thinking placeholder, reset and keep waiting
      const isThinking = thinkingPhrases.some(p =>
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
      } else if (stableSince !== null) {
        if (Date.now() - stableSince >= stableDuration) {
          logger.debug(`Stable for ${stableDuration}ms`);
          return lastText;
        }
      }

      await this._sleep(pollInterval);
    }

    if (lastText) {
      logger.warn('Finish timeout — using partial text');
      return lastText;
    }

    throw new Error(`Response finish timeout (${responseFinishTimeout}ms)`);
  }

  // ── Get innerText of the last response bubble ──────────────
  async _getLastResponseText() {
    try {
      const locator = this.frame.locator(config.chatbot.responseSelector);
      const count   = await locator.count();
      if (count === 0) return '';
      const raw = (await locator.nth(count - 1).innerText()).trim();
      // Strip non-Thai/non-ASCII garbage characters (e.g. CJK from rendering artifacts)
      return raw.replace(/[^\u0e00-\u0e7f\u0020-\u007e\u00a0-\u00ff\n]/g, '').replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  // ── Screenshot ─────────────────────────────────────────────
  async takeScreenshot(filePath) {
    try {
      await this.page.screenshot({ path: filePath, fullPage: false });
      logger.debug(`Screenshot: ${filePath}`);
    } catch (err) {
      logger.error('Screenshot failed', { error: err.message });
    }
  }

  // ── Reload and re-open widget ──────────────────────────────
  async reload() {
    logger.info('Reloading page…');
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    this.frame = null;
    await this._dismissPopup();
    await this._openChatWidget();
  }

  // ── Shutdown ───────────────────────────────────────────────
  async close() {
    if (this.browser) {
      await this.browser.close();
      logger.info('Browser closed');
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default BrowserController;