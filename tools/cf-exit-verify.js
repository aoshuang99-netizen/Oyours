#!/usr/bin/env node
/**
 * CF Worker 出口 —— 逐端口验证 + 代理池同步
 *
 * 为什么需要它：
 *   ① `cf-worker-exit.js --ip` 走 Worker 的 fetch() 出口池，恒返回 2a06:98c0:3600::103，
 *      用它验证「多开是否生效」必然得出错误结论。真出口走 cloudflare:sockets.connect()，
 *      必须经隧道端口（20201+）探测。
 *   ② CF-hosted 的 IP 回显服务在 CF 出口下会被回环检测拒绝（api.ipify.org /
 *      cloudflare.com / icanhazip.com 全部 TLS 断连）→ 必须用非 CF 源。
 *   ③ `multi-exit.js` 的探测源正是 api.ipify.org → 40 个 CF 出口会被误判全不可达、
 *      一条都进不了池。本工具用可用源补齐这一步。
 *
 * 可用源（2026-09-11 实测）：
 *   IPv6: ifconfig.me/ip, ip.me, ident.me        -> 2a09:bac5:...
 *   IPv4: checkip.amazonaws.com, ipinfo.io/ip    -> 104.28.x.x
 *
 * 用法：
 *   node tools/cf-exit-verify.js                 # 逐端口验证（默认全部）
 *   node tools/cf-exit-verify.js --count=40
 *   node tools/cf-exit-verify.js --sync-pool     # 用实测 IP 新增/更新 proxy-pool.json
 *   node tools/cf-exit-verify.js --json
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = 'D:/mscms-ws/config/cf-worker-exits.json';
const YAML = 'D:/mscms-ws/tmp/mihomo-multi-exit.yaml';
// 权威池文件是 D 盘那份：server.js 里 EXIT_POOL_FILE = path.join(__dirname, 'proxy-pool.json')，
// 而 3002 是从 D:\MSCMS-Desktop\resources 启动的；工作区那份只是 EXIT_POOL_MIRROR 镜像。
// 只写工作区 = 服务看不到（这是 2026-09-11 踩过的坑）。
const POOL_PRIMARY = 'D:/MSCMS-Desktop/resources/proxy-pool.json';
const POOL_MIRROR = path.join(ROOT, 'proxy-pool.json');
const TUNNEL_BASE = 20201;
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => {
  const m = args.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};

// 非 CF 托管（或经实测可用）的 IP 回显源
const SRC_V6 = ['https://ifconfig.me/ip', 'https://ip.me', 'https://ident.me'];
const SRC_V4 = ['https://checkip.amazonaws.com', 'https://ipinfo.io/ip'];
const SRC_ANY = [...SRC_V6, ...SRC_V4];

const RE_V6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}$/i;
const RE_V4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const pickIp = (b) => {
  const t = String(b || '').trim();
  const first = t.split(/\s+/)[0];
  return RE_V6.test(first) || RE_V4.test(first) ? first : null;
};

function getViaProxy(port, url, timeoutMs = 18000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, err: 'badurl' }); }
    let req;
    try {
      req = http.request(
        { host: '127.0.0.1', port, method: 'CONNECT', path: `${u.hostname}:443`, timeout: timeoutMs },
        () => {}
      );
    } catch (e) { return resolve({ ok: false, err: e.message, ms: Date.now() - t0 }); }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ ...r, ms: Date.now() - t0 }); } };
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return done({ ok: false, err: 'proxy_' + res.statusCode }); }
      const r2 = https.request(
        {
          socket, agent: false, host: u.hostname, path: u.pathname + u.search, method: 'GET',
          servername: u.hostname, rejectUnauthorized: false, headers: { 'User-Agent': 'curl/8.0' },
        },
        (resp) => {
          let body = '';
          resp.on('data', (c) => (body += c));
          resp.on('end', () => done({ ok: true, status: resp.statusCode, body }));
        }
      );
      r2.setTimeout(timeoutMs, () => { r2.destroy(); done({ ok: false, err: 'timeout' }); });
      r2.on('error', (e) => done({ ok: false, err: String(e.message).slice(0, 50) }));
      r2.end();
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, err: 'connect_timeout' }); });
    req.on('error', (e) => done({ ok: false, err: String(e.message).slice(0, 50) }));
    req.end();
  });
}

async function firstIp(port, sources) {
  for (const u of sources) {
    const r = await getViaProxy(port, u);
    if (r.ok && r.status === 200) {
      const ip = pickIp(r.body);
      if (ip) return ip;
    }
  }
  return null;
}

async function probeExit(port) {
  const ip = await firstIp(port, SRC_ANY);
  if (!ip) return { port, ok: false, err: 'no_ip_source_reachable' };
  const ip6 = RE_V6.test(ip) ? ip : await firstIp(port, SRC_V6);
  const ip4 = RE_V4.test(ip) ? ip : await firstIp(port, SRC_V4);
  const t = await getViaProxy(port, 'https://www.tumblr.com/');
  const tumblrOk = t.ok && [200, 301, 302, 401, 403, 404, 429].includes(t.status);
  return { port, ok: true, ip, ip4, ip6, tumblr: tumblrOk, tumblrStatus: t.status || t.err, ms: t.ms };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** 从 mihomo 配置解析 proxy 名 -> listener 端口（池里的 url 用的是这个端口） */
