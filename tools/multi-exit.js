'use strict';
/**
 * multi-exit.js — 「已注册 IP 资源」统一接入网关（自动化，零手工）
 *
 * 背景：系统空转的根因是出口 IP 只有 1 个（），Tumblr 侧 429 限流。
 * 本机其实已注册大量出口资源但从未接入：
 *   ① Clash profile 机场订阅（145 节点 / 112 国）
 *   ② v2rayN 自有 VPS（BWG 74.211.97.178 / vpsa-cf 104.21.71.122 / bwg-clone ）
 *   ③ Bright Data ISP 住宅（185.97.0.157）
 *   ④ 自有 SS 节点（185.242.86.156）
 *
 * 做法：用 mihomo（Clash Meta）单进程起 N 个 mixed listener，
 *       每个 listener 通过 `proxy:` 字段绑定一个节点 → 每个本地端口 = 一个独立公网出口 IP。
 *       然后自动探测「出口 IP + Tumblr 可达性」，可用的写入 proxy-pool.json（按 IP 去重）。
 *
 * 用法：
 *   node tools/multi-exit.js                # 生成配置 + 启动 + 探测（不写池）
 *   node tools/multi-exit.js --apply        # 探测通过后写入 proxy-pool.json
 *   node tools/multi-exit.js --restart      # 强制重启 mihomo
 *   node tools/multi-exit.js --limit=20     # 只处理前 N 个节点（快速验证）
 *   node tools/multi-exit.js --only=name1,name2
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIHOMO = 'C:/Users/AS/Pictures/v2rayN-windows-64/bin/mihomo/mihomo.exe';
const CLASH_PROFILE_DIR = 'C:/Users/AS/.config/clash/profiles';
const V2RAYN_DB = 'C:/Users/AS/Pictures/v2rayN-windows-64/guiConfigs/guiNDB.db';
const OUT_DIR = 'D:/mscms-ws/tmp';
const CFG_PATH = path.join(OUT_DIR, 'mihomo-multi-exit.yaml');
// 【2026-09-12 修复·重要】权威池是 D 盘那份。
//   3002 由看门狗从 D:\MSCMS-Desktop\resources 启动 → server.js 读的 proxy-pool.json 在 D 盘；
//   工作区那份只是镜像（tools/sync-desktop.js 明确排除本文件，不会把镜像推给 D 盘）。
//   而 exit-guard 由看门狗以 cwd=【工作区】启动 → 本脚本 __dirname 也是工作区
//   → 旧实现 `path.join(ROOT,'proxy-pool.json')` 只写镜像
//   → 后果：【multi-exit 自动发现的新出口永远不被生产读到】，出口池无法自动增长。
//   现与 tools/cf-exit-verify.js 统一策略：双写「权威池 + 镜像」。
const POOL_PRIMARY = 'D:/MSCMS-Desktop/resources/proxy-pool.json';
const POOL_MIRROR = path.join(ROOT, 'proxy-pool.json');
const POOL_PATH = fs.existsSync(POOL_PRIMARY) ? POOL_PRIMARY : POOL_MIRROR;
const BASE_PORT = 20101;
const CF_TUNNEL_BASE = 20201; // tools/cf-tunnel.js 为各 CF Worker 暴露的本地代理端口起点

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESTART = args.includes('--restart');
const LIMIT = parseInt((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const onlyList = ONLY ? ONLY.split(',').map((s) => s.trim()) : null;

const log = (...a) => console.log(...a);

/* ---------------------------------------------------------------- 1. 采集节点 */
 collectClashNodes() {
  const out = [];
  if (!fs.existsSync(CLASH_PROFILE_DIR)) return out;
  for (const f of fs.readdirSync(CLASH_PROFILE_DIR)) {
    if (!f.endsWith('.yml')) continue;
    if (fs.statSync(path.join(CLASH_PROFILE_DIR, f)).size < 10000) continue;
    const t = fs.readFileSync(path.join(CLASH_PROFILE_DIR, f), 'utf8');
    const i = t.indexOf('\nproxies:');
    const j = t.indexOf('\nproxy-groups:');
    if (i < 0) continue;
    const seg = t.slice(i + 10, j > 0 ? j : t.length);
    for (const l of seg.split('\n')) {
      const s = l.trim();
      if (!s.startsWith('- {')) continue;
      try {
        const o = JSON.parse(s.slice(2));
        if (o.type === 'ss' && o.server && o.port) {
          out.push({ name: safeName(o.name), type: 'ss', server: o.server, port: Number(o.port), cipher: o.cipher, : o., plugin: o.plugin, '': o[''], src: 'clash' });
        }
      } catch (_) {}
    }
  }
  return out;
}

 collectV2rayNVps() {
  // v2rayN 的 sqlite 用 node 读不便（无 better-sqlite3），改为读取已导出的缓存（若存在），
  // 否则使用下面硬编码的自有 VPS 参数（来自 guiNDB.db，已于 2026-09-08 核对）。
  const known = [
    {
      name: 'vps-bwg-74', type: 'vless',
      server: '74.211.97.178', port: 443, uuid: '90ef1ecc-07dd-426e-8b7a-2a3f133e31c2',
      network: 'tcp', tls: true, servername: 'statici.icloud.com',
      'reality-opts': { 'public-key': 'HnsfE76ZFil19rS16zqtCJmv8WjkNKE4UKKu_JA_Nz4', 'short-id': 'd6e5e2755d9b03e0' },
      'client-fingerprint': 'chrome', udp: true, src: 'vps',
      dialer: 'vps-bwg-clone-104', // 本机直连超时 → 经已验证出口链式接入
      'skip-cert-verify': true,
    },
    {
      name: 'vps-vpsa-cf-104', type: 'vless',
      server: '104.21.71.122', port: 443, uuid: 'f01424e9-d670-4573-aff8-1988d4400ade',
      network: 'ws', tls: true, servername: 'cf.vpsa.cc.cd',
      'ws-opts': { path: '/vpsa', headers: { Host: 'cf.vpsa.cc.cd' } },
      'client-fingerprint': 'chrome', udp: true, src: 'vps',
      'skip-cert-verify': true,
    },
    {
      name: 'vps-bwg-clone-104', type: 'trojan',
      server: '', port: 443, : '',
      network: 'tcp', tls: true, sni: 'azure.microsoft.com',
      'reality-opts': { 'public-key': 'FNdxVRjg7s9dOC6AHYqdDaHZfcH2jlOlCNkSrwnJ_H8', 'short-id': '5dfb9bad' },
      'client-fingerprint': 'chrome', udp: true, src: 'vps',
    },
  ];
  return known;
}

 collectOwnSS() {
  // test-singbox.json（自有 SS 节点）
  const p = path.join(ROOT, 'test-singbox.json');
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const o = (j.outbounds || []).find((x) => x.type === 'shadowsocks');
    if (!o) return [];
    return [{ name: '', type: 'ss', server: o.server, port: o.server_port, cipher: o.method, : o., udp: true, src: 'ss' }];
  } catch (_) { return []; }
}

 collectBrightData() {
  // BD ISP 住宅（经 10950 SOCKS5 → VPS → brd.superproxy.io）。
  // 需先在 proxies 里定义 socks5 出口（vps-socks），BD 用 dialer-proxy 挂上去。
  const p = path.join(ROOT, 'trusted-exits.json');
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return arr.slice(0, 6).map((e, i) => {
      const u = new URL(e.url);
      return {
        name: 'brd-isp-' + (i + 1),
        type: 'http',
        server: u.hostname,
        port: Number(u.port),
        : decodeURIComponent(u.),
        : decodeURIComponent(u.),
        src: 'brd',
      };
    });
  } catch (_) { return []; }
}

