'use strict';
/**
 * exit-guard.js — 多出口网关常驻守护（自动化，无需人工介入）
 *
 * 职责：
 *   1. 保活 VPS 隧道 SOCKS5(10950)：mihomo 的 Bright Data 出口依赖它
 *   2. 保活 mihomo 多出口网关(20777/20778)：每个端口 = 一个独立公网出口 IP
 *   3. 周期性重探测所有出口（调用 tools/multi-exit.js --apply），
 *      自动剔除失效出口、把新可用出口写进 proxy-pool.json
 *   4. 提供 HTTP 健康端点 20779/health，供 mscms-watchdog 纳管保活
 *
 * 用法：node tools/exit-guard.js        （常驻）
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const XRAY = 'C:/Users/AS/Pictures/v2rayN-windows-64/bin/xray/xray.exe';
const MIHOMO = 'C:/Users/AS/Pictures/v2rayN-windows-64/bin/mihomo/mihomo.exe';
const SOCKS_CFG = path.join(ROOT, 'scripts', 'vps-socks5-proxy.json');
const MIHOMO_CFG = 'D:/mscms-ws/tmp/mihomo-multi-exit.yaml';
const MIHOMO_HOME = 'D:/mscms-ws/tmp/mihomo-home';
const CF_EXITS = 'D:/mscms-ws/config/cf-worker-exits.json'; // 已部署的 Cloudflare Worker 出口

/** 捕获子进程 stdout（用于凭证自诊断） */
 runCapture(args, ms = 60000) {
  return new Promise((resolve) => {
    try {
      const c = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d.toString(); });
      const t = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(out); }, ms);
      c.on('exit', () => { clearTimeout(t); resolve(out); });
      c.on('error', () => { clearTimeout(t); resolve(out); });
    } catch (_) { resolve(''); }
  });
}
const LOG = 'D:/mscms-ws/logs/exit-guard.log';
const HEALTH_PORT = 20779;
const RESCAN_MS = parseInt(process.env.EXIT_GUARD_RESCAN_MS || '', 10) || 15 * 60 * 1000; // 每 15 分钟重探测一次出口（P0）
const CHECK_MS = 60 * 1000;         // 每 60 秒保活检查

 log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
  console.log(line);
}

 portOpen(port, host = '') {
  return new Promise((res) => {
    const s = net.connect(port, host);
    s.setTimeout(1200, () => { s.destroy(); res(false); });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
}

 start(cmd, args, opts, tag) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
    child.unref();
    log(`[start] ${tag} pid=${child.pid}`);
    return child.pid;
  } catch (e) {
    log(`[start-fail] ${tag}: ${e.message}`);
    return null;
  }
}

