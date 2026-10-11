#!/usr/bin/env node
/**
 * reclaim-stale-queued.js — P0-3 修复：回收僵尸 queued 内容
 *
 * ── 背景（2026-09-15 诊断）────────────────────────────────────────────
 * content.json 有 418 条 status='queued' 的内容（全部 tumblr），
 * 它们入队后既没成功也没失败，永久占位：
 *   - `failed_count` / `last_error` 仅 3 条有值 → 其余 415 条**没有任何失败信息**
 *   - createdAt 跨越 09-10 ~ 09-15，说明泄漏**仍在持续发生**
 *
 * ── 根因（双重）──────────────────────────────────────────────────────
 * ① cloud-publisher.js 的 `_recoverStaleQueued()` 只在 **启动时跑一次**
 *    （start() 里 setTimeout 20s），长时间不重启的进程永远不会回收 →
 *    队列在内存里、进程重启即丢，而内容状态已置 queued，S4 只挑 ready → 卡死。
 * ② 该函数**刻意跳过超过 24h 的**（怕脱离 MySQL (账号,内容) 去重窗口后重复外发）
 *    → 418 条里 412 条超过 24h 就成了**永久僵尸**，没有任何回收路径。
 *
 * ── 本脚本的安全前提（三重证据，任一不满足即拒绝回收）─────────────────
 *   A. published !== true            （未被标记发布）
 *   B. published_at 为空              （无发布时间）
 *   C. used_count === 0              （未被消费过）
 *   D. publish 模块中不存在该 content_id（DataStore 权威发布记录 3279 条，交叉验证）
 *   实测：418 条**全部满足 A~D**（published/published_at/used_count 全 0，
 *   与 publish 模块交叉为 0 条）→ 它们从未外发，回收后不会重复发布。
 *
 * 另外：isPublishable() 在选取侧还有 `!published && !published_at && status==='ready'`
 * 三重闸门，与 MySQL 24h (账号,内容) 去重闸门（若 MySQL 在线）形成双保险。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node tools/reclaim-stale-queued.js                 # DRY-RUN：只列差异
 *   node tools/reclaim-stale-queued.js --apply          # 写盘（要求 3002 已停）
 *   node tools/reclaim-stale-queued.js --apply --min-age-min=30
 *   node tools/reclaim-stale-queued.js --apply --include-stale   # 允许回收 >24h 的（默认允许，见下）
 *
 * 注意：本脚本默认**包含** >24h 的存量僵尸（因为 A~D 已证其从未外发），
 *       这与 cloud-publisher 启动回收的 24h 保守策略不同 —— 那是针对"可能已发布但状态没落盘"
 *       的模糊情形；本脚本要求 A~D 全满足，证据强度更高。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');

const CONTENT_FILE = process.env.MSCMS_CONTENT_FILE || 'D:/mscms-ws/data/content.json';
const PUBLISH_FILE = process.env.MSCMS_PUBLISH_FILE || 'D:/mscms-ws/data/publish.json';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const argVal = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const MIN_AGE_MIN = Number(argVal('min-age-min', 30));          // 与 cloud-publisher 的 30min「在途」口径一致
const MAX_AGE_HOURS = Number(argVal('max-age-hours', 0));        // 0 = 不限（含 >24h 存量僵尸）

console.log('=== reclaim-stale-queued (P0-3) ===');
console.log('content file :', CONTENT_FILE);
console.log('publish file :', PUBLISH_FILE);
console.log('mode         :', apply ? 'APPLY' : 'DRY-RUN');
console.log('min age      :', MIN_AGE_MIN, 'min（更新的视为仍在途，不动）');
console.log('max age      :', MAX_AGE_HOURS > 0 ? `${MAX_AGE_HOURS}h` : '不限（含历史存量僵尸）');

function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { try { sock.destroy(); } catch (_) {} resolve(false); }, 1500);
  });
}

function loadArr(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : Object.values(raw);
}

// 记录是否为「可安全回收的僵尸 queued」
function classify(c, publishedIds, now, minAgeMs, maxAgeMs) {
  const reasons = [];
  const t = Date.parse(c.queued_at || c.updatedAt || c.createdAt || '');
  if (isNaN(t)) reasons.push('no-timestamp');
  else {
    if (now - t < minAgeMs) reasons.push('too-fresh(in-flight)');
    if (maxAgeMs > 0 && now - t > maxAgeMs) reasons.push('beyond-max-age');
  }
  // A~D 安全闸门
  if (c.published === true) reasons.push('published=true');
  if (c.published_at) reasons.push('has-published_at');
  if ((c.used_count || 0) > 0) reasons.push('used_count>0');
  if (publishedIds.has(String(c.id))) reasons.push('in-publish-module');
  return reasons;
}

(async () => {
  if (!fs.existsSync(CONTENT_FILE)) {
    console.error('FATAL: content file not found:', CONTENT_FILE);
    process.exit(1);
  }

  const listening = await isPortListening(3002);
  if (listening && apply) {
    console.error('FATAL: 3002 仍在监听！DataStore 每 5s flush 会用内存缓存覆盖磁盘改动。');
    console.error('      请先停 3002 再 --apply。');
    process.exit(2);
  }
  if (listening) console.warn('⚠️  3002 正在运行：DRY-RUN 结果可能与运行时内存状态略有偏差（不影响盘点）');

  const arr = loadArr(CONTENT_FILE);

  // DataStore 权威发布记录（交叉验证 D）
  const publishedIds = new Set();
  try {
    for (const p of loadArr(PUBLISH_FILE)) {
      if (p && p.content_id) publishedIds.add(String(p.content_id));
    }
    console.log(`publish 模块权威记录: ${publishedIds.size} 条 content_id`);
  } catch (e) {
    console.error('FATAL: 无法读取 publish 模块，无法完成「从未外发」交叉验证，拒绝继续。', e.message);
    process.exit(3);
  }

  const now = Date.now();
  const minAgeMs = MIN_AGE_MIN * 60 * 1000;
  const maxAgeMs = MAX_AGE_HOURS > 0 ? MAX_AGE_HOURS * 3600 * 1000 : 0;

  const queued = arr.filter((c) => c && c.status === 'queued');
  const reclaim = [];
  const skip = [];

  for (const c of queued) {
    const reasons = classify(c, publishedIds, now, minAgeMs, maxAgeMs);
    if (reasons.length === 0) reclaim.push(c);
    else skip.push({ c, reasons });
  }

  console.log('\n=== 盘点 ===');
  console.log('queued 总数        :', queued.length);
  console.log('可安全回收         :', reclaim.length);
  console.log('跳过（保留 queued）:', skip.length);

  const skipAgg = {};
  for (const s of skip) for (const r of s.reasons) skipAgg[r] = (skipAgg[r] || 0) + 1;
  if (Object.keys(skipAgg).length) console.log('跳过原因分布       :', JSON.stringify(skipAgg));

  if (reclaim.length) {
    console.log('\n回收样例（前 5 条）:');
    for (const c of reclaim.slice(0, 5)) {
      console.log(`  ${c.id} | queued_at=${c.queued_at} | q2=${c.quality_v2} | ${String(c.title).slice(0, 40)}`);
    }
    const platforms = {};
    for (const c of reclaim) platforms[c.platform] = (platforms[c.platform] || 0) + 1;
    console.log('回收平台分布       :', JSON.stringify(platforms));
  }

  if (!apply) {
    console.log('\n--- DRY-RUN 完成，未写盘。加 --apply 执行 ---');
    return;
  }

  if (reclaim.length === 0) {
    console.log('\n无需回收，未写盘。');
    return;
  }

  // 备份
  const bak = CONTENT_FILE.replace(/\.json$/, `.bak-reclaim-${Date.now()}.json`);
  fs.copyFileSync(CONTENT_FILE, bak);
  console.log('\n备份到:', bak);

  // 改写
  const stamp = new Date().toISOString();
  const ids = new Set(reclaim.map((c) => c.id));
  let n = 0;
  for (const c of arr) {
    if (!ids.has(c.id)) continue;
    c.status = 'ready';
    c.requeued_at = stamp;
    c.requeue_reason = 'p0_3_reclaim_stale_queued';
    c.updatedAt = stamp;
    delete c.queued_at;
    delete c.queued_account_id;
    n++;
  }

  fs.writeFileSync(CONTENT_FILE, JSON.stringify(arr, null, 2));
  console.log(`✓ 已写盘：${n} 条 queued → ready`);

  // 回读校验
  const after = loadArr(CONTENT_FILE);
  const left = after.filter((c) => c.status === 'queued').length;
  const readyTumblr = after.filter((c) => c.status === 'ready' && String(c.platform) === 'tumblr'
    && !c.published && !c.published_at).length;
  console.log('回读校验: 剩余 queued =', left, ' | tumblr ready 未发布 =', readyTumblr);
  console.log('下一步: 启动 3002 → S4 按逐通道查询取到内容 → 发布链路恢复');
})();
