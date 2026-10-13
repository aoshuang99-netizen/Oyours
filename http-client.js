'use strict';
/**
 * http-client.js — 统一的代理感知 HTTP 客户端
 *
 * 背景：
 *  - 本机运行在沙箱/代理环境，外网必须通过本地代理 (HTTP_PROXY / HTTPS_PROXY) 访问。
 *  - Node 内置 fetch (undici) 默认【不】读取 HTTP_PROXY 环境变量，会直接连外网而超时。
 *  - 本模块自动检测代理并用 undici ProxyAgent 路由，使所有外部请求（Reddit/Tumblr/Google Trends）可达。
 *
 * 使用：
 *  - 外部请求一律用 fetchExt(url, opts)
 *  - 内部请求（localhost）仍用全局 fetch，不受影响
 */

// 关键：必须使用 undici 自带的 fetch（与 ProxyAgent 同版本），
// 不能混用 Node 内置全局 fetch —— 两者 Dispatcher 内部符号不兼容，
// 把 npm undici 的 ProxyAgent 传给全局 fetch 会报 UND_ERR_INVALID_ARG。
const { ProxyAgent, fetch: undiciFetch, Response } = require('undici');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Bright Data Web Unlocker 桥（bdunlocker:// scheme）
 * ------------------------------------------------------------------
 * 背景：Bright Data 的 Web Unlocker zone 没有标准 HTTP 代理端口（只有 REST API），
 * 而本账户「住宅代理」需 KYC 被锁、「ISP 代理」的 ASN 被 Tumblr 在网络层重置、
 * 「Scraping Browser」禁止当代理。Web Unlocker 是唯一实测能连 Tumblr 的类型。
 * 因此把它的 REST API 包成 MSCMS 的「出口代理」，根除 Tumblr 429（单 IP 限流）。
 *
 * 关键兼容点：BD /request 调用本身恒返回 200，但把目标【真实状态码】放在响应头
 * `x-brd-status-code`，响应体是目标原样响应。故 OAuth 错误处理（401/403）完整保留。
 *
 * 代理 URL 格式：bdunlocker://<zone>:<apiKey>
 */
const BD_UNLOCKER_RE = /^bdunlocker:\/\/([^:]+):(.+)$/;
const BD_UNLOCKER_EP = 'https://api.brightdata.com/request';

// 自动路由：proxy-pool.json 含 bd-unlocker 出口时，所有 *.tumblr.com 请求经其 REST 桥
// （彻底用住宅轮换 IP 替代单出口 10808，根除 429）；非 tumblr 请求不受影响。
let _unlocker = null;
try {
  const poolRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'proxy-pool.json'), 'utf8'));
  if (Array.isArray(poolRaw)) {
    // ⚠️【2026-09-10 修复】旧实现（2026-09-08 P2）刻意「不要求 enabled!==false」——
    //   只要池里存在 bdunlocker:// 条目就启用桥，理由是它必须保持 disabled 以免被
    //   ProxyPool 当成普通代理分给 POST 请求。
    //   但这带来一个致命副作用：条目「留着但已停用」同样会让所有 *.tumblr.com 的
    //   GET/HEAD 走已停用/欠费的 Bright Data 桥 → 桥恒返回 407 Proxy Authentication Required
    //   → getPostStats('/blog/{blog}/posts/{id}') 全部 407，
    //   发出去的帖子互动数据(reach/likes/reblogs)永远回收不到。
    //   现改为：必须显式 enabled:true 才启用桥；BD 恢复后把池里该条 enabled 置 true 即可。
    //   需要临时强制开启时用 BD_UNLOCKER_ENABLE=1，不必改池文件。
    const force = ['1', 'true'].includes(String(process.env.BD_UNLOCKER_ENABLE || '').toLowerCase());
    const u = poolRaw.find((p) => p && typeof p.url === 'string' && BD_UNLOCKER_RE.test(p.url)
      && (force || p.enabled === true));
    if (u) { const m = u.url.match(BD_UNLOCKER_RE); _unlocker = { zone: m[1], apiKey: m[2] }; }
    else { _unlocker = null; }
  }
} catch (e) { _unlocker = null; }

let proxyAgent = null;
const proxy =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || null;

