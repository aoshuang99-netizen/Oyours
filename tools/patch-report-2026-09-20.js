'use strict';
/**
 * 一次性原子补丁脚本：把 F3-extension 的更新同步进 P0 交付报告（MD + HTML）。
 *
 * 背景：先前用多个 Edit 并发改同一文件，发生**丢失更新**（部分改动被覆盖）。
 *       此脚本改为**串行精确替换 + 命中计数审计 + 幂等闸门**，一次写盘。
 * 用法：node tools/patch-report-2026-09-20.js
 */
const fs = require('fs');
const ROOT = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/';
const MD = ROOT + 'reports/p0-fix-delivery-2026-09-20.md';
const HTML = ROOT + 'reports/p0-fix-delivery-2026-09-20.html';

function patch(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  const log = [];
  let applied = 0, skipped = 0, failed = 0;
  for (const [from, to] of pairs) {
    const cnt = s.split(from).length - 1;
    if (cnt === 0) {
      if (s.includes(to)) { log.push('  ⏭  已完成（幂等跳过）: ' + from.slice(0, 55).replace(/\n/g, '⏎')); skipped++; }
      else { log.push('  ❌ 未命中: ' + from.slice(0, 55).replace(/\n/g, '⏎')); failed++; }
      continue;
    }
    s = s.split(from).join(to);
    log.push('  ✅ x' + cnt + '  ' + from.slice(0, 55).replace(/\n/g, '⏎'));
    applied++;
  }
  fs.writeFileSync(file, s, 'utf8');
  return { log, applied, skipped, failed };
}

// ══════════════ MD ══════════════
const mdPairs = [
  ['| **F1** | 429 限流被判为 401 token 失效 | ✅ 已修 | 49 PASS 回归 + 生产黑名单释放 23 个账号 |',
   '| **F1** | 429 限流被判为 401 token 失效 | ✅ 已修 | 92 PASS 回归 + 生产黑名单释放 23 个账号 |'],

  ['| **F5(2)** | F5 首轮漏 2 处运行时出现点 | ✅ 已补修 | 回归采集断言「4 处全同源」 |\n\n**整体验收**：`tools/verify-p0-fixes.js` → **49 PASS / 0 FAIL**（F5 组由 4 条扩为 7 条；另新增 F3-safety 组 3 条）\n**服务状态**：3002 重启三次（PID 1804 → 4112 → 17368 → 22460），每次均由看门狗 30~60s 自动拉起，**单一 LISTENING**，**零 ERROR**',
   '| **F5(2)** | F5 首轮漏 2 处运行时出现点 | ✅ 已补修 | 回归采集断言「4 处全同源」 |\n| **F3E** | F3 首轮漏 5 处 `configStatus()` 同类缺口（假绿预防） | ✅ 已补修 | 注入占位凭据实测 `authorized=false` |\n\n**整体验收**：`tools/verify-p0-fixes.js` → **92 PASS / 0 FAIL**（F5 组 4→7；另新增 F3-safety 组 3 条、F3-extension 组 43 条）\n**服务状态**：3002 重启四次（PID 1804 → 4112 → 17368 → 22460 → 9656），每次均由看门狗 30~60s 自动拉起，**单一 LISTENING**，**零 ERROR**'],

  ['P0 修复验收：49 PASS / 0 FAIL', 'P0 修复验收：92 PASS / 0 FAIL'],

  ['| **F3-safety** | **3** | **消费方全量复核：无人读 `configStatus().authorized` + 发布只用 `configured` + tumblr 闸门未被误删** |',
   '| **F3-safety** | **3** | **消费方全量复核：无人读 `configStatus().authorized` + 发布只用 `configured` + tumblr 闸门未被误删** |\n| **F3-extension** | **43** | **5 provider × (4 源码 + 4 运行时假绿拦截) + 全量 format 覆盖 + tumblr 例外 + Stub 断言** |'],

  ['| `providers/nostr-provider.js` | F3 |',
   '| `providers/nostr-provider.js` | F3 |\n| **`providers/telegram-provider.js`** | **F3-extension**（格式闸门） |\n| **`providers/discord-provider.js`** | **F3-extension**（格式闸门） |\n| **`providers/github-provider.js`** | **F3-extension**（格式闸门） |\n| **`providers/devto-provider.js`** | **F3-extension**（保守格式闸门） |\n| **`providers/hashnode-provider.js`** | **F3-extension**（保守格式闸门） |'],

  ['| `tools/verify-p0-fixes.js` | **新增**：**49 条**断言的回归脚本（F5 组已全局化 + F3-safety 组） |',
   '| `tools/verify-p0-fixes.js` | **新增**：**92 条**断言的回归脚本（F5 组已全局化 + F3-safety + F3-extension 组） |'],
];

