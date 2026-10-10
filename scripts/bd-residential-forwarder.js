#!/usr/bin/env node
/**
 * BD Residential/ISP 转发器 — 让 MSCMS 经本地端口使用 Bright Data 标准代理（住宅/ISP）。
 *
 * 链路（SOCKS5 透明隧道，绕过 xray HTTP-CONNECT 嵌套挂起）：
 *   MSCMS(undici ProxyAgent → 127.0.0.1:LISTEN)
 *     → 本转发器 → SOCKS5(10950) → VPS(104.36.71.219) 出口 → brd.superproxy.io:BD_PORT(住宅/ISP zone) → 目标
 *
 * 关键点：
 *  - 外层用 SOCKS5 拿到一条到 BD 的【原始 TCP 隧道】（SOCKS5 对字节透明，xray 不会重解析内层 CONNECT）。
 *  - 内层再向 BD 发 CONNECT 目标（带 Proxy-Authorization），BD 做隧道中转，TLS 端到端，OAuth 签名头完整保留。
 *  - 这正是 Web Unlocker（终止 TLS 重发、剥除鉴权头）不可用，而标准住宅/ISP 代理可用的原因。
 *  - 之前用 10808(xray HTTP 代理) 做嵌套 CONNECT 会挂起 30-60s，改用 SOCKS5 透明隧道后稳定 200。
 *
 * 用法：
 *   BD_ZONE=isp_proxy1 BD_PASSWORD=d2ream9zn4am LISTEN_PORT=10809 \
 *   SOCKS_HOST=127.0.0.1 SOCKS_PORT=10950 node scripts/bd-residential-forwarder.js
 * 默认：BD_CUSTOMER=hl_ac0f9818, BD_PORT=44445(ISP), 住宅=22225
 *
 * 然后 proxy-pool.json 加：{ "url":"http://127.0.0.1:10809", "name":"bd-residential", "enabled":true }
 * 并 POST 3005 /api/reload 即可让养号/发布走住宅/ISP IP。
 */
const net = require('net');
const http = require('http');

const SOCKS_HOST = process.env.SOCKS_HOST || '127.0.0.1';
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || '10950', 10);
const BD_HOST = process.env.BD_HOST || 'brd.superproxy.io';
const BD_PORT = parseInt(process.env.BD_PORT || '44445', 10); // 住宅=22225, ISP=44445, DC=33335
const BD_CUSTOMER = process.env.BD_CUSTOMER || 'hl_ac0f9818';
const BD_ZONE = process.env.BD_ZONE || 'isp_proxy1';
const BD_PASSWORD = process.env.BD_PASSWORD || '';
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '10809', 10);
// 可选：固定 session 让同一出口 IP 保持稳定（养号友好）
const BD_SESSION = process.env.BD_SESSION || '';

if (!BD_PASSWORD) {
  console.error('[bd-forwarder] FATAL: BD_PASSWORD (zone password) 未设置');
  process.exit(1);
}
const BD_USER = `brd-customer-${BD_CUSTOMER}-zone-${BD_ZONE}` + (BD_SESSION ? `-session-${BD_SESSION}` : '');
const BD_AUTH = 'Basic ' + Buffer.from(`${BD_USER}:${BD_PASSWORD}`).toString('base64');

function log(...a) { console.log(`[${new Date().toISOString()}] [bd-forwarder]`, ...a); }
log(`启动: 监听 :${LISTEN_PORT} → SOCKS5 ${SOCKS_HOST}:${SOCKS_PORT} → ${BD_HOST}:${BD_PORT} (user=${BD_USER})`);

/** SOCKS5 握手：连到 SOCKS 代理并向 targetHost:targetPort 发起 CONNECT，返回已连通的 socket */
function socksConnect(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCKS_PORT, SOCKS_HOST, () => {
      s.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: SOCKS5, 1 method, no auth
    });
    let phase = 0, buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return reject(new Error('SOCKS 握手被拒: ' + buf.toString('hex')));
        const h = Buffer.from(targetHost, 'utf8');
        const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])]);
        buf = Buffer.alloc(0); phase = 1; s.write(req);
      } else if (phase === 1) {
        if (buf.length < 10) return;
        if (buf[1] !== 0x00) return reject(new Error('SOCKS CONNECT 失败 rep=' + buf[1]));
        phase = 2; resolve(s);
      }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('SOCKS 超时(>20s)')), 20000);
  });
}

