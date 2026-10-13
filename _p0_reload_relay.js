#!/usr/bin/env node
/**
 * _p0_reload_relay.js — 免提权重启 BD TLS 转发器（出网单点），带「新代码生效」证据
 *
 * ⚠️ 本环境铁律：node 内 child_process 不可用（`spawnSync cmd.exe EBUSY`）
 *   ⇒ 无法从 node 内跑 netstat，故 PID 必须由调用方（Bash 侧）用 --pid= 传入。
 *
 * 原理（免提权）：3005(:3005) 以 SYSTEM 运行，其 /api/proxy/activate 会读【磁盘上】
 *   的 .proxy-v2ray-pids.json，对每条目探出口 IP；探测失败即 process.kill(entry.pid)。
 *   ⇒ 写 {url:'http://127.0.0.1:1', pid:<转发器>} 再 POST，即借 3005 之手杀掉转发器；
 *     exit-guard 的 ensureRelay() 探到 10809 未监听会自动 startRelay()（载入新代码）。
 *
 * 判据（三重，缺一不算成功）：
 *   ① 10809 出现过「不可达」（旧实例已死）
 *   ② 10809 重新可达
 *   ③ D:/mscms-ws/logs/bd-relay.log 出现 **新启动标记**（evidenceRe 匹配的行，时间戳晚于本次启动）
 *
 * 用法：node _p0_reload_relay.js --pid=22556 [--port=10809] [--timeout=200]
 *      [--evidence="兜底退避"] [--log=D:/mscms-ws/logs/bd-relay.log]
 */
'use strict';
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const WS = __dirname;
const PID_FILE = path.join(WS, '.proxy-v2ray-pids.json');
const NURTURE_PORT = 3005;
const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const PORT = Number(arg('port', 10809));
const TIMEOUT = Number(arg('timeout', 200));
const PID = Number(arg('pid', 0));
const LOGF = arg('log', 'D:/mscms-ws/logs/bd-relay.log');
const EVIDENCE = arg('evidence', '兜底退避');

const t0 = Date.now();
const ts = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tcpOpen(p, timeout = 2500) {
  return new Promise((resolve) => {
    const s = net.connect(p, '127.0.0.1');
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}
function req(p, method, urlPath, body, timeout) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = data.length;
    const r = http.request({ host: '127.0.0.1', port: p, path: urlPath, method, headers, timeout }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 400) }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'TIMEOUT' }); });
    if (data) r.write(data);
    r.end();
  });
}
/** 在日志里找本次启动之后的 evidence 行 */
function findEvidence() {
  try {
    const txt = fs.readFileSync(LOGF, 'utf8');
    const lines = txt.split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20000); i--) {
      const l = lines[i];
      if (!l.includes(EVIDENCE)) continue;
      const m = l.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      if (m && Date.parse(m[1]) >= t0 - 5000) return { line: l.trim(), at: m[1] };
    }
  } catch (_) {}
  return null;
}

(async () => {
  console.log(`${ts()} [1] 目标 :${PORT} pid=${PID}`);
  if (!PID || PID <= 4) { console.error('❌ 必须用 --pid=<PID> 传入（本环境 node 内无法跑 netstat）'); process.exit(2); }

  const before = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8') : '[]';
  console.log(`${ts()} [2] 备份 .proxy-v2ray-pids.json = ${before.replace(/\s+/g, ' ').slice(0, 100)}`);
  fs.writeFileSync(PID_FILE, JSON.stringify([{ url: 'http://127.0.0.1:1', pid: PID, port: 1080 }], null, 2));
  console.log(`${ts()} [3] 已写入伪条目 pid=${PID}`);

  let activateDone = false;
  console.log(`${ts()} [4] POST :${NURTURE_PORT}/api/proxy/activate`);
  req(NURTURE_PORT, 'POST', '/api/proxy/activate', JSON.stringify({ desired: 1 }), 900000)
    .then((r) => { activateDone = true; console.log(`${ts()} [4b] activate -> ${JSON.stringify(r).slice(0, 300)}`); })
    .catch(() => {});

  const deadline = Date.now() + TIMEOUT * 1000;
  let sawDown = false, backUp = false, evidence = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const up = await tcpOpen(PORT);
    const el = Math.round((Date.now() - t0) / 1000);
    if (!up && !sawDown) { sawDown = true; console.log(`${ts()} [poll] ${el}s ⏬ :${PORT} 不可达（旧实例已退出）`); }
    if (sawDown && up && !backUp) { backUp = true; console.log(`${ts()} [poll] ${el}s ⏫ :${PORT} 重新可达（exit-guard 已重拉）`); }
    if (backUp) { evidence = findEvidence(); if (evidence) { console.log(`${ts()} [poll] ${el}s 🔎 新代码标记命中: ${evidence.line.slice(0, 150)}`); break; } }
  }

  if (!evidence) evidence = findEvidence();
  try { fs.writeFileSync(PID_FILE, before); console.log(`${ts()} [5] 已复位 .proxy-v2ray-pids.json`); } catch (e) { console.log('   复位失败: ' + e.message); }

  const finalUp = await tcpOpen(PORT);
  const ok = sawDown && backUp && finalUp && !!evidence;
  console.log(`${ts()} [6] ① 曾不可达=${sawDown} ② 恢复可达=${finalUp} ③ 新代码标记=${evidence ? evidence.at : '未命中'}  ⇒ ${ok ? '✅ RESTARTED 且新代码已生效' : '❌ FAILED（见上方分项）'}`);
  process.exit(ok ? 0 : 3);
})().catch((e) => { console.error('FATAL: ' + e.stack); process.exit(1); });
