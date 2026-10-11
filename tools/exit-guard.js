'use strict';
/**
 * exit-guard.js — 出网守护（2026-10-11 P0-1 重构版）
 *
 * ── 为什么重构（旧版的三个致命问题，均已实测坐实）────────────────────
 *   旧职责：① 保活 xray VPS SOCKS5(10950) ② 保活 mihomo 多出口(20101-20150)
 *          ③ 保活 CF Worker 隧道(20201-20240) ④ 每 15min 重写 proxy-pool.json
 *   问题：
 *     A. 三条隧道【全部无法出网】（GFW 识别明文 HTTP CONNECT 主机名并 RST；
 *        经 BD 明文口连 tumblr=exit56、连 github=200，对照坐实）。
 *     B. 旧 /health 要求 10950 与 20777 同时在线 → 两者皆死 → **恒 503** →
 *        mscms-watchdog 每轮判它"假死"强杀重启 → 每次都重新 spawn mihomo/cf-tunnel
 *        → 与新的 BD 转发器抢端口(20105/20106/20201+) → 间歇 fetch failed。
 *        【自持故障循环】
 *     C. rescan 会把已死出口重新写回 proxy-pool.json，抵消人工收敛。
 *
 * ── 新职责 ──────────────────────────────────────────────────────────
 *   1. 守护 Bright Data TLS 转发器（tools/bd-tls-forwarder.js → 127.0.0.1:10809,10808）
 *      —— 这是当前唯一可用的出网通道，故 10809 是它的单点，必须重点保活。
 *   2. /health = 端到端真探活：经转发器 CONNECT api.tumblr.com:443 是否返回 200
 *      （不是裸 TCP 探活 —— 端口在听但 BD 上游挂掉时也能被发现）。
 *   3. 假死自愈：TCP 在听但连续 N 次探活失败 → taskkill 占用进程并重启。
 *   4. 池防污染：确保 proxy-pool.json 存在【启用中】的 bd-tls-relay 条目（只增不改）。
 *
 * 用法：node tools/exit-guard.js          （常驻，由 mscms-watchdog 纳管）
 * 环境：
 *   EXIT_GUARD_LEGACY=1   恢复旧隧道逻辑（默认关；VPS/CF 链路恢复后再开）
 *   EXIT_GUARD_DEAD_STREAK 连续探活失败多少次判假死（默认 4）
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELAY_SCRIPT = path.join(ROOT, 'tools', 'bd-tls-forwarder.js');
// 仅在显式指定时才覆盖转发器端口（否则用 bd-tls-forwarder.js 自带的兼容超集）
const RELAY_PORTS_ENV = process.env.BD_RELAY_PORTS ? String(process.env.BD_RELAY_PORTS) : null;
const RELAY_PRIMARY = Number(process.env.MSCMS_OUTBOUND_PROXY_PORT || 10809);
const PROBE_HOST = process.env.EXIT_PROBE_HOST || 'api.tumblr.com';
const PROBE_PORT = Number(process.env.EXIT_PROBE_PORT || 443);
const PROBE_TIMEOUT_MS = Number(process.env.EXIT_PROBE_TIMEOUT_MS || 8000);
const HEALTH_PORT = Number(process.env.EXIT_GUARD_HEALTH_PORT || 20779);
const CHECK_MS = Number(process.env.EXIT_GUARD_CHECK_MS || 60 * 1000);
const DEAD_STREAK_KILL = Number(process.env.EXIT_GUARD_DEAD_STREAK || 4);
const LEGACY = process.env.EXIT_GUARD_LEGACY === '1';

// 代理池：D 盘权威池 + 工作区镜像（sync-desktop 不镜像 proxy-pool.json，两处都要照看）
const POOLS = [
  'D:/MSCMS-Desktop/resources/proxy-pool.json',
  path.join(ROOT, 'proxy-pool.json'),
];
const LOG = (process.env.LOG_DIR || 'D:/mscms-ws/logs') + '/exit-guard.log';

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
  console.log(line);
}

/** 裸 TCP 探活 */
function portOpen(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const s = net.connect(port, host);
    s.setTimeout(1500, () => { s.destroy(); res(false); });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
}

/**
 * 端到端探活：经本机转发器向 PROBE_HOST:PROBE_PORT 发 CONNECT，看是否 200。
 * 这才是"出网是否真的通"的真判据（裸 TCP 会被"端口在听但上游死"骗过）。
 */