/** Cloudflare Workers 出口（由 tools/cf-worker-exit.js --deploy 生成） */
 collectCFWorkers() {
  const p = 'D:/mscms-ws/config/cf-worker-exits.json';
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return arr
      .filter((x) => x && x.host)
      .map((x, i) => {
        // 本地联调（insecure）直连 workerd；线上走 tools/cf-tunnel.js 暴露的本地端口
        if (x.insecure) {
          return {
            name: safeName(x.name || ('cf-local-' + i)),
            type: 'vless',
            server: String(x.host).split(':')[0],
            port: Number(String(x.host).split(':')[1] || 8787),
            uuid: x.uuid,
            network: 'ws',
            tls: false,
            udp: false,
            'ws-opts': { path: '/' },
            src: 'cf',
          };
        }
        return {
          name: safeName(x.name || ('cf-' + String(x.host).split('.')[0])),
          type: 'http',
          server: '',
          port: CF_TUNNEL_BASE + i,
          udp: false,
          src: 'cf',
        };
      });
  } catch (_) { return []; }
}

 safeName(n) {
  return String(n).replace(/[^\w\u4e00-\u9fa5\-\.]/g, '_').slice(0, 40);
}

/* ---------------------------------------------------------------- 2. 生成配置 */
 buildConfig(nodes) {
  const y = [];
  y.push('# 自动生成 by tools/multi-exit.js — 每端口一个独立出口 IP');
  y.push('mixed-port: 20777');
  y.push('external-controller: :20778');
  y.push('allow-lan: false');
  y.push('mode: rule');
  y.push('log-level: error');
  y.push('ipv6: false');
  y.push('dns:');
  y.push('  enable: true');
  y.push('  ipv6: false');
  y.push('  default-nameserver: [223.5.5.5, 119.29.29.29]');
  y.push('  nameserver: [https://doh.pub/dns-query, 223.5.5.5]');
  y.push('proxies:');
  // BD 出口依赖的 SOCKS5 底层（10950：本机 → VPS trojan/reality）
  y.push('  - {"name":"vps-socks","type":"socks5","server":"","port":10950,"udp":false}');
  nodes.forEach((n) => {
    const raw = { ...n.raw };
    if (n.src === 'brd') raw['dialer-proxy'] = 'vps-socks';
    if (n.raw.dialer) { raw['dialer-proxy'] = n.raw.dialer; delete raw.dialer; }
    y.push('  - ' + JSON.stringify(raw));
  });
  y.push('listeners:');
  nodes.forEach((n, i) => {
    y.push(`  - name: in-${i}`);
    y.push('    type: mixed');
    y.push(`    port: ${BASE_PORT + i}`);
    y.push(`    proxy: ${JSON.stringify(n.name)}`);
  });
  y.push('rules:');
  y.push('  - MATCH,DIRECT');
  return y.join('\n');
}

