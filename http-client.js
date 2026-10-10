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
const _agentCache = new Map();
function _agentFor(proxyUrl) {
  if (!proxyUrl) return proxyAgent;
  if (_agentCache.has(proxyUrl)) return _agentCache.get(proxyUrl);
  try {
    const a = new ProxyAgent(proxyUrl);
    _agentCache.set(proxyUrl, a);
    return a;
  } catch (e) {
    console.error(`[http-client] 代理 ${proxyUrl} 初始化失败，回退全局代理:`, e.message);
    return proxyAgent;
  }
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

async function fetchExt(url, opts = {}, proxyUrl) {
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
  try {
    if (agent) return await undiciFetch(url, { ...fetchOpts, dispatcher: agent });
    return await undiciFetch(url, fetchOpts);
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

module.exports = { fetchExt, ping, proxyUrl: proxy, hasProxy: !!proxyAgent };
