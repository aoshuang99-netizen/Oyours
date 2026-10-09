/**
 * MSCMS v14 —  字段命名归一 (M5)
 * 仅对 data/*.json 中对象的  字段做命名归一，零信息丢失、零假数据：
 *   x / X   -> twitter   (对齐 server.js PLATFORM_TO_ACCOUNT 主映射)
 *   Reddit  -> reddit    (修复 SUPPORTED_PUBLISH_PLATFORMS 白名单外导致被过滤的 bug)
 *   Discord -> discord
 * 其他值 (tumblr/tiktok/instagram/facebook/b2test/gmail 等) 不动。
 * 原子写回：先写 .tmp 再 rename。
 *
 * 铁律：本脚本必须在 3002 停止后运行（避免 DataStore 5s flush 覆盖）。
 */
const fs = require('fs');
const path = require('path');

const DATA = 'D:/mscms-ws/data';
const MAP = { 'x': 'twitter', 'X': 'twitter', 'Reddit': 'reddit', 'Discord': 'discord' };
const KEYS = ['rows', 'data', 'items']; // 可能的数组包裹键

const summary = { runAt: new Date().toISOString(), files: {}, totalChanged: 0 };

 normArray(arr, file) {
  let changed = 0;
  for (const it of arr) {
    if (it && typeof it === 'object' && typeof it. === 'string' && MAP[it.]) {
      it. = MAP[it.];
      changed++;
    }
  }
  return changed;
}

const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json'));
for (const f of files) {
  const fp = path.join(DATA, f);
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
  let o;
  try { o = JSON.parse(raw); } catch (e) { summary.files[f] = { error: 'parse:' + e.message }; continue; }

  let changed = 0;
  if (Array.isArray(o)) {
    changed = normArray(o, f);
  } else if (o && typeof o === 'object') {
    for (const k of KEYS) {
      if (Array.isArray(o[k])) changed += normArray(o[k], f);
    }
    // 顶层对象自身带 （罕见）
    if (typeof o. === 'string' && MAP[o.]) { o. = MAP[o.]; changed++; }
  }
  if (changed > 0) {
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, fp);
    summary.files[f] = { changed };
    summary.totalChanged += changed;
  }
}

fs.writeFileSync('C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/reports/normalize_report.json', JSON.stringify(summary, null, 2));
console.log('==  归一完成 ==');
console.log('总改动条数:', summary.totalChanged);
for (const [f, v] of Object.entries(summary.files)) {
  if (v.changed) console.log(`  ${f}: ${v.changed} 条`);
}
if (summary.totalChanged === 0) console.log('  (无  双名需归一)');
console.log('报告:', 'reports/normalize_report.json');
