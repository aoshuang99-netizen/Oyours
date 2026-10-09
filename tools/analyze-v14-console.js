#!/usr/bin/env node
/**
 * 分析 v14-console.html 的信息架构现状（只读，不改文件）
 * 输出：导航体系 / 区块层级 / 卡片密度 / CSS 体系 / 首屏内容
 * 用途：为「首页面板重构」提供取证依据
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'v14-console.html');
const s = fs.readFileSync(FILE, 'utf8');

 count(re) {
  return (s.match(re) || [];
}

console.log('════════ 文件基本量 ════════');
console.log('字节:', s.length, '| 行数:', s.split('\n');
const styleLen = (s.match(/<style[\s\S]*?<\/style>/g) || []).join('';
const scriptLen = (s.match(/<script[\s\S]*?<\/script>/g) || []).join('';
console.log('style 内联字节:', styleLen, '| script 内联字节:', scriptLen);

console.log('\n════════ 导航体系探测 ════════');
const navKeys = ['sidebar', 'nav-item', 'topbar', 'breadcrumb', 'page-title',
  'section-title', 'data-view', 'v-show=', 'tab-', 'menu-item', 'c-nav', 'c-card'];
for (const k of navKeys) {
  const n = s.split(k - 1;
  console.log('  ' + k.padEnd(16) + n);
}

console.log('\n════════ 顶层区块（h1）— 平级堆叠情况 ════════');
const h1 = [...s.matchAll(/<h1[^>]*>([\s\S]{0,90}?)<\/h1>/g)]
  .map(m => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
console.log('h1 总数:', h1.length);
h1.forEach((t, i) => console.log('  ' + String(i + 1).padStart(2) + '. ' + t));

console.log('\n════════ h2 / h3 分布 ════════');
const h2 = count(/<h2[^>]*>/g), h3 = count(/<h3[^>]*>/g), h4 = count(/<h4[^>]*>/g);
console.log('h1=' + h1.length, 'h2=' + h2, 'h3=' + h3, 'h4=' + h4);

console.log('\n════════ 卡片 / 面板密度 ════════');
console.log('  .card 出现:', count(/class="[^"]*\bcard\b[^"]*"/g));
console.log('  .panel 出现:', count(/class="[^"]*\bpanel\b[^"]*"/g));
console.log('  class= 总出现:', count(/class="/g));
console.log('  唯一 class 名数量:', (() => {
  const set = new Set();
  for (const m of s.matchAll(/class="([^"]+)"/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach(c => set.add(c));
  }
  return set.size;
})());

console.log('\n════════ CSS 变量体系 ════════');
const vars = [...new Set([...s.matchAll(/--([a-z0-9-]+)\s*:/gi)].map(m => m[1]))];
console.log('CSS 自定义属性数量:', vars.length);
console.log('  ', vars.slice(0, 40).join(', '));

console.log('\n════════ 视觉 token（间距/圆角/字号） ════════');
const px = (re) => [...new Set([...s.matchAll(re)].map(m => m[1]))].sort();
console.log('  padding 出现次数:', count(/padding\s*:/g));
console.log('  margin  出现次数:', count(/margin\s*:/g));
console.log('  border-radius 出现:', count(/border-radius\s*:/g));
console.log('  font-size 出现:', count(/font-size\s*:/g));
console.log('  唯一 font-size 值:', px(/font-size\s*:\s*([0-9.]+(?:px|rem|em))/g).join(', '));
console.log('  唯一 border-radius 值:', px(/border-radius\s*:\s*([0-9.]+(?:px|rem|%))/g).join(', '));

console.log('\n════════ 首屏（body 后前 1 段 HTML 骨架，压缩后） ════════');
const b = s.indexOf('<body');
const head = s.slice(b, b + 2500);
console.log(head.replace(/\n\s*\n/g, '\n').split('\n').slice(0, 40).join('\n'));
