#!/usr/bin/env node
/*
 * patch-autostart.js — 把 _autostart_mscms.bat 的「看门狗启动块」(step 4+5) 安全跳过，
 * 使 WinSW 成为看门狗唯一父级（避免与 :3011 单实例锁冲突）。
 *
 * 机制（非正则、按行精确匹配，杜绝破坏单入口文件）：
 *   1. 在 step 3(MySQL) 结束的 `)` 之后插入 `goto :skip_winsw_wd`
 *   2. 在文件末尾追加标签 `:skip_winsw_wd`
 *   3. 首次修改前自动备份为 _autostart_mscms.bat.bak
 *   4. 幂等：已含 sentinel `skip_winsw_wd` 则直接跳过
 *
 * 用法：
 *   node patch-autostart.js            # 打补丁（注释看门狗块）
 *   node patch-autostart.js --restore  # 从 .bak 恢复
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv.includes('--restore')
  ? null
  : path.resolve(__dirname, '..', '..', '_autostart_mscms.bat');
const SENTINEL = 'skip_winsw_wd';
const ANCHOR = 'call :log "3307 already LISTENING -> skip mysqld"';

function fail(msg) {
  console.error('[patch-autostart] ' + msg);
  process.exit(1);
}

if (process.argv.includes('--restore')) {
  const bak = path.resolve(__dirname, '..', '..', '_autostart_mscms.bat.bak');
  const dst = path.resolve(__dirname, '..', '..', '_autostart_mscms.bat');
  if (!fs.existsSync(bak)) fail('未找到备份 ' + bak + '，无法恢复');
  fs.copyFileSync(bak, dst);
  console.log('[patch-autostart] 已从备份恢复 _autostart_mscms.bat');
  process.exit(0);
}

if (!fs.existsSync(TARGET)) fail('未找到 ' + TARGET);

let content = fs.readFileSync(TARGET, 'utf8');
if (content.includes(SENTINEL)) {
  console.log('[patch-autostart] 已含 sentinel，跳过（幂等）');
  process.exit(0);
}

const lines = content.split(/\r?\n/);
const anchorIdx = lines.findIndex((l) => l.trim() === ANCHOR.trim());
if (anchorIdx < 0) fail('未定位到 MySQL 结束锚点，中止（不修改文件）');

// 锚点之后找到第一个独立成行的 `)`（step 3 的闭合括号）
let insertAt = -1;
for (let i = anchorIdx + 1; i < lines.length; i++) {
  if (lines[i].trim() === ')') {
    insertAt = i;
    break;
  }
}
if (insertAt < 0) fail('未定位到 step 3 闭合 `)`，中止（不修改文件）');

// 备份（仅首次）
const bak = TARGET + '.bak';
if (!fs.existsSync(bak)) {
  fs.copyFileSync(TARGET, bak);
  console.log('[patch-autostart] 已备份 -> ' + path.basename(bak));
}

lines.splice(insertAt + 1, 0, 'goto :' + SENTINEL);
// 末尾追加标签（确保文件以换行结尾）
let out = lines.join('\r\n');
if (!out.endsWith('\r\n')) out += '\r\n';
out += ':' + SENTINEL + '\r\n';
fs.writeFileSync(TARGET, out, 'utf8');

console.log('[patch-autostart] 已跳过看门狗块（step 4+5）。MySQL 启动兜底保留。');
console.log('[patch-autostart] 如需恢复：node patch-autostart.js --restore');
