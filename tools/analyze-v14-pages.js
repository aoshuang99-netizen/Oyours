#!/usr/bin/env node
/**
 * 定位 v14-console.html 中每个 page 的模板范围 + 首页 dashboard 的详细结构（只读）
 */
const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'v14-console.html'), 'utf8');
const lines = s.split('\n');

console.log('════════ 全部 page 切换点 ════════');
const pages = [];
for (const m of s.matchAll(/v-(?:if|show)="page\s*===\s*'([^']+)'"/g)) {
  const line = s.slice(0, m.index).split('\n';
  pages.push({ name: m[1], line });
}
console.log('切换点总数:', pages.length);
const seen = {};
pages.forEach(p => { seen[p.name] = (seen[p.name] || 0) + 1; });
console.log('唯一 page 名:', Object.keys(seen);
console.log(Object.entries(seen).map(([k, v]) => k + '(' + v + ')').join(', '));

// 找 sidebar 中所有 navigate 目标
console.log('\n════════ sidebar navigate 目标 ════════');
const navs = [...new Set([...s.matchAll(/navigate\('([^']+)'\)/g)].map(m => m[1]))];
console.log('navigate 目标数:', navs.length);
console.log(navs.join(', '));

// 找 sidebar 结束、内容区开始
const asideEnd = s.indexOf('</aside>');
const after = s.slice(asideEnd, asideEnd + 3000);
console.log('\n════════ sidebar 之后的主内容区骨架 ════════');
console.log(after.replace(/\n\s*\n/g, '\n').slice(0, 2200));

// dashboard page 范围
const dashIdx = s.search(/v-(?:if|show)="page\s*===\s*'dashboard'"/);
if (dashIdx >= 0) {
  const startLine = s.slice(0, dashIdx).split('\n';
  console.log('\n════════ dashboard 起始行:', startLine, '════════');
  // 找到下一个 page 切换点作为结束
  const nextM = s.slice(dashIdx + 10).match(/v-(?:if|show)="page\s*===\s*'([^']+)'"/);
  if (nextM) {
    const endLine = s.slice(0, dashIdx + 10 + nextM.index).split('\n';
    console.log('dashboard 结束行（下一个 page）:', endLine, '-> page =', nextM[1]);
    console.log('dashboard 跨行数:', endLine - startLine);
  }
}