/* ---------------------------------------------------------------- 3. 探测 */
 portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, '', () => { s.destroy(); res(true); });
    s.setTimeout(800, () => { s.destroy(); res(false); });
    s.on('error', () => res(false));
  });
}

 httpGetViaProxy(port, url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      const u = new URL(url);
      const req = http.request({
        host: '', port, method: 'CONNECT', path: `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`,
        timeout: timeoutMs,
      });
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve({ ...r, ms: Date.now() - t0 }); } };
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); return done({ ok: false, err: 'proxy_' + res.statusCode }); }
        const https = require('https');
        const r2 = https.request({ socket, agent: false, host: u.hostname, path: u.pathname + u.search, method: 'GET', servername: u.hostname, rejectUnauthorized: false, headers: { '': 'curl/8.0' } }, (resp) => {
          let body = '';
          resp.on('data', (c) => (body += c));
          resp.on('end', () => done({ ok: true, status: resp.statusCode, body: body.slice(0, 400) }));
        });
        r2.setTimeout(timeoutMs, () => { r2.destroy(); done({ ok: false, err: 'timeout' }); });
        r2.on('error', (e) => done({ ok: false, err: e.message }));
        r2.end();
      });
      req.on('timeout', () => { req.destroy(); done({ ok: false, err: 'connect_timeout' }); });
      req.on('error', (e) => done({ ok: false, err: e.message }));
      req.end();
    } catch (e) { resolve({ ok: false, err: e.message, ms: Date.now() - t0 }); }
  });
}

/**
 * IP 回显源（按顺序回退）。
 * 为什么不能只用 api.ipify.org：它托管在 Cloudflare 上，经 CF Worker 出口访问会被
 * 回环检测 TLS 断连（2026-09-11 实测 40/40 全失败）→ 导致 CF 出口被误判「全不可达」、
 * 一条都进不了池。必须用非 CF 源，并保留多级回退。
 */
