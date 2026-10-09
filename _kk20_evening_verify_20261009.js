const http = require('http');
const BASE = 'http://:3002';
const PREFIX = 'kk20-2026-10-09-evening-';

 fetchJson(url, timeout = 60000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(b), ms: Date.now() - t }); }
        catch (e) { resolve({ ok: false, status: res.statusCode, err: 'parse:' + e.message, ms: Date.now() - t }); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - t }); });
    req.on('error', (e) => resolve({ ok: false, err: e.message, ms: Date.now() - t }));
  });
}

(async () => {
  const r = await fetchJson(`${BASE}/api/v14/data/content?limit=30000`, 120000);
  console.log('probe ok=', r.ok, 'status=', r.status, 'ms=', r.ms, r.err || '');
  if (!r.ok) { console.log('BODY', JSON.stringify(r.data || r.err).slice(0, 300)); return; }
  const items = (r.data && r.data.items) || [];
  console.log('endpoint total items =', items.length, 'totalField=', r.data.total);
  console.log('item key sample =', Object.keys(items[0] || {}).join(','));
  const mine = items.filter((x) => String(x.id || '').indexOf(PREFIX) >= 0);
  console.log('==> ENDPOINT kk20 evening today =', mine.length);
  mine.forEach((x) => console.log('   ', x.id, '|', x.status, '|', x.account_id, '|', x., '|', (x.preview_url || '').slice(-40)));
})();
