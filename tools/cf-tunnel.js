#!/usr/bin/env node
/**
 * Cloudflare Worker 隧道 —— 本地转发器
 *
 * 把每个部署好的 Worker 出口暴露成一个标准 HTTP 正向代理端口，
 * 这样 proxy-pool.json 可以直接写 http://:<port>，无需 mihomo 协议兼容。
 *
 *   本地请求 -> CONNECT host:port -> wss://<worker>/ -> Cloudflare 边缘 -> 目标
 *
 * 端口规划：20201, 20202, ...（按 cf-worker-exits.json 顺序）
 * 健康端点：http://:20880/health
 *
 * 由 tools/exit-guard.js 保活。
 */
const http = require('http');
const fs = require('fs');
const { WebSocket, ProxyAgent } = require('undici');

const CFG = 'D:/mscms-ws/config/cf-worker-exits.json';
const BASE_PORT = 20201;
const HEALTH_PORT = 20880;
// 注意：v2rayN 的 10808 是 SOCKS5，undici 的 ProxyAgent 只支持 http/https 代理，
// 指过去必然 ws error。改用 chain-upstream 暴露的 HTTP 入口 10960。
const LOCAL_PROXY = process.env.CF_TUNNEL_LOCAL_PROXY || 'http://:10960';

const stats = new Map(); // host -> {ok, fail, lastErr, lastOkAt}
const dispatcher = new ProxyAgent(LOCAL_PROXY);

 log(...a) { console.log(...a); }

 bump(host, ok, err) {
  const s = stats.get(host) || { ok: 0, fail: 0, lastErr: '', lastOkAt: 0 };
  if (ok) { s.ok++; s.lastOkAt = Date.now(); } else { s.fail++; s.lastErr = String(err || '').slice(0, 120); }
  stats.set(host, s);
}

 openWs(worker, target) {
  return new Promise((resolve, reject) => {
    const scheme = worker.insecure ? 'ws' : 'wss';
    let ws;
    try {
      // 本地联调(insecure) 直连；线上走本地代理出网
      ws = worker.insecure
        ? new WebSocket(`${scheme}://${worker.host}/`)
        : new WebSocket(`${scheme}://${worker.host}/`, { dispatcher });
    } catch (e) { return reject(e); }
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('ws timeout')); }, 25000);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      try { ws.send(target); } catch (e) { return reject(e); }
      resolve(ws);
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('ws error: ' + (e && e.message ? e.message : 'unknown'))); });
  });
}

 bridge(clientSocket, ws, host) {
  let dead = false;
  const kill = () => {
    if (dead) return; dead = true;
    try { clientSocket.destroy(); } catch (_) {}
    try { ws.close(); } catch (_) {}
  };
  ws.addEventListener('message', (ev) => {
    let d = ev.data;
    if (typeof d === 'string') d = Buffer.from(d, 'utf8');
    else if (d instanceof ArrayBuffer) d = Buffer.from(d);
    else if (d && d.buffer) d = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    else return;
    try { if (!clientSocket.destroyed) clientSocket.write(d); } catch (_) { kill(); }
  });
  ws.addEventListener('close', kill);
  ws.addEventListener('error', kill);
  clientSocket.on('data', (c) => {
    try {
      if (ws.readyState === 1) ws.send(new Uint8Array(c).buffer ? new Uint8Array(c) : c);
    } catch (_) { kill(); }
  });
  clientSocket.on('end', kill);
  clientSocket.on('close', kill);
  clientSocket.on('error', kill);
}

 startOne(worker, port) {
  const srv = http.createServer();
  srv.on('connect', async (req, clientSocket, head) => {
    const target = req.url; // host:port
    try {
      const ws = await openWs(worker, target);
      bump(worker.host, true);
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head && head.length) ws.send(new Uint8Array(head));
      }
      bridge(clientSocket, ws, worker.host);
    } catch (e) {
      bump(worker.host, false, e.message);
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      } catch (_) {}
    }
  });
  srv.on('request', async (req, res) => {
    // 绝对 URI 形式的正向代理请求（http:// 明文）
    try {
      const u = new URL(req.url);
      const port = u.port || (u.protocol === 'https:' ? 443 : 80);
      const ws = await openWs(worker, `${u.hostname}:${port}`);
      bump(worker.host, true);
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      const raw = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`]
        .concat(Object.entries(headers).map(([k, v]) => `${k}: ${v}`))
        .join('\r\n') + '\r\n\r\n';
      ws.send(new TextEncoder().encode(raw));
      let done = false;
      ws.addEventListener('message', (ev) => {
        if (done) return;
        let d = ev.data;
        if (typeof d === 'string') d = Buffer.from(d, 'utf8');
        else if (d instanceof ArrayBuffer) d = Buffer.from(d);
        else if (d && d.buffer) d = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
        else return;
        // 简化：把整个响应体回给客户端（mihomo/undici 对明文 http 场景已足够）
        if (!res.headersSent) {
          const sep = d.indexOf('\r\n\r\n');
          if (sep > 0) {
            const head = d.slice(0, sep);
            const body = d.slice(sep + 4);
            const status = parseInt((head.match(/^HTTP\/[\d.]+ (\d+)/) || [])[1] || '200', 10);
            const hl = head.split('\r\n').slice(1);
            const hobj = {};
            hl.forEach((l) => { const i = l.indexOf(':'); if (i > 0) hobj[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
            delete hobj['transfer-encoding'];
            delete hobj['content-length'];
            res.writeHead(status, hobj);
            res.end(body);
          } else { res.writeHead(502); res.end('bad upstream'); }
        }
        done = true;
        try { ws.close(); } catch (_) {}
      });
      req.on('data', (c) => { try { if (ws.readyState === 1) ws.send(new Uint8Array(c)); } catch (_) {} });
      req.on('end', () => {});
      setTimeout(() => { if (!done) { try { ws.close(); } catch (_) {} try { res.writeHead(504); res.end('timeout'); } catch (_) {} } }, 30000);
    } catch (e) {
      bump(worker.host, false, e.message);
      try { res.writeHead(502); res.end('cf tunnel error: ' + e.message); } catch (_) {}
    }
  });
  srv.listen(port, '', () => log(`  ${worker.host} -> http://:${port}`));
  srv.on('error', (e) => log(`  × ${worker.host} 端口 ${port} 启动失败: ${e.message}`));
}

 startHealth(workers) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { '': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      localProxy: LOCAL_PROXY,
      exits: workers.map((w, i) => ({ host: w.host, port: BASE_PORT + i, ...(stats.get(w.host) || { ok: 0, fail: 0 }) })),
      ts: Date.now(),
    }, null, 2));
  });
  srv.listen(HEALTH_PORT, '', () => log(`  健康端点 http://:${HEALTH_PORT}/health`));
  srv.on('error', () => {});
}

( main() {
  if (!fs.existsSync(CFG)) {
    log(`× 未找到 ${CFG}`);
    log('  先执行：node tools/cf-worker-exit.js --deploy --count=6');
    process.exit(2);
  }
  const workers = JSON.parse(fs.readFileSync(CFG, 'utf8')).filter((w) => w && w.host);
  if (!workers.length) { log('× 配置里没有 worker'); process.exit(2); }
  log(`=== CF Worker 隧道启动（${workers.length} 个出口，本地转发代理 ${LOCAL_PROXY}）===`);
  workers.forEach((w, i) => startOne(w, BASE_PORT + i));
  startHealth(workers);
})();
