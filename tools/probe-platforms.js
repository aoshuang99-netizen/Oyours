#!/usr/bin/env node
/* 平台盘点探针（只读）
 * 用途：一次性拉齐「系统已接入什么 / 配置了什么 / 实际发布了什么 / provider 通道开了没」
 * 输出：控制台 + reports/_-inventory.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const WS = path.join(__dirname, '..');
const OUT = path.join(WS, 'reports', '_-inventory.json');

 get(port, p, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const q = http.get({ host: '', port, path: p, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ s: res.statusCode, b }));
    });
    q.on('timeout', () => { q.destroy(); resolve({ s: 0, b: 'TIMEOUT' }); });
    q.on('error', (e) => resolve({ s: 0, b: 'ERR ' + e.message }));
  });
}

 rdModule(f) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(WS, 'data', f), 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && raw['0'] && typeof raw['0'] === 'object') return Object.values(raw['0']);
    return Object.values(raw).filter((x) => x && typeof x === 'object');
  } catch (e) { return []; }
}

 mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return s.replace(/.(?=.{2})/g, '*');
  return s.slice(0, 4) + '…' + s.slice(-3) + `(len=${s.length})`;
}

(async () => {
  const out = { at: new Date().toISOString(), providers: [], configs: {}, distributions: {}, publishReport: null };

  // 1) 线上 provider 状态
  const r = await get(3002, '/api/v14/mixpost/providers');
  console.log('=== 1. providers API ===');
  console.log('HTTP', r.s);
  let provArr = [];
  try {
    const j = JSON.parse(r.b);
    provArr = Array.isArray(j) ? j : (j.providers || j.data || []);
  } catch (e) { console.log(r.b.slice(0, 300)); }
  for (const p of provArr) {
    const row = {
      id: p.identifier || p.id || p.name,
      configured: p.configured,
      authorized: p.authorized,
      reachable: p.reachable,
      reason: p.reason || null,
      account: p.account ? (p.account.name || p.account.url) : null,
    };
    out.providers.push(row);
    console.log(`  ${String(row.id).padEnd(12)} configured=${String(row.configured).padEnd(5)} authorized=${String(row.authorized).padEnd(5)} reachable=${String(row.reachable).padEnd(8)} ${row.reason || ''}`);
  }

  // 2) 平台子集公告
  for (const p of ['/api/v14/mixpost/provider/channels', '/api/v14/mixpost/providers/supported']) {
    const rr = await get(3002, p, 20000);
    if (rr.s === 200) { console.log(`\n[${p}]`, rr.b.slice(0, 600)); out[p] = rr.b.slice(0, 2000); }
  }

  // 3) 各平台 config 文件实况（脱敏）
  console.log('\n=== 2. 平台配置文件 ===');
  const cfgFiles = fs.readdirSync(path.join(WS, 'data')).filter((f) => /_config\.json$|creds\.json$/.test(f));
  for (const f of cfgFiles) {
    const arr = rdModule(f);
    const first = arr[0] || {};
    const cred = {
      file: f, rows: arr.length,
      keys: Object.keys(first),
      fields: Object.fromEntries(Object.entries(first).filter(([k]) => /token|key|secret|pass|id|instance|host|user|domain|url/i.test(k)).map(([k, v]) => [k, mask(typeof v === 'object' ? JSON.stringify(v) : v)])),
    };
    out.configs[f] = cred;
    console.log(`  ${f.padEnd(28)} rows=${String(arr.length).padEnd(4)} keys=${cred.keys.join(',')}`);
    for (const [k, v] of Object.entries(cred.fields)) console.log(`      ${k} = ${v}`);
  }
  // 根目录 creeds（非 data/）
  for (const f of ['-creds.json', 'telegraph-creds.json', 'credentials-input.json', 'tumblr_apps.json']) {
    const fp = path.join(WS, f);
    if (fs.existsSync(fp)) {
      try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        console.log(`  [root] ${f} keys=${Object.keys(j).join(',')} size=${fs.statSync(fp).size}B`);
        out.configs['root:' + f] = { file: f, keys: Object.keys(j) };
      } catch (e) { console.log(`  [root] ${f} 解析失败`); }
    }
  }

  // 4) 数据分布
  console.log('\n=== 3. 数据分布 ===');
  const content = rdModule('content.json');
  const publish = rdModule('publish.json');
  const  = rdModule('.json');
  const tab = (arr, k) => arr.reduce((m, x) => { const v = String(x[k] || '-'); m[v] = (m[v] || 0) + 1; return m; }, {});
  const dist = {
    content_total: content.length, content_: tab(content, ''), content_status: tab(content, 'status'),
    publish_total: publish.length, publish_: tab(publish, ''),
    _total: .length, _: tab(, ''),
  };
  out.distributions = dist;
  console.log('  content:', dist.content_total, JSON.stringify(dist.content_));
  console.log('  content.status:', JSON.stringify(dist.content_status));
  console.log('  publish:', dist.publish_total, JSON.stringify(dist.publish_));
  console.log('  :', dist._total, JSON.stringify(dist._));

  // 5) 发布报告（含 byPlatform）
  const rep = await get(3002, '/api/v14/cloud-publish/report', 90000);
  console.log('\n=== 4. cloud-publish report ===');
  if (rep.s === 200) {
    try { const j = JSON.parse(rep.b); out.publishReport = j; console.log(JSON.stringify(j.byPlatform || j, null, 1).slice(0, 1500)); }
    catch (e) { console.log(rep.b.slice(0, 800)); }
  } else console.log('HTTP', rep.s, rep.b.slice(0, 200));

  // 6) 因果链状态
  const cc = await get(3002, '/api/v14/causal-chain/status', 90000);
  if (cc.s === 200) { try { const j = JSON.parse(cc.b); out.causal = j; console.log('\n=== 5. 因果链 ==='); console.log(JSON.stringify(j.phases || j, null, 1).slice(0, 1200)); } catch (e) {} }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n落盘 →', OUT);
})();