function probeRelay(port = RELAY_PRIMARY, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    let s = null;
    const fin = (ok, detail) => {
      if (done) return; done = true;
      try { if (s) s.destroy(); } catch (_) {}
      resolve({ ok, detail });
    };
    s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(timeout, () => fin(false, 'CONNECT 超时(>' + timeout + 'ms)'));
    s.on('error', (e) => fin(false, 'TCP ' + (e.code || e.message)));
    s.on('connect', () => {
      try {
        s.write(`CONNECT ${PROBE_HOST}:${PROBE_PORT} HTTP/1.1\r\nHost: ${PROBE_HOST}:${PROBE_PORT}\r\n\r\n`);
      } catch (e) { fin(false, 'write ' + e.message); }
    });
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) { if (buf.length > 8192) fin(false, '响应头过大'); return; }
      const sl = buf.slice(0, i).toString('latin1').split('\r\n')[0];
      const m = sl.match(/HTTP\/1\.[01] (\d{3})/);
      fin(!!m && m[1] === '200', sl);
    });
    s.on('close', () => fin(false, '连接提前关闭'));
  });
}

/** 找出监听某端口的进程 PID（Windows netstat） */
function pidOnPort(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const re = new RegExp(':' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
      const lines = String(stdout).split(/\r?\n/);
      for (const l of lines) {
        const m = l.match(re);
        if (m) return resolve(Number(m[1]));
      }
      resolve(null);
    });
  });
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (!pid || pid <= 4 || pid === process.pid) return resolve(false);
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 10000 }, () => resolve(true));
  });
}

/** 进程名（tasklist；exit-guard 以 SYSTEM 运行，可读全机进程） */
function procName(pid) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return resolve('');
      const m = String(stdout).match(/^"([^"]+)"/m);
      resolve(m ? m[1] : '');
    });
  });
}

/** 一次 netstat 取回 port -> pid 快照 */
function listenersSnapshot() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const map = new Map();
      if (!err && stdout) {
        for (const l of String(stdout).split(/\r?\n/)) {
          const m = l.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
          if (m) map.set(Number(m[1]), Number(m[2]));
        }
      }
      resolve(map);
    });
  });
}

/**
 * 清除旧隧道进程（mihomo/xray/clash）占用的兼容端口段。
 *
 * 为什么必须清：三者均已无法出网（GFW 明文 CONNECT 识别），但 mihomo 仍在
 * 20101-20150 【监听】。发布器 _refreshProxyHealth 只做 TCP 探活 →
 * 这些"在听但请求必失败"的端口会被判为【健康】并进入轮换 → fetch failed。
 * 它们由 SYSTEM 看门狗派生，普通权限 Stop-Process 被拒（拒绝访问），
 * 而 exit-guard 本身就以 SYSTEM 运行 → 由它来清是最省事且足够的路径。
 */
