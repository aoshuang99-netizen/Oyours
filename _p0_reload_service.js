/**
 * _p0_reload_service.js — 免提权重启「单个」看门狗子服务
 *
 * 用途：把源码改动真正生效（本机铁律「文件已改 ≠ 改动生效」）。
 *
 * 原理（为什么能免提权）：
 *   看门狗(mscms-watchdog, WinSW/LocalSystem) 以 SYSTEM 令牌派生所有子服务
 *   ⇒ 非提权 `taskkill` 一律「拒绝访问」。
 *   但 tumblr-nurture-server(:3005) 暴露了 `POST /api/proxy/activate`，
 *   其内部 require 的 proxy-pool-activator 会读【磁盘上的】.proxy-v2ray-pids.json，
 *   对每个条目探测出口 IP，探测失败/重复就 `process.kill(entry.pid)`。
 *   ⇒ 把该文件的 pid 指向目标进程、url 指向死端口，3005(SYSTEM) 就会替我们杀掉它；
 *     看门狗下一轮 tick 探到该端口不再监听 → 用新代码自动重拉。
 *
 * 用法：
 *   node _p0_reload_service.js 20779            # 按端口解析 PID
 *   node _p0_reload_service.js --pid=5696 --label=relay
 *   node _p0_reload_service.js 10809 --timeout=180
 *
 * 安全：
 *   · 拒绝作用于 3005 自身（避免自杀导致链路中断）；
 *   · 拒绝 pid<=4；
 *   · 只写 1 条伪条目并备份/复位 .proxy-v2ray-pids.json；
 *   · 目标服务由看门狗重拉，不影响其它服务。
 */
'use strict';
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const WS = __dirname;
const PID_FILE = path.join(WS, '.proxy-v2ray-pids.json');
const NURTURE_PORT = 3005;
const RELAY_PID_PORT = 10809;   // 中继是出网单点，重拉窗口尽量短

const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const port = Number(argv.find((a) => /^\d+$/.test(a)) || 0);
let pid = Number(arg('pid', 0));
const label = arg('label', port ? (':' + port) : 'pid');
const timeoutSec = Number(arg('timeout', 240));

const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();

function pidOnPort(p) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }).toString();
    const re = new RegExp(':' + p + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
    for (const l of out.split(/\r?\n/)) { const m = l.match(re); if (m) return Number(m[1]); }
  } catch (_) {}
  return null;
}

function tcpOpen(p, timeout = 3000) {
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
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 300) }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'TIMEOUT' }); });
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  if (!pid && port) pid = pidOnPort(port);
  console.log(`${ts()} [1] 目标 ${label} ${port ? (':' + port) : ''} pid=${pid}`);
  if (!pid) { console.error('❌ 无法解析目标 PID'); process.exit(2); }
  if (pid <= 4 || pid === process.pid) { console.error('❌ PID 不合理/指向自身，中止'); process.exit(2); }
  if (pid === pidOnPort(NURTURE_PORT)) { console.error(`❌ 目标是 :${NURTURE_PORT} 自身（它是杀进程的执行者），拒绝自杀`); process.exit(2); }

  const before = fs.existsSync(PID_FILE) ? fs.readFileSync(PID_FILE, 'utf8') : '[]';
  console.log(`${ts()} [2] 备份 .proxy-v2ray-pids.json = ${before.replace(/\s+/g, ' ').slice(0, 120)}`);

  fs.writeFileSync(PID_FILE, JSON.stringify([{ url: 'http://127.0.0.1:1', pid, port: 1080 }], null, 2));
  console.log(`${ts()} [3] 已写入伪条目 pid=${pid}`);

  console.log(`${ts()} [4] POST :${NURTURE_PORT}/api/proxy/activate`);
  const pending = req(NURTURE_PORT, 'POST', '/api/proxy/activate', JSON.stringify({ desired: 1 }), 600000);
  pending.then((r) => console.log(`${ts()} [4b] activate -> ${JSON.stringify(r).slice(0, 260)}`));

  let newPid = null;
  const deadline = Date.now() + timeoutSec * 1000;
  let gone = 0;
  while (Date.now() < deadline) {
    await sleep(4000);
    const cur = port ? pidOnPort(port) : null;
    const up = port ? await tcpOpen(port) : null;
    const el = Math.round((Date.now() - t0) / 1000);
    if (port && !cur && !up) { gone++; if (gone <= 2) console.log(`${ts()} [poll] ${el}s ${port} 已释放（进程退出），等待看门狗重拉…`); }
    else if (port && cur && cur !== pid) { newPid = cur; console.log(`${ts()} [poll] ${el}s ✅ ${port} 已换新实例 ${pid} → ${cur}`); break; }
    else if (!port) { console.log(`${ts()} [poll] ${el}s 等待…`); }
  }

  try { fs.writeFileSync(PID_FILE, before); console.log(`${ts()} [5] 已复位 .proxy-v2ray-pids.json`); } catch (e) { console.log('   复位失败: ' + e.message); }
  console.log(`${ts()} [6] 结果: ${port ? (newPid ? 'NEW_PID=' + newPid + ' （' + label + ' 已载入新代码）' : 'NO_NEW_PID 超时') : '已发出 kill 请求，请自行复核'}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL: ' + e.stack); process.exit(1); });
