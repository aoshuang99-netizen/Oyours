#!/usr/bin/env node
/**
 * 注入 nostr 待发布内容（走 HTTP API 热写，不直接改盘 —— DataStore 内存优先会覆盖磁盘）
 *
 * 用法：
 *   node tools/seed-nostr-content.js --count=4          # 注入 4 条 ready 内容
 *   node tools/seed-nostr-content.js --count=4 --dry    # 只看将要注入什么
 *
 * 纪律：
 *   · 只经 POST /api/v14/data/content（属主 3002 落库），不碰文件
 *   · account_id 显式绑定到「不在 token 失效黑名单」的活跃账号，
 *     避免兜底 Arr[0] 恰好命中黑名单导致内容永不入队
 *   · tags 必填（P2 定标：零标签 = 零分发的总开关）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const WS = path.join(__dirname, '..');
const COUNT = Number((process.argv.find((a) => a.startsWith('--count=')) || '--count=4').split('=')[1]) || 4;
const DRY = process.argv.includes('--dry');

 req(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const q = http.request({
      host: '', port: 3002, path: p, method, timeout: 30000,
      headers: data ? { '': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ s: res.statusCode, b })); });
    q.on('timeout', () => { q.destroy(); resolve({ s: 0, b: 'TIMEOUT' }); });
    q.on('error', (e) => resolve({ s: 0, b: 'ERR ' + e.message }));
    if (data) q.write(data);
    q.end();
  });
}

 rd(f) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(WS, 'data', f), 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && raw['0'] && typeof raw['0'] === 'object') return Object.values(raw['0']);
    return Object.values(raw).filter((x) => x && typeof x === 'object');
  } catch (e) { return []; }
}

const TOPICS = [
  { t: 'The quiet economics of small creator tools', b: 'Most creator tooling dies because it optimises for launch day instead of month six. The teams that last pick one narrow workflow, instrument it honestly, and resist the urge to bolt on a dashboard nobody opens. Distribution follows trust, not features.', g: ['creators', 'tools', 'product', 'sustainability', 'writing'] },
  { t: 'Why your  pipeline needs an honest failure mode', b: 'An  that silently returns success is worse than one that fails loudly. When every step reports its real status, failures become a queue you can drain. When it lies, failures become a mystery you inherit six months later.', g: ['', 'engineering', 'reliability', 'ops', 'lessons'] },
  { t: 'Notes on running many  without losing the plot', b: 'Scale changes the shape of the problem. One account is a voice. A hundred  is a logistics system, and logistics systems fail at the seams: credentials expire, quotas shift, and the export nobody reads drifts out of date.', g: ['scale', 'systems', 'operations', 'growth', 'notes'] },
  { t: 'A small case for publishing where the protocol is open', b: 'Open protocols are slower to adopt and faster to trust. You keep your identity, your audience is not rented, and no single company can decide your reach overnight. That trade is worth more than a growth chart suggests.', g: ['nostr', 'protocols', 'decentralisation', 'publishing', 'openweb'] },
  { t: 'What measuring honestly actually buys you', b: 'Honest metrics are unglamorous: they are lower, noisier, and they frequently say nothing happened. That is exactly why they are useful. A number you can defend is a number you can act on.', g: ['analytics', 'metrics', 'data', 'honesty', 'process'] },
  { t: 'On reusing one piece of content across many channels', b: 'Cross-posting is not lazy if you adapt the framing per channel. The text survives, the wrapping changes. What kills reach is not repetition but irrelevance: the same flat  everywhere.', g: ['distribution', 'content', 'channels', '', 'reach'] },
];

(async () => {
  // 1) 找一个不在 token 黑名单里的活跃账号
  // ⚠️ 不能用上面的 rd()：deadlist 的结构是 {updatedAt,ttlHours,count,dead:{账号id:…}}，
  // rd() 会把整个对象的 values 摊平成数组，导致读不到 `.dead` 而误报「黑名单 0 个」。
  const deadSet = new Set();
  try {
    const dRaw = JSON.parse(fs.readFileSync(path.join(WS, 'data', '__deadlist.json'), 'utf8'));
    const box = (dRaw && dRaw.dead) || (dRaw && dRaw['0'] && dRaw['0'].dead) || {};
    Object.keys(box).forEach((k) => deadSet.add(k));
  } catch (e) { console.warn('读取 token 黑名单失败（按空处理）:', e.message); }

  const  = rd('.json').filter((a) => String(a.status || '') === 'active' && !String(a.id'acc_'));
  const usable = .find((a) => !deadSet.has(String(a.id)));
  console.log(`活跃真实账号 ${.length} 个；token 黑名单 ${deadSet.size} 个`);
  if (!usable) { console.log('❌ 找不到不在黑名单的活跃账号，中止'); process.exit(1); }
  console.log(`绑定账号: ${usable.id} (=${usable.})`);
  console.log(`内容沉淀平台: nostr（provider 通道）`);

  const ids = [];
  for (let i = 0; i < COUNT; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const id = `content_nostr_${Date.now()}_${i}`;
    const rec = {
      id,
      : 'nostr',
      content_type: 'text',
      title: topic.t,
      body: topic.b,
      status: 'ready',
      quality_v2: 78,
      quality_score: 78,
      tags: topic.g,
      topic: topic.g[0],
      account_id: usable.id,
      source: 'nostr-seed-2026-09-21',
      createdAt: new Date().toISOString(),
    };
    ids.push(id);
    if (DRY) { console.log(`  [dry] ${id} | ${topic.t}`); continue; }
    const r = await req('POST', '/api/v14/data/content', rec);
    console.log(`  ${r.s === 200 ? '✅' : '❌'} ${id} HTTP=${r.s} ${r.s === 200 ? '' : r.b.slice(0, 160)}`);
  }

  if (DRY) { console.log('\n[dry] 未写入。'); return; }
  console.log(`\n已注入 ${ids.length} 条 nostr ready 内容。`);
  fs.writeFileSync(path.join(WS, 'reports', '_nostr-seeded.json'), JSON.stringify({ at: new Date().toISOString(), ids, accountId: usable.id }, null, 2), 'utf8');
})();
