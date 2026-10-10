'use strict';
/**
 * tumblr-nurture-server.js — 独立的 Tumblr 第二阶段真实养号服务 (端口 3003)
 *
 * 设计：
 *  - 与运行中的主 v14 服务(3002)【共享同一 data/ 目录】，但：
 *      · 只读读取 tumblr_token / tumblr_config / accounts（主服务负责写这些）
 *      · 只写【新增的】 tumblr_nurture / tumblr_persona 集合（主服务从不写）
 *    → 无任何共享文件写竞争，零干扰线上 50 云手机因果链。
 *  - 不自动启动养号循环；通过 /api/start 显式开启（或设环境变量 TUMBLR_NURTURE_AUTO=1）。
 *  - 提供 /api/* 接口 + 提供根路径下的真实指标看板 (tumblr-nurture-dashboard.html)。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DataStore } = require('./data-store.js');
const { TumblrPublisher } = require('./tumblr-publisher.js');
const { TumblrNurtureEngine } = require('./tumblr-nurture.js');
const { MobileDevicePool } = require('./tumblr-nurture-device.js');
const { ProxyPool, hashStr } = require('./proxy-pool.js');

const PORT = parseInt(process.env.TUMBLR_NURTURE_PORT || '3003', 10);
// DATA_DIR 支持外部覆盖（C: 盘写满时可将 data 目录迁移到其它盘，避免 ENOSPC/EPERM）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const dataStore = new DataStore(DATA_DIR);
const publisher = new TumblrPublisher(dataStore);
const engine = new TumblrNurtureEngine({ dataStore, publisher, eventBus: null });
engine.load();

// 多出口代理池：浏览器分组 + 按账号分配出口 IP 用（429 限流根因缓解）
const proxyPool = new ProxyPool();
const PROXIES = proxyPool.list().map((p) => p.url);
// 按账号确定性分配出口 IP（proxy-pool.js 的 forAccount）；空池回退全局代理。
// 激活 publisher 中既有的 _proxyResolver 死代码，使不同账号走不同出口 IP，缓解 429 根因之一。
publisher.setProxyResolver((accountId) => proxyPool.forAccount(accountId));
// 出口健康回传：429/连续失败 → 冷却该出口，账号自动切到其它出口（修复空转）
if (typeof publisher.setProxyReporter === 'function') {
  publisher.setProxyReporter((url, r) => proxyPool.report(url, r));
}

// 设备池容量随账号数自适应：每浏览器 ~12 上下文，最多 8 浏览器（资源上限）
function devicePoolOpts() {
  const n = engine.accounts.length || 15;
  const maxBrowsers = Math.max(4, Math.min(8, Math.ceil(n / 10)));
  return { dataStore, proxies: PROXIES, perBrowserMax: 12, maxBrowsers };
}

// 移动端设备池：默认关闭，仅当 TUMBLR_NURTURE_DEVICE=1 启用（与线上 50 云手机完全隔离）
const DEVICE_ENABLED = process.env.TUMBLR_NURTURE_DEVICE === '1';
let devicePool = null;
if (DEVICE_ENABLED) {
  devicePool = new MobileDevicePool(devicePoolOpts());
  engine.setDevice(devicePool);
  console.log(`[tumblr-nurture] 移动端设备池 ENABLED (proxies=${PROXIES.length}, perBrowserMax=12, maxBrowsers=${devicePool.maxBrowsers})`);
} else {
  console.log('[tumblr-nurture] 移动端设备池 DISABLED（设 TUMBLR_NURTURE_DEVICE=1 启用）');
}

let started = false;
// 统一启动入口：先同步移动端 UA（启动浏览器+分配上下文），再启动养号循环
async function bootNurture() {
  if (devicePool) {
    try { await engine.syncDeviceUA(); }
    catch (e) { console.error('[tumblr-nurture] 设备同步失败:', e.message); }
  }
  engine.start();
  started = true;
}
if (process.env.TUMBLR_NURTURE_AUTO === '1') { bootNurture(); }

// ── 自愈看门狗：检测养号循环「静默死亡」并自动重启 ──
// 现象：chromium 长时间运行(15 上下文)可能卡死 → 事件循环被拖死 → tickAccount 的 await 永不返回，
//       但服务进程与 HTTP 仍「看似存活」(running=true)，实际 10+ 小时零动作。
// 机制：监听每次完整 tick 完成时间戳；若超过阈值未推进，则停旧循环 + 关闭旧浏览器 + 重建设备池 + 重启。
let lastTickAt = Date.now();
const STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 分钟无完整 tick 视为停滞（fetchExt 已有 30s 超时兜底，此处仅作最后防线）
engine.on('nurture:tick', () => { lastTickAt = Date.now(); });
engine.on('nurture:started', () => { lastTickAt = Date.now(); });
setInterval(() => {
  if (!started && !engine._timer) return; // 未启动则不看管
  const idle = Date.now() - lastTickAt;
  if (idle <= STALL_THRESHOLD_MS) return;
  console.error(`[watchdog] 检测到养号循环停滞 ${Math.round(idle / 60000)} 分钟，自动重启引擎+浏览器池…`);
  try { engine.stop(); } catch (_) {}
  if (devicePool) { try { devicePool.closeAll(); } catch (_) {} }
  setTimeout(async () => {
    try {
      if (devicePool) {
        devicePool = new MobileDevicePool(devicePoolOpts());
        engine.setDevice(devicePool);
      }
      await bootNurture();
      console.error(`[watchdog] 已自愈重启，accounts=${engine.accounts.length}`);
    } catch (e) { console.error('[watchdog] 自愈失败:', e.message); }
  }, 5000);
}, 60 * 1000);

const DASHBOARD_FILE = path.join(__dirname, 'tumblr-nurture-dashboard.html');

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }

    // 根路径 → 看板 HTML
    if (p === '/' && req.method === 'GET') {
      if (fs.existsSync(DASHBOARD_FILE)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(DASHBOARD_FILE, 'utf8'));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('dashboard not found');
    }

    // 静态看板：项目根目录下任意 .html（tumblr-nurture-dashboard.html / tumblr-nurture-logs.html 等）
    if (p.endsWith('.html') && req.method === 'GET') {
      const fp = path.join(__dirname, path.basename(p));
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(fp, 'utf8'));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
    }

    if (p === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, {
        running: started || !!engine._timer,
        tickMs: engine._tickMs,
        totalAccounts: engine.accounts.length,
        proxyPoolSize: proxyPool.count(),
        apiCooldownUntil: engine._apiCooldownUntil,
        apiCooldownByProxy: engine._apiCooldownView(),
        snapshot: engine.snapshot(),
        device: devicePool ? devicePool.snapshot() : { enabled: false, disabled: false, disableReason: null, browserUp: false, contextCount: 0, maxContexts: 0, contexts: [] },
      });
    }

    if (p === '/api/accounts' && req.method === 'GET') {
      const rows = engine.accounts.map((a) => {
        const tok = dataStore.get('tumblr_token', a.id);
        return { id: a.id, blog: (tok && tok.blogName) || null, authorized: !!(tok && tok.oauthToken), email: a.email || null };
      });
      return sendJSON(res, 200, { total: rows.length, accounts: rows });
    }

    if (p === '/api/start' && req.method === 'POST') {
      if (engine._timer) return sendJSON(res, 200, { ok: true, alreadyRunning: true, totalAccounts: engine.accounts.length, device: devicePool ? devicePool.snapshot() : null });
      if (devicePool) {
        try { await engine.syncDeviceUA(); }
        catch (e) { console.error('[tumblr-nurture] 设备同步失败:', e.message); }
      }
      engine.start();
      started = true;
      return sendJSON(res, 200, { ok: true, running: true, totalAccounts: engine.accounts.length, device: devicePool ? devicePool.snapshot() : null });
    }

    // 重新加载账号并纳入养号：tumblr-onboard.js 直接写 accounts.json 后调用，
    // 使新注册账号被引擎识别、分配移动设备上下文、并开始养号。
    if (p === '/api/reload' && req.method === 'POST') {
      try {
        dataStore.reloadModule('accounts');   // 从磁盘重读（覆盖内存缓存，感知外部注册的账号）
        // B1 修复：同时重读 token/config/reqtoken，否则新注册账号「进了养号却拿不到 token」→ 所有 API 动作静默失败
        dataStore.reloadModule('tumblr_token');
        dataStore.reloadModule('tumblr_config');
        dataStore.reloadModule('tumblr_reqtoken');
        proxyPool.load();        // 重新读取 proxy-pool.json：新增出口 IP 即时生效（无需重启）
        engine.proxyPool.load(); // 同步重载引擎内部代理池（按出口 IP 分桶冷却的 key 依赖它，必须一致）
        publisher.reloadApps();  // 重新读取 tumblr_apps.json：新增 OAuth App 即时生效
        const n = engine.load();
        // 账号数增长时同步放大设备池容量（多浏览器分片，按账号数自适应），让新账号也能拿到移动上下文
        if (devicePool) {
          const opts = devicePoolOpts();
          devicePool.perBrowserMax = opts.perBrowserMax;
          devicePool.maxBrowsers = opts.maxBrowsers;
          devicePool.proxies = opts.proxies;
        }
        if (devicePool) { try { await engine.syncDeviceUA(); } catch (e) { console.error('[tumblr-nurture] 设备同步失败:', e.message); } }
        return sendJSON(res, 200, {
          ok: true,
          accounts: n,
          deviceEnabled: !!(devicePool && devicePool.enabled),
          // B9 修复：设备池改为 ephemeral 后已无 .contexts，改用 _uaByAccount.size（已分配指纹的账号数）
          contexts: devicePool ? (devicePool._uaByAccount ? devicePool._uaByAccount.size : 0) : 0,
          maxContexts: devicePool ? devicePool.maxContexts : 0,
          browsers: devicePool ? devicePool.browsers.length : 0,
          proxyPoolSize: proxyPool.count(),
        });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 安全再平衡（仅服务端内部 localhost 调用）：仅对「无 OAuth token」的账号重新分配 App，
    // 不破坏已签发 token↔app 绑定；已有 token 的账号须重新授权才能换 App（否则 401）。
    if (p === '/api/internal/rebalance-apps' && req.method === 'POST') {
      try {
        const cfgs = (dataStore.list('tumblr_config', { limit: 100000 }).items) || [];
        let reassigned = 0, needsReauth = 0, skipped = 0;
        for (const c of cfgs) {
          if (!c || c.id === 'main') { skipped++; continue; }
          const tok = dataStore.get('tumblr_token', c.id);
          if (tok && tok.oauthToken) { needsReauth++; continue; } // 有 token，须重授权才能换 App
          const app = publisher._appForAccount(c.id);
          if (app) {
            dataStore.update('tumblr_config', c.id, { consumerKey: app.consumerKey, consumerSecret: app.consumerSecret });
            reassigned++;
          }
        }
        publisher.reloadApps();
        return sendJSON(res, 200, { ok: true, reassigned, needsReauth, skipped });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // ── 每账号操作日志 ──
    if (p === '/api/logs' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '80', 10);
      return sendJSON(res, 200, { total: engine.accounts.length, logs: engine.getRecentLogs(limit) });
    }
    if (p.startsWith('/api/logs/') && req.method === 'GET') {
      const accountId = decodeURIComponent(p.slice('/api/logs/'.length));
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      return sendJSON(res, 200, { accountId, logs: engine.getActionLog(accountId, limit) });
    }

    // ── 每日养号进度汇总 ──
    if (p === '/api/summary/daily' && req.method === 'GET') {
      const date = url.searchParams.get('date') || undefined;
      return sendJSON(res, 200, engine.dailySummary(date));
    }

    // ── 代理池状态 ──
    if (p === '/api/proxies' && req.method === 'GET') {
      return sendJSON(res, 200, { size: proxyPool.count(), list: proxyPool.list() });
    }

    // ── 激活多出口代理池（在真实机器 3005 进程内运行 freefq→sing-box→本地 HTTP 代理）──
    // 关键：本脚本从沙箱无法直接验证 freefq 节点可达性，故需在拥有真实网络的 3005 进程里跑。
    // 运行后：启动可达的 freefq 节点为本地 HTTP 代理 → 探测各自出口 IP 去重 → 写入 proxy-pool.json → 即时 reload。
    if (p === '/api/proxy/activate' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const desired = Math.min(20, Math.max(1, parseInt(body.desired, 10) || 8));
        const { activate: runActivate } = require('./proxy-pool-activator.js');
        const result = await runActivate({ desired });
        // 重新加载代理池到 server + engine(按 IP 分桶冷却) + 设备池（与 /api/reload 同逻辑）
        proxyPool.load();
        engine.proxyPool.load();
        publisher.reloadApps();
        if (devicePool) { const o = devicePoolOpts(); devicePool.proxies = o.proxies; }
        return sendJSON(res, 200, {
          ok: true,
          poolSize: proxyPool.count(),
          distinctIp: result.distinctIp,
          nodes: result.nodes,
          exits: result.exits || [],
          note: result.distinctIp > 1
            ? `多出口已生效（${result.distinctIp} 个独立公网 IP），账号按哈希分散到不同出口，429 压力显著下降`
            : '当前仅 1 个独立出口 IP（10808 中继）：freefq 节点不可达，且本机其它代理(7890)要么不可用要么出口相同。要进一步分散需补充可达的多出口代理订阅',
        });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // ── 429 缓解分布诊断：展示生效的出口 IP 数 / OAuth App 数 / 按账号分配抽样 ──
    if (p === '/api/mitigation' && req.method === 'GET') {
      const appCount = publisher._appList ? publisher._appList.length : 0;
      const sample = engine.accounts.slice(0, 16).map((a) => {
        const id = a.id || a.accountId;
        return { id, proxy: proxyPool.forAccount(id), appIndex: appCount ? (hashStr(String(id)) % appCount) : -1 };
      });
      return sendJSON(res, 200, {
        resolverWired: !!publisher._proxyResolver,
        proxyPoolSize: proxyPool.count(),
        appCount,
        note: proxyPool.count() <= 1
          ? '仅单出口 IP：429 仍会触发，请在 proxy-pool.json 增加出口 IP'
          : '多出口已生效，账号已按哈希分散到不同 IP',
        sample,
      });
    }

    if (p === '/api/stop' && req.method === 'POST') {
      engine.stop();
      started = false;
      return sendJSON(res, 200, { ok: true, running: false });
    }

    if (p === '/api/run-one' && req.method === 'POST') {
      const body = await readBody(req);
      const { accountId, phase, opts } = body || {};
      if (!accountId) return sendJSON(res, 400, { error: 'accountId required' });
      if (!engine.states.has(accountId)) return sendJSON(res, 404, { error: 'account not loaded (terminated or not tumblr)' });
      const r = await engine.runPhaseNow(accountId, phase || 'P0', opts || {});
      return sendJSON(res, 200, { ok: true, accountId, phase: phase || 'P0', result: r });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[tumblr-nurture] service listening on http://localhost:${PORT}  (accounts=${engine.accounts.length}, autoStart=${started}, device=${DEVICE_ENABLED})`);
});

// 优雅退出：关闭移动端浏览器池，避免孤儿 chromium 进程
async function shutdown() {
  try { if (devicePool) await devicePool.closeAll(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, engine, devicePool };
