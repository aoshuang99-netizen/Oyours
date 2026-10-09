/**
 * client-runner.js — Playwright 浏览器防关联矩阵脚本
 *
 * 职责：
 *   1. 代理 IP 地理反查（ip-api.com）→ 动态对齐 timezone / locale / geolocation
 *   2. 阻断 WebRTC，防止 UDP 泄漏本地真实 IP
 *   3. Canvas 感知哈希混淆 → 全网唯一硬件指纹伪装
 *   4. Cookie JSON 热启动 + 滚动持久化
 *   5. 支持单账号 / 批量矩阵执行
 *
 * 用法：
 *   node client-runner.js --bot-id=bot_01 --=X --proxy=http://user:pass@ip:port
 *   node client-runner.js --batch=.json
 */

const { chromium } = require('playwright-core');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// ── 常量 ─────────────────────────────────────────────────
const COOKIE_DIR = path.resolve(process.env.COOKIE_DIR || './cookies');
const PROFILE_DIR = path.resolve(process.env.PROFILE_DIR || './profiles');  // DD.txt: 持久化 profile
const GEO_CACHE_TTL = 3600_000; // 地理位置缓存 1 小时

// ── 工具：日志 ───────────────────────────────────────────
const log = (botId, msg) => {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`[${ts}] [${botId || 'init'}] ${msg}`);
};

// ══════════════════════════════════════════════════════════
//  1. 地理位置反查器
// ══════════════════════════════════════════════════════════

const geoCache = new Map();

/**
 * 通过代理出口 IP 反查精确地理位置
 * @param {string} proxyServer - 代理 URL（如 http://user:pass@1.2.3.4:8080）
 * @returns {Promise<{country, countryCode, timezone, lat, lng, locale}>
 */
async  resolveGeo(proxyServer) {
  const cacheKey = proxyServer || 'direct';

  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) return cached.data;

  const axiosOpts = { timeout: 8000 };
  if (proxyServer) {
    axiosOpts.proxy = {
      protocol: 'http',
      host: new URL(proxyServer).hostname,
      port: parseInt(new URL(proxyServer).port, 10),
    };
  }

  try {
    const { data } = await axios.get('http://ip-api.com/json/?fields=status,country,countryCode,timezone,lat,lon', axiosOpts);
    if (data.status !== 'success') throw new Error(`ip-api: ${data.message || 'fail'}`);

    // 根据国家映射 locale
    const localeMap = {
      US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU',
      CN: 'zh-CN', JP: 'ja-JP', KR: 'ko-KR', DE: 'de-DE',
      FR: 'fr-FR', BR: 'pt-BR', ES: 'es-ES', IT: 'it-IT',
      IN: 'en-IN', NL: 'nl-NL', SE: 'sv-SE',
    };

    const geo = {
      country: data.country,
      countryCode: data.countryCode,
      timezone: data.timezone,
      lat: data.lat,
      lng: data.lon,
      locale: localeMap[data.countryCode] || 'en-US',
    };

    geoCache.set(cacheKey, { data: geo, ts: Date.now() });
    return geo;
  } catch (err) {
    log('geo', `ip-api failed: ${err.message}, fallback to US`);
    return { country: 'United States', countryCode: 'US', timezone: 'America/New_York', lat: 40.7128, lng: -74.006, locale: 'en-US' };
  }
}

// ══════════════════════════════════════════════════════════
//  2. Canvas 感知哈希混淆注入
// ══════════════════════════════════════════════════════════

