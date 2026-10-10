#!/usr/bin/env node
/**
 * DataStore 平台名规范化 + 非法平台标记（默认 dry-run，加 --apply 写盘）
 *
 * 脏点：
 *  - 大小写分裂：X/x、Reddit/reddit、Discord/discord 同时存在 → 平台统计分裂、
 *    PLATFORM_TO_ACCOUNT 与真实通道判定按小写匹配时大写条目永远命中不了。
 *  - 测试/非社交平台残留：b2test、gmail 等被当成内容平台混在发布池里。
 *
 * 处理：
 *  1) platform 统一小写（保留原值到 platform_raw 备查）
 *  2) 不在支持列表内的平台（b2test/gmail 等）→ status='invalid'，永不入队
 *  3) 已 published / queued 的记录只规范平台名，不改状态
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const CONTENT = 'D:/mscms-ws/data/content.json';
const VALID = ['reddit', 'x', 'twitter', 'instagram', 'tiktok', 'facebook', 'discord', 'tumblr'];

function atomicWrite(target, obj) {
  const tmp = path.join('D:/mscms-tmp', 'plat-' + path.basename(target) + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

const items = JSON.parse(fs.readFileSync(CONTENT, 'utf8'));
const stat = { normalized: 0, invalid: 0, unchanged: 0 };
const before = {};
const after = {};

for (const it of items) {
  if (!it || typeof it !== 'object') continue;
  const raw = it.platform;
  before[String(raw)] = (before[String(raw)] || 0) + 1;

  const low = String(raw || '').toLowerCase();
  if (raw !== low) {
    it.platform_raw = raw;
    it.platform = low;
    stat.normalized++;
  }
  after[low] = (after[low] || 0) + 1;

  if (!VALID.includes(low)) {
    // 测试/非社交平台残留：标为 invalid，S4 永不取用（内容本身保留，可审计）
    if ((!it.status || it.status === 'ready') && !it.published) {
      it.status = 'invalid';
      it.invalid_reason = 'platform_not_supported';
      stat.invalid++;
    }
  }
}

console.log(APPLY ? '=== 执行模式 (--apply) ===' : '=== DRY-RUN（加 --apply 写盘）===');
console.log('\n--- 平台名规范化 ---');
console.log('  规范化条目: ' + stat.normalized + ' | 标记 invalid: ' + stat.invalid);
console.log('  处理前: ' + JSON.stringify(before));
console.log('  处理后: ' + JSON.stringify(after));

const byStatus = {};
for (const it of items) { const s = (it && it.status) || '(none)'; byStatus[s] = (byStatus[s] || 0) + 1; }
console.log('  状态分布: ' + JSON.stringify(byStatus));

if (APPLY) {
  atomicWrite(CONTENT, items);
  console.log('\n  ✅ 已写回 content.json');
}
