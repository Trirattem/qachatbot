/**
 * src/modules/browserController.js  (updated)
 * ─────────────────────────────────────────────────────────────
 * เพิ่ม:
 *  - _waitForStableResponse() ส่ง signal กลับมาบอกว่า "เพิ่งเปลี่ยนจาก
 *    กำลังคิด → คำตอบจริง" เพื่อให้ testRunner แคปภาพทันที
 *  - sendMessage() return { text, justFinishedThinking: true/false }
 *    testRunner ใช้ justFinishedThinking เพื่อตัดสินใจแคปเร็วหรือช้า
 */

import { chromium } from 'playwright';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

class BrowserController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.frame = null;
  }

  async init() {
    logger.info('Launching Playwright browser…');
    this.browser = await chromium.launch({
      headless: config.browser.headless,
      slowMo: config.browser.slowMo,
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
      timeout: config.timing.responseWaitTimeout,
    });

    await this._dismissPopup();
    await this._openChatWidget();
    logger.info('Chatbot ready');
  }

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
        const btn = this.page.locator(sel).first();
        const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await btn.click();
          logger.info(`Dismissed popup with: ${sel}`);
          await this._sleep(500);
          return;
        }
      } catch {
        // ลองอันต่อไป
      }
    }

    try {
      await this.page.keyboard.press('Escape');
      logger.debug('Pressed Escape to dismiss any popup');
    } catch { /* ignore */ }
  }

  async _openChatWidget() {
    const iframeSelector = config.chatbot.iframeSelector || 'iframe[src*="index_example.html"]';
    const toggleSelector = config.chatbot.toggleSelector || '.pmx-chat-head';
    const inputSelector = config.chatbot.inputSelector || 'textarea#message-input';

    logger.info(`Waiting for iframe: ${iframeSelector}`);
    await this.page.waitForSelector(iframeSelector, {
      state: 'attached',
      timeout: config.timing.responseWaitTimeout,
    });

    this.frame = this.page.frameLocator(iframeSelector);
    logger.info('iframe attached');

    const alreadyOpen = await this.frame.locator(inputSelector)
      .isVisible({ timeout: 2000 }).catch(() => false);

    if (alreadyOpen) {
      logger.info('Chat panel already open — skipping toggle');
      return;
    }

    logger.info(`Clicking toggle: ${toggleSelector}`);
    try {
      await this.frame.locator(toggleSelector).waitFor({
        state: 'visible',
        timeout: config.timing.responseWaitTimeout,
      });
      await this.frame.locator(toggleSelector).click();
      logger.info('Toggle clicked');
    } catch (err) {
      logger.warn(`Toggle click failed: ${err.message}`);
    }

    await this.frame.locator(inputSelector).waitFor({
      state: 'visible',
      timeout: config.timing.responseWaitTimeout,
    });
    logger.info('Chat input visible');

    await this._expandToFullscreen();
  }

  async _expandToFullscreen() {
    try {
      const alreadyFull = await this.frame
        .locator('button[title="Minimize to popup"]')
        .isVisible({ timeout: 1500 });
      if (alreadyFull) {
        logger.info('Already in fullscreen — skipping expand');
        return;
      }
    } catch { /* not fullscreen yet */ }

    const expandSelectors = [
      config.chatbot.expandSelector,
      'button[title="Expand to fullscreen"]',
      'button[aria-label="Expand to fullscreen"]',
      'button[title*="fullscreen" i]',
      'button[title*="expand" i]',
      'button[aria-label*="fullscreen" i]',
      '.pmx-layout-manager__control-btn:nth-child(2)',
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
      } catch { /* ลองอันต่อไป */ }
    }
    logger.warn('Expand button not found — continuing in widget mode');
  }

  /**
   * ส่งคำถามและรอคำตอบ
   * @returns {{ text: string, justFinishedThinking: boolean }}
   *   justFinishedThinking = true หมายความว่าเพิ่งเปลี่ยนจาก "กำลังคิด"
   *   testRunner ควรแคปภาพทันทีโดยไม่ต้องรอ screenshotDelay
   */
  async sessionHealthCheck() {
    try {
      const { inputSelector } = config.chatbot;
      const input = this.frame.locator(inputSelector);
      const isVisible = await input.isVisible({ timeout: 2000 });
      if (!isVisible) {
        throw new SessionError('Chat input is no longer visible. Session might have expired.');
      }
    } catch (err) {
      if (err.name === 'SessionError') throw err;
      throw new SessionError(`Session health check failed: ${err.message}`);
    }
  }

  async sendMessage(question, attempt = 1) {
    await this.sessionHealthCheck();
    
    try {
      // Wait for network to settle before sending
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } catch { /* ignore network idle timeout */ }

    const { inputSelector, sendSelector, responseSelector, loadingSelector } = config.chatbot;

    logger.info(`Sending (attempt ${attempt}): "${question.slice(0, 80)}…"`);

    const input = this.frame.locator(inputSelector);
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click();
    await input.fill(question);
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    await this._sleep(200);

    const beforeCount = await this.frame.locator(responseSelector).count()
      .catch(() => 0);

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

    logger.debug('Submitted, waiting for response…');

    await this._waitForNewResponse(beforeCount, question, attempt);

    if (loadingSelector) {
      await this._waitForLoadingToFinish();
    }

    // รอให้ข้อความนิ่ง — ได้ทั้งข้อความและ flag "เพิ่งเสร็จจากกำลังคิด"
    const { text, justFinishedThinking } = await this._waitForStableResponse();

    logger.info(`Response (attempt ${attempt}): "${text.slice(0, 120)}…"`);
    return { text, justFinishedThinking };
  }

  async _waitForNewResponse(beforeCount, question, attempt) {
    const deadline = Date.now() + config.timing.responseWaitTimeout;
    const locator = this.frame.locator(config.chatbot.responseSelector);

    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      if (count > beforeCount) {
        const latest = await this._getLastResponseText();
        if (latest && !this._isEchoedQuestion(latest, question)) {
          logger.debug(`New bot bubble appeared (total: ${count})`);
          return;
        }
        logger.debug(`New bubble appeared (total: ${count})`);
      }
      await this._sleep(config.timing.pollInterval);
    }

    throw new Error(
      `Timeout: no new response within ${config.timing.responseWaitTimeout}ms (attempt ${attempt})`
    );
  }

  async _waitForLoadingToFinish() {
    const locator = this.frame.locator(config.chatbot.loadingSelector);
    const deadline = Date.now() + config.timing.responseFinishTimeout;

    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      return;
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

  /**
   * รอให้ข้อความนิ่งและไม่ใช่ placeholder
   *
   * คืนค่า:
   *   { text: string, justFinishedThinking: boolean }
   *
   * justFinishedThinking = true เมื่อ:
   *   - ก่อนหน้านี้เห็น thinking phrase อยู่
   *   - แล้วข้อความเปลี่ยนเป็นคำตอบจริง
   *   → testRunner รู้ว่าควรแคปเลย ไม่ต้องรอ screenshotDelay
   */
  async _waitForStableResponse() {
    const { responseFinishTimeout, pollInterval, stableDuration } = config.timing;

    const deadline = Date.now() + responseFinishTimeout;
    let lastText = '';
    let stableSince = null;
    let wasThinking = false; // เคยเจอ thinking phrase มาก่อน
    let justFlipped = false; // เพิ่งเปลี่ยนจาก thinking → คำตอบ

    while (Date.now() < deadline) {
      const text = await this._getLastResponseText();

      const isThinking = config.chatbot.thinkingPhrases.some(p =>
        text.toLowerCase().includes(p)
      );

      if (isThinking) {
        // ยังคิดอยู่
        wasThinking = true;
        lastText = '';
        stableSince = null;
        justFlipped = false;
        await this._sleep(pollInterval);
        continue;
      }

      // ตรวจว่าเพิ่งเปลี่ยนจาก thinking → คำตอบ
      if (wasThinking && text && text !== lastText) {
        justFlipped = true;
        wasThinking = false;
        logger.debug('Thinking ended → answer appeared, ready to screenshot');
      }

      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      } else if (stableSince !== null) {
        if (Date.now() - stableSince >= stableDuration) {
          logger.debug(`Stable for ${stableDuration}ms`);
          return { text: lastText, justFinishedThinking: justFlipped };
        }
      }

      await this._sleep(pollInterval);
    }

    if (lastText) {
      logger.warn('Finish timeout — using partial text');
      return { text: lastText, justFinishedThinking: justFlipped };
    }

    throw new Error(`Response finish timeout (${responseFinishTimeout}ms)`);
  }

  async _getLastResponseText() {
    try {
      const locator = this.frame.locator(config.chatbot.responseSelector);
      const count = await locator.count();
      if (count === 0) return '';
      const raw = (await locator.nth(count - 1).innerText()).trim();
      // Don't strip too many characters to support emojis and symbols
      return raw.replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  _isEchoedQuestion(responseText, question) {
    const response = (responseText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const sent = (question ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return Boolean(response && sent && response === sent);
  }

  _normaliseForEchoCheck(text) {
    return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async takeScreenshot(filePath) {
    try {
      await this.page.screenshot({ path: filePath, fullPage: false });
      logger.debug(`Screenshot: ${filePath}`);
    } catch (err) {
      logger.error('Screenshot failed', { error: err.message });
    }
  }

  async reload() {
    logger.info('Reloading page…');
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    this.frame = null;
    await this._dismissPopup();
    await this._openChatWidget();
  }

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