/**
 * 构建 Canvas 混淆注入脚本（在页面初始化前执行）
 *
 * 劫持 toDataURL / toBlob，对像素矩阵施加极微弱扰动：
 *   - 随机选取 3~8 个像素偏移 ±1（肉眼不可见）
 *   - 在 Alpha 通道最低位嵌入哈希签名
 *   - 每次调用都产生不同扰动，生成全网唯一指纹
 */
 buildCanvasNoiseScript() {
  return `
(() {
  'use strict';
  if (window.__canvas_noised) return;
  window.__canvas_noised = true;

  // 基于 session 的随机种子（同一次启动内保持一致，跨启动变化）
  const SEED = Date.now() ^ (Math.random() * 0xFFFFFFFF >>> 0);
  let callCount = 0;

   pseudoRandom(seed) {
    let s = seed;
    return () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }
  const rng = pseudoRandom(SEED);

  // ── 注入噪点到 ImageData ──
   injectNoise(imageData) {
    const d = imageData.data;
    const len = d.length;
    const noisePoints = 3 + Math.floor(rng() * 6); // 3~8 个扰动点

    for (let i = 0; i < noisePoints; i++) {
      const idx = (Math.floor(rng() * (len / 4)) * 4);
      const channel = Math.floor(rng() * 3); // R/G/B
      const offset = (rng() < 0.5) ? 1 : -1;
      const val = d[idx + channel] + offset;
      d[idx + channel] = Math.max(0, Math.min(255, val));
    }

    // Alpha 通道 LSB 嵌入签名
    const sig = (SEED & 0xFF) ^ (callCount & 0xFF);
    for (let i = 3; i < len; i += 16) {
      const lsb = ((i / 4) & 1) ? ((sig >> 3) & 1) : (sig & 1);
      d[i] = (d[i] & 0xFE) | lsb;
    }
  }

  // ── 劫持 getImageData ──
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = (sx, sy, sw, sh, settings) {
    const result = origGetImageData.call(this, sx, sy, sw, sh, settings);
    callCount++;
    injectNoise(result);
    return result;
  };

  // ── 劫持 toDataURL ──
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = (type, quality) {
    const ctx = this.getContext('2d', { willReadFrequently: true });
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        callCount++;
        injectNoise(imageData);
        ctx.putImageData(imageData, 0, 0);
      } catch (e) { /* cross-origin — 静默跳过 */ }
    }
    return origToDataURL.call(this, type, quality);
  };

  // ── 劫持 toBlob ──
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = (callback, type, quality) {
    const ctx = this.getContext('2d', { willReadFrequently: true });
    if (ctx && this.width > 0 && this.height > 0) {
      try {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        callCount++;
        injectNoise(imageData);
        ctx.putImageData(imageData, 0, 0);
      } catch (e) { /* cross-origin — 静默跳过 */ }
    }
    return origToBlob.call(this, callback, type, quality);
  };

  // ── 劫持 OffscreenCanvas (Web Worker 中) ──
  if (typeof OffscreenCanvas !== 'undefined') {
    const origOffToBlob = OffscreenCanvas.prototype.convertToBlob;
    if (origOffToBlob) {
      OffscreenCanvas.prototype.convertToBlob = (options) {
        return origOffToBlob.call(this, options);
      };
    }
  }
})();
`;
}

// ══════════════════════════════════════════════════════════
//  3. WebRTC 阻断注入
// ══════════════════════════════════════════════════════════

/**
 * 构建 WebRTC 阻断脚本：
 *   - 删除 RTCPeerConnection 构造函数
 *   - 拦截 navigator.mediaDevices 枚举
 *   - 防止 UDP STUN 泄漏真实 IP
 */
 buildWebRTCBlocker() {
  return `
(() {
  'use strict';
  if (window.__webrtc_blocked) return;
  window.__webrtc_blocked = true;

  // 阻断 RTCPeerConnection
  const noop = () { throw new DOMException('WebRTC is disabled', 'NotAllowedError'); };
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'].forEach((name) {
    try { Object.defineProperty(window, name, { value: noop, writable: false, configurable: false }); } catch(e) {}
  });

  // 阻断 mediaDevices
  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: noop,
        enumerateDevices: () { return Promise.resolve([]); },
        getDisplayMedia: noop,
      },
      writable: false, configurable: false,
    });
  } catch(e) {}
})();
`;
}

// ══════════════════════════════════════════════════════════
//  4. Cookie 读写管理
// ══════════════════════════════════════════════════════════

/**
 * 获取 bot 的 cookie 文件路径
 */
 cookiePath(botId) {
  return path.join(COOKIE_DIR, `${botId}.json`);
}

/**
 * 从本地 JSON 文件加载 cookie
 * @returns {Promise<Array|null>} cookie 数组或 null
 */
async  loadCookies(botId) {
  const fp = cookiePath(botId);
  try {
    const raw = await fsp.readFile(fp, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      log(botId, 'cookie file empty, cold start');
      return null;
    }
    log(botId, `loaded ${cookies.length} cookies from cache`);
    return cookies;
  } catch (err) {
    if (err.code !== 'ENOENT') log(botId, `cookie load error: ${err.message}`);
    return null;
  }
}

/**
 * 提取当前页面所有 cookie 并写入本地 JSON
 */
async  saveCookies(botId, context) {
  const cookies = await context.cookies();
  const fp = cookiePath(botId);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await fsp.writeFile(fp, JSON.stringify(cookies, null, 2), 'utf-8');
  log(botId, `saved ${cookies.length} cookies → ${fp}`);
  return cookies;
}