async function cleanupLegacyTunnels() {
  if (String(process.env.EXIT_GUARD_KILL_LEGACY || '1') === '0') return false;
  const snap = await listenersSnapshot();
  const self = snap.get(RELAY_PRIMARY) || null;
  let killed = false;
  for (const [port, pid] of snap) {
    const inCompat = (port >= 20101 && port <= 20150) || (port >= 20201 && port <= 20240);
    if (!inCompat) continue;
    if (!pid || pid === self || pid === process.pid) continue;
    const name = await procName(pid);
    if (/^(mihomo|xray|clash|v2ray)/i.test(name || '')) {
      log(`[cleanup] 清除占用 ${port} 的旧隧道 ${name}(${pid})`);
      await killPid(pid);
      killed = true;
    }
  }
  return killed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 拉起 BD TLS 转发器（自清代理 env，防自环） */
function startRelay() {
  const env = Object.assign({}, process.env, {
    HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '',
    BD_ZONE: process.env.BD_ZONE || 'isp_proxy1',
    BD_CUSTOMER: process.env.BD_CUSTOMER || 'hl_ac0f9818',
    BD_PASSWORD: process.env.BD_PASSWORD || 'd2ream9zn4am',
    BD_TLS_PORT: process.env.BD_TLS_PORT || '33335',
    LOG_DIR: process.env.LOG_DIR || 'D:/mscms-ws/logs',
  });
  if (RELAY_PORTS_ENV) env.BD_RELAY_PORTS = RELAY_PORTS_ENV;
  try {
    const child = spawn(process.execPath, [RELAY_SCRIPT], { cwd: ROOT, detached: true, stdio: 'ignore', env });
    child.unref();
    log(`[start] bd-relay:${RELAY_PRIMARY} pid=${child.pid}`);
    return child.pid;
  } catch (e) {
    log('[start-fail] bd-relay: ' + e.message);
    return null;
  }
}

let deadStreak = 0;
let lastProbe = { ok: false, detail: '未探测' };

async function ensureRelay() {
  const tcp = await portOpen(RELAY_PRIMARY);
  if (!tcp) {
    deadStreak = 0;
    log(`[probe] 转发器 ${RELAY_PRIMARY} 未监听 → 拉起`);
    startRelay();
    return false;
  }
  const p = await probeRelay();
  lastProbe = p;
  if (p.ok) { deadStreak = 0; return true; }
  deadStreak++;
  log(`[probe] 转发器探活失败 ${deadStreak}/${DEAD_STREAK_KILL}（${p.detail}）`);
  if (deadStreak >= DEAD_STREAK_KILL) {
    const pid = await pidOnPort(RELAY_PRIMARY);
    log(`[probe] 判定假死 → 杀 pid=${pid} 并重启转发器`);
    await killPid(pid);
    deadStreak = 0;
    setTimeout(startRelay, 1000);
  }
  return false;
}

/** 确保代理池存在启用中的 bd-tls-relay 条目（只增不改其它条目） */
function ensurePool() {
  for (const f of POOLS) {
    try {
      if (!fs.existsSync(f)) continue;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arr = Array.isArray(raw) ? raw : (raw.proxies || raw.items || null);
      if (!Array.isArray(arr)) continue;
      const hit = arr.find((x) => x && /^https?:\/\/127\.0\.0\.1:(10809|10808)\b/.test(String(x.url || '')));
      if (hit) {
        if (hit.enabled === false) {
          hit.enabled = true;
          fs.writeFileSync(f, JSON.stringify(arr, null, 2));
          log(`[pool] 重新启用 bd 条目 → ${f}`);
        }
        continue;
      }
      arr.push({
        url: `http://127.0.0.1:${RELAY_PRIMARY}`, name: 'bd-tls-relay', weight: 5, enabled: true,
        type: 'http', provider: 'brightdata-isp-tls', usage: 'post',
        note: '由 tools/exit-guard.js 自动补回（BD TLS 转发器 33335；绕开 GFW 明文 CONNECT 识别）',
      });
      fs.writeFileSync(f, JSON.stringify(arr, null, 2));
      log(`[pool] 补回缺失的 bd-tls-relay 条目 → ${f}`);
    } catch (e) {
      log(`[pool] 处理 ${f} 失败: ${e.message}`);
    }
  }
}

// ── 健康端点（看门狗据此纳管）────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const p = await probeRelay();
    lastProbe = p;
    res.writeHead(p.ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: p.ok, relay: `127.0.0.1:${RELAY_PRIMARY}`, probe: p.detail,
      probeTarget: `${PROBE_HOST}:${PROBE_PORT}`, deadStreak, legacy: LEGACY,
      uptimeSec: Math.round(process.uptime()),
    }));
  } else if (req.url === '/pool') {
    const out = {};
    for (const f of POOLS) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const arr = Array.isArray(raw) ? raw : (raw.proxies || raw.items || []);
        const en = arr.filter((x) => x && x.enabled !== false);
        out[f] = { total: arr.length, enabled: en.length, urls: en.map((x) => x.url) };
      } catch (e) { out[f] = { error: e.message }; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
  } else { res.writeHead(404); res.end(); }
}).listen(HEALTH_PORT, '127.0.0.1', () => log(`exit-guard 健康端点: http://127.0.0.1:${HEALTH_PORT}/health`));

/** 清旧隧道 + 让转发器补齐所有兼容端口 */
async function reconcile() {
  const killed = await cleanupLegacyTunnels();
  if (killed) {
    // 转发器启动时若端口被旧隧道占用会 bind 失败且不重试 → 杀掉它重启，使其重新占满端口
    const rp = await pidOnPort(RELAY_PRIMARY);
    if (rp) { log(`[reconcile] 重启转发器(pid=${rp})以补齐被旧隧道占用的端口`); await killPid(rp); await sleep(900); }
    startRelay();
    return;
  }
  await ensureRelay();
}

