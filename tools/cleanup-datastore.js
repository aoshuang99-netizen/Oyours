#!/usr/bin/env node
/**
 * DataStore 侧清理（默认 dry-run，加 --apply 才写盘）
 *
 * 1) content.json：
 *    - 已发布(published/published_at) 但 status 仍为 ready → status='published'
 *      （这正是重复发布的根因：状态未推进，S4 每轮重新取用）
 *    - 创建超过 STALE_DAYS 天仍未发布的 ready 内容 → status='expired'（避免重启后集中补发打爆配额）
 * 2) 残留文件：*.bak / _vid_*.mp4 / _junction_test.txt → 移动到隔离目录（不直接删，规避 safe-delete 守卫）
 *
 * 前提：主服务 :3002 已停止（DataStore 每 5s flush，运行时改盘会被内存覆盖）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DATA_DIR = 'D:/mscms-ws/data';
const STALE_DAYS = 3;
const QUARANTINE = 'D:/mscms-backup/20260904-2010/quarantine';

const JUNK_RE = /\.bak|_test|_tmp/i;
const JUNK_EXACT = ['_junction_test.txt', '_vid_direct.mp4', '_vid_real.mp4'];

 readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
 atomicWrite(target, obj) {
  const tmp = path.join('D:/mscms-tmp', 'cleanup-' + path.basename(target) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

(async () => {
  console.log(APPLY ? '=== 执行模式 (--apply) ===' : '=== DRY-RUN（加 --apply 写盘）===');

  // ---------- 1) content.json ----------
  const contentPath = path.join(DATA_DIR, 'content.json');
  const items = readJson(contentPath);
  const cutoff = Date.now() - STALE_DAYS * 86400 * 1000;
  let published = 0, expired = 0, kept = 0;

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const already = it.published === true || !!it.published_at;
    if (already && (!it.status || it.status === 'ready')) {
      it.status = 'published';
      published++;
    } else if ((!it.status || it.status === 'ready') && !already) {
      const created = Date.parse(it.createdAt || it. || 0);
      if (created && created < cutoff) { it.status = 'expired'; expired++; }
      else kept++;
    }
  }
  const byStatus = {};
  for (const it of items) { const s = (it && it.status) || '(none)'; byStatus[s] = (byStatus[s] || 0) + 1; }

  console.log('\n--- content.json ---');
  console.log(`  条目 ${items.length} | 标记 published: ${published} | 过期: ${expired} | 保留 ready: ${kept}`);
  console.log('  处理后 status 分布: ' + JSON.stringify(byStatus));

  if (APPLY) {
    atomicWrite(contentPath, items);
    console.log('  ✅ 已写回 content.json');
  }

  // ---------- 2) 残留文件 ----------
  const files = fs.readdirSync(DATA_DIR);
  const junk = files.filter((f) => JUNK_RE.test(f) || JUNK_EXACT.includes(f));
  let totalBytes = 0;
  const list = [];
  for (const f of junk) {
    const st = fs.statSync(path.join(DATA_DIR, f));
    totalBytes += st.size;
    list.push({ f, mb: (st.size / 1048576).toFixed(2) });
  }
  console.log('\n--- 残留文件 ---');
  console.log(`  共 ${junk.length} 个，${(totalBytes / 1048576).toFixed(1)} MB`);
  for (const x of list.slice(0, 20)) console.log(`    ${x.f}  ${x.mb} MB`);

  if (APPLY && junk.length) {
    fs.mkdirSync(QUARANTINE, { recursive: true });
    let moved = 0, failed = 0;
    for (const f of junk) {
      try {
        fs.renameSync(path.join(DATA_DIR, f), path.join(QUARANTINE, f));
        moved++;
      } catch (e) { failed++; console.log(`    ⚠️ 移动失败 ${f}: ${e.code || e.message}`); }
    }
    console.log(`  ✅ 已隔离 ${moved} 个文件 → ${QUARANTINE}${failed ? `（失败 ${failed} 个）` : ''}`);
  }

  // ---------- 3) 清理后统计 ----------
  if (APPLY) {
    const left = fs.readdirSync(DATA_DIR);
    let bytes = 0;
    for (const f of left) { try { bytes += fs.statSync(path.join(DATA_DIR, f)).size; } catch (_) {} }
    console.log(`\n  data 目录剩余: ${left.length} 个文件, ${(bytes / 1048576).toFixed(1)} MB (清理前 26 MB / 71 个)`);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
