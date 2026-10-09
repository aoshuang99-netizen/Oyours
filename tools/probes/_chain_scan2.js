'use strict';
// 多源重试拉取代理列表（退避）+ CONNECT 链式扫描可达 Tumblr 的代理
const http = require('http');
const https = require('https');
const fs = require('fs');

const PARENT = { host: '', port: 10808 };
const TUMBLR_HOST = 'api.tumblr.com';
const TUMBLR_PORT = 443;

const SOURCES = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/proxy-scraper-list/master/http.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/http.txt',
  'https://api.proxyscrape.com/?request=getproxies&proxytype=http&timeout=10000&country=all',
];

 getVia10808(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      host: PARENT.host, port: PARENT.port, method: 'GET', path: url, timeout: 20000,
      headers: { Host: u.host, '': 'curl/8.0' },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'ERR', msg: e.message.slice(0, 40) }));
    req.end();
  });
}

async  fetchAny() {
  for (const u of SOURCES) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await getVia10808(u);
      if (r.status === 200 && r.body) {
        const found = r.body.split('\n').map((s) => s.trim()).filter((s) => /^[\d.]+:\d+$/.test(s));
        if (found.length) { console.log(`✅ ${u.split('/').pop()} 第${attempt}次成功, 代理 ${found.length}`); return found; }
      }
      if (attempt < 4) { console.log(`  ${u.split('/').pop()} 第${attempt}次 ${r.status}, 退避5s`); await new Promise((s) => setTimeout(s, 5000)); }
    }
  }
  return [];
}

 chainTumblr(freeProxy) {
  return new Promise((resolve) => {
    const [fh, fp] = freeProxy.split(':');
    const req = http.request({ host: PARENT.host, port: PARENT.port, method: 'CONNECT', path: `${fh}:${fp}`, timeout: 10000 });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { try { socket.destroy(); } catch (e) {} resolve({ status: 'HOP1_FAIL' }); return; }
      const req2 = http.request({ host: fh, port: Number(fp), method: 'CONNECT', path: `${TUMBLR_HOST}:${TUMBLR_PORT}`, timeout: 10000, socket, agent: false });
      req2.on('connect', (res2, socket2) => {
        if (res2.statusCode !== 200) { try { socket2.destroy(); } catch (e) {} resolve({ status: 'HOP2_FAIL' }); return; }
        const greq = https.request({ method: 'GET', path: '/v2/user/info', headers: { Host: TUMBLR_HOST, '': 'Mozilla/5.0' }, timeout: 12000, socket: socket2, servername: TUMBLR_HOST },
          (gres) => { let d = ''; gres.on('data', (c) => (d += c)); gres.on('end', () => resolve({ status: gres.statusCode })); });
        greq.on('timeout', () => { try { greq.destroy(); } catch (e) {} resolve({ status: 'TLS_TIMEOUT' }); });
        greq.on('error', (e) => resolve({ status: 'TLS_ERR' }));
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

const DEADLINE = Date.now() + 400000;

(async () => {
  console.log('=== 多源重试拉取代理列表 ===');
  const lines = await fetchAny();
  if (!lines.length) { console.log('全部源失败，终止'); process.exit(0); }
  console.log(`总候选: ${lines.length}`);

  console.log('\n=== 链式扫描（前 60）===');
  const working = [];
  for (let i = 0; i < Math.min(60, lines.length); i++) {
    if (Date.now() > DEADLINE) { console.log('截止'); break; }
    const r = await chainTumblr(lines[i]);
    const reached = typeof r.status === 'number' && r.status >= 100 && r.status < 600;
    if (i < 15 || reached) console.log(`  ${lines[i]} => ${JSON.stringify(r)} ${reached ? '✅' : ''}`);
    if (reached) working.push({ proxy: lines[i], status: r.status });
    if (working.length >= 12) break;
  }
  console.log(`\n链路可达 tumblr 代理: ${working.length}`);
  if (working.length) {
    fs.writeFileSync('C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/_working_proxies.json', JSON.stringify(working, null, 2));
    console.log('已保存 _working_proxies.json');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
