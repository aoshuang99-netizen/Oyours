/**
 * ops-oneclick.js — 代理一键运维端点（体检 → 切池 → 实测可用性 → 有条件热生效）
 *
 * 为什么需要它（2026-10-13 定位到的两个真实缺口）：
 *   ① 池文件分裂：`proxy-pool-activator.js`（跑在 3005，cwd=工作区）写的是
 *      `工作区/proxy-pool.json`；而 3002（cwd=D:\MSCMS-Desktop\resources）与
 *      发布器 `cloud-publisher.js:889` 读的都是 **D 盘** 那份。
 *      ⇒ 按了「激活」按钮，出口池对发布器**完全没变**。
 *   ② 永久缓存：发布器 `_proxyCandidates()` 把读到的池缓存在 `this._proxyCache`
 *      且**只增不减地复用** ⇒ 即使文件换了，发布器仍然用旧列表。
 *
 * 本模块把三件事串成一条链，并把「切了到底有没有用」用**实测**回答出来：
 *   1. 体检：exit-guard /health + /pool、两侧池文件、逐出口实测（Tumblr 可达性 + 真实出口 IP）
 *   2. 切池：POST 3005 /api/proxy/activate
 *   3. 生效：把 3005 写出的池**有条件**镜像到 D 盘，并清掉发布器的缓存 + 重载池句柄
 *
 * 安全护栏（重要）：
 *   · 镜像默认带「不劣化」保护：新池实测可达出口数 < 当前池 ⇒ 拒绝写入（force:true 可强制）。
 *     没有这条，freefq 不可达时会把 D 盘 42 条池覆写成 1 条（10-13 已实际发生过一次）。
 *   · 写入前必备份 `proxy-pool.json.bak-oneclick`。
 *   · 同一时刻只允许一次调用（防抖），并发调用直接 409。
 *
 * 用法：
 *   POST /api/ops/proxy-oneclick { desired?:8, verify?:true, mirror?:true, force?:false, probeLimit?:6 }
 *   GET  /api/ops/proxy-status          # 只体检，不切池、不写盘
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const WS = __dirname;
/**
 * ⚠️ 关键坑（2026-10-13 实测踩到）：`__dirname` 取决于**谁加载了本模块**。
 *   本模块被 3002 加载（3002 cwd=`D:\MSCMS-Desktop\resources`）
 *   ⇒ `path.join(__dirname,'proxy-pool.json')` 指向的是 **D 盘**那份，
 *   而**不是**工作区那份。最初版本据此认为「WS 侧池 = 工作区池」，导致
 *   两侧读成同一个文件、镜像退化为自拷贝（首测已复现）。
 *
 * 正确口径：
 *   · 发布器/3002 读的池 = 本模块 `__dirname` 下的池（因为 3002 就在那儿跑）
 *   · 养号 3005/activator 读写的池 = **工作区**池（3005 cwd=工作区）
 *   · 工作区池路径由 exit-guard `/pool` 动态发现（它从工作区跑，会把两个
 *     绝对路径都报回来），失败才退回 `MSCMS_WS_POOL` / 硬编码兜底。
 */
const PUBLISHER_POOL = path.join(WS, 'proxy-pool.json');
const WS_POOL_FALLBACK = process.env.MSCMS_WS_POOL || 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/proxy-pool.json';

const EXIT_GUARD_PORT = 20779;
const NURTURE_PORT = 3005;

let _nurturePool = null;
/** 动态解析「工作区池」（= activator 的写入目标） */
async function resolveNurturePool() {
  if (_nurturePool) return _nurturePool;
  const r = await httpJson(EXIT_GUARD_PORT, 'GET', '/pool', null, 8000);
  if (r.ok && r.body && typeof r.body === 'object' && !Array.isArray(r.body)) {
    const cand = Object.keys(r.body).find((k) => path.resolve(k) !== path.resolve(PUBLISHER_POOL));
    if (cand) { _nurturePool = cand; return cand; }
  }
  _nurturePool = WS_POOL_FALLBACK;
  return _nurturePool;
}

