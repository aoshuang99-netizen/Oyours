#!/usr/bin/env node
/**
 * 提取 v14-console.html 的 sidebar 导航结构与区块切换机制（只读）
 */
const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'v14-console.html'), 'utf8');

console.log('════════ sidebar 完整结构 ════════');
const a = s.indexOf('<aside');
const b = s.indexOf('</aside>');
const side = s.slice(a, b);
console.log('sidebar 字节:', side.length);
console.log(side.replace(/\n\s*\n/g, '\n').slice(0, 4000));

console.log('\n\n════════ 区块切换机制探测 ════════');
for (const k of ['scrollIntoView', 'location.hash', 'activeSection', 'currentSection',
  'switchTab', 'showSection', 'sectionRefs', 'IntersectionObserver', '@click="scroll',
  'href="#']) {
  const n = s.split(k - 1;
  if (n) console.log('  ' + k.padEnd(22) + n);
}

console.log('\n════════ 区块 id 锚点（id="...") 前 45 个 ════════');
const ids = [...s.matchAll(/\sid="([a-zA-Z][\w-]*)"/g)].map(m => m[1]);
console.log('id 总数:', ids.length);
console.log(ids.slice(0, 45).join(', '));

console.log('\n════════ 分组标题（section-title）上下文 ════════');
for (const m of s.matchAll(/<[^>]*class="[^"]*section-title[^"]*"[^>]*>([\s\S]{0,120}?)<\//g)) {
  console.log('  · ' + m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}
