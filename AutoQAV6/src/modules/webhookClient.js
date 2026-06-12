/**
 * src/modules/webhookClient.js
 * ─────────────────────────────────────────────────────────────
 * Sends questions to the chatbot backend via HTTP Webhook API.
 * URL, auth, and payload mapping are configurable via .env.
 *
 * TODO: Fill in WEBHOOK_URL and related settings when API details are available.
 */

import axios from 'axios';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class WebhookError extends Error {
  constructor(message, { status = null, responseBody = null } = {}) {
    super(message);
    this.name = 'WebhookError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

class WebhookClient {
  constructor(overrides = {}) {
    this.cfg = { ...config.webhook, ...overrides };
    this._validateConfig();
    this.client = axios.create({
      baseURL: this.cfg.baseUrl || undefined,
      timeout: this.cfg.requestTimeoutMs,
      headers: this._buildHeaders(),
      validateStatus: () => true,
    });
  }

  _validateConfig() {
    if (!this.cfg.enabled) {
      logger.warn('[WebhookClient] WEBHOOK_ENABLED=false — client ready but calls will be skipped');
      return;
    }

    if (!this.cfg.url && !this.cfg.baseUrl) {
      logger.warn(
        '[WebhookClient] WEBHOOK_URL is not configured yet. ' +
        'Set it in .env when the API endpoint is available.'
      );
    }
  }

  _buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...this._parseExtraHeaders(),
    };

    const authType = (this.cfg.authType || 'none').toLowerCase();

    if (authType === 'bearer' && this.cfg.authToken) {
      headers.Authorization = `Bearer ${this.cfg.authToken}`;
    } else if (authType === 'api-key' && this.cfg.authToken) {
      const headerName = this.cfg.apiKeyHeader || 'X-API-Key';
      headers[headerName] = this.cfg.authToken;
    } else if (authType === 'basic' && this.cfg.authToken) {
      headers.Authorization = `Basic ${this.cfg.authToken}`;
    }

    return headers;
  }

  _parseExtraHeaders() {
    const raw = this.cfg.extraHeaders;
    if (!raw) return {};

    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      logger.warn('[WebhookClient] WEBHOOK_EXTRA_HEADERS is not valid JSON — ignoring');
      return {};
    }
  }

  /**
   * Build outbound request body from a test case.
   * @param {object} testCase
   * @returns {object}
   */
  buildPayload(testCase) {
    const template = this.cfg.payloadTemplate;

    if (template) {
      try {
        const parsed = typeof template === 'string' ? JSON.parse(template) : template;
        return this._fillTemplate(parsed, testCase);
      } catch (err) {
        logger.warn('[WebhookClient] Invalid WEBHOOK_PAYLOAD_TEMPLATE — using default shape');
      }
    }

    const questionField = this.cfg.questionField || 'question';
    const payload = {
      [questionField]: testCase.question,
      testId: testCase.testId ?? null,
      metadata: {
        rowIndex: testCase.rowIndex ?? null,
        expected: testCase.expected ?? null,
      },
    };

    if (this.cfg.sessionId) {
      payload.sessionId = this.cfg.sessionId;
    }

    return payload;
  }

  _fillTemplate(template, testCase) {
    const json = JSON.stringify(template);
    const filled = json
      .replace(/\{\{question\}\}/g, JSON.stringify(testCase.question ?? '').slice(1, -1))
      .replace(/\{\{testId\}\}/g, testCase.testId ?? '')
      .replace(/\{\{expected\}\}/g, JSON.stringify(testCase.expected ?? '').slice(1, -1))
      .replace(/\{\{sessionId\}\}/g, this.cfg.sessionId ?? '');

    return JSON.parse(filled);
  }

  /**
   * Extract bot answer text from webhook response.
   * @param {object} data
   * @returns {string}
   */
  extractAnswer(data) {
    const path = (this.cfg.responseField || 'answer').split('.');
    let current = data;

    for (const key of path) {
      if (current == null || typeof current !== 'object') {
        return '';
      }
      current = current[key];
    }

    if (typeof current === 'string') return current.trim();
    if (current == null) return '';

    return typeof current === 'object' ? JSON.stringify(current) : String(current);
  }

  /**
   * Send one question to the chatbot webhook.
   * @param {string} question
   * @param {object} [meta]
   * @returns {Promise<{ text: string, raw: object, status: number }>}
   */
  async sendQuestion(question, meta = {}) {
    if (!this.cfg.enabled) {
      throw new WebhookError('Webhook is disabled (WEBHOOK_ENABLED=false)');
    }

    const targetUrl = this.cfg.url;
    if (!targetUrl) {
      throw new WebhookError(
        'WEBHOOK_URL is not configured. Add the API endpoint to .env before running.'
      );
    }

    const testCase = { question, ...meta };
    const payload = this.buildPayload(testCase);
    const method = (this.cfg.method || 'POST').toUpperCase();

    logger.info(`[Webhook] ${method} ${targetUrl} — "${question.slice(0, 80)}…"`);

    const response = await this.client.request({
      url: targetUrl,
      method,
      data: payload,
    });

    const { status, data } = response;

    if (status < 200 || status >= 300) {
      throw new WebhookError(
        `Webhook returned HTTP ${status}`,
        { status, responseBody: data }
      );
    }

    const text = this.extractAnswer(data);

    if (!text) {
      throw new WebhookError(
        'Webhook response did not contain an answer',
        { status, responseBody: data }
      );
    }

    logger.info(`[Webhook] Response: "${text.slice(0, 120)}…"`);
    return { text, raw: data, status };
  }

  /**
   * Lightweight health check — optional ping endpoint.
   */
  async healthCheck() {
    const pingUrl = this.cfg.healthCheckUrl;
    if (!pingUrl) {
      logger.debug('[Webhook] No WEBHOOK_HEALTH_CHECK_URL configured — skipping');
      return { ok: true, skipped: true };
    }

    const response = await this.client.get(pingUrl);
    const ok = response.status >= 200 && response.status < 300;

    if (!ok) {
      throw new WebhookError(`Health check failed: HTTP ${response.status}`);
    }

    return { ok: true, status: response.status };
  }
}

export { WebhookError };
export default WebhookClient;
