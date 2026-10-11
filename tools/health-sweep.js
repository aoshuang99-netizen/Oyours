#!/usr/bin/env node
/**
 * health-sweep.js — MSCMS v14 被动健康巡检（双线监控骨架之一）
 * =====================================================================
 * 与 tools/mscms-watchdog.js 的分工：
 *   · 看门狗 = 主动治愈层（探活 + 自动重启）
 *   · 本脚本 = 被动观测层（只探活 + 记录事件，绝不重启任何进程）
 *
 * 探活每个服务的 TCP 端口 + 业务 HTTP 端点（与看门狗 SERVICES 的 probe 对齐），
 * 输出一张状态表；对检测到的「宕机/假死」事件追加写入 ops/incidents.jsonl。
 *
 * 用法:
 *   node tools/health-sweep.js            # 单次巡检，宕机数 >0 时退出码 1
 *   node tools/health-sweep.js --json     # 机器可读输出
 *   node tools/health-sweep.js --loop     # 常驻循环（间隔 HEALTH_SWEEP_INTERVAL_MS，默认 60s）
 *
 * 注意：本脚本探测的是本机 localhost，不走任何出网代理。
 * 事件冷却：--loop 模式下，同一服务 5 分钟内只记一条，避免刷屏。
 */
'use strict';
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WS = 'C:\\Users\\AS\\WorkBuddy\\2026-06-13-19-42-19';
const INCIDENTS = path.join(WS, 'ops', 'incidents.jsonl');

// 与看门狗 SERVICES 对齐的探活目标（tcpOnly = 仅 TCP，无 HTTP 端点）
const TARGETS = [
  { name: 'mysql:3307',      port: 3307, tcpOnly: true },
  { name: 'main:3002',       port: 3002, probe: '/api/v14/causal-chain/status' },
  { name: 'nurture:3005',    port: 3005, probe: '/api/status' },
  { name: 'contentgen:3010', port: 3010, probe: '/api/assets' },
  { name: 'exitguard:20779', port: 20779, probe: '/health' },
  { name: 'visitor:3012',    port: 3012, probe: '/api/status' },
  { name: 'sync:3013',       port: 3013, probe: '/health' },
  { name: 'mpt:8080',        port: 8080, probe: '/docs' },
  { name: 'kkmatch:8001',    port: 8001, probe: '/health' },
];

const HTTP_TIMEOUT = 8000;
const TCP_TIMEOUT = 2000;
const COOLDOWN_MS = 5 * 60 * 1000; // loop 模式下同一服务事件冷却

function portOpen(port, timeout = TCP_TIMEOUT) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, '127.0.0.1');
  });
}

function httpOk(port, pathName, timeout = HTTP_TIMEOUT) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.once('error', () => resolve({ ok: false, status: 0 }));
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
  });
}

async function sweep() {
  const rows = [];
  for (const t of TARGETS) {
    const open = await portOpen(t.port);
    let httpRes = null;
    if (open && !t.tcpOnly) httpRes = await httpOk(t.port, t.probe);
    rows.push({ name: t.name, port: t.port, tcp: open, http: httpRes });
  }
  return rows;
}

function render(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('SERVICE', 18) + pad('PORT', 7) + pad('TCP', 6) + 'HTTP');
  console.log('-'.repeat(48));
  for (const r of rows) {
    const tcp = r.tcp ? 'UP' : 'DOWN';
    const http = r.http ? (r.http.ok ? `OK ${r.http.status}` : `FAIL ${r.http.status}`) : (r.tcpOnly ? '(tcp)' : '-');
    console.log(pad(r.name, 18) + pad(r.port, 7) + pad(tcp, 6) + http);
  }
}

function lastIncidentAt(service) {
  try {
    const lines = fs.readFileSync(INCIDENTS, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); if (o.service === service) return new Date(o.ts).getTime(); } catch (_) {}
    }
  } catch (_) {}
  return 0;
}

function recordIncident(row) {
  const reason = !row.tcp ? 'tcp-closed' : `http-${row.http ? row.http.status : '?'}`;
  const rec = {
    ts: new Date().toISOString(),
    level: row.tcp ? 'warn' : 'crit',
    service: row.name,
    port: row.port,
    reason,
    tcp: row.tcp,
    http: row.http,
  };
  try { fs.appendFileSync(INCIDENTS, JSON.stringify(rec) + '\n'); } catch (_) {}
  return rec;
}

(async () => {
  const json = process.argv.includes('--json');
  const loop = process.argv.includes('--loop');
  const once = async () => {
    const rows = await sweep();
    if (json) console.log(JSON.stringify(rows, null, 2));
    else render(rows);
    const down = rows.filter((r) => !r.tcp || (r.http && !r.http.ok));
    for (const d of down) {
      if (loop && Date.now() - lastIncidentAt(d.name) < COOLDOWN_MS) continue;
      const rec = recordIncident(d);
      console.log(`[incident] ${rec.level} ${rec.service} (${rec.reason})`);
    }
    return down.length;
  };
  const downCount = await once();
  if (loop) {
    const interval = Number(process.env.HEALTH_SWEEP_INTERVAL_MS || 60000);
    console.log(`[health-sweep] loop mode, interval=${interval}ms, incidents-> ${INCIDENTS}`);
    setInterval(async () => { try { await once(); } catch (e) { console.error('sweep err', e.message); } }, interval);
  } else {
    process.exitCode = downCount > 0 ? 1 : 0;
  }
})();
