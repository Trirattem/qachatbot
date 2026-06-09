import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import logger from '../utils/logger.js';
import config from '../config/index.js';

export default class RangeCoordinator {
  constructor(datasetName = 'latest.json') {
    const dir = config.paths.logs || './logs';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.queueFile = path.join(dir, `${datasetName}.queue.json`);
  }

  async initQueue(testCases) {
    if (!fs.existsSync(this.queueFile)) {
      const queue = testCases.map(tc => tc.testId);
      fs.writeFileSync(
        this.queueFile,
        JSON.stringify({ pending: queue, processing: {}, done: [] }, null, 2),
        'utf8'
      );
      logger.info(`[RangeCoordinator] Initialized queue with ${queue.length} items`);
    }
  }

  async acquireNext(instanceId, batchSize = 1) {
    if (!fs.existsSync(this.queueFile)) return [];

    let release;
    try {
      release = await lockfile.lock(this.queueFile, { retries: 5 });
      const data = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));

      if (data.pending.length === 0) {
        return [];
      }

      const acquired = data.pending.splice(0, batchSize);
      acquired.forEach(id => {
        data.processing[id] = { instanceId, startedAt: Date.now() };
      });

      fs.writeFileSync(this.queueFile, JSON.stringify(data, null, 2), 'utf8');
      return acquired;
    } catch (err) {
      logger.error('Failed to acquire from queue', { error: err.message });
      return [];
    } finally {
      if (release) await release();
    }
  }

  async markDone(testId) {
    if (!fs.existsSync(this.queueFile)) return;

    let release;
    try {
      release = await lockfile.lock(this.queueFile, { retries: 5 });
      const data = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));

      if (data.processing[testId]) {
        delete data.processing[testId];
      }
      if (!data.done.includes(testId)) {
        data.done.push(testId);
      }

      fs.writeFileSync(this.queueFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`Failed to mark ${testId} as done in queue`, { error: err.message });
    } finally {
      if (release) await release();
    }
  }
}
