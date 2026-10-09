'use strict';
// 验证 10808 是否支持 CONNECT 链式转发到外部代理，并修正 GitHub 代理列表地址
const http = require('http');
const https = require('https');

const PARENT = { host: '', port: 10808 };
const TUMBLR_HOST = 'api.tumblr.com';
const TUMBLR_PORT = 443;

// 候选 GitHub 代理列表（修正地址）
const LIST_URLS = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/proxy-scraper-list/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/http.txt',
];

 getVia10808(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      host: PARENT.host, port: PARENT.port, method: 'GET',
      path: url, timeout: 15000,
      headers: { Host: u.host },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'ERR', msg: e.message.slice(0, 40) }));
    req.end();
  });
}

// 测试 10808 是否允许 CONNECT 到外部主机
 testConnectAllowed(targetHost, targetPort) {
  return new Promise((resolve) => {
    const req = http.request({
      host: PARENT.host, port: PARENT.port, method: 'CONNECT',
      path: `${targetHost}:${targetPort}`, timeout: 10000,
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ allowed: res.statusCode === 200, code: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ allowed: false, code: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ allowed: false, code: 'ERR', msg: e.message.slice(0, 40) }));
    req.end();
  });
}

// 链式：10808 CONNECT -> freeProxy, 再经 freeProxy CONNECT -> tumblr, 最后 TLS+GET
 chainTumblr(freeProxy) {
  return new Promise((resolve) => {
    const [fh, fp] = freeProxy.split(':');
    // 第1跳：10808 -> freeProxy
    const req = http.request({
      host: PARENT.host, port: PARENT.port, method: 'CONNECT',
      path: `${fh}:${fp}`, timeout: 10000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve({ status: 'HOP1_FAIL', code: res.statusCode }); return; }
      // 第2跳：在 socket 上让 freeProxy CONNECT -> tumblr:443
      const req2 = http.request({
        host: fh, port: Number(fp), method: 'CONNECT',
        path: `${TUMBLR_HOST}:${TUMBLR_PORT}`, timeout: 10000,
        socket, agent: false,
      });
      req2.on('connect', (res2, socket2) => {
        if (res2.statusCode !== 200) { socket2.destroy(); resolve({ status: 'HOP2_FAIL', code: res2.statusCode }); return; }
        // 第3跳：TLS 到 tumblr，GET /v2/user/info
        const tlsOpts = { socket: socket2, servername: TUMBLR_HOST };
        const greq = https.request({
          method: 'GET', path: '/v2/user/info', headers: { Host: TUMBLR_HOST, '': 'Mozilla/5.0' },
          timeout: 12000, ...tlsOpts,
        }, (gres) => {
          let d = ''; gres.on('data', (c) => (d += c)); gres.on('end', () => resolve({ status: gres.statusCode, body: d.slice(0, 120) }));
        });
        greq.on('timeout', () => { greq.destroy(); resolve({ status: 'TLS_TIMEOUT' }); });
        greq.on('error', (e) => resolve({ status: 'TLS_ERR', msg: e.message.slice(0, 50) }));
        greq.end();
      });
      req2.on('timeout', () => { req2.destroy(); resolve({ status: 'HOP2_TIMEOUT' }); });
      req2.on('error', (e) => resolve({ status: 'HOP2_ERR', msg: e.message.slice(0, 40) }));
      req2.end();
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'HOP1_TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 'HOP1_ERR', msg: e.message.slice(0, 40) }));
    req.end();
  });
}

(async () => {
  console.log('=== [A] 10808 CONNECT 允许性测试 ===');
  const c1 = await testConnectAllowed('raw.githubusercontent.com', 443);
  console.log('CONNECT raw.githubusercontent.com:443 =>', JSON.stringify(c1));
  const c2 = await testConnectAllowed('1.1.1.1', 80);
  console.log('CONNECT 1.1.1.1:80 =>', JSON.stringify(c2));

  console.log('\n=== [B] 拉取代理列表（修正地址）===');
  let lines = [];
  for (const u of LIST_URLS) {
    const r = await getVia10808(u);
    console.log(`${u} => ${r.status}${r.body ? ' len=' + r.body.length : ''}`);
    if (r.status === 200 && r.body) {
      lines = r.body.split('\n').map((s) => s.trim()).filter((s) => /^[\d.]+:\d+$/.test(s));
      if (lines.length) { console.log('  解析到代理:', lines.length, ' 例:', lines.slice(0, 3).join(', ')); break; }
    }
  }
  if (!lines.length) { console.log('无可用列表，终止'); process.exit(0); }

  console.log('\n=== [C] 链式转发测试（10808->freeProxy->tumblr）===');
  const working = [];
  for (let i = 0; i < Math.min(30, lines.length); i++) {
    const r = await chainTumblr(lines[i]);
    const ok = r.status && r.status !== 'ERR' && !String(r.status).includes('FAIL') && !String(r.status).includes('TIMEOUT') && r.status !== 429;
    // 只要到达 tumblr（任何 HTTP 状态含 401/403 都算链路通），429 表示 IP 仍被限
    const reached = r.status && r.status >= 100 && r.status < 600;
    console.log(`  ${lines[i]} => ${JSON.stringify(r)} ${reached ? '✅链路通' : ''}`);
    if (reached) working.push({ proxy: lines[i], status: r.status });
    if (working.length >= 8) break;
  }
  console.log(`\n链路可达 tumblr 的代理: ${working.length}`);
  if (working.length) {
    const fs = require('fs');
    fs.writeFileSync('C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/_working_proxies.json', JSON.stringify(working, null, 2));
    console.log('已保存 _working_proxies.json');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
