#!/usr/bin/env node
/**
 * migrate_checkpoint.js
 * ─────────────────────────────────────────────────────────────
 * อัปเกรด checkpoint JSON เดิม (ไม่มี writtenToDocs)
 * ให้รองรับ two-phase architecture ใหม่
 *
 * Usage:
 *   node migrate_checkpoint.js [path/to/progress_xxx.json]
 *
 * ถ้าไม่ระบุ path จะค้นหา progress_*.json ใน logs/ อัตโนมัติ
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { format as dateFormat } from 'date-fns';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findCheckpoints(logsDir) {
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir)
    .filter(f => f.startsWith('progress_') && f.endsWith('.json'))
    .map(f => path.join(logsDir, f));
}

function migrate(filePath) {
  console.log(`\n📂 อ่าน: ${filePath}`);
  
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`  ❌ อ่านไม่ได้: ${err.message}`);
    return;
  }

  const completed = data.completed ?? {};
  let migrated = 0;
  let alreadyNew = 0;

  for (const [testId, entry] of Object.entries(completed)) {
    if (typeof entry.writtenToDocs === 'boolean') {
      alreadyNew++;
      continue;
    }
    // เดิมไม่มี writtenToDocs — ถือว่ายังไม่ได้ write (false)
    // แต่ถ้ามี status แสดงว่าผ่าน browser phase มาแล้ว
    entry.writtenToDocs = false;
    // ถ้าไม่มี actual/reason ให้ใส่ค่าว่าง
    if (entry.actual === undefined) entry.actual = '';
    if (entry.reason === undefined) entry.reason = '';
    if (entry.attempts === undefined) entry.attempts = 1;
    if (entry.selectedAttempt === undefined) entry.selectedAttempt = 1;
    migrated++;
  }

  if (migrated === 0 && alreadyNew > 0) {
    console.log(`  ✅ ไม่ต้อง migrate (${alreadyNew} entries เป็น format ใหม่แล้ว)`);
    return;
  }

  // backup ก่อน
  const backupPath = filePath + '.backup_' + dateFormat(new Date(), 'yyyyMMdd_HHmmss');
  fs.copyFileSync(filePath, backupPath);
  console.log(`  💾 backup → ${backupPath}`);

  data.updatedAt = dateFormat(new Date(), 'yyyy-MM-dd HH:mm:ss');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

  console.log(`  ✅ migrate แล้ว ${migrated} entries`);
  console.log(`  ℹ️  writtenToDocs = false ทุก entry`);
  console.log(`     (ใช้ --docs-only เพื่อ write ทั้งหมดลง Google Docs)`);
}

// ── main ──────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.length > 0) {
  // migrate ไฟล์ที่ระบุ
  for (const f of args) {
    migrate(path.resolve(f));
  }
} else {
  // ค้นหาอัตโนมัติ
  const logsDir = path.resolve(__dirname, '../logs');
  const files = findCheckpoints(logsDir);
  
  if (files.length === 0) {
    console.log('ไม่พบ checkpoint files ใน logs/');
    console.log('Usage: node migrate_checkpoint.js [path/to/progress_xxx.json]');
  } else {
    console.log(`พบ ${files.length} checkpoint file(s)`);
    for (const f of files) {
      migrate(f);
    }
  }
}

console.log('\nเสร็จสิ้น');
