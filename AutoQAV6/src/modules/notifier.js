import axios from 'axios';
import logger from '../utils/logger.js';
import config from '../config/index.js';

export default class Notifier {
  constructor() {
    this.lineToken = config.notification.lineNotifyToken;
    this.slackWebhook = config.notification.slackWebhookUrl;
    this.enabled = config.notification.notifyOnComplete;
    this.failThreshold = config.notification.notifyFailThreshold;
  }

  async notifyCompletion(results) {
    if (!this.enabled) return;

    const total = results.length;
    const pass = results.filter(r => r.status === 'PASS').length;
    const partial = results.filter(r => r.status === 'PARTIAL').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    
    const failRate = total > 0 ? fail / total : 0;
    const isAlert = failRate >= this.failThreshold;

    let message = `\n📊 [AutoQA] Test Run Completed\n`;
    message += `Total: ${total}\n`;
    message += `✅ PASS: ${pass}\n`;
    message += `⚠️ PARTIAL: ${partial}\n`;
    message += `❌ FAIL: ${fail}\n`;
    
    if (isAlert) {
      message += `\n🚨 ALERT: Fail rate (${(failRate * 100).toFixed(1)}%) exceeded threshold (${this.failThreshold * 100}%)!`;
    }

    await this.sendLineNotify(message);
    await this.sendSlackNotify(message, isAlert);
  }

  async sendLineNotify(message) {
    if (!this.lineToken) return;
    try {
      await axios.post(
        'https://notify-api.line.me/api/notify',
        `message=${encodeURIComponent(message)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Bearer ${this.lineToken}`
          }
        }
      );
      logger.info('LINE notification sent successfully');
    } catch (err) {
      logger.warn('Failed to send LINE notification', { error: err.message });
    }
  }

  async sendSlackNotify(message, isAlert) {
    if (!this.slackWebhook) return;
    try {
      await axios.post(this.slackWebhook, {
        text: message,
        mrkdwn: true,
      });
      logger.info('Slack notification sent successfully');
    } catch (err) {
      logger.warn('Failed to send Slack notification', { error: err.message });
    }
  }
}