// ══════════════════════════════════════════════════════════
//  5. 浏览器启动：全防关联上下文
// ══════════════════════════════════════════════════════════

/**
 * 创建防关联浏览器上下文
 *
 * @param {object} opts
 * @param {string} opts.botId      - 账号 ID
 * @param {string} opts.   - X / Reddit / Instagram / TikTok
 * @param {string} opts.proxyServer - 代理地址
 * @param {object} [opts.viewport] - 视口（默认随机选取常见分辨率）
 * @returns {Promise<{browser, context, page, geo}>}
 */
async  createAntiFingerprintContext(opts = {}) {
  const { botId = 'default',  = 'X', proxyServer } = opts;

  // ── 1. 地理反查 ──
  const geo = await resolveGeo(proxyServer);
  log(botId, `geo → ${geo.countryCode}/${geo.timezone} (${geo.lat.toFixed(2)},${geo.lng.toFixed(2)})`);

  // ── 2. 随机视口（避免固定分辨率指纹） ──
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 1680, height: 1050 },
  ];
  const viewport = opts.viewport || viewports[crypto.randomInt(0, viewports.length)];

  // ── 3. 随机  ──
  const userAgents = {
    X: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Reddit: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    TikTok: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
  };

  // ── 4. 构建 launch 参数 ──
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    `--window-size=${viewport.width},${viewport.height}`,
    // 阻止 WebRTC 的 IP 处理策略
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--enforce-webrtc-ip-permission-check',
    // 伪装音频输入设备数量
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ];

  // 代理
  if (proxyServer) {
    launchArgs.push(`--proxy-server=${proxyServer}`);
    // 强制代理绕过列表为空
    launchArgs.push('--proxy-bypass-list=<-loopback>');
  }

  // ── 5. 持久化 Profile 路径（DD.txt: profiles/_${botId}） ──
  const userDataDir = path.join(PROFILE_DIR, `_${botId}`);
  await fsp.mkdir(userDataDir, { recursive: true });

  // ── 6. 构建 PersistentContext 参数 ──
  const contextOpts = {
    viewport,
    userAgent: userAgents[] || userAgents.X,
    locale: geo.locale,
    timezoneId: geo.timezone,
    geolocation: { latitude: geo.lat, longitude: geo.lng },
    permissions: ['geolocation'],
    colorScheme: 'light',
    deviceScaleFactor: 1,
    isMobile:  === 'Instagram' ||  === 'TikTok',
    hasTouch:  === 'Instagram' ||  === 'TikTok',
    headless: false,
    args: launchArgs,
    ignoreDefaultArgs: ['--enable-'],
    extraHTTPHeaders: {
      'Accept-Language': geo.locale.replace('_', '-') + ',en;q=0.9',
    },
    // 绕过 HTTPS 证书错误（代理环境常见）
    ignoreHTTPSErrors: !!proxyServer,
  };

  // 代理认证
  if (proxyServer) {
    const  = new URL(proxyServer);
    contextOpts.proxy = {
      server: `${.protocol}//${.hostname}:${.port}`,
    };
    if (.) {
      contextOpts.proxy. = .;
      contextOpts.proxy. = . || '';
    }
  }

  // ── 7. launchPersistentContext（DD.txt 标准） ──
  log(botId, `launching persistent context → ${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, contextOpts);

  // 从 persistent context 获取 browser 引用（用于关闭）
  // 注：launchPersistentContext 直接返回 BrowserContext，Browser 隐藏在内

  // ── 8. 注入 WebRTC 阻断 ──
  await context.addInitScript(buildWebRTCBlocker());

  // ── 9. 注入 Canvas 混淆 ──
  await context.addInitScript(buildCanvasNoiseScript());

  // ── 10. 移除 webdriver 标记 ──
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {}, loadTimes: () {}, csi: () {}, app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // ── 11. Cookie 热启动（JSON 快照备份，persistent context 自带但双保险） ──
  const cachedCookies = await loadCookies(botId);
  if (cachedCookies) {
    await context.addCookies(cachedCookies);
    log(botId, 'hot start: injected cached cookies');
  } else {
    log(botId, 'cold start — profile may contain session from previous run');
  }

  // ── 12. 创建页面 ──
  const page = await context.newPage();

  // 监听新页面（弹窗等），同步注入
  context.on('page', async (newPage) => {
    await newPage.addInitScript(buildWebRTCBlocker());
    await newPage.addInitScript(buildCanvasNoiseScript());
  });

  log(botId, `context ready — ${viewport.width}x${viewport.height}, ${geo.locale}, ${geo.timezone}`);

  return { context, page, geo, userDataDir };
}

// ══════════════════════════════════════════════════════════
//  6. 单账号任务执行器
// ══════════════════════════════════════════════════════════

/**
 * 运行单个 bot 的标准任务
 * @param {object} account
 * @param {string} account.botId
 * @param {string} account.
 * @param {string} account.proxyServer
 * @param {string} [account.targetUrl] - 目标页面 URL
 * @param {number} [account.dwellMs]   - 驻留时间 (ms)
 */
async  runSingleBot(account) {
  const { botId, , proxyServer, targetUrl, dwellMs = 30_000 } = account;
  log(botId, `=== START () ===`);

  let context;
  try {
    const ctx = await createAntiFingerprintContext({ botId, , proxyServer });
    context = ctx.context;
    const page = ctx.page;

    // 导航到目标页面
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      log(botId, `navigated to ${targetUrl}`);
    }

    // 模拟人类行为：滚动、停顿
    await page.evaluate(() => {
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      return (async () => {
        for (let i = 0; i < 3; i++) {
          window.scrollBy(0, 300 + Math.random() * 500);
          await delay(800 + Math.random() * 1200);
        }
      })();
    });
    log(botId, 'simulated human scroll');

    // 驻留
    log(botId, `dwelling ${dwellMs}ms...`);
    await new Promise((r) => setTimeout(r, dwellMs));

    // ── 保存 Cookie（JSON 快照 + 持久化 profile 双保险） ──
    await saveCookies(botId, context);

    log(botId, `=== DONE (profile: ${ctx.userDataDir}) ===`);
    return { success: true, botId, userDataDir: ctx.userDataDir };
  } catch (err) {
    log(botId, `ERROR: ${err.message}`);
    return { success: false, botId, error: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════
//  7. 批量矩阵执行器
// ══════════════════════════════════════════════════════════

/**
 * 批量执行多个 bot 账号（并发上限可配）
 */
async  runBatch(, concurrency = 2) {
  const results = [];
  const queue = [...];

  async  worker() {
    while (queue.length > 0) {
      const account = queue.shift();
      if (!account) break;
      const result = await runSingleBot(account);
      results.push(result);
      // 间隔 3~8 秒，避免同 IP 并发过高
      await new Promise((r) => setTimeout(r, 3000 + crypto.randomInt(0, 5000)));
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const ok = results.filter((r) => r.success;
  console.log(`\n=== BATCH COMPLETE: ${ok}/${results.length} OK ===`);
  return results;
}

// ══════════════════════════════════════════════════════════
//  8. CLI 入口
// ══════════════════════════════════════════════════════════

async  main() {
  const args = process.argv.slice(2);
  const getArg = (key) => {
    const found = args.find((a) => a.startsWith(`--${key}=`));
    return found ? found.split('=')[1] : null;
  };

  const botId = getArg('bot-id');
  const  = getArg('') || 'X';
  const proxy = getArg('proxy');
  const target = getArg('target');
  const batchFile = getArg('batch');
  const dwell = parseInt(getArg('dwell') || '30000', 10);

  // 确保 cookie 目录存在
  await fsp.mkdir(COOKIE_DIR, { recursive: true });

  if (batchFile) {
    // 批量模式
    const raw = await fsp.readFile(batchFile, 'utf-8');
    const  = JSON.parse(raw);
    if (!Array.isArray()) throw new Error('batch file must be JSON array');
    log('batch', `loaded ${.length}  from ${batchFile}`);
    await runBatch();
  } else if (botId) {
    // 单账号模式
    await runSingleBot({ botId, , proxyServer: proxy, targetUrl: target, dwellMs: dwell });
  } else {
    console.log(`
Usage:
  node client-runner.js --bot-id=BOT01 --=X --proxy=http://user:pass@ip:port [--target=https://...] [--dwell=30000]
  node client-runner.js --batch=.json

Batch file format (JSON array):
  [
    { "botId": "bot_01", "": "X",      "proxyServer": "http://user:pass@1.2.3.4:8080" },
    { "botId": "bot_02", "": "Reddit", "proxyServer": "http://user:pass@5.6.7.8:8080" }
  ]
`);
  }
}

// 仅直接运行时执行 CLI，require 时不触发
if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}

module.exports = {
  createAntiFingerprintContext,
  runSingleBot,
  runBatch,
  resolveGeo,
  loadCookies,
  saveCookies,
};
