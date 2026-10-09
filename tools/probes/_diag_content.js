const fs = require('fs');
const path = require('path');

const DIR = 'D:\\mscms-ws\\data2';
const load = (n) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, n + '.json'), 'utf8')); }
  catch (e) { return null; }
};

// 1) content 类型分布
const content = load('content');
if (Array.isArray(content)) {
  const byType = {};
  for (const c of content) {
    const t = c.type || c.contentType || c.mediaType || '(无 type 字段)';
    byType[t] = (byType[t] || 0) + 1;
  }
  console.log('=== content 类型分布 (total=' + content.length + ') ===');
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k.padEnd(18) + v));
  const recent = content.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5);
  console.log('  最近内容样例:');
  recent.forEach((c) => console.log('    type=' + (c.type || '?') + '  video=' + (c.videoPath || c.video || '(无)') + '  id=' + c.id));
  console.log('  字段: ' + Object.keys(content[0] || {}).join(', ').slice(0, 160));
}

// 2) 视频文件与内容的时间对齐
console.log('\n=== 视频产出情况 ===');
const vdir = 'D:\\MSCMS-Content\\videos';
if (fs.existsSync(vdir)) {
  const vids = fs.readdirSync(vdir).filter((f) => f.endsWith('.mp4'));
  console.log('  视频总数 = ' + vids.length);
  const times = vids.map((f) => fs.statSync(path.join(vdir, f)).mtimeMs).sort((a, b) => b - a);
  if (times.length) {
    console.log('  最新视频时间 = ' + new Date(times[0]).toISOString().slice(0, 19));
    console.log('  距今 = ' + ((Date.now() - times[0]) / 3600000).toFixed(1) + ' 小时');
  }
} else { console.log('  视频目录不存在'); }

// 3) 最近 24h 是否有内容生成
if (Array.isArray(content)) {
  const cut = Date.now() - 24 * 3600000;
  const recent24 = content.filter((c) => Date.parse(c.createdAt || 0) >= cut);
  console.log('\n=== 最近 24 小时 ===');
  console.log('  新增内容 = ' + recent24.length + ' 条');
  const withVideo = recent24.filter((c) => c.videoPath || c.video);
  console.log('  其中带视频路径 = ' + withVideo.length + ' 条');
}