if (proxy) {
  try {
    // 字符串形式即兼容（10808 为普通 HTTP 正向代理，curl -x 已验证可达）
    proxyAgent = new ProxyAgent(proxy);
    // 双保险：进程级关闭 TLS 校验（仅当存在代理时），兼容本地 MITM 类代理
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    console.log(`[http-client] 已启用代理中转: ${proxy}`);
  } catch (e) {
    console.error('[http-client] 初始化代理失败，将直连:', e.message);
    proxyAgent = null;
  }
}

// 每调用方代理缓存：实现「按账号/按浏览器」分配不同出口 IP（429 限流根因缓解）。
// 默认（不传 proxyUrl）仍走全局 proxyAgent，完全向后兼容。
//
// ── 🔴 2026-10-12 P0-5：3002 内存黑洞根治（真凶就在本段）──────────────────
// 事故：3002 RSS 7.4h 涨到 3.9GB（本实例 04:00:12Z 启 → 11:20Z 实测 3,902MB），
//   顶到 Node 默认堆顶 + 把 16GB 物理内存压到 free 0.5GB ⇒ 其它进程报
//   `页面文件太小`(0x800705AF) / `spawn EBUSY`，整机丧失响应能力；
//   在此之前已两次误归因（Ollama CPU 抢占、MsMpEng 416%）——那些都只是伴随现象。
// 归因（实证）：本实例日志（79,332 行）里 `[proxy-circuit] ⛔ 出口 X 连续失败`
//   出现 23,664 次，涉及 **3,767 个不同出口 URL**；而旧实现每见到一个新出口就
//   `new ProxyAgent(proxyUrl)` 并塞进 `_agentCache` —— 【无上限、无淘汰、永不 close()】。
//   undici 的 ProxyAgent 自带 Pool / Client / connector / keep-alive socket / timer，
//   3,902MB ÷ 3,767 ≈ 1.06MB/个 —— 与实测增量吻合（≈1GB/h，池子轮换越快涨得越快）。
//   出口为什么这么多：池子里混入了免费代理（`proxy-pool.json` 有
//   `"source":"free-proxy-pool"`，实测含 `http://0.0.0.0:80`、`http://47.252.18.37:6379`
//   这类根本不是 HTTP 代理的地址），池子持续轮换 ⇒ 缓存只增不减 ⇒ RSS 单向爬升。
// 修法：LRU 上限 + 淘汰即释放底层 socket/timer。
//   · MAX_PROXY_AGENTS 默认 24：足够「按账号/按浏览器分散出口」，不再无限膨胀；
//   · 命中即移到队尾（真 LRU），超限淘汰队首；
//   · 释放走「先 graceful close()、90s 后硬 destroy()」两段式 ——
//     close() 会等在途请求跑完（不打断业务），destroy() 兜住「socket 卡死导致
//     close() 永不 settle」的场景，保证内存一定回收；
//   · 出口被熔断时立即 retire（死出口没必要继续占坑）。
// 可观测量：每 30min 打一行
//   `[http-client] agent缓存 size=… created=… retired=… 熔断表=…`
//   修复后 size 应恒 ≤ 24、retired 与 created 同步增长、RSS 不再单向爬升。
// 回滚：`MSCMS_MAX_PROXY_AGENTS=0` 恢复旧的「无上限」行为（仅排障用）。
const MAX_PROXY_AGENTS = (() => {
  const v = Number(process.env.MSCMS_MAX_PROXY_AGENTS);
  if (Number.isFinite(v) && v <= 0) return Infinity;          // 显式 0/负数 = 关闭上限（回滚开关）
  return Number.isFinite(v) && v >= 4 ? Math.floor(v) : 24;
})();
const AGENT_DESTROY_AFTER_MS = Number(process.env.MSCMS_AGENT_DESTROY_AFTER_MS || 90 * 1000);
const _agentCache = new Map();   // proxyUrl -> ProxyAgent（LRU：队首最旧）
const _retiring = [];            // [{a, dueAt}] 已 graceful close、等待硬 destroy 兜底
let _agentCreated = 0, _agentRetired = 0;

