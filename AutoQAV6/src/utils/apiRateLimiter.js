import logger from './logger.js';
import config from '../config/index.js';

class ApiRateLimiter {
  constructor(maxRequestsPerMin) {
    this.maxRequests = maxRequestsPerMin;
    this.tokens = maxRequestsPerMin;
    this.lastRefill = Date.now();
    this.queue = [];
    this.isProcessing = false;
  }

  _refill() {
    const now = Date.now();
    const elapsedMinutes = (now - this.lastRefill) / 60000;
    if (elapsedMinutes > 0) {
      const add = Math.floor(elapsedMinutes * this.maxRequests);
      if (add > 0) {
        this.tokens = Math.min(this.maxRequests, this.tokens + add);
        this.lastRefill = now;
      }
    }
  }

  async acquire() {
    this._refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    return new Promise(resolve => {
      this.queue.push(resolve);
      this._processQueue();
    });
  }

  _processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const interval = setInterval(() => {
      this._refill();
      while (this.queue.length > 0 && this.tokens > 0) {
        this.tokens--;
        const resolve = this.queue.shift();
        resolve();
      }
      if (this.queue.length === 0) {
        clearInterval(interval);
        this.isProcessing = false;
      }
    }, 1000);
  }

  async execute(fn) {
    await this.acquire();
    try {
      return await fn();
    } catch (error) {
      // Handle 429 Too Many Requests
      if (error.code === 429 || (error.response && error.response.status === 429)) {
        logger.warn('Rate limit hit (429). Backing off for 10s...');
        await new Promise(r => setTimeout(r, 10000));
        return this.execute(fn); // retry once
      }
      throw error;
    }
  }
}

// Global instance using configured limit
export const googleApiLimiter = new ApiRateLimiter(config.system.googleApiMaxRequestsPerMin);
