'use strict';
// 读取 proxies_raw.txt，经 10808 CONNECT 链式转发测试可达 Tumblr 的代理
const http = require('http');
const https = require('https');
const fs = require('fs');

const PARENT = { host: '', port: 10808 };
const TUMBLR_HOST = 'api.tumblr.com';
const TUMBLR_PORT = 443;
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';

 chainTumblr(freeProxy) {
  return new Promise((resolve) => {
    const [fh, fp] = freeProxy.split(':');
    const req = http.request({ host: PARENT.host, port: PARENT.port, method: 'CONNECT', path: `${fh}:${fp}`, timeout: 8000 });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { try { socket.destroy(); } catch (e) {} resolve({ status: 'HOP1_FAIL' }); return; }
      const req2 = http.request({ host: fh, port: Number(fp), method: 'CONNECT', path: `${TUMBLR_HOST}:${TUMBLR_PORT}`, timeout: 8000, socket, agent: false });
      req2.on('connect', (res2, socket2) => {
        if (res2.statusCode !== 200) { try { socket2.destroy(); } catch (e) {} resolve({ status: 'HOP2_FAIL' }); return; }
        const greq = https.request({ method: 'GET', path: '/v2/user/info', headers: { Host: TUMBLR_HOST, '': 'Mozilla/5.0' }, timeout: 10000, socket: socket2, servername: TUMBLR_HOST },
          (gres) => { let d = ''; gres.on('data', (c) => (d += c)); gres.on('end', () => resolve({ status: gres.statusCode })); });
        greq.on('timeout', () => { try { greq.destroy(); } catch (e) {} resolve({ status: 'TLS_TIMEOUT' }); });
        greq.on('error', () => resolve({ status: 'TLS_ERR' }));
        greq.end();
      });
      req2.on('timeout', () => { try { req2.destroy(); } catch (e) {} resolve({ status: 'HOP2_TIMEOUT' }); });
      req2.on('error', () => resolve({ status: 'HOP2_ERR' }));
      req2.end();
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ status: 'HOP1_TIMEOUT' }); });
    req.on('error', () => resolve({ status: 'HOP1_ERR' }));
    req.end();
  });
}

const DEADLINE = Date.now() + 500000;

(async () => {
  const lines = fs.readFileSync(WS + '/proxies_raw.txt', 'utf8').split('\n').map((s) => s.trim()).filter((s) => /^[\d.]+:\d+$/.test(s) && !s.startsWith('0.0.0.0') && !s.startsWith('127.0.0'));
  console.log(`候选代理: ${lines.length}`);
  const working = [];
  const CONC = 25;
  let idx = 0;
  async  worker() {
    while (idx < lines.length && Date.now() < DEADLINE) {
      const i = idx++;
      const r = await chainTumblr(lines[i]);
      const reached = typeof r.status === 'number' && r.status >= 100 && r.status < 600;
      if (reached) {
        working.push({ proxy: lines[i], status: r.status });
        if (working.length <= 20) console.log(`  ✅ ${lines[i]} => ${r.status}`);
        if (working.length >= 25) break;
      }
    }
  }
  const workers = [];
  for (let w = 0; w < CONC; w++) workers.push(worker());
  await Promise.all(workers);
  console.log(`\n链路可达 tumblr 的代理: ${working.length}`);
  if (working.length) {
    fs.writeFileSync(WS + '/_working_proxies.json', JSON.stringify(working, null, 2));
    console.log('已保存 _working_proxies.json');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