function _hardDestroy(a) {
  try {
    if (a && typeof a.destroy === 'function') {
      const p = a.destroy(); if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_) { /* 释放失败不影响请求路径 */ }
}

/** 退休一个 Agent：先 graceful close()（等在途请求跑完），并登记 90s 后硬 destroy 兜底 */
function _retireAgent(a) {
  if (!a) return;
  _agentRetired++;
  try {
    if (typeof a.close === 'function') { const p = a.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
    else { _hardDestroy(a); return; }
  } catch (_) { _hardDestroy(a); return; }
  _retiring.push({ a, dueAt: Date.now() + AGENT_DESTROY_AFTER_MS });
  // 抖动期兜底：退休队列也不允许无界
  while (_retiring.length > 128) _hardDestroy(_retiring.shift().a);
}

function _evictAgent(proxyUrl) {
  const a = _agentCache.get(proxyUrl);
  if (!a) return false;
  _agentCache.delete(proxyUrl);
  _retireAgent(a);
  return true;
}

function _agentFor(proxyUrl) {
  if (!proxyUrl) return proxyAgent;
  const hit = _agentCache.get(proxyUrl);
  if (hit) { _agentCache.delete(proxyUrl); _agentCache.set(proxyUrl, hit); return hit; }  // LRU touch
  let a;
  try {
    a = new ProxyAgent(proxyUrl);
  } catch (e) {
    console.error(`[http-client] 代理 ${proxyUrl} 初始化失败，回退全局代理:`, e.message);
    return proxyAgent;
  }
  _agentCache.set(proxyUrl, a);
  _agentCreated++;
  while (_agentCache.size > MAX_PROXY_AGENTS) {
    const oldest = _agentCache.keys().next().value;
    if (oldest === undefined || oldest === proxyUrl) break;   // 上限极小时别把刚建好的淘汰掉
    _evictAgent(oldest);
  }
  return a;
}

/**
 * 代理感知 fetch —— 用于一切外部网络请求
 * 注意：始终用 undici 自带 fetch（见顶部说明），不可混用全局 fetch
 * @param {string} proxyUrl 可选，指定本次请求使用的出口代理（按账号/浏览器分配）。
 *                          不传则使用全局 proxyAgent（默认行为）。
 *
 * 安全护栏：默认 30s 超时（AbortController）。原因——Tumblr 或本地代理(10808)在连接
 * 半开/对端不响应时会让 await 永久挂起；养号循环若卡在某个账号的 API 调用上，整个
 * 事件循环被拖死、nurture:tick 不再发射，表现为「进程存活但 10+ 小时零动作」的静默死亡。
 * 超时把挂起转成可捕获错误，循环 catch 后继续下一个账号，杜绝死循环。
 * 若调用方已传入 opts.signal（如 ping 自带 8s 超时），则尊重调用方信号、不再叠加。
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 经 Bright Data Web Unlocker REST API 中转一次请求。
 * 返回真实 undici Response（status = 目标真实状态码，body = 目标原样响应）。
 *
 * 实现注意：本机经 10808 全局代理出网。实测 undici ProxyAgent 对 api.brightdata.com
 * 的 CONNECT 隧道会静默失败（fetch failed），而 curl -x 10808 稳定可达并正确返回
 * x-brd-status-code。故桥的 BD 中转跳改用 curl execFile，桥一旦启用即可真正生效
 * （否则账户结清后启用桥仍会因 undici 失败而 407/fetch failed，反而比 10808 更差）。
 */
async function fetchViaBrightDataUnlocker(realUrl, fetchOpts, zone, apiKey, controller) {
  const bdBody = {
    zone,
    url: realUrl,
    method: (fetchOpts.method || 'GET').toUpperCase(),
    format: 'raw',
  };
  if (fetchOpts.headers) bdBody.headers = fetchOpts.headers;
  if (fetchOpts.body) bdBody.data = fetchOpts.body;

  // BD 桥链路更长（curl → 本地代理 → BD API → 目标站），实测单请求 5~10s。
  // 调用方常按直连标准给 8~15s 超时，会稳定把桥请求打死 → 上层只看到 502 空 body。
  // 因此给桥一个 30s 的超时下限（调用方给更大则尊重调用方）。
  const timeoutMs = Math.max(Number(fetchOpts.timeout) || DEFAULT_TIMEOUT_MS, 30000);
  const proxyArg = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:10808';

  const curlArgs = [
    '-s', '-x', proxyArg,
    '-m', String(Math.floor(timeoutMs / 1000)),
    '-i', // 含响应头（读取 x-brd-status-code）
    '-X', 'POST', BD_UNLOCKER_EP,
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', JSON.stringify(bdBody),
  ];

  let rawOut;
  try {
    rawOut = await new Promise((resolve, reject) => {
      // windowsHide: 避免每次 BD 桥请求都弹出控制台黑窗（curl 为 console 子系统程序）
      const cp = execFile('curl', curlArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
      // 尊重调用方 AbortController（_viaUnlocker 的 30s 超时）
      if (controller) {
        controller.signal.addEventListener('abort', () => { try { cp.kill('SIGKILL'); } catch (_) {} });
      }
    });
  } catch (e) {
    // curl 失败 = 网络层错误（代理不可达 / 超时），透传为 502 让上层走兜底
    console.warn(`[bd-unlocker] curl 失败 url=${String(url).slice(0, 90)} timeoutMs=${timeoutMs} err=${e && e.message}`);
    return new Response(JSON.stringify({ error: 'bd_unlocker_fetch_failed', detail: e.message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  // 解析 curl -i 输出。⚠️ 实际输出含【两层】HTTP 响应块：
  //   ① 10808 代理的 CONNECT 响应（HTTP/1.1 200 Connection established）
  //   ② Bright Data 的响应（HTTP/1.1 200 OK + x-brd-status-code）
  //   ③ 才是目标站点的原始响应（含自己的 HTTP 头 + body）
  // 旧实现只取第一个 \r\n\r\n 前的头（即 ①），永远匹配不到 x-brd-status-code，
  // 于是把 ②③ 整体当成 body 返回 —— 回采因此解析到 "HTTP/1.1 200 OK\nServer: nginx..."
  // 而非真正 JSON，表现为 fetched=0。改为在【整个输出】中定位 BD 状态码。
  const brdStatusMatch = rawOut.match(/x-brd-status-code:\s*(\d+)/i);
  const sep = rawOut.indexOf('\r\n\r\n');
  if (brdStatusMatch) {
    // BD 成功代理：真实状态码在 x-brd-status-code；body 为 BD 头块之后的内容
    const realStatus = parseInt(brdStatusMatch[1], 10);
    const afterBrdHeader = rawOut.indexOf('\r\n\r\n', rawOut.indexOf(brdStatusMatch[0]));
    let body = afterBrdHeader >= 0 ? rawOut.slice(afterBrdHeader + 4) : (sep >= 0 ? rawOut.slice(sep + 4) : '');
    // 目标响应自带状态行（如 "HTTP/1.1 200 OK\r\n..."）时剥掉，只留真正的报文体
    if (/^HTTP\/[\d.]+\s+\d{3}/.test(body)) {
      const hs = body.search(/\r\n\r\n|\n\n/);
      if (hs >= 0) body = body.slice(hs).replace(/^(\r\n\r\n|\n\n)/, '');
    }
    return new Response(body, {
      status: realStatus,
      headers: { 'content-type': 'application/json' },
    });
  }
  const headerPart = sep >= 0 ? rawOut.slice(0, sep) : rawOut;
  const body = sep >= 0 ? rawOut.slice(sep + 4) : '';

  // BD 侧错误（鉴权/欠费/限额）：取 BD 自身 HTTP 状态码（最后一个 HTTP/1.1 NNN）
  const allHttp = [...headerPart.matchAll(/HTTP\/1\.1\s+(\d{3})/gi)];
  const bdStatus = allHttp.length ? parseInt(allHttp[allHttp.length - 1][1], 10) : 502;
  // 静默失败会导致上层只看到 502 而无从定位（回采曾因此长期空转），此处必留诊断痕迹
  console.warn(`[bd-unlocker] BD 侧错误 status=${bdStatus} url=${String(url).slice(0, 90)}`);
  console.warn(`[bd-unlocker] 响应片段: ${String(rawOut).slice(0, 300).replace(/\r?\n/g, ' | ')}`);
  return new Response(body || JSON.stringify({ error: 'bd_side_error', status: bdStatus }), {
    status: bdStatus,
    headers: { 'content-type': 'application/json' },
  });
}

/** 统一入口：解析 bdunlocker:// 并调用桥 */
async function _viaUnlocker(url, opts, bdUrl) {
  const m = bdUrl.match(BD_UNLOCKER_RE);
  const zone = m[1];
  const apiKey = m[2];
  const fetchOpts = { ...opts };
  let controller = null;
  if (!fetchOpts.signal) {
    controller = new AbortController();
    fetchOpts.signal = controller.signal;
  }
  const timer = setTimeout(() => { if (controller) controller.abort(); }, opts.timeout || DEFAULT_TIMEOUT_MS);
  try {
    return await fetchViaBrightDataUnlocker(url, fetchOpts, zone, apiKey, controller);
  } finally {
    clearTimeout(timer);
  }
}

// ── 死出口熔断（2026-10-09）─────────────────────────────────────────────
// 背景：出口代理池可能只剩少数几条，且其中一条已死（如36.137.204.11:8002
//   实测 http=000 / 超时 20s）。而 fetchExt 的单代理路径是「失败即抛」，
//   于是这一个死代理会让**所有**经它出网的请求全灭 —— post-metrics 互动回收
//   表现为 "fetch failed"，看起来像网络故障，实际是单点代理死亡。
// 修法：给每个显式 proxyUrl 记失败账；连续失败达阈值即对该出口熔断，
//   后续请求直接改走全局代理（HTTP(S)_PROXY，通常是本机常驻出口），
//   并在日志里显式告警 —— 保证「单点故障不扩散」且错误可归因。
const _DEAD_PROXY_FAILS = new Map();   // proxyUrl -> 连续失败次数
const _DEAD_PROXY_UNTIL = new Map();  // proxyUrl -> 熔断截止时间戳
const PROXY_CIRCUIT_THRESHOLD = Number(process.env.MSCMS_PROXY_CIRCUIT_THRESHOLD || 2);
const PROXY_CIRCUIT_COOLDOWN_MS = Number(process.env.MSCMS_PROXY_CIRCUIT_COOLDOWN_MS || 5 * 60 * 1000);
// 熔断表硬上限（2026-10-12 P0-5）：免费代理池（tools/free-proxy-pool.js）会持续轮换出
//   成千上万个无效出口，这两个 Map 若不加约束同样是慢泄漏。上限内按插入序淘汰最旧。
const PROXY_CIRCUIT_MAX = Math.max(64, Number(process.env.MSCMS_PROXY_CIRCUIT_MAX || 4096));

function _proxyCircuitOpen(proxyUrl) {
  const until = _DEAD_PROXY_UNTIL.get(proxyUrl) || 0;
  return Date.now() < until;
}

// ── 熔断日志限流（2026-10-12 P0-5）──────────────────────────────────────
// 背景：本实例 79,332 行日志里有 23,664 行（29.8%）都是同一句
//   `[proxy-circuit] ⛔ 出口 X 连续失败 2 次 → 熔断 5 分钟`，涉及 3,767 个出口。
//   真故障（MySQL 断连 / 语法错 / 出口全灭）会被彻底淹没 —— 这正是 10-10「宕机
//   10.3h 无人定位」的同一个坑。故保留 `[proxy-circuit]` 前缀（既有 grep 不受影响），
//   但改成「窗口内前 N 条逐条 + 其余聚合成一条汇总」，信号不丢、噪声降 95%+。
const CIRCUIT_LOG_WINDOW_MS = Number(process.env.MSCMS_CIRCUIT_LOG_WINDOW_MS || 5 * 60 * 1000);
const CIRCUIT_LOG_BUDGET = Number(process.env.MSCMS_CIRCUIT_LOG_BUDGET || 40);
let _circuitWinStart = Date.now(), _circuitWinCount = 0, _circuitSuppressed = 0, _circuitTotal = 0;

function _circuitLog(proxyUrl, n) {
  _circuitTotal++;
  const now = Date.now();
  if (now - _circuitWinStart >= CIRCUIT_LOG_WINDOW_MS) {
    if (_circuitSuppressed > 0) {
      console.warn(`[proxy-circuit] （上一 ${Math.round(CIRCUIT_LOG_WINDOW_MS / 60000)}min 窗口另有 ${_circuitSuppressed} 次熔断已聚合，累计 ${_circuitTotal} 次）`);
    }
    _circuitWinStart = now; _circuitWinCount = 0; _circuitSuppressed = 0;
  }
  if (_circuitWinCount < CIRCUIT_LOG_BUDGET) {
    _circuitWinCount++;
    console.warn(`[proxy-circuit] ⛔ 出口 ${proxyUrl} 连续失败 ${n} 次 → 熔断 ${Math.round(PROXY_CIRCUIT_COOLDOWN_MS / 60000)} 分钟，改走全局代理`);
  } else {
    _circuitSuppressed++;
  }
}

function _noteProxyFail(proxyUrl) {
  const n = (_DEAD_PROXY_FAILS.get(proxyUrl) || 0) + 1;
  _DEAD_PROXY_FAILS.set(proxyUrl, n);
  if (n >= PROXY_CIRCUIT_THRESHOLD && !_proxyCircuitOpen(proxyUrl)) {
    _DEAD_PROXY_UNTIL.set(proxyUrl, Date.now() + PROXY_CIRCUIT_COOLDOWN_MS);
    _DEAD_PROXY_FAILS.set(proxyUrl, 0);
    // 2026-10-12 P0-5：判定死亡的出口立刻释放它占用的 undici Agent
    //   —— 这是 3.9GB RSS 的主要来源，死出口没有任何理由继续占坑。
    _evictAgent(proxyUrl);
    _circuitLog(proxyUrl, n);
    if (_DEAD_PROXY_UNTIL.size > PROXY_CIRCUIT_MAX) {
      const k = _DEAD_PROXY_UNTIL.keys().next().value;
      if (k !== undefined) { _DEAD_PROXY_UNTIL.delete(k); _DEAD_PROXY_FAILS.delete(k); }
    }
  }
}
// 成功即删键（旧实现只把值写成 0、键永久保留 ⇒ 3,767 个出口 = 3,767 个常驻键）
function _noteProxyOk(proxyUrl) { _DEAD_PROXY_FAILS.delete(proxyUrl); }

// ── 后台回收器（2026-10-12 P0-5）────────────────────────────────────────
// ① 硬 destroy 已 graceful close 的 Agent（兜住「socket 卡死 ⇒ close() 永不 settle」）
// ② 清掉过期熔断项与归零计数，把两张表钉在真实规模上
// ③ 输出可观测量，让「修复是否生效」可被机器判定（而不是靠感觉）
const REAP_MS = Math.max(100, Number(process.env.MSCMS_AGENT_REAP_MS || 15000));
const DIAG_EVERY_TICKS = Math.max(1, Math.round(Number(process.env.MSCMS_AGENT_DIAG_MS || 20 * 60 * 1000) / REAP_MS));
// P0-5c（2026-10-13）：启动后前 DENSE_FOR_MS 内改用 DENSE_EVERY_MS 的加密节奏打点。
//   原因：RSS/heap 是 V8 锯齿（实测 879MB → 608MB 一分钟内回落），20min 粒度两点算不出斜率；
//   而「是否收敛」只有在冷启动窗口里才看得清。窗口过后自动回到 20min 稳态节奏。
const DENSE_FOR_MS = Math.max(0, Number(process.env.MSCMS_AGENT_DIAG_DENSE_FOR_MS || 30 * 60 * 1000));
const DENSE_TICKS = Math.max(1, Math.round(Number(process.env.MSCMS_AGENT_DIAG_DENSE_EVERY_MS || 2 * 60 * 1000) / REAP_MS));
const _BOOT_AT = Date.now();
let _diagTicks = 0;
// 外部注入的「集合规模探针」：http-client 不该知道 DataStore / proxy-pool 的存在，
//   故由 server.js 通过 setDiagExtra(fn) 反向注册，返回一段附加文本（或 null）。
let _diagExtra = null;
function setDiagExtra(fn) { _diagExtra = (typeof fn === 'function') ? fn : null; }
function _reapNow() {
  const now = Date.now();
  for (let i = _retiring.length - 1; i >= 0; i--) {
    if (_retiring[i].dueAt <= now) { _hardDestroy(_retiring[i].a); _retiring.splice(i, 1); }
  }
  for (const k of [..._DEAD_PROXY_UNTIL.keys()]) if ((_DEAD_PROXY_UNTIL.get(k) || 0) <= now) _DEAD_PROXY_UNTIL.delete(k);
  for (const k of [..._DEAD_PROXY_FAILS.keys()]) if (!_DEAD_PROXY_FAILS.get(k)) _DEAD_PROXY_FAILS.delete(k);
  _diagTicks++;
  const _dense = (now - _BOOT_AT) < DENSE_FOR_MS;
  const _every = _dense ? DENSE_TICKS : DIAG_EVERY_TICKS;
  if (_diagTicks % _every !== 0) return;
  // P0-5b（2026-10-13）：诊断行加入真实内存构成 —— 只报 Map 大小无法解释
  //   「size 恒 ≤24 但 RSS 仍涨到 3.9GB」。heapUsed 增长 ⇒ JS 对象泄漏（查 Map/闭包）；
  //   external/arrayBuffers 增长 ⇒ undici socket/buffer 未归还（查 agent destroy 路径）。
  const _mu = process.memoryUsage();
  const _mb = (x) => Math.round((x || 0) / 1048576);
  let _extra = '';
  if (_diagExtra) {
    try { const r = _diagExtra(); if (r) _extra = ` | ${r}`; }
    catch (e) { _extra = ` | extra-error=${e.message}`; }
  }
  const _upMin = ((now - _BOOT_AT) / 60000).toFixed(1);
  console.log(`[http-client] agent缓存 size=${_agentCache.size}/${MAX_PROXY_AGENTS === Infinity ? '∞' : MAX_PROXY_AGENTS} created=${_agentCreated} retired=${_agentRetired} 待硬销毁=${_retiring.length} 熔断表=${_DEAD_PROXY_UNTIL.size} 熔断累计=${_circuitTotal} | up=${_upMin}min rss=${_mb(_mu.rss)}MB heapUsed=${_mb(_mu.heapUsed)}MB heapTotal=${_mb(_mu.heapTotal)}MB external=${_mb(_mu.external)}MB arrayBuffers=${_mb(_mu.arrayBuffers)}MB${_extra}`);
}
const _reapTimer = setInterval(_reapNow, REAP_MS);
if (typeof _reapTimer.unref === 'function') _reapTimer.unref();

async function fetchExt(url, opts = {}, proxyUrl) {
  // ⛔ 熔断中的出口直接跳过，不再浪费 20s 超时。
  //    ⚠️ 2026-10-13 注意：这会把「经该出口」静默变成「经全局代理」——
  //    用于健康检查时会让探针张口说谎（测的不是那个出口）。运维探针须传
  //    `opts.bypassCircuit = true` 才能拿到该出口的真实结论。
  const _bypassCircuit = opts.bypassCircuit === true;
  if (_bypassCircuit) delete opts.bypassCircuit;
  if (proxyUrl && !_bypassCircuit && !BD_UNLOCKER_RE.test(proxyUrl) && _proxyCircuitOpen(proxyUrl)) {
    proxyUrl = null;   // 回落全局代理
  }
  // ① 显式指定 bdunlocker 出口
  if (proxyUrl && BD_UNLOCKER_RE.test(proxyUrl)) {
    return _viaUnlocker(url, opts, proxyUrl);
  }
  // ② 自动路由：*.tumblr.com 的【只读请求】经住宅 REST 桥（根除单 IP 429），非 tumblr 不受影响。
  //    仅 GET/HEAD 走桥：Unlocker 无法中继 POST body，养号/发布等写操作必须继续走现有出口。
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  if (_unlocker && typeof url === 'string' && /tumblr\.com/i.test(url) && (method === 'GET' || method === 'HEAD')) {
    const viaBr = await _viaUnlocker(url, opts, `bdunlocker://${_unlocker.zone}:${_unlocker.apiKey}`);
    // 桥返回 5xx（BD 侧故障/配额/zone 异常）时回落直连，避免上层拿到空 body 无从处理
    if (viaBr.status < 500) return viaBr;
    console.warn(`[bd-unlocker] 桥返回 ${viaBr.status}，回落直连: ${String(url).slice(0, 80)}`);
  }
  const agent = _agentFor(proxyUrl);
  const fetchOpts = { ...opts };
  let controller = null;
  if (!fetchOpts.signal) {
    controller = new AbortController();
    fetchOpts.signal = controller.signal;
  }
  const timer = setTimeout(() => { if (controller) controller.abort(); }, opts.timeout || DEFAULT_TIMEOUT_MS);
  const _usedPx = proxyUrl;   // 记录本次真实使用的出口（可能已回落为 null）
  try {
    let _r;
    if (agent) _r = await undiciFetch(url, { ...fetchOpts, dispatcher: agent });
    else _r = await undiciFetch(url, fetchOpts);
    if (_usedPx) _noteProxyOk(_usedPx);
    return _r;
  } catch (e) {
    if (_usedPx) _noteProxyFail(_usedPx);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检测外部主机是否可达（用于系统自检 / UI 状态灯）
 */
async function ping(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchExt(url, { method: 'GET', signal: ctrl.signal, headers: { 'User-Agent': 'MSCMS/1.0' } });
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchExt, ping, proxyUrl: proxy, hasProxy: !!proxyAgent, setDiagExtra, isProxyCircuitOpen: _proxyCircuitOpen };
