'use strict';
// 经 10808 拉取多源免费代理列表，再用 CONNECT 链式转发测试可达 Tumblr 的代理
const http = require('http');
const https = require('https');
const fs = require('fs');

const PARENT = { host: '', port: 10808 };
const TUMBLR_HOST = 'api.tumblr.com';
const TUMBLR_PORT = 443;

const SOURCES = [
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://www.proxy-list.download/api/v1/get?type=http&anon=elite&country=all',
  'https://api.github.com/repos/monosans/proxy-list/contents/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/proxy-scraper-list/master/http.txt',
];

 getVia10808(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      host: PARENT.host, port: PARENT.port, method: 'GET', path: url, timeout: 20000,
      headers: { Host: u.host, '': 'Mozilla/5.0' },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        // GitHub API 返回 JSON，需解码 content
        if (u.host.includes('api.github.com')) {
          try { const j = JSON.parse(d); if (j.content) d = Buffer.from(j.content, j.encoding || 'base64''utf8'); } catch (e) {}
        }
        resolve({ status: res.statusCode, body: d });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'ERR', msg: e.message.slice(0, 40) }));
    req.end();
  });
}

 chainTumblr(freeProxy) {
  return new Promise((resolve) => {
    const [fh, fp] = freeProxy.split(':');
    const req = http.request({ host: PARENT.host, port: PARENT.port, method: 'CONNECT', path: `${fh}:${fp}`, timeout: 10000 });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { try { socket.destroy(); } catch (e) {} resolve({ status: 'HOP1_FAIL', code: res.statusCode }); return; }
      const req2 = http.request({ host: fh, port: Number(fp), method: 'CONNECT', path: `${TUMBLR_HOST}:${TUMBLR_PORT}`, timeout: 10000, socket, agent: false });
      req2.on('connect', (res2, socket2) => {
        if (res2.statusCode !== 200) { try { socket2.destroy(); } catch (e) {} resolve({ status: 'HOP2_FAIL', code: res2.statusCode }); return; }
        const greq = https.request({ method: 'GET', path: '/v2/user/info', headers: { Host: TUMBLR_HOST, '': 'Mozilla/5.0' }, timeout: 12000, socket: socket2, servername: TUMBLR_HOST },
          (gres) => { let d = ''; gres.on('data', (c) => (d += c)); gres.on('end', () => resolve({ status: gres.statusCode, body: d.slice(0, 100) })); });
        greq.on('timeout', () => { try { greq.destroy(); } catch (e) {} resolve({ status: 'TLS_TIMEOUT' }); });
        greq.on('error', (e) => resolve({ status: 'TLS_ERR', msg: e.message.slice(0, 40) }));
        greq.end();
      });
      req2.on('timeout', () => { try { req2.destroy(); } catch (e) {} resolve({ status: 'HOP2_TIMEOUT' }); });
      req2.on('error', (e) => resolve({ status: 'HOP2_ERR', msg: e.message.slice(0, 40) }));
      req2.end();
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ status: 'HOP1_TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'HOP1_ERR', msg: e.message.slice(0, 40) }));
    req.end();
  });
}

const DEADLINE = Date.now() + 280000;

(async () => {
  console.log('=== 拉取代理列表（多源经 10808）===');
  let lines = [];
  for (const u of SOURCES) {
    const r = await getVia10808(u);
    console.log(`${u.split('?')[0].slice(0, 55)} => ${r.status}`);
    if (r.status === 200 && r.body) {
      const found = r.body.split('\n').map((s) => s.trim()).filter((s) => /^[\d.]+:\d+$/.test(s));
      if (found.length) { lines = found; console.log('  解析到:', found.length, '例:', found.slice(0, 3).join(', ')); break; }
    }
  }
  if (!lines.length) { console.log('所有源失败，终止'); process.exit(0); }

  console.log(`\n=== 链式测试前 ${Math.min(40, lines.length)} 个代理 ===`);
  const working = [];
  for (let i = 0; i < Math.min(40, lines.length); i++) {
    if (Date.now() > DEADLINE) { console.log('触达截止'); break; }
    const r = await chainTumblr(lines[i]);
    const reached = r.status && typeof r.status === 'number' && r.status >= 100 && r.status < 600;
    if (i < 12 || reached) console.log(`  ${lines[i]} => ${JSON.stringify(r)} ${reached ? '✅' : ''}`);
    if (reached) working.push({ proxy: lines[i], status: r.status });
    if (working.length >= 10) break;
  }
  console.log(`\n链路可达 tumblr 的代理: ${working.length}`);
  if (working.length) {
    fs.writeFileSync('C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/_working_proxies.json', JSON.stringify(working, null, 2));
    console.log('已保存 _working_proxies.json');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