const IP_SOURCES = [
  { url: 'https://checkip.amazonaws.com', pick: (b) => (b.match(/((?:\d{1,3}\.){3}\d{1,3})/) || [])[1] },
  { url: 'https://ipinfo.io/ip', pick: (b) => (b.match(/((?:\d{1,3}\.){3}\d{1,3})/) || [])[1] },
  { url: 'https://ifconfig.me/ip', pick: (b) => (b.match(/([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}|\d{1,3}(?:\.\d{1,3}){3})/i) || [])[1] },
  { url: 'https://api.ipify.org?format=json', pick: (b) => (b.match(/"ip"\s*:\s*"([^"]+)"/) || [])[1] },
];

async  probeIp(port) {
  let lastErr = 'no_ip_source';
  for (const s of IP_SOURCES) {
    const r = await httpGetViaProxy(port, s.url, 18000);
    if (!r.ok) { lastErr = s.url.includes('ipify') ? (r.err || ('http_' + r.status)) : lastErr; continue; }
    const ip = s.pick(r.body || '');
    if (ip) return { ip, ms: r.ms, src: s.url };
    lastErr = 'no_ip_match';
  }
  return { ip: null, err: lastErr };
}

async  probePort(port) {
  const ipR = await probeIp(port);
  if (!ipR.ip) return { port, ok: false, err: 'ip_' + (ipR.err || 'unknown') };
  const ip = ipR.ip;
  const tR = await httpGetViaProxy(port, 'https://api.tumblr.com/v2/user/info', 20000);
  // Tumblr 无凭证时返回 401 = 网络可达；429 = 可达但限流；连接失败才是不可达
  const tumblrOk = tR.ok && [200, 301, 302, 401, 403, 404, 429].includes(tR.status);
  return { port, ok: true, ip, tumblr: tumblrOk, tumblrStatus: tR.status || tR.err, ms: ipR.ms };
}

async  mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ---------------------------------------------------------------- main */
(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  log('=== 1) 采集已注册 IP 资源 ===');
  const clash = collectClashNodes();
  const vps = collectV2rayNVps();
  const ss = collectOwnSS();
  const brd = collectBrightData();
  const cfw = collectCFWorkers();
  const useClash = args.includes('--clash');
  log(`  Clash 机场节点: ${clash.length}${useClash ? '' : '（默认跳过，--clash 启用）'} | 自有 VPS: ${vps.length} | 自有 SS: ${ss.length} | BrightData: ${brd.length} | CF Workers: ${cfw.length}`);

  let nodes = [];
  const push = (n, src) => {
    const raw = { ...n }; delete raw.name; delete raw.src;
    nodes.push({ name: safeName(n.name), raw: { name: safeName(n.name), ...raw }, src });
  };
  if (useClash) clash.forEach((n) => push(n, 'clash'));
  vps.forEach((n) => push(n, 'vps'));
  ss.forEach((n) => push(n, 'ss'));
  brd.forEach((n) => push(n, 'brd'));
  cfw.forEach((n) => push(n, 'cf'));

  if (onlyList) nodes = nodes.filter((n) => onlyList.some((o) => n.name.includes(o)));
  if (LIMIT) nodes = nodes.slice(0, LIMIT);

  // 按端口去重
  const seen = new Set();
  nodes = nodes.filter((n) => {
    // 同一 server:port 但不同账号（如 BD 多 session）视为不同出口，分开探测
    const k = [n.raw.server, n.raw.port, n.raw. || '', n.raw.uuid || '', n.raw. || ''].join(':');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  log(`  去重后待接入: ${nodes.length}`);

  log('\n=== 2) 生成 mihomo 多出口配置 ===');
  const yaml = buildConfig(nodes);
  fs.writeFileSync(CFG_PATH, yaml, 'utf8');
  log(`  写入 ${CFG_PATH}（${nodes.length} 个出口，端口 ${BASE_PORT}~${BASE_PORT + nodes.length - 1}）`);

  const controllerPort = 20777;
  if (RESTART || !(await portOpen(controllerPort))) {
    try { execSync(`taskkill /F /IM mihomo.exe /T`, { stdio: 'ignore' }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1200));
    const workDir = path.join(OUT_DIR, 'mihomo-home');
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    const logFd = fs.openSync(path.join(OUT_DIR, 'mihomo.log'), 'a');
    const child = spawn(MIHOMO, ['-f', CFG_PATH, '-d', workDir, '-ext-ui', ''], { detached: true, stdio: ['ignore', logFd, logFd], cwd: workDir });
    child.unref();
    log('  mihomo 已启动（detached）');
    await new Promise((r) => setTimeout(r, 3500));
  } else {
    log('  mihomo 已在运行，复用');
  }

  log('\n=== 3) 探测出口 IP + Tumblr 可达 ===');
  const ports = nodes.map((_, i) => BASE_PORT + i);
  const results = await mapLimit(ports, 16, async (p, i) => {
    const r = await probePort(p);
    return { ...r, name: nodes[i].name, src: nodes[i].src, server: nodes[i].raw.server, nodePort: nodes[i].raw.port };
  });

  const ok = results.filter((r) => r.ok);
  const tumblrOk = ok.filter((r) => r.tumblr);
  const ipSet = new Set(ok.map((r) => r.ip));
  const tumblrIpSet = new Set(tumblrOk.map((r) => r.ip));
  log(`  可达出口: ${ok.length}/${results.length} | 唯一出口 IP: ${ipSet.size} | Tumblr 可达 IP: ${tumblrIpSet.size}`);

  const sample = tumblrOk.slice(0, 12);
  sample.forEach((r) => log(`   ✅ ${r.name} → ${r.ip} (tumblr ${r.tumblrStatus}, ${r.ms}ms)`));
  const failed = results.filter((r) => !r.ok).slice(0, 8);
  failed.forEach((r) => log(`   ❌ ${r.name} → ${r.err}`));

  const reportPath = path.join(OUT_DIR, 'multi-exit-probe.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 1));
  log(`  完整探测结果: ${reportPath}`);

  if (!APPLY) {
    log('\n（未 --apply，未写入 proxy-pool.json）');
    return;
  }

  log('\n=== 4) 写入 proxy-pool.json ===');
  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const arr = Array.isArray(pool) ? pool : (pool.proxies || []);
  const existingIp = new Set(arr.filter((p) => p.enabled !== false).map((p) => p.exitIp).filter(Boolean));
  let added = 0;
  const byIp = new Map();
  // CF Worker 出口**不在这里入池**：
  //   本函数只能拿到 mihomo 监听端口（20101+ 全局节点序号派生），节点数一变就整体漂移，
  //   而 CF 有更稳定的直连隧道端口（20201+i，只由 Worker 序号决定）。
  //   CF 段由 `node tools/cf-exit-verify.js --sync-pool` 统一维护（含 IPv6 出口 IP 刷新）。
  const cfCount = tumblrOk.filter((r) => r.src === 'cf';
  for (const r of tumblrOk) {
    if (r.src === 'cf') continue;
    if (!byIp.has(r.ip)) byIp.set(r.ip, r);
  }
  for (const [ip, r] of byIp) {
    if (existingIp.has(ip)) { log(`  skip 已存在出口 ${ip}`); continue; }
    arr.push({
      url: `http://:${r.port}`,
      name: `exit-${r.src}-${ip.replace(/\./g, '-')}`,
      weight: 1,
      enabled: true,
      exitIp: ip,
      tumblr: true,
      note: `${new Date().toISOString().slice(0, 10)} multi-exit 自动接入（${r.name}，Tumblr ${r.tumblrStatus}）`,
    });
    added++;
  }
  // 双写：权威池（生产读取）+ 镜像池（工作区，供 diff/审计）
  const out = JSON.stringify(arr, null, 2);
  fs.writeFileSync(POOL_PATH, out);
  try { fs.writeFileSync(POOL_PRIMARY, out); } catch (e) { log(`  ⚠️ 写权威池失败: ${e.message}`); }
  try { fs.writeFileSync(POOL_MIRROR, out); } catch (e) { log(`  ⚠️ 写镜像池失败: ${e.message}`); }
  log(`  ✅ 已双写 权威池(${POOL_PRIMARY}) + 镜像池(${POOL_MIRROR})`);
  log(`  新增 ${added} 条出口，池内总数 ${arr.length}，启用 ${arr.filter((p) => p.enabled !== false}`);
  if (cfCount) {
    log(`  跳过 ${cfCount} 个 CF Worker 出口（由 cf-exit-verify.js --sync-pool 维护，用隧道端口 + IPv6）`);
    log(`  如需刷新 CF 段：node tools/cf-exit-verify.js --sync-pool`);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