/**
 * 建立 本机→SOCKS5→VPS→BD→目标 隧道。
 * 1) SOCKS5 拿到到 BD 的原始 TCP 隧道
 * 2) 向内层发 CONNECT 目标（带 BD 鉴权）
 * 3) 200 → 隧道建成
 */
function buildTunnel(targetHost, targetPort, onReady, onError) {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    onError(new Error('隧道建立超时(>25s): ' + targetHost));
    try { sock.destroy(); } catch (_) {}
  }, 25000);
  socksConnect(BD_HOST, BD_PORT).then((sock) => {
    sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}\r\nProxy-Authorization: ${BD_AUTH}\r\n\r\n`);
    let buf = '';
    sock.on('data', (d) => {
      if (settled) return;
      buf += d.toString();
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const first = buf.slice(0, idx).split('\r\n')[0];
      if (!/ 200 /.test(first)) {
        settled = true; clearTimeout(timer);
        onError(new Error('BD→目标 CONNECT 失败: ' + first)); sock.destroy(); return;
      }
      settled = true; clearTimeout(timer);
      onReady(sock);
    });
    sock.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); onError(e); } });
  }).catch((e) => { if (!settled) { settled = true; clearTimeout(timer); onError(e); } });
}

const server = http.createServer();

server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const targetPort = parseInt(port || '443', 10);
  log(`CONNECT ${host}:${targetPort}`);
  const tunnel = buildTunnel(host, targetPort, (t) => {
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head && head.length) t.write(head);
    t.pipe(clientSocket);
    clientSocket.pipe(t);
    clientSocket.on('error', () => t.destroy());
    t.on('error', () => clientSocket.destroy());
    t.on('close', () => clientSocket.destroy());
    clientSocket.on('close', () => t.destroy());
  }, (err) => {
    log(`隧道失败 ${host}:${targetPort} -> ${err.message}`);
    try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {}
    clientSocket.destroy();
  });
});

// 处理 undici 对 http(非https) 绝对 URI 请求：CONNECT 后再转发原请求
server.on('request', (req, res) => {
  const target = new URL(req.url);
  const th = target.hostname;
  const tp = parseInt(target.port || (target.protocol === 'https:' ? 443 : 80), 10);
  log(`REQUEST ${req.method} ${req.url}`);
  const tunnel = buildTunnel(th, tp, (t) => {
    let out = `${req.method} ${target.pathname + target.search} HTTP/1.1\r\n`;
    out += `Host: ${th}\r\n`;
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'proxy-authorization') continue;
      out += `${k}: ${v}\r\n`;
    }
    out += '\r\n';
    t.write(out);
    req.on('data', (c) => t.write(c));
    req.on('end', () => {});
    let respHead = '';
    let relayBuf = Buffer.alloc(0);
    t.on('data', (c) => {
      if (!respHead) {
        relayBuf = Buffer.concat([relayBuf, c]);
        const i = relayBuf.indexOf('\r\n\r\n');
        if (i < 0) return;
        respHead = relayBuf.slice(0, i).toString();
        const body = relayBuf.slice(i + 4);
        const statusLine = respHead.split('\r\n')[0];
        const m = statusLine.match(/HTTP\/1\.1 (\d+)/);
        const code = m ? parseInt(m[1], 10) : 502;
        const hdrs = respHead.split('\r\n').slice(1).filter(h => !/^transfer-encoding/i.test(h));
        res.writeHead(code, hdrs.map(h => h.split(': ')));
        if (body.length) res.write(body);
      } else {
        res.write(c);
      }
    });
    t.on('end', () => res.end());
    t.on('error', () => res.destroy());
  }, (err) => {
    log(`http 隧道失败 ${th}:${tp} -> ${err.message}`);
    res.writeHead(502); res.end();
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log(`监听 127.0.0.1:${LISTEN_PORT} 就绪`);
});
