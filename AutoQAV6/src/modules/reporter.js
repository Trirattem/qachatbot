/**
 * src/modules/reporter.js
 * ─────────────────────────────────────────────────────────────
 * Generates a human-readable HTML summary report after the run.
 * Saved to:  reports/report_{timestamp}.html
 * 
 * Also generates a CSV version of the results.
 * Also prints a quick ASCII summary table to the console.
 */

import fs from 'fs';
import path from 'path';
import { format as dateFormat } from 'date-fns';
import chalk from 'chalk';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import { STATUS } from './classifier.js';

const colourStatus = s => ({
  [STATUS.PASS]:    chalk.bgGreen.black(` ${s} `),
  [STATUS.PARTIAL]: chalk.bgYellow.black(` ${s} `),
  [STATUS.FAIL]:    chalk.bgRed.white(` ${s} `),
}[s] ?? s);

class Reporter {
  constructor() {
    fs.mkdirSync(config.paths.reports, { recursive: true });
  }

  async generate(results, title = '') {
    this._printConsoleSummary(results);
    const timestamp = dateFormat(new Date(), 'yyyyMMdd_HHmmss');
    const safeTitle = title ? title.replace(/[^a-zA-Z0-9_\u0E00-\u0E7F]/g, '_') : '';
    const prefix = safeTitle ? `${safeTitle}_report` : 'report';
    
    const htmlPath = this._writeHtml(results, timestamp, prefix);
    const csvPath = this._writeCsv(results, timestamp, prefix);
    logger.info(`HTML report saved: ${htmlPath}`);
    logger.info(`CSV report saved: ${csvPath}`);
    return htmlPath;
  }

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
      const sim = `${((r.similarity || 0) * 100).toFixed(1)}%`;
      console.log(
        (r.testId || '').padEnd(idW) +
        colourStatus(r.status || 'FAIL').padEnd(statW + 10) +
        sim.padEnd(simW) +
        (r.reason ?? '').slice(0, 40)
      );
    }
    console.log(chalk.bold('─'.repeat(70)) + '\n');
  }

  _writeCsv(results, timestamp, prefix) {
    const filename = `${prefix}_${timestamp}.csv`;
    const outPath = path.join(config.paths.reports, filename);
    
    let csv = '\uFEFF'; // BOM for Excel
    csv += 'Test ID,Status,Similarity,Question,Expected,Actual,Reason,Timestamp,Screenshot\n';
    
    for (const r of results) {
      const row = [
        r.testId,
        r.status,
        (r.similarity || 0).toFixed(4),
        r.question,
        r.expected,
        r.actual,
        r.reason,
        r.timestamp,
        r.screenshotPath || ''
      ].map(val => `"${String(val ?? '').replace(/"/g, '""')}"`);
      
      csv += row.join(',') + '\n';
    }
    
    fs.writeFileSync(outPath, csv, 'utf8');
    return outPath;
  }

  _writeHtml(results, timestamp, prefix) {
    const filename = `${prefix}_${timestamp}.html`;
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
        <tr style="background:${bgColor}" class="row-${r.status}">
          <td>${esc(r.testId)}</td>
          <td>${esc(r.question ?? '')}</td>
          <td>${esc(r.expected ?? '')}</td>
          <td>${esc(r.actual ?? '')}</td>
          <td><strong>${esc(r.status)}</strong></td>
          <td>${((r.similarity || 0) * 100).toFixed(1)}%</td>
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
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; color: #333; }
    h1   { color: #2c3e50; }
    .summary-container { display: flex; align-items: center; gap: 40px; margin-bottom: 20px; }
    .chart-container { width: 300px; height: 300px; }
    .summary { display:flex; flex-direction: column; gap:10px; }
    .badge { padding:8px 16px; border-radius:6px; font-weight:bold; font-size:18px; cursor: pointer; border: 2px solid transparent; }
    .badge:hover { opacity: 0.8; }
    .badge.active { border-color: #000; box-shadow: 0 0 5px rgba(0,0,0,0.3); }
    .pass    { background:#28a745; color:#fff; }
    .partial { background:#ffc107; color:#333; }
    .fail    { background:#dc3545; color:#fff; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th    { background:#343a40; color:#fff; padding:8px; text-align:left; }
    td    { padding:7px 8px; border-bottom:1px solid #dee2e6; vertical-align:top; }
    td:nth-child(3), td:nth-child(4) { max-width:260px; word-break:break-word; }
    .controls { margin-bottom: 15px; }
    .btn { padding: 8px 15px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .btn:hover { background: #0056b3; }
  </style>
</head>
<body>
  <h1>🤖 Chatbot QA Automation Report</h1>
  <p>Generated: ${dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss')}</p>

  <div class="summary-container">
    <div class="chart-container">
      <canvas id="resultChart"></canvas>
    </div>
    <div class="summary">
      <div class="badge pass" onclick="filterStatus('PASS')" id="btn-PASS">✅ PASS: ${counts.PASS}</div>
      <div class="badge partial" onclick="filterStatus('PARTIAL')" id="btn-PARTIAL">⚠️ PARTIAL: ${counts.PARTIAL}</div>
      <div class="badge fail" onclick="filterStatus('FAIL')" id="btn-FAIL">❌ FAIL: ${counts.FAIL}</div>
      <div class="badge" style="background:#6c757d;color:#fff" onclick="filterStatus('ALL')" id="btn-ALL">Total: ${results.length} (Show All)</div>
    </div>
  </div>

  <div class="controls">
    <a href="report_${timestamp}.csv" download class="btn">⬇️ Export CSV</a>
  </div>

  <table>
    <thead>
      <tr>
        <th>Test ID</th><th>Question</th><th>Expected</th><th>Actual</th>
        <th>Status</th><th>Similarity</th><th>Reason</th><th>Timestamp</th><th>Screenshot</th>
      </tr>
    </thead>
    <tbody id="table-body">
      ${rows}
    </tbody>
  </table>

  <script>
    // Chart initialization
    const ctx = document.getElementById('resultChart').getContext('2d');
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['PASS', 'PARTIAL', 'FAIL'],
        datasets: [{
          data: [${counts.PASS}, ${counts.PARTIAL}, ${counts.FAIL}],
          backgroundColor: ['#28a745', '#ffc107', '#dc3545']
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom' }
        }
      }
    });

    // Filtering logic
    function filterStatus(status) {
      document.querySelectorAll('.badge').forEach(b => b.classList.remove('active'));
      document.getElementById('btn-' + status).classList.add('active');

      const rows = document.querySelectorAll('tbody tr');
      rows.forEach(row => {
        if (status === 'ALL') {
          row.style.display = '';
        } else {
          if (row.classList.contains('row-' + status)) {
            row.style.display = '';
          } else {
            row.style.display = 'none';
          }
        }
      });
    }
    filterStatus('ALL');
  </script>
</body>
</html>`;

    fs.writeFileSync(outPath, html, 'utf8');
    return outPath;
  }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default Reporter;