/** 与 proxy-pool.js/_prewarmAlive 保持同一权威口径：status!==0 即「可达」 */
const TUMBLR_PROBE = 'https://api.tumblr.com/v2/tumblr.info';
const IP_ECHO = 'https://api.ipify.org?format=json';
/**
 * 「出口自身是否活着」的对照目标（非 Tumblr）。
 * 用途：Tumblr 探测失败时区分两种完全不同的故障 ——
 *   · exitAlive=false ⇒ 出口本身死了（换出口有意义）
 *   · exitAlive=true  ⇒ 出口活着但 Tumblr 不可达（换出口无用，必须补 IP/换线路）
 * 2026-10-13 实测：经 10809 访问 qq.com=200 而 *.tumblr.com 全部超时/RST，
 * 正是第二种。没有这个对照，端点会给出「0 个可用出口」的误导性结论。
 */
const ALIVE_PROBE = 'https://www.qq.com/';

const PROBE_TIMEOUT_MS = Number(process.env.MSCMS_OPS_PROBE_TIMEOUT_MS || 8000);
const PROBE_CONCURRENCY = Number(process.env.MSCMS_OPS_PROBE_CONCURRENCY || 6);

let _busy = false;

// ────────────────────────── 小工具 ──────────────────────────

/** 极简本机 HTTP JSON 请求（走 http 模块，不经代理、不经 undici） */
function httpJson(port, method, urlPath, body, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch (_) { parsed = { _raw: buf.slice(0, 400) }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout ${timeoutMs}ms`)); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function hostOf(u) { try { return new URL(u).host; } catch (_) { return String(u); } }

/** 读池文件，返回结构化摘要（不写盘） */
function readPoolFile(p) {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.proxies || raw.items || []);
    const enabled = arr.filter((x) => x && x.url && x.enabled !== false && (x.usage || 'post') !== 'scrape');
    const hosts = new Set(enabled.map((x) => hostOf(x.url)));
    const claimedIps = [...new Set(enabled.map((x) => x.exitIp).filter(Boolean))];
    return {
      path: p,
      exists: true,
      total: arr.length,
      enabled: enabled.length,
      distinctHost: hosts.size,
      claimedExitIps: claimedIps,
      urls: [...new Set(enabled.map((x) => x.url))],
      mtime: (() => { try { return fs.statSync(p).mtime.toISOString(); } catch (_) { return null; } })(),
    };
  } catch (e) {
    return { path: p, exists: false, error: e.message };
  }
}

let _fetchExt;
function getFetchExt() {
  if (_fetchExt !== undefined) return _fetchExt;
  try { _fetchExt = require('./http-client.js').fetchExt; } catch (_) { _fetchExt = null; }
  return _fetchExt;
}

let _hc;
function getHttpClient() {
  if (_hc !== undefined) return _hc;
  try { _hc = require('./http-client.js'); } catch (_) { _hc = null; }
  return _hc;
}

/**
 * 单出口实测：先探 Tumblr 可达性（权威口径），可达再探真实出口 IP。
 * 返回 {url, ok, tumblrStatus, exitIp, ms, circuitOpen, error}
 *
 * ⚠️ 必须传 `bypassCircuit:true`：fetchExt 对熔断中的出口会**静默回落全局代理**
 *   （http-client.js:412），不绕过的话测的是全局代理而非该出口 —— 探针会说谎。
 *   熔断状态单独用 `circuitOpen` 报出，两者不混为一谈。
 */
async function probeExit(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const fe = getFetchExt();
  if (!fe) return { url, ok: false, error: 'fetchExt unavailable' };
  const hc = getHttpClient();
  let circuitOpen = false;
  try { circuitOpen = !!(hc && hc.isProxyCircuitOpen && hc.isProxyCircuitOpen(url)); } catch (_) {}
  const t0 = Date.now();
  let tumblrStatus = 0;
  try {
    const r = await fe(TUMBLR_PROBE, { method: 'GET', timeout: timeoutMs, bypassCircuit: true }, url);
    tumblrStatus = (r && typeof r.status === 'number') ? r.status : 0;
  } catch (_) { tumblrStatus = 0; }

  const ok = tumblrStatus !== 0;
  const out = { url, ok, tumblrStatus, exitIp: null, ms: Date.now() - t0, circuitOpen, exitAlive: null };
  if (!ok) {
    out.error = 'tumblr unreachable';
    // 对照：出口自身是否活着（决定「换出口」有没有意义）
    try {
      const r3 = await fe(ALIVE_PROBE, { method: 'HEAD', timeout: timeoutMs, bypassCircuit: true }, url);
      out.exitAlive = !!(r3 && typeof r3.status === 'number' && r3.status !== 0);
    } catch (_) { out.exitAlive = false; }
    out.ms = Date.now() - t0;
    return out;
  }

  try {
    const r2 = await fe(IP_ECHO, { method: 'GET', timeout: timeoutMs, bypassCircuit: true }, url);
    if (r2 && r2.ok) {
      const txt = String(await r2.text()).trim();
      out.exitIp = (txt.match(/(\d{1,3}\.){3}\d{1,3}/) || [])[0] || null;
    }
  } catch (_) { /* 出口 IP 拿不到不影响可达性判定 */ }
  out.ms = Date.now() - t0;
  return out;
}

/** 并发探测（限流），最多 probeLimit 个唯一 URL */
async function probeMany(urls, timeoutMs, probeLimit) {
  const uniq = [...new Set(urls || [])].slice(0, Math.max(1, probeLimit));
  const out = [];
  for (let i = 0; i < uniq.length; i += PROBE_CONCURRENCY) {
    const batch = uniq.slice(i, i + PROBE_CONCURRENCY);
    const rs = await Promise.all(batch.map((u) => probeExit(u, timeoutMs)));
    out.push(...rs);
  }
  return out;
}

function summarizeProbes(probes) {
  const ok = probes.filter((p) => p.ok);
  const ips = new Set(ok.map((p) => p.exitIp).filter(Boolean));
  const lat = ok.map((p) => p.ms).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const alive = probes.filter((p) => p.exitAlive === true);
  return {
    probed: probes.length,
    reachable: ok.length,
    distinctExitIp: ips.size,
    exitIps: [...ips],
    medianMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    circuitOpen: probes.filter((p) => p.circuitOpen).length,
    /** 出口自身活着（非 Tumblr 目标可达）的条数 —— 用于区分「出口死」与「Tumblr 不可达」 */
    exitAlive: alive.length,
  };
}

// ────────────────────────── 主流程 ──────────────────────────

/**
 * 清掉发布器的池缓存并重载池句柄 —— 这是「切了真的生效」的关键一步。
 * 对应 cloud-publisher.js:888 `if (this._proxyCache && this._proxyCache.length) return ...`
 */
function hotReloadPublisherPool(cloudPublisher) {
  if (!cloudPublisher) return { ok: false, reason: '发布器句柄不可用' };
  const touched = [];
  try {
    if (cloudPublisher._proxyCache) { cloudPublisher._proxyCache = null; touched.push('_proxyCache'); }
    if (cloudPublisher._proxyHealth) { cloudPublisher._proxyHealth = null; touched.push('_proxyHealth'); }
    cloudPublisher._proxyHealthAt = 0;
    touched.push('_proxyHealthAt');
    cloudPublisher._proxyCfgWarned = false;

    const { ProxyPool } = require('./proxy-pool');
    if (cloudPublisher._poolForBudget && typeof cloudPublisher._poolForBudget.load === 'function') {
      cloudPublisher._poolForBudget.load();
      touched.push('_poolForBudget.load()');
    } else {
      cloudPublisher._poolForBudget = new ProxyPool();
      touched.push('_poolForBudget=new');
    }
    return { ok: true, touched };
  } catch (e) {
    return { ok: false, reason: e.message, touched };
  }
}

/** exit-guard /pool 会原样吐出全部 URL（41 条 ≈ 1.2KB）—— 只保留计数，URL 已在别处汇总 */
function slimGuardPool(body) {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === 'object' && Array.isArray(v.urls)) {
      out[k] = { total: v.total, enabled: v.enabled, distinctUrl: new Set(v.urls).size, error: v.error };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 体检（只读，不切池不写盘） */
async function proxyStatus(opts = {}) {
  const probeLimit = Math.min(24, Math.max(1, parseInt(opts.probeLimit, 10) || 6));
  const doVerify = opts.verify !== false;

  const [guardHealth, guardPool] = await Promise.all([
    httpJson(EXIT_GUARD_PORT, 'GET', '/health', null, 10000),
    httpJson(EXIT_GUARD_PORT, 'GET', '/pool', null, 10000),
  ]);

  const dPool = readPoolFile(PUBLISHER_POOL);
  const wPool = readPoolFile(await resolveNurturePool());

  const probes = doVerify ? await probeMany(dPool.urls || [], PROBE_TIMEOUT_MS, probeLimit) : [];
  return {
    ts: new Date().toISOString(),
    exitGuard: {
      port: EXIT_GUARD_PORT,
      health: guardHealth.ok ? guardHealth.body : { error: guardHealth.error || `HTTP ${guardHealth.status}` },
      pool: guardPool.ok ? slimGuardPool(guardPool.body) : { error: guardPool.error || `HTTP ${guardPool.status}` },
    },
    poolForPublisher: dPool,
    poolForNurture: wPool,
    probes,
    probeSummary: doVerify ? summarizeProbes(probes) : null,
    note: doVerify ? null : '已跳过实测（verify:false）',
  };
}

/** 一键：体检 → 切池 → 实测 → 有条件生效 */
async function proxyOneclick(opts = {}) {
  if (_busy) return { ok: false, busy: true, error: '另一次 proxy-oneclick 正在执行，请稍后重试' };
  _busy = true;
  const t0 = Date.now();
  try {
    const desired = Math.min(20, Math.max(1, parseInt(opts.desired, 10) || 8));
    const doVerify = opts.verify !== false;
    const doMirror = opts.mirror !== false;
    const force = opts.force === true;
    const probeLimit = Math.min(24, Math.max(1, parseInt(opts.probeLimit, 10) || 6));
    const steps = [];

    // ── 1. 体检（切池前） ──
    const before = await proxyStatus({ probeLimit, verify: doVerify });
    steps.push({ step: 'preflight', ok: true, summary: before.probeSummary, pool: before.poolForPublisher,
      exitGuardHealth: before.exitGuard.health });

    // ── 2. 切池（3005 activate） ──
    const act = await httpJson(NURTURE_PORT, 'POST', '/api/proxy/activate', { desired }, 240000);
    steps.push({ step: 'activate', ok: act.ok, detail: act.ok ? act.body : { error: act.error || `HTTP ${act.status}` } });

    // ── 3. 实测新池（工作区池已被 3005 重写） ──
    const nurturePoolPath = await resolveNurturePool();
    const afterW = readPoolFile(nurturePoolPath);
    const afterProbes = doVerify ? await probeMany(afterW.urls || [], PROBE_TIMEOUT_MS, probeLimit) : [];
    const afterSummary = doVerify ? summarizeProbes(afterProbes) : null;
    steps.push({ step: 'verify', ok: true, pool: afterW, summary: afterSummary });

    // ── 4. 有条件镜像到 D 盘 + 热生效 ──
    const beforeReach = (before.probeSummary && before.probeSummary.reachable) || 0;
    const beforeIp = (before.probeSummary && before.probeSummary.distinctExitIp) || 0;
    const afterReach = (afterSummary && afterSummary.reachable) || 0;
    const afterIp = (afterSummary && afterSummary.distinctExitIp) || 0;

    let mirror = { attempted: doMirror, applied: false, reason: '', backup: null };
    if (!doMirror) {
      mirror.reason = 'mirror:false，未写入发布器池';
    } else if (!afterW.exists || !afterW.enabled) {
      mirror.reason = '新池不可读或为空，拒绝覆写发布器池';
    } else if (!force && afterReach === 0) {
      mirror.reason = `新池实测 0 个可达出口（当前池 ${beforeReach} 个）⇒ 拒绝劣化；如确认要写用 force:true`;
    } else if (!force && afterIp < beforeIp) {
      mirror.reason = `新池独立出口 IP ${afterIp} < 当前 ${beforeIp} ⇒ 拒绝劣化；如确认要写用 force:true`;
    } else {
      try {
        const bak = PUBLISHER_POOL + '.bak-oneclick';
        if (fs.existsSync(PUBLISHER_POOL)) fs.copyFileSync(PUBLISHER_POOL, bak);
        const src = fs.readFileSync(nurturePoolPath, 'utf8');
        fs.writeFileSync(PUBLISHER_POOL, src);
        mirror.applied = true;
        mirror.backup = bak;
        mirror.from = nurturePoolPath;
        mirror.to = PUBLISHER_POOL;
        mirror.reason = `已镜像工作区池 → 发布器池（${afterW.enabled} 条）`;
      } catch (e) {
        mirror.reason = '写入失败: ' + e.message;
      }
    }

    let hot = null;
    if (mirror.applied) {
      hot = hotReloadPublisherPool(opts.cloudPublisher);
    }
    steps.push({ step: 'apply', ok: mirror.applied, mirror, hotReload: hot });

    // ── 5. 判定 ──
    const improved = afterIp > beforeIp || afterReach > beforeReach;
    const afterAlive = (afterSummary && afterSummary.exitAlive) || 0;
    // 关键分诊：出口活着但 Tumblr 全不可达 ⇒ 换出口/做按钮都没用
    const tumblrBlocked = afterReach === 0 && afterAlive > 0;
    const verdict = {
      canSwitch: improved,
      distinctExitIpBefore: beforeIp,
      distinctExitIpAfter: afterIp,
      reachableBefore: beforeReach,
      reachableAfter: afterReach,
      exitAliveAfter: afterAlive,
      tumblrBlocked,
      appliedToPublisher: !!mirror.applied,
      headline: improved
        ? `切换有改善：独立出口 IP ${beforeIp} → ${afterIp}，Tumblr 可达 ${beforeReach} → ${afterReach}`
        : (tumblrBlocked
          ? `切换无改善且**不是出口数量问题**：${afterAlive} 个出口链路正常，但对 *.tumblr.com 全部不可达`
          : `切换无改善：独立出口 IP 仍为 ${afterIp}（Tumblr 可达 ${afterReach}）——按了也是白按`),
      advice: improved
        ? '出口已分散，429 压力应下降；建议观察 30 分钟发布成功率。'
        : (tumblrBlocked
          ? '出口链路健康（对照目标可达）但 *.tumblr.com 全域不可达 ⇒ 必须换「对 Tumblr 有效的线路/IP」（新住宅 IP 订阅、ShardX+住宅代理），做按钮或加免费代理都解决不了。'
          : '出口本身不可用（对照目标也不可达）。先修出口链路，再谈池数量。'),
    };
    if (opts.explain) verdict.steps = steps;

    return {
      ok: true,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      params: { desired, verify: doVerify, mirror: doMirror, force, probeLimit },
      verdict,
      steps,
      activateNote: (act.ok && act.body && act.body.note) || null,
    };
  } finally {
    _busy = false;
  }
}

// ────────────────────────── 路由注册 ──────────────────────────

/**
 * @param {import('express').Express} app
 * @param {{getCloudPublisher?: () => any}} deps
 */
function registerOpsRoutes(app, deps = {}) {
  const getCP = typeof deps.getCloudPublisher === 'function' ? deps.getCloudPublisher : () => null;

  app.post('/api/ops/proxy-oneclick', async (req, res) => {
    try {
      const body = req.body || {};
      body.cloudPublisher = getCP();
      const out = await proxyOneclick(body);
      res.status(out.busy ? 409 : 200).json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/ops/proxy-status', async (req, res) => {
    try {
      const q = req.query || {};
      const out = await proxyStatus({
        probeLimit: q.probeLimit,
        verify: q.verify !== 'false',
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  registerOpsRoutes,
  proxyOneclick,
  proxyStatus,
  probeExit,
  probeMany,
  readPoolFile,
  hotReloadPublisherPool,
  resolveNurturePool,
  PUBLISHER_POOL,
  WS_POOL_FALLBACK,
};
