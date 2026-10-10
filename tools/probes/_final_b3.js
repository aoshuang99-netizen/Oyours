const http = require('http');
const fs = require('fs');
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function req(o, b) {
  return new Promise((r) => {
    const body = b ? JSON.stringify(b) : null;
    const q = http.request(Object.assign({ host: '127.0.0.1', port: 3002, timeout: 8000, headers: { 'Content-Type': 'application/json' } }, o), (x) => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => { try { r({ c: x.statusCode, j: JSON.parse(d) }); } catch (e) { r({ c: x.statusCode, raw: d.slice(0, 150) }); } });
    });
    q.on('timeout', () => { q.destroy(); r({ c: 'TIMEOUT' }); });
    q.on('error', e => r({ c: 'ERR', m: e.message }));
    if (body) q.write(body); q.end();
  });
}
const fakeCnt = () => { const p = fs.readFileSync(WS + '/data/publish.json', 'utf8'); return (p.match(/hlua\.cc\.cd\/content/g) || []).length; };

(async () => {
  // 1) 观察窗口：多个 flush 周期，确认 publish.json 不再反弹污染
  for (let i = 0; i < 3; i++) {
    await sleep(5000);
    const h = await req({ path: '/health', method: 'GET' });
    console.log(`[观察${i}] /health=${h.c} publish.json伪造=${fakeCnt()}`);
  }
  // 2) 重新触发 B3 闭环
  const base = await req({ path: '/api/v14/decision/status', method: 'GET' });
  const bTotal = base.j.totalDecisions;
  const tr = await req({ path: '/api/v14/decision/action', method: 'POST' }, { signal: { signalType: 'VIRAL_IMMINENT', probability: 0.97, variantId: 'b3_final', accountId: '9065' } });
  console.log('[B3触发] code=%s action=%s', tr.c, tr.j && tr.j.action);
  await sleep(1500);
  const after = await req({ path: '/api/v14/decision/status', method: 'GET' });
  console.log('[B3后] totalDecisions %s -> %s state=%s', bTotal, after.j.totalDecisions, after.j.currentState);
  console.log('[诚实性] publish.json 最终伪造数=%s', fakeCnt());
  console.log((after.j.totalDecisions === bTotal + 1 && fakeCnt() === 0) ? 'B3 闭环+诚实性 最终验证通过 ✅' : '需复查 ⚠️');
})();
