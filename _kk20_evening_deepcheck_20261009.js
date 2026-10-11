const http = require('http');
const BASE = 'http://127.0.0.1:3002';

function fetchJson(url, timeout = 120000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ ok: true, data: JSON.parse(b), ms: Date.now() - t }); } catch (e) { resolve({ ok: false, err: 'parse:' + e.message }); } });
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - t }); });
    req.on('error', (e) => resolve({ ok: false, err: e.message, ms: Date.now() - t }));
  });
}

(async () => {
  const r = await fetchJson(`${BASE}/api/v14/data/content?limit=30000`);
  if (!r.ok) { console.log('PROBE FAIL', r.err); return; }
  const items = r.data.items || [];
  console.log('endpoint items =', items.length);

  // 全字段扫描：任何字段包含 kk20-2026-10-09 的条目
  const hits = [];
  for (const x of items) {
    const blob = JSON.stringify(x);
    if (blob.indexOf('kk20-2026-10-09') >= 0) hits.push(x);
  }
  console.log('==> any-field match kk20-2026-10-09 =', hits.length);
  hits.forEach(h => console.log('   ', JSON.stringify(h).slice(0, 300)));

  // 统计今日各前缀
  const byPrefix = {};
  for (const x of items) {
    const m = JSON.stringify(x).match(/kk20-\d{4}-\d{2}-\d{2}/);
    if (m) byPrefix[m[0]] = (byPrefix[m[0]] || 0) + 1;
  }
  console.log('kk20 prefix histogram:', JSON.stringify(byPrefix));

  // 看最新 10 条更新时间（判断本批是否在池中）
  const sorted = [...items].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  console.log('--- newest 8 by updatedAt ---');
  sorted.slice(0, 8).forEach(x => console.log('   ', x.id, '|', x.updatedAt, '|', x.status, '|', x.platform));
})();
