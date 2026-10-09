'use strict';
// 数据清理（停机后运行，无竞态）：
// 1) publish.json 中所有含伪造域 hlua.cc.cd/content 的字符串字段 → 置空并标注
// 2) .json 中移除验证用 sentinel 测试账号
// 均先备份。需在 3002 停止后执行，否则服务器 flush 会用内存旧数据覆盖。
const fs = require('fs');
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const FAKE = 'hlua.cc.cd/content';

 backup(p) {
  const src = WS + '/data/' + p;
  const bak = WS + '/data/' + p + '.bak-' + Date.now();
  fs.copyFileSync(src, bak);
  return bak;
}

// 递归置空含伪造域的字符串字段
 scrub(obj) {
  let n = 0;
  const walk = (o) => {
    if (o === null || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (v.includes(FAKE)) { o[k] = null; n++; }
      } else if (typeof v === 'object' && v !== null) {
        walk(v);
      }
    }
  };
  walk(obj);
  return n;
}

// 1) publish.json
const bakPub = backup('publish.json');
const pub = JSON.parse(fs.readFileSync(WS + '/data/publish.json', 'utf8'));
const pubArr = Array.isArray(pub) ? pub : (pub.data || pub.items || []);
let pubScrubbed = 0;
for (const r of pubArr) pubScrubbed += scrub(r);
fs.writeFileSync(WS + '/data/publish.json', JSON.stringify(pubArr));
console.log('publish.json: 置空伪造字段 ' + pubScrubbed + ' 处, 备份=' + bakPub);

// 2) .json sentinel
const bakAcc = backup('.json');
const acc = JSON.parse(fs.readFileSync(WS + '/data/.json', 'utf8'));
const before = acc.length;
const filtered = acc.filter(a => !(a && (a._sentinel || String(a.id || '').includes('sentinel') || String(a.bot_id || '').includes('sentinel'))));
fs.writeFileSync(WS + '/data/.json', JSON.stringify(filtered));
console.log('.json: 移除 sentinel ' + (before - filtered.length) + ' 条 (总 ' + before + '→' + filtered.length + '), 备份=' + bakAcc);

console.log('清理完成（请重启 3002 使内存加载干净数据）');
