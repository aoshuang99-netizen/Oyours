const http = require('http');
const fs = require('fs');
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';

function req(o, b) {
  return new Promise((r) => {
    const body = b ? JSON.stringify(b) : null;
    const opts = Object.assign({ host: '127.0.0.1', port: 3002, timeout: 8000, headers: { 'Content-Type': 'application/json' } }, o);
    const q = http.request(opts, (x) => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => { try { r({ c: x.statusCode, j: JSON.parse(d) }); } catch (e) { r({ c: x.statusCode, raw: d.slice(0, 200) }); } });
    });
    q.on('timeout', () => { q.destroy(); r({ c: 'TIMEOUT' }); });
    q.on('error', e => r({ c: 'ERR', m: e.message }));
    if (body) q.write(body);
    q.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1) baseline
  const base = await req({ path: '/api/v14/decision/status', method: 'GET' });
  const b = base.j;
  console.log('[BASELINE] state=%s totalDecisions=%s', b.currentState, b.totalDecisions);

  // 2) 触发 VIRAL_IMMINENT 信号（绕过 detector 打分，直接驱动 handleViralSignal）
  const resp = await req({ path: '/api/v14/decision/action', method: 'POST' }, {
    signal: { signalType: 'VIRAL_IMMINENT', probability: 0.97, variantId: 'b3_clone_test', accountId: '9065', views: 999999, shares: 99999, title: 'B3闭环测试' }
  });
  const dec = resp.j;
  console.log('[TRIGGER] code=%s full=%s', resp.c, JSON.stringify(dec).slice(0, 300));

  // 3) 轮询状态机演进（期望 VIRAL_DETECTED→CLONING→SYNCING→LEARNING→MONITORING）
  let sawViral = false, sawLearning = false, finalState = '';
  for (let i = 0; i < 5; i++) {
    await sleep(700);
    const s = await req({ path: '/api/v14/decision/status', method: 'GET' });
    const j = s.j;
    const last = j.recentDecisions[j.recentDecisions.length - 1];
    if (j.currentState === 'VIRAL_DETECTED') sawViral = true;
    if (j.currentState === 'LEARNING') sawLearning = true;
    finalState = j.currentState;
    console.log('[POLL %d] state=%s totalDecisions=%s lastAction=%s', i, j.currentState, j.totalDecisions, (last && last.action) || '-');
  }

  // 4) 诚实性检查：未授权真实发布被跳过，publish.json 不应新增伪造链接
  const pub = fs.readFileSync(WS + '/data/publish.json', 'utf8');
  const fakeCount = (pub.match(/hlua\.cc\.cd\/content/g) || []).length;
  console.log('[HONESTY] publish.json 伪造链接数=%d (应为0)', fakeCount);

  // 5) 结论
  const closed = sawViral || sawLearning;
  console.log('=== B3 闭环结论 ===');
  console.log('状态机经历 VIRAL/LEARNING 阶段:', closed ? 'YES' : 'NO');
  console.log('最终回到:', finalState);
  console.log('诚实跳过真实发布(无伪造链接):', fakeCount === 0 ? 'YES' : 'NO');
  console.log(closed && fakeCount === 0 ? 'B3 闭环验证通过 ✅' : 'B3 验证需复查 ⚠️');
})();
