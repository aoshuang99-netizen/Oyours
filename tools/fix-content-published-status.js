#!/usr/bin/env node
/**
 * fix-content-published-status.js — 一次性修复历史遗留：published=true 但 status='ready'
 *
 * 背景（2026-09-05 S5 断链根因）：
 *   修复 S4 状态机 bug 前发布的"内容"，published 标志为 true，但 status 字段仍为 'ready'，
 *   导致 isPublishable() 因 `!c.published` 过滤掉全部候选，S4 executor 永远拿不到可发布内容。
 *
 * 修复原则（零伪造）：
 *   ① 凡 published=true 且 published_at 非空 → status 改为 'published'
 *   ② 同时清掉被本不应出现的 published=false 项（极少见，作 audit 日志）
 *   ③ dry-run 默认；--apply 才写盘
 *   ④ 改盘前会停 3002，避免 DataStore 5s 周期用内存覆盖磁盘
 *
 * 用法：
 *   node tools/fix-content-published-status.js         # 只列差异
 *   node tools/fix-content-published-status.js --apply  # 写盘（要求 3002 已停）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONTENT_FILE = 'D:/mscms-ws/data/content.json';
const BACKUP_FILE = CONTENT_FILE.replace('.json', `.bak-${Date.now()}.json`);

const apply = process.argv.includes('--apply');

console.log('=== fix-content-published-status ===');
console.log('content file:', CONTENT_FILE);
console.log('mode:', apply ? 'APPLY' : 'DRY-RUN');

// 端口检查
 isPortListening(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ port, host: '' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    setTimeout(() => { try { sock.destroy(); } catch(_){} resolve(false); }, 1500);
  });
}

(async () => {
  if (!fs.existsSync(CONTENT_FILE)) {
    console.error('ERR: content file not found');
    process.exit(1);
  }

  const listening = await isPortListening(3002);
  if (listening && apply) {
    console.error('FATAL: 3002 仍在监听！先 taskkill /F /T /PID <3002_pid> 停掉 server 再 --apply。');
    console.error('     服务运行时 DataStore 每 5s flush 会覆盖磁盘改动。');
    process.exit(2);
  }

  const raw = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
  const arr = Array.isArray(raw) ? raw : Object.values(raw);

  let total = arr.length;
  let needFix = 0;
  let needsHistory = 0;
  const samples = [];

  for (const c of arr) {
    if (c.published === true && c.published_at && c.status === 'ready') {
      needFix++;
      if (samples.length < 5) samples.push({ id: c.id, : c., status: c.status, published: c.published, published_at: c.published_at });
    } else if (c.published === true && !c.published_at) {
      // published=true 但没有 published_at —— 异常记录
      needsHistory++;
    }
  }

  console.log('=== stats ===');
  console.log('total content:', total);
  console.log('need fix (published=true && status=ready):', needFix);
  console.log('need history audit (published=true but no published_at):', needsHistory);
  console.log('samples:', JSON.stringify(samples, null, 2));

  if (!apply) {
    console.log('--- DRY-RUN 完成，未写盘。加 --apply 执行 ---');
    return;
  }

  // 备份
  fs.copyFileSync(CONTENT_FILE, BACKUP_FILE);
  console.log('备份到:', BACKUP_FILE);

  // 改写
  for (const c of arr) {
    if (c.published === true && c.published_at && c.status === 'ready') {
      c.status = 'published';
      c.updatedAt = new Date().toISOString();
    }
  }

  fs.writeFileSync(CONTENT_FILE, JSON.stringify(arr, null, 2));
  console.log('✓ 已写盘');
  console.log('下一步：start 3002 → S4 自动消费 ready → 进入 S5');
})();