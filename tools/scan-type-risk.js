// 扫描 v14-dash.html 中所有类型不安全的渲染调用：
//  A. X.slice(  —— X 可能是 number/object（number 无 slice，直接崩）
//  B. X.toFixed( —— X 可能是 string
//  C. X*100 / X*1  —— X 可能是 string 或 "0%"
//  D. kpiCard( 第一参可能是 object -> [object Object]
//  E. .length 用在可能是对象的值上
const fs = require('fs');
const FILE = process.argv[2] || 'v14-dash.html';
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

// 统计每个 render 函数的范围
const fnRe = /^(?:async )?function (render\w+)\(\)\s*\{/;
const fns = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(fnRe);
  if (m) fns.push({ name: m[1], start: i });
}
fns.forEach((f, i) => { f.end = (i + 1 < fns.length ? fns[i + 1].start : lines.length); });
const fnAt = n => fns.find(f => n >= f.start && n < f.end);

const findings = [];
const push = (ln, kind, expr) => findings.push({ loc: ln + 1, fn: (fnAt(ln) || {}).name || '-', kind, expr: expr.trim().slice(0, 130) });

lines.forEach((L, i) => {
  if (/^\s*\/\//.test(L)) return;

  // A. .slice(  —— 排除已用 str()/esc(str( 包裹的
  for (const m of L.matchAll(/([\w$.\[\]'"]+)\.slice\(/g)) {
    const pre = L.slice(Math.max(0, m.index - 6), m.index);
    if (/str\(|esc\(|String\(/.test(pre)) continue;          // 已安全包装
    push(i, 'A-slice', m[1]);
  }
  // B. .toFixed(
  for (const m of L.matchAll(/([\w$.\[\]'"]+)\.toFixed\(/g)) {
    const pre = L.slice(Math.max(0, m.index - 10), m.index);
    if (/numOf\(|Number\(|parseFloat\(/.test(pre)) continue;
    push(i, 'B-toFixed', m[1]);
  }
  // C. *100 且左侧不是 numOf/Number
  for (const m of L.matchAll(/([\w$.\[\]'"]+)\s*\*\s*100\b/g)) {
    const pre = L.slice(Math.max(0, m.index - 10), m.index);
    if (/numOf\(|Number\(|parseFloat\(/.test(pre)) continue;
    push(i, 'C-mul100', m[1]);
  }
  // D. kpiCard( 首个参数是可能为对象的表达式（含 || 的复合）
  for (const m of L.matchAll(/kpiCard\(\s*([^,]{1,80}?)\s*,/g)) {
    const a = m[1];
    if (/^(numOf\(|str\(|[0-9]|')/.test(a)) continue;
    if (!/\|/.test(a)) continue;                       // 无 || 兜底的简单引用不算高危
    push(i, 'D-kpiObj', a);
  }
});

const byKind = {};
findings.forEach(f => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
console.log('=== 类型风险扫描: ' + FILE + ' ===');
Object.keys(byKind).sort().forEach(k => {
  console.log('\n## ' + k + '  (' + byKind[k].length + ')');
  byKind[k].forEach(f => console.log('  L' + String(f.loc).padEnd(5) + f.fn.padEnd(24) + f.expr));
});
console.log('\n总计 ' + findings.length + ' 处待评估');
