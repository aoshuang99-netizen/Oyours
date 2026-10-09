// check-html-balance.js — Vue in-DOM 模板的标签配平 / 面板嵌套体检
//
// 用法：node check-html-balance.js <html文件> [容器选择器，默认 #app]
//
// 背景（2026-09-06 真实事故）：v14-console.html 的「智能发布」面板少一个 </div>，
//   浏览器 HTML 解析器把**其后 21 个面板全部嵌套进了该面板内部** →
//   page==='dau' 时外层 v-if="page==='publish'" 为 false → 内容区一片空白。
//   症状极具迷惑性：没有 JS 报错、没有 404、导航高亮正常（active 类照样切换），
//   只有内容区是空的。逐个面板点击 + 数元素才能发现。
//
// 本脚本做两件事：
//   1) 按 `<!-- ====== 面板名 ====== -->` 注释切块，逐块统计 <div>/</div> 是否配平；
//   2) 用 DOM 规则模拟解析，报告每个面板的真实父链（应直接挂在容器下）。
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('用法: node check-html-balance.js <html文件> [#容器]'); process.exit(1); }
const containerSel = process.argv[3] || '#app';

// 关键：JS 模板字符串里常有 HTML 片段（如 `const tpl = \`<div class="x">...\``），
//   直接全文统计会把它们算进来 → 大量误报。先把 <script>/<style> 内容抹成等长空格
//   （保留换行以维持行号），只统计真实 DOM 结构。
const raw = fs.readFileSync(file, 'utf8');
const html = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '));

// ── 1) 定位容器区域 ────────────────────────────────
const openTagRe = new RegExp('<(' + 'div|main|section' + ')\\b[^>]*>', 'g');
 findContainer() {
  // 简化：找第一个带 id/class 匹配选择器的开标签
  const m = new RegExp('<(\\w+)[^>]*' +
    (containerSel.startsWith('#') ? 'id="' + containerSel.slice(1) + '"' : 'class="[^"]*' + containerSel.slice(1)) +
    '[^>]*>').exec(html);
  return m ? { start: m.index, tag: m[1] } : null;
}
const cont = findContainer();
const region = cont ? html.slice(cont.start) : html;
console.log('容器:', containerSel, cont ? `找到 <${cont.tag}> @${cont.start}` : '未找到（检查整个文件）');

// ── 2) 按面板注释切块，统计 div 配平 ────────────────
const marks = [];
const re = /<!--\s*=+\s*(.+?)\s*=+\s*-->/g;
let m;
while ((m = re.exec(region))) marks.push({ name: m[1].trim(), pos: m.index });

let bad = 0;
if (marks.length) {
  console.log(`\n=== 面板 div 配平（共 ${marks.length} 块） ===`);
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].pos;
    const to = i + 1 < marks.length ? marks[i + 1].pos : region.length;
    const seg = region.slice(from, to);
    const o = (seg.match(/<div\b/g) || [];
    const c = (seg.match(/<\/div>/g) || [];
    const line = html.slice(0, cont.start + from).split('\n';
    if (o - c > 0) {
      // 正差 = 该块有 <div> 没闭合 → 浏览器会把后续面板全部嵌套进来，必须修
      bad++;
      console.log(`❌ 行 ${String(line).padStart(5)} | ${marks[i].name} | <div>${o} </div>${c} | 少 ${o - c} 个 </div>`);
    } else if (o - c < 0 && i < marks.length - 1) {
      // 负差多半是块边界切在了嵌套中间（外层容器的闭合落在下一块），只提示不报错。
      // 最后一块的负差是文件尾部闭合，完全正常，连提示都不需要。
      console.log(`⚠️  行 ${String(line).padStart(5)} | ${marks[i].name} | <div>${o} </div>${c} | 多 ${c - o} 个 </div>（可能只是块边界）`);
    }
  }
  if (!bad) console.log('✅ 全部配平');
}

// ── 3) 全文件级配平 ─────────────────────────────────
const allOpen = (html.match(/<div\b/g) || [];
const allClose = (html.match(/<\/div>/g) || [];
console.log(`\n=== 全文件 ===\n<div> ${allOpen}  </div> ${allClose}  ${allOpen === allClose ? '✅' : '❌ 差 ' + (allOpen - allClose)}`);

// ── 4) 模拟 DOM 解析，输出每个面板的真实父链 ──────────
//    用轻量栈模拟（只跟踪 div/main/section），找出被"吞进"别的 v-if 块的面板
console.log('\n=== 面板父链（应直接挂在容器下，多一层 v-if 即被吞） ===');
const stack = [];
const panelStack = [];
const lineOf = (idx) => html.slice(0, idx).split('\n';
const tagRe = /<(\/?)(div|main|section)\b([^>]*)>|<!--\s*=+\s*(.+?)\s*=+\s*-->/g;
let t;
let unexpected = 0;
while ((t = tagRe.exec(html))) {
  const idx = t.index;
  if (t[4] !== undefined) {
    // 面板注释：报告当前所处的 v-if 嵌套
    const chain = stack.filter((s) => s.vif).map((s) => s.vif);
    const flag = chain.length > 1 ? '❌ 被嵌套' : (chain.length === 1 ? '✅' : '⚪ 无 v-if');
    if (chain.length > 1) unexpected++;
    console.log(`${flag} | 行 ${String(lineOf(idx)).padStart(5)} | ${t[4].trim().padEnd(20)} | 父链: ${chain.join(' < ') || '(无)'}`);
    continue;
  }
  const closing = t[1] === '/';
  const vif = (t[3] || '').match(/v-if="([^"]*)"/);
  if (!closing) {
    stack.push({ tag: t[2], line: lineOf(idx), vif: vif ? vif[1] : null });
  } else {
    // 弹出到最近的匹配开标签
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag === t[2]) { stack.length = i; break; }
    }
  }
}
console.log(unexpected ? `\n❌ ${unexpected} 个面板被嵌套进了其他 v-if 块 —— 需修复标签配平` : '\n✅ 没有面板被错误嵌套');
process.exit(bad || unexpected || allOpen !== allClose ? 1 : 0);
