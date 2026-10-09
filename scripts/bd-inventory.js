'use strict';
/**
 * bd-inventory.js — 盘点 Bright Data 账户里「所有可用出口资源」
 * 1. 账户状态 / 余额
 * 2. zone 全清单（含类型、密码、是否 active）
 * 3. 每个 zone 实测若干 session 的出口 IP（经 10950 SOCKS5 → VPS → brd.superproxy.io）
 *
 * 用法：node scripts/bd-inventory.js [--socks=:10950]
 */
const { ProxyAgent, fetch: uFetch } = require('undici');
const { SocksProxyAgent } = (() => { try { return require('socks-proxy-agent'); } catch (e) { return {}; } })();
const net = require('net');

const API_KEY = process.env.BD_API_KEY || '';
const OUT_PROXY = process.env.HTTPS_PROXY || 'http://:10808';
const dispatcher = new ProxyAgent(OUT_PROXY);
const argSocks = (process.argv.find(a => a.startsWith('--socks=')) || '').split('=')[1] || ':10950';

async  api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await uFetch('https://api.brightdata.com' + path, {
      ...opts,
      headers: { : `Bearer ${API_KEY}`, '': 'application/json', ...(opts.headers || {}) },
      dispatcher,
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch (_) {}
    return { status: r.status, json, text: txt.slice(0, 1200) };
  } finally { clearTimeout(timer); }
}

/** 经 SOCKS5 → VPS → brd.superproxy.io 发一次 CONNECT 隧道 + TLS，拿到出口 IP */
 probeExit({ host = 'brd.superproxy.io', port = 44445, user, pass, target = 'api.ipify.org' }) {
  return new Promise((resolve) => {
    const [sh, sp] = argSocks.split(':');
    const t0 = Date.now();
    const s = net.connect(Number(sp) || 10950, sh, () => {
      // SOCKS5 greeting: no auth
      s.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let stage = 0, buf = Buffer.alloc(0), done = false;
    const fail = (m) => { if (!done) { done = true; try { s.destroy(); } catch (_) {} resolve({ ok: false, err: m, ms: Date.now() - t0 }); } };
    s.setTimeout(25000, () => fail('timeout'));
    s.on('error', (e) => fail('socks_err:' + e.message));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf[1] === 0x00) {
        // connect to brd
        const a = Buffer.from(host);
        const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, a.length]), a, Buffer.from([port >> 8, port & 0xff])]);
        s.write(req); stage = 1; buf = Buffer.alloc(0); return;
      }
      if (stage === 1 && buf.length >= 10) {
        if (buf[1] !== 0x00) return fail('socks_connect_failed:' + buf[1]);
        // TCP tunnel established -> do HTTPS CONNECT to brd with basic auth
        const auth = Buffer.from(`${user}:${pass}`'base64');
        s.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\nProxy-: Basic ${auth}\r\n\r\n`);
        stage = 2; buf = Buffer.alloc(0); return;
      }
      if (stage === 2 && buf.indexOf('\r\n\r\n') >= 0) {
        const head = buf.slice(0, buf.indexOf('\r\n\r\n'));
        const code = (head.match(/HTTP\/1\.[01]\s+(\d+)/) || [])[1];
        if (code !== '200') return fail('brd_connect_' + code + ':' + head.split('\r\n')[0]);
        // TLS handshake + HTTP/1.1 GET /
        const tls = require('tls');
        const t = tls.connect({ socket: s, servername: target, rejectUnauthorized: false }, () => {
          t.write(`GET /?format=json HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
        });
        let out = '';
        t.on('data', (x) => { out += x.toString(); });
        t.on('end', () => {
          const ip = (out.match(/"ip"\s*:\s*"([^"]+)"/) || [])[1] || (out.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1];
          resolve({ ok: !!ip, ip, ms: Date.now() - t0 });
          t.destroy();
        });
        t.on('error', (e) => fail('tls_err:' + e.message));
        t.setTimeout(20000, () => fail('tls_timeout'));
        stage = 3;
      }
    });
  });
}

(async () => {
  console.log('=== 1) 账户状态 ===');
  const acc = await api('/account/get');
  console.log('status', acc.status, JSON.stringify(acc.json || acc.text).slice(0, 400));

  console.log('\n=== 2) zone 清单 ===');
  const zs = await api('/zone/get_zones');
  let zones = [];
  if (Array.isArray(zs.json)) zones = zs.json;
  else if (zs.json && Array.isArray(zs.json.zones)) zones = zs.json.zones;
  if (!zones.length) {
    console.log('get_zones 返回:', zs.status, JSON.stringify(zs.json || zs.text).slice(0, 600));
  }
  const custId = (zones[0] && zones[0].customer) || 'hl_ac0f9818';
  console.log('zone 数量:', zones.length, 'customer:', custId);
  zones.forEach((z) => {
    console.log(` - ${z.name} | type=${z.type || z.product || '?'} | active=${z.active !== false} | plan=${JSON.stringify(z.plan || {}).slice(0, 80)}`);
  });

  console.log('\n=== 3) 出口 IP 实测（经', argSocks, '） ===');
  if (!SocksProxyAgent) { console.log('（socks-proxy-agent 未安装，使用原生探测）'); }
  const toTest = [];
  const pw = process.env.BD_ZONE_PW || 'd2ream9zn4am';
  // 已配置的 isp_proxy1 + 常见默认 zone 名
  ['isp_proxy1', 'residential_proxy1', 'datacenter_proxy1', 'isp_proxy2', 'resi_tumblr'].forEach((z) => {
    for (let i = 1; i <= 3; i++) toTest.push({ zone: z, sess: `s${i}` });
  });
  const seen = {};
  for (const t of toTest) {
    const user = `brd-customer-${custId}-zone-${t.zone}-session-${t.sess}`;
    const r = await probeExit({ user, pass: pw });
    const tag = `${t.zone}/${t.sess}`;
    console.log(` ${tag.padEnd(28)} ${r.ok ? 'OK  ip=' + r.ip + ` (${r.ms}ms)` : 'FAIL ' + r.err}`);
    if (r.ok) { seen[r.ip] = true; }
    if (!r.ok && /brd_connect_407|auth/i.test(r.err)) { /* 该 zone 不可用，继续 */ }
  }
  const ips = Object.keys(seen);
  console.log(`\n唯一出口 IP 数: ${ips.length}`, ips.join(', '));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