// ══════════════ HTML ══════════════
const htmlPairs = [
  ['<span><b>执行时刻</b> 12:48–13:05（北京时间 20:48–21:05），含 F5(2) 补修</span>',
   '<span><b>执行时刻</b> 12:48–13:58（北京时间 20:48–21:58），含 F5(2) / F3-extension 补修</span>'],

  ['429 限流被判为 401 token 失效</td><td><span class="badge b-ok">✅ 已修</span></td><td>49 PASS 回归',
   '429 限流被判为 401 token 失效</td><td><span class="badge b-ok">✅ 已修</span></td><td>92 PASS 回归'],

  ["    <tr><td class=\"num\">F5</td><td>通道默认值不一致</td><td><span class=\"badge b-ok\">✅ 已修</span></td><td>四处默认值统一 <code>'tumblr,nostr'</code></td></tr>",
   "    <tr><td class=\"num\">F5</td><td>通道默认值不一致</td><td><span class=\"badge b-ok\">✅ 已修</span></td><td>四处默认值统一 <code>'tumblr,nostr'</code></td></tr>\n    <tr><td class=\"num\">F3E</td><td>F3 首轮漏 5 处 <code>configStatus()</code> 同类缺口（假绿预防）</td><td><span class=\"badge b-ok\">✅ 已补修</span></td><td>注入占位凭据实测 <code>authorized=false</code></td></tr>"],

  ['<div class="note ok"><span class="t">整体验收</span><code>tools/verify-p0-fixes.js</code> → <b>49 PASS / 0 FAIL</b>（F5 组由 4 条扩为 7 条；另新增 F3-safety 组 3 条）<br>\n服务：3002 重启三次（PID 1804 → 4112 → 17368 → 22460），每次均由看门狗 30~60s 自动拉起，<b>单一 LISTENING</b>，<b>零 ERROR</b>。</div>',
   '<div class="note ok"><span class="t">整体验收</span><code>tools/verify-p0-fixes.js</code> → <b>92 PASS / 0 FAIL</b>（F5 组 4→7；另新增 F3-safety 组 3 条、F3-extension 组 43 条）<br>\n服务：3002 重启<b>四次</b>（PID 1804 → 4112 → 17368 → 22460 → 9656），每次均由看门狗 30~60s 自动拉起，<b>单一 LISTENING</b>，<b>零 ERROR</b>。</div>'],

  ['    <tr><td>其余 8 个</td><td class="num">false</td><td>—</td><td>false</td><td>未配置（诚实脚手架）</td></tr>\n  </tbody>\n</table>\n<div class="note ok"><span class="t">假绿已消除</span>',
   '    <tr><td>其余 8 个</td><td class="num">false</td><td>—</td><td>false</td><td>未配置（其中 twitter/facebook/instagram 为诚实脚手架）</td></tr>\n  </tbody>\n</table>\n<div class="note warn"><span class="t">本表为 F3 首轮快照</span>其中 <code>telegram / discord / github / devto / hashnode</code> 的 <code>format</code> 字段在 <b>F3-extension</b> 补修后已具备，详见下节。</div>\n<div class="note ok"><span class="t">假绿已消除</span>'],

  ['<pre><code>P0 修复验收：49 PASS / 0 FAIL', '<pre><code>P0 修复验收：92 PASS / 0 FAIL'],

  ['    <tr><td><b>F3-safety</b></td><td class="num">3</td><td><b>消费方全量复核：无人读 <code>configStatus().authorized</code> + 发布只用 <code>configured</code> + tumblr 闸门未被误删</b></td></tr>',
   '    <tr><td><b>F3-safety</b></td><td class="num">3</td><td><b>消费方全量复核：无人读 <code>configStatus().authorized</code> + 发布只用 <code>configured</code> + tumblr 闸门未被误删</b></td></tr>\n    <tr><td><b>F3-extension</b></td><td class="num">43</td><td><b>5 provider × (4 源码 + 4 运行时假绿拦截) + 全量 format 覆盖 + tumblr 例外 + Stub 断言</b></td></tr>'],

  ['    <tr><td><code>providers/nostr-provider.js</code></td><td>F3</td></tr>\n    <tr><td><code>tools/verify-p0-fixes.js</code></td><td><b>新增</b>：<b>49 条</b>断言的回归脚本（F5 组已全局化 + F3-safety 组）</td></tr>',
   '    <tr><td><code>providers/nostr-provider.js</code></td><td>F3</td></tr>\n    <tr><td><code>providers/telegram-provider.js</code></td><td><b>F3-extension</b>（格式闸门）</td></tr>\n    <tr><td><code>providers/discord-provider.js</code></td><td><b>F3-extension</b>（格式闸门）</td></tr>\n    <tr><td><code>providers/github-provider.js</code></td><td><b>F3-extension</b>（格式闸门）</td></tr>\n    <tr><td><code>providers/devto-provider.js</code></td><td><b>F3-extension</b>（保守格式闸门）</td></tr>\n    <tr><td><code>providers/hashnode-provider.js</code></td><td><b>F3-extension</b>（保守格式闸门）</td></tr>\n    <tr><td><code>tools/verify-p0-fixes.js</code></td><td><b>新增</b>：<b>92 条</b>断言的回归脚本（F5 组已全局化 + F3-safety + F3-extension 组）</td></tr>'],

  ['<footer>本报告所有数字均为 2026-09-20 12:48–13:05 实测。</footer>',
   '<footer>本报告所有数字均为 2026-09-20 12:48–13:58 实测。</footer>'],
];