// ── 启动 ────────────────────────────────────────────────────────────
(async () => {
  log(`exit-guard 启动（bd-relay 守护模式 · legacy=${LEGACY}）`);
  ensurePool();
  await reconcile();
  setInterval(reconcile, CHECK_MS);
  setInterval(ensurePool, 5 * 60 * 1000);
  if (LEGACY) startLegacy();
})();

// ── 旧隧道逻辑（默认停用；EXIT_GUARD_LEGACY=1 时恢复）──────────────────
function startLegacy() {
  const XRAY = 'C:/Users/AS/Pictures/v2rayN-windows-64/bin/xray/xray.exe';
  const MIHOMO = 'C:/Users/AS/Pictures/v2rayN-windows-64/bin/mihomo/mihomo.exe';
  const SOCKS_CFG = path.join(ROOT, 'scripts', 'vps-socks5-proxy.json');
  const MIHOMO_CFG = 'D:/mscms-ws/tmp/mihomo-multi-exit.yaml';
  const MIHOMO_HOME = 'D:/mscms-ws/tmp/mihomo-home';
  const CF_EXITS = 'D:/mscms-ws/config/cf-worker-exits.json';
  const RESCAN_MS = parseInt(process.env.EXIT_GUARD_RESCAN_MS || '', 10) || 15 * 60 * 1000;
  const start = (cmd, args, opts, tag) => {
    try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts }); c.unref(); log(`[legacy][start] ${tag} pid=${c.pid}`); }
    catch (e) { log(`[legacy][start-fail] ${tag}: ${e.message}`); }
  };
  const runStep = (args, ms, tag) => new Promise((resolve) => {
    try {
      const c = spawn(process.execPath, args, { stdio: 'ignore', cwd: ROOT });
      const t = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(); }, ms);
      c.on('exit', () => { clearTimeout(t); resolve(); });
      c.on('error', () => { clearTimeout(t); resolve(); });
    } catch (e) { log(`[legacy][rescan] ${tag} 启动失败: ${e.message}`); resolve(); }
  });
  const ensure = async () => {
    log('[legacy] 检查旧隧道…');
    if (!(await portOpen(10950)) && fs.existsSync(XRAY) && fs.existsSync(SOCKS_CFG)) start(XRAY, ['run', '-c', SOCKS_CFG], { cwd: path.dirname(SOCKS_CFG) }, 'xray:10950');
    if (fs.existsSync(CF_EXITS)) {
      let has = false; try { has = (JSON.parse(fs.readFileSync(CF_EXITS, 'utf8')) || []).length > 0; } catch (_) {}
      if (has && !(await portOpen(20880))) start(process.execPath, [path.join(ROOT, 'tools', 'cf-tunnel.js')], { cwd: ROOT }, 'cf-tunnel:20880');
    }
    if (!(await portOpen(20777)) && fs.existsSync(MIHOMO) && fs.existsSync(MIHOMO_CFG)) {
      if (!fs.existsSync(MIHOMO_HOME)) fs.mkdirSync(MIHOMO_HOME, { recursive: true });
      start(MIHOMO, ['-f', MIHOMO_CFG, '-d', MIHOMO_HOME], { cwd: MIHOMO_HOME }, 'mihomo:20777');
    }
  };
  const rescan = async () => {
    if (!fs.existsSync(MIHOMO_CFG)) return;
    log('[legacy][rescan] 重探测出口并刷新代理池…');
    await runStep([path.join(ROOT, 'tools', 'multi-exit.js'), '--apply'], 5 * 60 * 1000, 'multi-exit');
    if (fs.existsSync(CF_EXITS)) {
      let has = false; try { has = (JSON.parse(fs.readFileSync(CF_EXITS, 'utf8')) || []).length > 0; } catch (_) {}
      if (has) await runStep([path.join(ROOT, 'tools', 'cf-exit-verify.js'), '--sync-pool'], 5 * 60 * 1000, 'cf-exit-verify');
    }
    log('[legacy][rescan] 完成');
  };
  ensure();
  setInterval(ensure, CHECK_MS);
  setInterval(rescan, RESCAN_MS);
  setTimeout(rescan, 3 * 60 * 1000);
}
