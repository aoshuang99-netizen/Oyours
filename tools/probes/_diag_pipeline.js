const fs = require('fs');
const path = require('path');

const DIR = 'D:\\mscms-ws\\data2';
const rows = [];
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  const p = path.join(DIR, f);
  let n = -1;
  let kind = '?';
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) { n = raw.length; kind = 'array'; }
    else if (raw && typeof raw === 'object') { n = Object.keys(raw; kind = 'object'; }
  } catch (e) { kind = 'parse_err'; }
  rows.push({ name: f.replace('.json', ''), n, kind, size: fs.statSync(p).size });
}
rows.sort((a, b) => b.n - a.n);
console.log('=== data2 模块记录数 TOP 25 ===');
for (const r of rows.slice(0, 25)) {
  console.log('  ' + String(r.n).padStart(7) + '  ' + r.kind.padEnd(9) + (r.size / 1024).toFixed(0).padStart(7) + 'KB  ' + r.name);
}
console.log('total modules = ' + rows.length);

// 关键链路模块单独确认
console.log('\n=== 全链路关键模块 ===');
const key = ['', '', 'content', 'publish', 'visits', 'dau_log', '',
  'decision_actions', 'conversion_logs', 'traffic_links', 'traffic_click_logs',
  'account_tracker_cycles', 'nurture_logs', 'tumblr_nurture', 'content_pipeline_logs'];
for (const k of key) {
  const r = rows.find((x) => x.name === k);
  console.log('  ' + k.padEnd(26) + (r ? String(r.n).padStart(7) + ' 条' : '—— 缺失'));
}
