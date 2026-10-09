const fs = require('fs');
const path = require('path');

const DIR = 'D:\\mscms-ws\\data2';
const load = (n) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8')); }
  catch (e) { return null; }
};

const publish = load('publish');
console.log('=== publish 字段结构 ===');
if (Array.isArray(publish) && publish[0]) {
  console.log('  ' + Object.keys(publish[0]).join(', '));
  console.log('  样例: ' + JSON.stringify(publish[0]).slice(0, 400));
}

console.log('\n=== 按平台统计 ===');
const byPlat = {};
for (const p of publish) {
  const k = p. || 'unknown';
  byPlat[k] = (byPlat[k] || 0) + 1;
}
Object.entries(byPlat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k.padEnd(14) + v));

console.log('\n=== 按 status 统计 ===');
const byStatus = {};
for (const p of publish) {
  const k = p.status || '(no status)';
  byStatus[k] = (byStatus[k] || 0) + 1;
}
Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(k).padEnd(28) + v));

console.log('\n=== 失败/未发布原因分布 ===');
const byReason = {};
for (const p of publish) {
  const k = p.reason || p.error || p.failReason || (p.status && p.status !== 'published' ? '(未记录原因 status=' + p.status + ')' : null);
  if (!k) continue;
  const short = String(k).split(':')[0].slice(0, 60);
  byReason[short] = (byReason[short] || 0) + 1;
}
Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log('  ' + String(v).padStart(5) + '  ' + k));

// 最近 5 条
console.log('\n=== 最近 5 条 publish ===');
const recent = publish.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5);
recent.forEach((p) => {
  console.log('  [' + (p. || '?') + '] status=' + (p.status || '?') +
    ' url=' + (p.postUrl || p.post_url || '(无)') +
    ' reason=' + String(p.reason || p.error || '').slice(0, 70));
});