console.log('══════ MD ══════');
const r1 = patch(MD, mdPairs);
r1.log.forEach((l) => console.log(l));
console.log(`  → 应用 ${r1.applied} / 幂等跳过 ${r1.skipped} / 未命中 ${r1.failed}`);

console.log('══════ HTML ══════');
const r2 = patch(HTML, htmlPairs);
r2.log.forEach((l) => console.log(l));
console.log(`  → 应用 ${r2.applied} / 幂等跳过 ${r2.skipped} / 未命中 ${r2.failed}`);

// ══════════════ 落盘后审计 ══════════════
console.log('══════ 审计 ══════');
const md = fs.readFileSync(MD, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');
const audit = [
  ['MD 残留 "49 PASS"', (md.match(/49 PASS/g) || []).length, 0],
  ['MD 残留 "49 条"', (md.match(/49 条/g) || []).length, 0],
  ['MD 残留 "重启三次"', (md.match(/重启三次/g) || []).length, 0],
  ['MD "92 PASS"', (md.match(/92 PASS/g) || []).length, 2],
  ['MD "92 条"', (md.match(/92 条/g) || []).length, 1],
  ['MD "F3-extension"', (md.match(/F3-extension/g) || []).length, 4],
  ['MD "重启四次"', (md.match(/重启四次/g) || []).length, 1],
  ['HTML 残留 "49 PASS"', (html.match(/49 PASS/g) || []).length, 0],
  ['HTML 残留 "49 条"', (html.match(/49 条/g) || []).length, 0],
  ['HTML 残留 "重启三次"', (html.match(/重启三次/g) || []).length, 0],
  ['HTML "92 PASS"', (html.match(/92 PASS/g) || []).length, 2],
  ['HTML "92 条"', (html.match(/92 条/g) || []).length, 1],
  ['HTML "重启四次"', (html.match(/重启四次/g) || []).length, 1],
  ['HTML 残留 "13:05"', (html.match(/13:05/g) || []).length, 0],
];
let bad = 0;
for (const [name, got, want] of audit) {
  const okMark = got === want ? '✅' : '❌';
  if (got !== want) bad++;
  console.log(`  ${okMark} ${name} = ${got}（期望 ${want}）`);
}
console.log(bad === 0 ? '\n全部通过。' : `\n⚠️ ${bad} 项不符。`);
