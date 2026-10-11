#!/usr/bin/env node
'use strict';
/**
 * BD TLS 转发器 (2026-10-11) —— P0-1 出口恢复的可靠方案
 *
 * 背景（实测坐实）：
 *   本机整套隧道（10808/10950 xray、mihomo 20101-20150、CF worker 20201-20240）
 *   全部失效；而 GFW 会对**明文 HTTP CONNECT 里的目标主机名**做识别并 RST
 *   （实测：经 BD 明文口 44445 连 google/tumblr → exit 56 秒断；连
 *    github/cloudflare/microsoft → 200）。因此凡是"明文 CONNECT 到代理"的
 *   链路，都无法访问被墙目标站。
 *
 * 解法：把与 Bright Data 的连接**升级为 TLS**（BD 的 TLS 代理端口 33335），
 *   CONNECT 目标主机名进入 TLS 密文 → GFW 不可见 → 正常中转。
 *
 * 链路：
 *   MSCMS(undici/curl) → 127.0.0.1:10809 (明文 HTTP CONNECT，仅本机环回)
 *     → [TLS] brd.superproxy.io:33335 → BD isp/residential 出口 → 目标
 *
 * 特性：全方法透传（GET/POST/PUT…，TLS 端到端，OAuth 签名头完整保留）、
 *       支持 CONNECT 隧道与明文绝对 URI 两种代理请求、超时与错误可归因。
 *
 * 用法：
 *   BD_PASSWORD=... LISTEN_PORT=10809 node tools/bd-tls-forwarder.js   （常驻）
 * 由 tools/mscms-watchdog.js 作为服务纳管保活。
 */
const net = require('net');
const tls = require('tls');
const http = require('http');
const fs = require('fs');

// 多端口监听：
//   10809 = 看门狗默认出网代理 + 代理池 bd-tls-relay 条目
//   10808 = 兼容既有由 SYSTEM 看门狗托管的 3002/3005 的 env（原 xray 端口）
//   20101-20150 = 兼容【发布器永久缓存】里的旧 mihomo 出口端口（mihomo 已停用）
//   20201-20240 = 兼容【发布器永久缓存】里的旧 CF worker 出口端口（cf-tunnel 已停用）
// 为什么必须兼容后两段：cloud-publisher.js:888 `if (this._proxyCache && this._proxyCache.length) return`
//   会**永久缓存**首次读到的出口列表（实测 44 条，主体是 20201-20240）；3002 由
//   WinSW/SYSTEM 托管，改池后无法重启 3002 去重读 → 那 44 个端口必须继续"看起来可用"。
//   让它们全部指向同一条 BD TLS 隧道即可：老缓存与新池（仅 10809）两条路径都能出网。
const _COMPAT_PORTS = (() => {
  const a = [10808, 10809];
  for (let p = 20101; p <= 20150; p++) a.push(p);
  for (let p = 20201; p <= 20240; p++) a.push(p);
  return a.join(',');
})();
const LISTEN_PORTS = String(process.env.BD_RELAY_PORTS || process.env.BD_RELAY_PORT || process.env.LISTEN_PORT || _COMPAT_PORTS)
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
const BD_HOST = process.env.BD_HOST || 'brd.superproxy.io';
const BD_TLS_PORT = Number(process.env.BD_TLS_PORT || 33335);   // TLS 代理口（关键）
const BD_CUSTOMER = process.env.BD_CUSTOMER || 'hl_ac0f9818';
const BD_ZONE = process.env.BD_ZONE || 'isp_proxy1';
const BD_PASSWORD = process.env.BD_PASSWORD || 'd2ream9zn4am';
const BD_SESSION = process.env.BD_SESSION || '';                // isp(res_static) 下为 no-op
const BD_INSECURE = String(process.env.BD_TLS_INSECURE || '1') !== '0';
const LOG_DIR = process.env.LOG_DIR || 'D:/mscms-ws/logs';
const LOG = LOG_DIR + '/bd-relay.log';
const UP_TIMEOUT_MS = Number(process.env.BD_UP_TIMEOUT_MS || 12000);
const UP_TRIES = Number(process.env.BD_UP_TRIES || 2);   // 上游建连重试次数（GFW 会偶发拖慢 TLS 握手）

const BD_USER = `brd-customer-${BD_CUSTOMER}-zone-${BD_ZONE}` + (BD_SESSION ? `-session-${BD_SESSION}` : '');
const BD_AUTH = 'Basic ' + Buffer.from(`${BD_USER}:${BD_PASSWORD}`).toString('base64');

