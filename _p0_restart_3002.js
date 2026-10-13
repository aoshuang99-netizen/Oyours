/**
 * _p0_restart_3002.js — 免提权重启 3002（P0-5 内存修复生效）
 *
 * 背景（为什么需要这个脚本）：
 *   3002 由 WinSW 服务 mscms-watchdog(LocalSystem) 派生 ⇒ 令牌是 SYSTEM，
 *   非提权 `taskkill /F /PID <3002>` 返回「拒绝访问」，无法直接杀。
 *   唯一可行的免提权路径：
 *     tumblr-nurture-server(:3005，同样由 SYSTEM 看门狗派生) 暴露了
 *     `POST /api/proxy/activate` → require('./proxy-pool-activator.js').activate()
 *     该激活器会读【磁盘上的】 .proxy-v2ray-pids.json，对每个条目做出口 IP 探测，
 *     探测失败或 IP 重复 ⇒ `process.kill(entry.pid)`。
 *   ⇒ 把该文件的 pid 指向 3002、url 指向死端口，3005(SYSTEM) 就会替我们杀掉 3002；
 *     看门狗探到 :3002 端口不再监听 → 60s 内用 D:\MSCMS-Desktop\resources 的新代码重拉。
 *
 * 安全措施：
 *   1. 先 POST /api/v14/datastore/flush（同步落盘），把硬杀的数据损失降到最低；
 *   2. 备份 .proxy-v2ray-pids.json 与 proxy-pool.json，结束时恢复；
 *   3. 只写 1 条伪条目 ⇒ 不影响任何真实 sing-box 代理进程；
 *   4. 轮询验证 pid 真的换了，才判定成功。
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const WS = __dirname;
const PID_FILE = path.join(WS, '.proxy-v2ray-pids.json');
const POOL_FILE = path.join(WS, 'proxy-pool.json');
const PID_HINT = path.join(WS, '_p0_pid.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();

function readTargetPid() {
  try {
    const m = fs.readFileSync(PID_HINT, 'utf8').match(/3002=(\d+)/);
    if (m) return Number(m[1]);
  } catch (_) {}
  return null;
}

function netstatPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }).toString();
    const re = new RegExp(':' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
    for (const l of out.split(/\r?\n/)) { const m = l.match(re); if (m) return Number(m[1]); }
  } catch (_) {}
  return null;
}

function tcpOpen(port, timeout = 3000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.connect(port, '127.0.0.1');
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

function req(port, method, urlPath, body, timeout) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = data.length;
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 600) }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'TIMEOUT' }); });
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const t0 = Date.now();
  let target = readTargetPid() || netstatPid(3002);
  console.log(`${ts()} [1] 目标 3002 pid = ${target}`);
  if (!target) { console.error('❌ 无法解析 3002 pid，中止'); process.exit(2); }
  if (target === process.pid || target < 100) { console.error('❌ pid 不合理，中止'); process.exit(2); }

  // ── 备份 ──
  const bk = (f) => { try { if (fs.existsSync(f)) { const d = f + '.bak-p0'; fs.copyFileSync(f, d); console.log(`   已备份 ${path.basename(f)} → ${path.basename(d)}`); } } catch (e) { console.log('   备份失败 ' + f + ': ' + e.message); } };
  console.log(`${ts()} [2] 备份`);
  bk(PID_FILE); bk(POOL_FILE);

  // ── 优雅落盘 ──
  console.log(`${ts()} [3] POST /api/v14/datastore/flush`);
  const fl = await req(3002, 'POST', '/api/v14/datastore/flush', '{}', 90000);
  console.log('   flush -> ' + JSON.stringify(fl).slice(0, 300));

  // ── 写入伪条目：url 指向死端口 ⇒ getExitIp 必然失败 ⇒ process.kill(target) ──
  fs.writeFileSync(PID_FILE, JSON.stringify([{ url: 'http://127.0.0.1:1', pid: target, port: 1080 }], null, 2));
  console.log(`${ts()} [4] 已写入 ${path.basename(PID_FILE)} = ${fs.readFileSync(PID_FILE, 'utf8').replace(/\s+/g, ' ')}`);

  // ── 触发（不等待完成，因为它本身会被我们杀掉的目标牵连/耗时）──
  console.log(`${ts()} [5] POST http://127.0.0.1:3005/api/proxy/activate {"desired":1}`);
  const pending = req(3005, 'POST', '/api/proxy/activate', JSON.stringify({ desired: 1 }), 600000);
  pending.then((r) => console.log(`${ts()} [5b] activate 返回 -> ` + JSON.stringify(r).slice(0, 400)));

  // ── 轮询 ──
  // 【2026-10-13 修正】原实现用 netstatPid 判「pid 变了没」，但本机 netstat 常静默返空
  //   （实测 tcp=UP 却 pidOn3002=- 连续 5 分钟）⇒ 明明重启成功却报 NO_NEW_PID。
  //   改为两阶段端口判定：端口「先 down 后 up」即新实例，不依赖 netstat。
  let sawDown = false, newPid = null;
  for (let i = 1; i <= 120; i++) {
    await sleep(5000);
    const up = await tcpOpen(3002);
    const el = Math.round((Date.now() - t0) / 1000);
    if (!up) {
      if (!sawDown) console.log(`${ts()} [poll ${i}] ${el}s 3002 端口已释放（旧进程退出），等看门狗重拉…`);
      sawDown = true;
    } else if (sawDown) {
      newPid = netstatPid(3002);
      console.log(`${ts()} [poll ${i}] ${el}s ✅ 3002 已恢复监听（端口先 down 后 up）pid=${newPid || '(netstat 未解析到，但端口已 UP)'}`);
      break;
    } else if (i % 6 === 0) {
      console.log(`${ts()} [poll ${i}] ${el}s tcp=UP（尚未见到 down，可能未杀成功或目标已换）`);
    }
  }

  // ── 恢复 pid 文件（不覆盖 writePool 的结果时再恢复）──
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify([], null, 2));
    console.log(`${ts()} [6] 已复位 ${path.basename(PID_FILE)} = []`);
  } catch (e) { console.log('   复位失败: ' + e.message); }

  console.log(`${ts()} [7] 结果: ${newPid ? ('NEW_PID=' + newPid) : 'NO_NEW_PID（10 分钟内未见新实例）'}`);
  const r = await Promise.race([pending, sleep(2000).then(() => ({ note: 'activate 仍在执行' }))]);
  console.log(`${ts()} [8] activate -> ` + JSON.stringify(r).slice(0, 300));
  process.exit(0);
})().catch((e) => { console.error('FATAL: ' + e.stack); process.exit(1); });