async  ensureProcesses() {
  // ① VPS 隧道 SOCKS5（xray，10950）
  if (!(await portOpen(10950))) {
    if (fs.existsSync(XRAY) && fs.existsSync(SOCKS_CFG)) {
      start(XRAY, ['run', '-c', SOCKS_CFG], { cwd: path.dirname(SOCKS_CFG) }, 'xray:10950');
    } else {
      log('[warn] xray 或 vps-socks5-proxy.json 缺失，10950 无法启动');
    }
  }
  // ② CF Worker 隧道本地转发器（20880 健康端点；仅当已部署 worker 时）
  if (fs.existsSync(CF_EXITS)) {
    let hasWorker = false;
    try { hasWorker = (JSON.parse(fs.readFileSync(CF_EXITS, 'utf8')) || [] > 0; } catch (_) {}
    if (hasWorker && !(await portOpen(20880))) {
      start(process.execPath, [path.join(ROOT, 'tools', 'cf-tunnel.js')], { cwd: ROOT }, 'cf-tunnel:20880');
    }
  }
  // ③ mihomo 多出口网关（20777）
  if (!(await portOpen(20777))) {
    if (fs.existsSync(MIHOMO) && fs.existsSync(MIHOMO_CFG)) {
      if (!fs.existsSync(MIHOMO_HOME)) fs.mkdirSync(MIHOMO_HOME, { recursive: true });
      start(MIHOMO, ['-f', MIHOMO_CFG, '-d', MIHOMO_HOME], { cwd: MIHOMO_HOME }, 'mihomo:20777');
    } else {
      log('[warn] mihomo 配置缺失，先运行: node tools/multi-exit.js --restart');
    }
  }
}

/**
 * 自动部署 Cloudflare Worker 出口：
 * 一旦检测到凭证（API token 或 wrangler OAuth 登录态）且尚未部署过，就自动部署。
 * 这样用户只需点一次授权链接，后续全部自动完成。
 */
async  autoDeployCF() {
  try {
    let has = false;
    if (fs.existsSync(CF_EXITS)) {
      const arr = JSON.parse(fs.readFileSync(CF_EXITS, 'utf8'));
      has = Array.isArray(arr) && arr.length > 0;
    }
    if (has) return; // 已部署，不再重复
    // 凭证探测必须包含 API Token 配置文件（否则 token 落地后守护不会自动接管）
    let tok = false;
    try {
      const cf = 'D:/mscms-ws/config/cloudflare.json';
      if (fs.existsSync(cf)) {
        const j = JSON.parse(fs.readFileSync(cf, 'utf8'));
        tok = !!(j. || j.api_token);
      }
    } catch (_) {}
    const cred = !!process.env.CLOUDFLARE_API_TOKEN || !!process.env.CF_API_TOKEN || tok
      || fs.existsSync(path.join(process.env.USERPROFILE || 'C:/Users/AS', '.wrangler/config/default.toml'));
    if (!cred) return; // 无凭证：静默跳过（等待用户授权）
    log('[cf] 检测到 Cloudflare 凭证，先做权限自诊断…');
    const diag = await runCapture([path.join(ROOT, 'tools', 'cf-worker-exit.js'), '--diag']);
    (diag || '').split('\n').filter((l) => l.trim()).forEach((l) => log('[cf] ' + l.trim()));
    if (/结论: ✅/.test(diag)) {
      log('[cf] 凭证可用，自动部署 Worker 出口…');
      await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'cf-worker-exit.js'), '--deploy', '--count=6'], { stdio: 'ignore', cwd: ROOT });
      const t = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(); }, 8 * 60 * 1000);
      c.on('exit', () => { clearTimeout(t); resolve(); });
      });
    } else {
      log('[cf] 凭证不可用，跳过部署（修复凭证后无需下指令，10 分钟后自动重试）');
    }
    log('[cf] 部署流程结束');
  } catch (e) {
    log('[cf] 自动部署异常: ' + e.message);
  }
}

/** 跑一个子进程并等它结束（带超时兜底） */
 runStep(args, ms, tag) {
  return new Promise((resolve) => {
    try {
      const c = spawn(process.execPath, args, { stdio: 'ignore', cwd: ROOT });
      const t = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(); }, ms);
      c.on('exit', () => { clearTimeout(t); resolve(); });
      c.on('error', () => { clearTimeout(t); resolve(); });
    } catch (e) {
      log(`[rescan] ${tag} 启动失败: ${e.message}`);
      resolve();
    }
  });
}

async  rescan() {
  if (!fs.existsSync(MIHOMO_CFG)) return;
  log('[rescan] 重新探测出口并刷新代理池…');
  // ① 非 CF 段（VPS / SS / BD）：写 mihomo 监听端口
  await runStep([path.join(ROOT, 'tools', 'multi-exit.js'), '--apply'], 5 * 60 * 1000, 'multi-exit');
  // ② CF 段：Worker 的 IPv6 出口会漂移，必须单独刷新（用隧道端口 + IPv6，源不能用 CF 托管服务）
  if (fs.existsSync(CF_EXITS)) {
    let hasWorker = false;
    try { hasWorker = (JSON.parse(fs.readFileSync(CF_EXITS, 'utf8')) || [] > 0; } catch (_) {}
    if (hasWorker) {
      log('[rescan] 刷新 CF Worker 出口 IP…');
      await runStep([path.join(ROOT, 'tools', 'cf-exit-verify.js'), '--sync-pool'], 5 * 60 * 1000, 'cf-exit-verify');
    }
  }
  log('[rescan] 完成');
}

http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const socks = await portOpen(10950);
    const gw = await portOpen(20777);
    res.writeHead(socks && gw ? 200 : 503, { '': 'application/json' });
    res.end(JSON.stringify({ ok: socks && gw, socks10950: socks, mihomo20777: gw, uptimeSec: Math.round(process.uptime()) }));
  } else { res.writeHead(404); res.end(); }
}).listen(HEALTH_PORT, '', () => log(`exit-guard 健康端点: http://:${HEALTH_PORT}/health`));

(async () => {
  log('exit-guard 启动');
  await ensureProcesses();
  await autoDeployCF();
  setInterval(ensureProcesses, CHECK_MS);
  setInterval(rescan, RESCAN_MS);
  setInterval(autoDeployCF, 10 * 60 * 1000); // 每 10 分钟检查一次是否已授权
  setTimeout(rescan, 3 * 60 * 1000); // 启动 3 分钟后首次重探测
})();