function log(...a) {
  const line = `[${new Date().toISOString()}] [bd-relay] ${a.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
  console.log(line);
}
function bump(ok) { stats[ok ? 'ok' : 'fail']++; }

const stats = { ok: 0, fail: 0, startedAt: Date.now() };
log(`启动: 监听 127.0.0.1:{${LISTEN_PORTS.join(',')}} → [TLS]${BD_HOST}:${BD_TLS_PORT} user=${BD_USER}`);

/** 与 BD 建立 TLS 连接（CONNECT 目标进入密文，绕开 GFW 明文 RST） */
function bdConnect() {
  return tls.connect({
    host: BD_HOST, port: BD_TLS_PORT, servername: BD_HOST,
    rejectUnauthorized: !BD_INSECURE,
  });
}

/**
 * 通过 BD 向 targetHost:targetPort 建立隧道。
 * onReady(tlsSocket) 时表示 CONNECT 返回 200，可开始透传。
 */
function buildTunnel(targetHost, targetPort, head, onReady, onFail, triesLeft) {
  if (triesLeft === undefined) triesLeft = UP_TRIES;
  let settled = false;
  const up = bdConnect();
  const fail = (err) => {
    if (settled) return; settled = true;
    try { up.destroy(); } catch (_) {}
    if (triesLeft > 1 && !/拒绝 CONNECT/.test(err.message)) {
      // 建连阶段失败（超时/重置）→ 快速重试；已被 BD 明确拒绝（403 等）则不重试
      setTimeout(() => buildTunnel(targetHost, targetPort, head, onReady, onFail, triesLeft - 1), 250);
    } else {
      onFail(err);
    }
  };
  const timer = setTimeout(() => fail(new Error('BD 上游超时(>' + (UP_TIMEOUT_MS / 1000) + 's)')), UP_TIMEOUT_MS);

  up.on('secureConnect', () => {
    up.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      `Proxy-Authorization: ${BD_AUTH}\r\n` +
      `Proxy-Connection: Keep-Alive\r\n\r\n`
    );
  });

  let buf = Buffer.alloc(0);
  const onData = (d) => {
    if (settled) return;
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) {
      if (buf.length > 65536) { clearTimeout(timer); fail(new Error('BD 响应头过大')); }
      return;
    }
    const head_str = buf.slice(0, i).toString('latin1');
    const statusLine = head_str.split('\r\n')[0];
    const m = statusLine.match(/HTTP\/1\.[01] (\d{3})/);
    const code = m ? Number(m[1]) : 0;
    if (code !== 200) {
      clearTimeout(timer);
      fail(new Error('BD 拒绝 CONNECT (' + code + '): ' + statusLine));
      return;
    }
    settled = true; clearTimeout(timer);
    up.removeListener('data', onData);
    const leftover = buf.slice(i + 4);
    onReady(up, leftover);
  };
  up.on('data', onData);
  up.on('error', (e) => { clearTimeout(timer); fail(e); });
  up.on('close', () => { clearTimeout(timer); fail(new Error('BD 连接提前关闭')); });
  return { up, head };
}

function makeProxyServer() {
  const server = http.createServer();

  // —— CONNECT 隧道（https 目标走这里，是主路径）——
  server.on('connect', (req, clientSocket, head) => {
    const [host, portRaw] = req.url.split(':');
    const port = parseInt(portRaw || '443', 10);
    clientSocket.on('error', () => {});
    buildTunnel(host, port, head, (up, leftover) => {
      bump(true);
      try { clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n'); } catch (_) {}
      if (head && head.length) up.write(head);
      if (leftover && leftover.length) clientSocket.write(leftover);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
      const kill = () => { try { up.destroy(); } catch (_) {} try { clientSocket.destroy(); } catch (_) {} };
      up.on('error', kill); up.on('close', kill);
      clientSocket.on('close', kill); clientSocket.on('error', kill);
    }, (err) => {
      bump(false);
      log(`CONNECT ${host}:${port} 失败 → ${err.message}`);
      try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch (_) {}
      try { clientSocket.destroy(); } catch (_) {}
    });
  });

  // —— 明文绝对 URI 请求（http 目标走这里）——
  server.on('request', (req, res) => {
    let target;
    try { target = new URL(req.url); } catch (_) { res.writeHead(400); res.end('bad url'); return; }
    const th = target.hostname;
    const tp = parseInt(target.port || (target.protocol === 'https:' ? 443 : 80), 10);
    buildTunnel(th, tp, null, (up) => {
      bump(true);
      let out = `${req.method} ${target.pathname + target.search} HTTP/1.1\r\n`;
      out += `Host: ${target.host}\r\n`;
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === 'proxy-authorization' || k.toLowerCase() === 'proxy-connection') continue;
        out += `${k}: ${v}\r\n`;
      }
      out += 'Connection: close\r\n\r\n';
      up.write(out);
      req.pipe(up);
      let raw = Buffer.alloc(0);
      up.on('data', (c) => {
        raw = Buffer.concat([raw, c]);
        const i = raw.indexOf('\r\n\r\n');
        if (i < 0) return;
        const headStr = raw.slice(0, i).toString('latin1');
        const body = raw.slice(i + 4);
        const sl = headStr.split('\r\n')[0];
        const code = (sl.match(/HTTP\/1\.[01] (\d{3})/) || [, '502'])[1];
        const hdrs = headStr.split('\r\n').slice(1)
          .filter((h) => !/^transfer-encoding/i.test(h) && !/^connection/i.test(h))
          .map((h) => { const j = h.indexOf(':'); return [h.slice(0, j), h.slice(j + 1).trim()]; });
        try { res.writeHead(Number(code), hdrs); } catch (_) {}
        if (body.length) res.write(body);
        raw = Buffer.alloc(0);
      });
      up.on('end', () => { try { res.end(); } catch (_) {} });
      up.on('error', () => { try { res.destroy(); } catch (_) {} });
    }, (err) => {
      bump(false);
      log(`REQUEST ${th}:${tp} 失败 → ${err.message}`);
      try { res.writeHead(502); res.end(); } catch (_) {}
    });
  });

  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch (_) {} });
  return server;
}

for (const port of LISTEN_PORTS) {
  const srv = makeProxyServer();
  srv.on('error', (e) => log(`监听 ${port} 失败: ${e.message}`));
  srv.listen(port, '127.0.0.1', () => {
    log(`就绪 ✅ 127.0.0.1:${port}（BD ${BD_ZONE} via TLS:${BD_TLS_PORT}）`);
  });
}

process.on('uncaughtException', (e) => log('uncaughtException: ' + (e && e.message)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.message)));