function buildMihomoPortMap() {
  const m = new Map();
  if (!fs.existsSync(YAML)) return m;
  const lines = fs.readFileSync(YAML, 'utf8').split('\n');
  let section = null, lastName = null;
  for (const l of lines) {
    if (/^listeners:/.test(l)) { section = 'listeners'; continue; }
    if (/^proxies:/.test(l)) { section = 'proxies'; continue; }
    if (/^rules:/.test(l)) { section = null; continue; }
    if (section === 'listeners') {
      const nm = l.match(/name:\s*in-(\d+)/);
      if (nm) { lastName = Number(nm[1]); continue; }
      const pm = l.match(/proxy:\s*"?([^"\s]+)"?/);
      if (pm && lastName !== null) { m.set(pm[1], 20101 + lastName); lastName = null; }
    }
  }
  return m;
}

(async () => {
  if (!fs.existsSync(CFG)) { console.error(`× 未找到 ${CFG}`); process.exit(2); }
  const workers = JSON.parse(fs.readFileSync(CFG, 'utf8')).filter((w) => w && w.host);
  if (!workers.length) { console.error('× 配置里没有 worker'); process.exit(2); }

  const portMap = buildMihomoPortMap();
  const count = Math.min(parseInt(arg('count', String(workers.length)), 10), workers.length);
  const targets = workers.slice(0, count).map((w, i) => ({ w, tunnelPort: TUNNEL_BASE + i, mihomoPort: portMap.get(w.name) || null }));

  console.log(`=== CF Worker 出口验证（隧道端口 ${TUNNEL_BASE}~${TUNNEL_BASE + count - 1}）===`);
  if (!portMap.size) console.log('  ⚠️ 未读到 mihomo 配置，--sync-pool 将被跳过');

  const results = await mapLimit(targets, CONCURRENCY, async ({ w, tunnelPort, mihomoPort }) => {
    const r = await probeExit(tunnelPort);
    return { name: w.name, host: w.host, tunnelPort, mihomoPort, ...r };
  });

  const ok = results.filter((r) => r.ok);
  const uniq = (key) => new Set(ok.map((r) => r[key]).filter(Boolean));
  const u6 = uniq('ip6'), u4 = uniq('ip4');

  results.forEach((r) => {
    console.log(r.ok
      ? `  ✅ ${r.tunnelPort} ${r.name.padEnd(14)} → v6 ${String(r.ip6 || '-').padEnd(28)} v4 ${String(r.ip4 || '-').padEnd(16)} tumblr ${r.tumblrStatus}`
      : `  ❌ ${r.tunnelPort} ${r.name.padEnd(14)} → ${r.err}`);
  });

  console.log('');
  console.log(`  隧道端口可达 : ${ok.length}/${results.length}`);
  console.log(`  唯一 IPv6    : ${u6.size}`);
  console.log(`  唯一 IPv4    : ${u4.size}`);
  console.log(`  Tumblr 可达  : ${ok.filter((r) => r.tumblr).length}`);

  const reportPath = path.join(ROOT, 'reports', `cf-exit-verify-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log(`  报告: ${reportPath}`);

  if (has('--json')) console.log(JSON.stringify(results, null, 2));

  if (has('--sync-pool')) {
    const POOL = fs.existsSync(POOL_PRIMARY) ? POOL_PRIMARY : POOL_MIRROR;
    if (!fs.existsSync(POOL)) { console.log('  × 无 proxy-pool.json，跳过同步'); return; }
    console.log(`  池文件: ${POOL}`);
    const arr = JSON.parse(fs.readFileSync(POOL, 'utf8'));

    // ① 清理历史错误条目：指向「mihomo 监听端口」的 CF 条目属于重复且更差的写法
    //    （mihomo 监听端口是全局节点序号派生的，节点数一变就整体漂移；而隧道端口
    //     20201+i 只由 Worker 序号决定，稳定）。正确约定 = 直连隧道端口 + 存 IPv6。
    let removed = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const nm = String(arr[i].name || '');
      if (/^exit-cf-/.test(nm)) { arr.splice(i, 1); removed++; }
    }

    // ② 按 cf-worker-<i> 约定新增/更新（url 固定为隧道端口，exitIp 存 IPv6 = 目标站实际看到的）
    const byName = new Map();
    for (const p of arr) byName.set(String(p.name || ''), p);

    let added = 0, updated = 0;
    for (const r of ok) {
      if (!r.tumblr) continue;
      const idx = r.tunnelPort - TUNNEL_BASE + 1;
      const name = `cf-worker-${idx}`;
      const url = `http://127.0.0.1:${r.tunnelPort}`;
      const exitIp = r.ip6 || r.ip;
      const lastCheck = { at: new Date().toISOString(), realIp: exitIp, http: 200, tumblr: `可达 ${r.tumblrStatus}`, ms: r.ms };
      const exist = byName.get(name);
      if (exist) {
        if (exist.exitIp !== exitIp) { exist.exitIp = exitIp; updated++; }
        if (exist.url !== url) exist.url = url;
        if (exist.usage !== 'post') exist.usage = 'post';
        if (exist.enabled === false) exist.enabled = true;
        exist.tumblr = true;
        exist.src = 'cf-worker';
        exist._lastCheck = lastCheck;
      } else {
        const item = {
          url, name, weight: 1, enabled: true, exitIp, tumblr: true,
          src: 'cf-worker', usage: 'post', _lastCheck: lastCheck,
          _note: `2026-09-11 CF 多开扩容至 40 个（隧道端口 ${r.tunnelPort}，出口为 CF 边缘 IPv6，实测与 Tumblr 可达）`,
        };
        arr.push(item);
        byName.set(name, item);
        added++;
      }
    }

    // ③ 修正历史错误结论的备注
    for (const p of arr) {
      if (typeof p._note === 'string' && /多开只增并发不增 IP 多样性/.test(p._note)) {
        p._note = 'CF 边缘出口（2026-09-11 实测：40 worker → 38 个唯一 IPv6，多开确实增加出口 IP 多样性）';
      }
    }

    const out = JSON.stringify(arr, null, 2);
    fs.writeFileSync(POOL, out, 'utf8');
    // 双写：权威（D 盘）+ 镜像（工作区），与 server.js 的 exitWritePool 语义一致
    try { fs.writeFileSync(POOL_PRIMARY, out, 'utf8'); } catch (e) { console.log('  ⚠️ 写权威池失败: ' + e.message); }
    try { fs.writeFileSync(POOL_MIRROR, out, 'utf8'); } catch (e) { console.log('  ⚠️ 写镜像池失败: ' + e.message); }
    const post = arr.filter((p) => (p.usage || 'post') === 'post' && p.enabled !== false);
    const cfPost = post.filter((p) => /^cf-worker-\d+$/.test(String(p.name || '')));
    console.log(`  池同步: 清理 ${removed} 条旧写法 / 新增 ${added} 条 / 更新 ${updated} 条`);
    console.log(`  池现状: 总数 ${arr.length}，启用 post ${post.length}，其中 CF ${cfPost.length} 条`);
    console.log(`  CF 唯一出口 IP = ${new Set(cfPost.map((p) => p.exitIp).filter(Boolean)).size}`);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
