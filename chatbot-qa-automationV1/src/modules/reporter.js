/**
 * src/modules/reporter.js
 * ─────────────────────────────────────────────────────────────
 * Generates a human-readable HTML summary report after the run.
 * Saved to:  reports/report_{timestamp}.html
 *
 * Also prints a quick ASCII summary table to the console.
 */

import fs from 'fs';
import path from 'path';
import { format as dateFormat } from 'date-fns';
import chalk from 'chalk';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { STATUS } from './classifier.js';

// ── Colour helpers for console ────────────────────────────────
const colourStatus = s => ({
  [STATUS.PASS]:    chalk.bgGreen.black(` ${s} `),
  [STATUS.PARTIAL]: chalk.bgYellow.black(` ${s} `),
  [STATUS.FAIL]:    chalk.bgRed.white(` ${s} `),
}[s] ?? s);

class Reporter {
  constructor() {
    fs.mkdirSync(config.paths.reports, { recursive: true });
  }

  /**
   * Print console summary and write HTML report.
   * @param {object[]} results  - array of result objects from TestRunner
   */
  async generate(results) {
    this._printConsoleSummary(results);
    const htmlPath = this._writeHtml(results);
    logger.info(`HTML report saved: ${htmlPath}`);
    return htmlPath;
  }

  // ── Console summary ───────────────────────────────────────
  _printConsoleSummary(results) {
    const counts = { PASS: 0, PARTIAL: 0, FAIL: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

    console.log('\n' + chalk.bold('─'.repeat(70)));
    console.log(chalk.bold(' CHATBOT QA RUN SUMMARY'));
    console.log(chalk.bold('─'.repeat(70)));
    console.log(
      ` Total: ${results.length}  |  ` +
      chalk.green(`PASS: ${counts.PASS}`) + '  |  ' +
      chalk.yellow(`PARTIAL: ${counts.PARTIAL}`) + '  |  ' +
      chalk.red(`FAIL: ${counts.FAIL}`)
    );
    console.log(chalk.bold('─'.repeat(70)));

    // Per-test table
    const idW   = 12;
    const statW = 9;
    const simW  = 8;
    const hdr =
      chalk.bold('Test ID'.padEnd(idW)) +
      chalk.bold('Status'.padEnd(statW)) +
      chalk.bold('Sim%'.padEnd(simW)) +
      chalk.bold('Reason');
    console.log(hdr);
    console.log('─'.repeat(70));

    for (const r of results) {
      const sim = `${(r.similarity * 100).toFixed(1)}%`;
      console.log(
        r.testId.padEnd(idW) +
        colourStatus(r.status).padEnd(statW + 10) + // extra for ANSI escape chars
        sim.padEnd(simW) +
        (r.reason ?? '').slice(0, 40)
      );
    }
    console.log(chalk.bold('─'.repeat(70)) + '\n');
  }

  // ── HTML report ────────────────────────────────────────────
  _writeHtml(results) {
    const timestamp = dateFormat(new Date(), 'yyyyMMdd_HHmmss');
    const filename  = `report_${timestamp}.html`;
    const outPath   = path.join(config.paths.reports, filename);

    const counts = { PASS: 0, PARTIAL: 0, FAIL: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

    const rows = results.map(r => {
      const bgColor = {
        PASS:    '#d4edda',
        PARTIAL: '#fff3cd',
        FAIL:    '#f8d7da',
      }[r.status] ?? '#fff';

      const screenshotLink = r.screenshotPath
        ? `<a href="../${r.screenshotPath}" target="_blank">📷 View</a>`
        : '–';

      return `
        <tr style="background:${bgColor}">
          <td>${esc(r.testId)}</td>
          <td>${esc(r.question ?? '')}</td>
          <td>${esc(r.expected ?? '')}</td>
          <td>${esc(r.actual ?? '')}</td>
          <td><strong>${esc(r.status)}</strong></td>
          <td>${(r.similarity * 100).toFixed(1)}%</td>
          <td>${esc(r.reason ?? '')}</td>
          <td>${esc(r.timestamp ?? '')}</td>
          <td>${screenshotLink}</td>
        </tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Chatbot QA Report — ${timestamp}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; color: #333; }
    h1   { color: #2c3e50; }
    .summary { display:flex; gap:20px; margin:16px 0; }
    .badge { padding:8px 16px; border-radius:6px; font-weight:bold; font-size:18px; }
    .pass    { background:#28a745; color:#fff; }
    .partial { background:#ffc107; color:#333; }
    .fail    { background:#dc3545; color:#fff; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th    { background:#343a40; color:#fff; padding:8px; text-align:left; }
    td    { padding:7px 8px; border-bottom:1px solid #dee2e6; vertical-align:top; }
    td:nth-child(3), td:nth-child(4) { max-width:260px; word-break:break-word; }
  </style>
</head>
<body>
  <h1>🤖 Chatbot QA Automation Report</h1>
  <p>Generated: ${dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss')}</p>

  <div class="summary">
    <div class="badge pass">✅ PASS: ${counts.PASS}</div>
    <div class="badge partial">⚠️ PARTIAL: ${counts.PARTIAL}</div>
    <div class="badge fail">❌ FAIL: ${counts.FAIL}</div>
    <div class="badge" style="background:#6c757d;color:#fff">Total: ${results.length}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Test ID</th><th>Question</th><th>Expected</th><th>Actual</th>
        <th>Status</th><th>Similarity</th><th>Reason</th><th>Timestamp</th><th>Screenshot</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;

    fs.writeFileSync(outPath, html, 'utf8');
    return outPath;
  }
}

// HTML-escape helper
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default Reporter;
