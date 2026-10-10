'use strict';
/**
 * tumblr-nurture-device.js — 养号「移动端」设备池（系统内云手机之外的独立网页移动池）
 *
 * 目的（用户指令：养号模拟必须在系统内的移动端上进行操作）：
 *  - 为养号账号各自建立一个【真实 chromium 移动上下文】，携带【唯一移动指纹】
 *    （UA / 视口 / deviceScaleFactor / 触摸 / 时区 / locale / 代理）。
 *  - 每个 tick 在「消费阶段」打开该账号的移动 tumblr 网页，执行【真实移动端消费行为】：
 *      滚 explore 信息流 → 浏览 dating/relationship 标签 → 读几条帖子 → 看自己博客（公开）。
 *  - 这些浏览都走系统统一代理，且与 OAuth API 共用同一移动 UA（指纹对齐，反关联）。
 *
 * 铁律：
 *  - 零假数据：所有浏览都是真实页面加载（真实流量），失败如实记录，绝不伪造「已登录/已互动」。
 *  - 不伪造登录态：设备池没有 tumblr 会话 cookie，只做【公开移动网页消费】，不声称以账号登录。
 *  - 隔离线上 50 云手机：本池是独立的移动网页会话，完全不影响生产云手机因果链。
 *  - 默认关闭：仅当 TUMBLR_NURTURE_DEVICE=1 时由服务实例化并启动。
 *
 * ⚠️ 关键架构约束（2026-08-21 修复）：
 *  单代理(10808)出口 + 多账号。早期实现把 N 个 Chromium 浏览器【常驻】，即便无会话也通过
 *  单代理保持上百条 keep-alive 连接 → 挤垮同一出口，导致 OAuth API 循环全面 fetch failed / CONNECT hung。
 *  现改为【浏览器按需临时启动、会话结束即关闭】：空闲时设备池在代理上【零连接】，API 养号循环
 *  独占代理出口，互不干扰。每次会话只短暂占用 ~1 个浏览器实例（受引擎 Semaphore(1) 串行）。
 */

const { chromium } = require('playwright-core');
const { getMobileEmulator, MOBILE_DEVICES } = require('./mobile-emulator.js');

// ── 确定性设备分配（按 accountId 播种，重启一致，避免每次随机换设备被关联） ──
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// tzOffset(-5..3) → IANA 时区（让移动网页时区与 persona 活跃窗口一致）
const TZ_BY_OFFSET = {
  '-5': 'America/New_York', '-4': 'America/New_York', '-3': 'America/Sao_Paulo',
  '-2': 'America/Sao_Paulo', '-1': 'Atlantic/Azores', '0': 'Europe/London',
  '1': 'Europe/Paris', '2': 'Europe/Athens', '3': 'Europe/Moscow',
};

// 消费阶段要浏览的标签（与养号赛道一致：生活 & 交友）
const CONSUME_TAGS = ['dating', 'relationships', 'relationshipadvice', 'tumblrrelationships', 'datingadvice', 'selflove', 'breakup'];

class MobileDevicePool {
  constructor(opts = {}) {
    this.emulator = getMobileEmulator();
    // ⚠️ 不再常驻任何浏览器实例。this.browsers 仅保留为空数组以兼容旧快照字段；
    //    真正的浏览器在 openSession 内临时启动、会话后关闭。
    this.browsers = [];
    // 真正在途（已 launch 未 close）的浏览器集合——用于快照展示「当前活跃浏览器数」。
    this._activeBrowsers = new Set();
    // 轻量常驻映射：accountId -> { ua, device, proxy, browserIdx }（供 API 指纹对齐 + 会话按需建上下文）。
    this._uaByAccount = new Map();
    this.proxy = opts.proxy || process.env.TUMBLR_NURTURE_PROXY || 'http://127.0.0.1:10808';
    // 代理池：传入多个出口 IP 即可让不同账号走不同 IP（缓解 429 共享 IP 问题）
    this.proxies = (opts.proxies && opts.proxies.length) ? opts.proxies : [this.proxy];
    this.perBrowserMax = opts.perBrowserMax || opts.maxContexts || 12; // 兼容旧字段
    this.maxBrowsers = opts.maxBrowsers || 4;                          // 最大并发会话浏览器数（仅限流用）
    this.maxContexts = this.perBrowserMax * this.maxBrowsers;          // 等效总容量（兼容旧字段）
    this.dataStore = opts.dataStore || null;
    this.launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--force-effective-connection-type=4G',
    ];
    this.enabled = false;     // 能力是否可用（playwright 可启动 + 未因错永久禁用）
    this.disabled = false;    // 是否因启动/运行错误被禁用（禁用后纯 API 养号仍可用）
    this.disableReason = null;
    this._sessionInFlight = new Set();
  }

  /**
   * 能力自检：临时启动一个浏览器并立即关闭，确认 playwright 可用 + 代理配置合法。
   * 不持有任何常驻连接（空闲时代理零占用）。失败则标记 disabled 并返回 false。
   */
  async launch() {
    if (this.disabled) return false;
    let b = null;
    try {
      b = await chromium.launch({ headless: true, args: this.launchArgs });
      this.enabled = true; this.disabled = false; this.disableReason = null;
      return true;
    } catch (e) {
      this.disableReason = 'launch-failed: ' + e.message;
      this.disabled = true; this.enabled = false;
      return false;
    } finally {
      if (b) { try { await b.close(); } catch (_) {} }
    }
  }

  _pickDevice(accountId) {
    const list = Object.values(MOBILE_DEVICES);
    const idx = hashStr(accountId) % list.length;
    return list[idx];
  }

  // 确定性代理选择（按 accountId 播种，分散到代理池；单代理时全部走 10808）
  _pickProxy(accountId) {
    return this.proxies[hashStr(accountId + ':px') % this.proxies.length];
  }

  /**
   * 为某账号分配（或取回）移动设备指纹 + 出口代理（常驻轻量映射，供 API 指纹对齐 + 会话按需建上下文）。
   * 不启动任何浏览器——纯内存映射，零代理连接。
   * @param {string} accountId
   * @param {object} overrides { tzOffset, locale }
   */
  async assignDevice(accountId, overrides = {}) {
    if (this.disabled) return null;
    // 已记录指纹的账号直接返回（幂等，避免重复分配；设备型号确定性分配，不换设备）
    if (this._uaByAccount.has(accountId)) return this._uaByAccount.get(accountId);
    if (!this.enabled) {
      // 尚未自检：先做一次能力自检（不持有连接）
      const ok = await this.launch();
      if (!ok) return null;
    }
    const device = this._pickDevice(accountId);
    const proxy = this._pickProxy(accountId);
    const tz = TZ_BY_OFFSET[String(overrides.tzOffset != null ? overrides.tzOffset : 0)] || 'America/New_York';
    // browserIdx 仅用于指纹稳定性展示/分片标识（不影响临时浏览器生命周期）
    const browserIdx = hashStr(accountId + ':bi') % Math.max(1, this.maxBrowsers);
    const entry = {
      accountId, device, ua: device.userAgent,
      proxy, tz, locale: overrides.locale || 'en-US',
      browserIdx, sessions: 0, lastError: null, lastUsedAt: Date.now(), lastSessionAt: null,
    };
    this._uaByAccount.set(accountId, entry);
    return entry;
  }

  getDevice(accountId) { return this._uaByAccount.get(accountId) || null; }
  getUA(accountId) { const e = this._uaByAccount.get(accountId); return e ? e.ua : null; }

  // 真实移动端「人类」滚动：分步 + 随机抖动延迟
  async _humanScroll(page, steps) {
    for (let i = 0; i < steps; i++) {
      await page.evaluate(() => window.scrollBy(0, 500 + Math.floor(Math.random() * 400)));
      await page.waitForTimeout(800 + Math.floor(Math.random() * 1500));
    }
  }
  async _dwell(page, secs) {
    await page.waitForTimeout(secs * 1000 + Math.floor(Math.random() * 1500));
  }

  /**
   * 执行一次真实移动端消费会话（公开网页浏览，不登录）。
   * ⚠️ 浏览器【临时启动、会话后关闭】：会话期间仅此 1 个浏览器短暂占用代理，
   *   会话结束即释放全部连接（空闲时设备池在代理上零连接，不挤占 OAuth API 出口）。
   * @returns {object} 会话摘要 { visited, scrolled, readPosts, tag, error, durationMs }
   */
  async openSession(accountId, opts = {}) {
    const entry = await this.assignDevice(accountId, opts.overrides || {});
    if (!entry) return { accountId, ok: false, error: this.disableReason || 'no-context' };
    if (this._sessionInFlight.has(accountId)) return { accountId, ok: false, error: 'session-in-flight' };
    this._sessionInFlight.add(accountId);
    entry.lastUsedAt = Date.now();

    let browser = null, context = null, page = null;
    const summary = {
      accountId, ok: true, model: entry.device.name,
      visited: [], scrolled: 0, readPosts: 0, tag: null,
      error: null, startedAt: Date.now(),
    };
    try {
      // ① 临时启动浏览器（代理在 context 级别配置，浏览器进程空闲即无连接）
      browser = await chromium.launch({ headless: true, args: this.launchArgs });
      this._activeBrowsers.add(browser);
      const cfg = this.emulator.getPlaywrightConfig(entry.device, {
        timezoneId: entry.tz, locale: entry.locale, proxy: { server: entry.proxy },
      });
      context = await browser.newContext(cfg);
      await context.addInitScript(this.emulator.getMobileAntiDetectionScript(entry.device));
      page = await context.newPage();

      // 1) 公开 explore 信息流
      await page.goto('https://www.tumblr.com/explore/trending', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this._humanScroll(page, 2);
      summary.scrolled += 2;
      summary.visited.push('explore');

      // 2) 浏览一个 dating/relationship 标签（赛道一致）
      const tag = opts.tags ? opts.tags[Math.floor(Math.random() * opts.tags.length)] : CONSUME_TAGS[Math.floor(Math.random() * CONSUME_TAGS.length)];
      await page.goto('https://www.tumblr.com/tagged/' + encodeURIComponent(tag), { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this._humanScroll(page, 3);
      summary.scrolled += 3;
      summary.tag = tag;
      summary.visited.push('tag:' + tag);

      // 3) 读几条帖子（真实打开文章页并停留）；先等 JS 渲染出帖子链接
      await page.waitForTimeout(2500);
      // tumblr 文章链接格式为 tumblr.com/{blog}/{数字id}（不含 /post/），用正则精准匹配
      const links = await page.evaluate(() => {
        const rx = /https?:\/\/[^/]*tumblr\.com\/[^/]+\/\d{8,}/;
        return Array.from(document.querySelectorAll('a')).map((e) => e.href).filter((h) => rx.test(h)).slice(0, 6);
      }).catch(() => []);
      for (const href of links.slice(0, 3)) {
        try {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await this._dwell(page, 4);
          summary.readPosts++;
        } catch (_) { /* 单条失败不影响整体会话 */ }
      }

      // 4) 看自己的博客（公开页面，真实移动访问）
      if (opts.ownBlog) {
        try {
          await page.goto('https://' + opts.ownBlog + '.tumblr.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await this._dwell(page, 3);
          summary.visited.push('ownblog');
        } catch (_) {}
      }
    } catch (e) {
      summary.error = e.message;
      summary.ok = false;
      // 启动级错误（如 playwright 崩溃）→ 标记 disabled，避免反复重试拖死
      if (/launch|crash|ENOENT|Executable|spawn/i.test(e.message)) {
        this.disableReason = 'runtime: ' + e.message;
        this.disabled = true; this.enabled = false;
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) {
        this._activeBrowsers.delete(browser);
        await browser.close().catch(() => {});
      }
      this._sessionInFlight.delete(accountId);
    }
    summary.endedAt = Date.now();
    summary.durationMs = summary.endedAt - summary.startedAt;
    entry.sessions++;
    entry.lastSessionAt = summary.endedAt;
    if (summary.error) entry.lastError = summary.error;
    // 详细会话日志（供看板下钻；由 dataStore 持久化，受 prune 约束）
    if (this.dataStore) {
      try {
        const prev = this.dataStore.get('tumblr_device', accountId) || { id: accountId, sessions: [] };
        prev.id = accountId;
        prev.model = summary.model;
        prev.ua = entry.ua;
        prev.sessions = prev.sessions || [];
        prev.sessions.push(summary);
        if (prev.sessions.length > 30) prev.sessions = prev.sessions.slice(-30);
        prev.lastSessionAt = summary.endedAt;
        if (!this.dataStore.get('tumblr_device', accountId)) this.dataStore.create('tumblr_device', prev);
        else this.dataStore.update('tumblr_device', accountId, prev);
      } catch (_) {}
    }
    return summary;
  }

  snapshot() {
    const contexts = [];
    for (const [id, c] of this._uaByAccount) {
      contexts.push({ accountId: id, model: c.device.name, brand: c.device.brand, os: c.device.os, ua: c.ua, sessions: c.sessions, lastSessionAt: c.lastSessionAt || null, lastError: c.lastError, browserIdx: c.browserIdx });
    }
    return {
      enabled: this.enabled, disabled: this.disabled, disableReason: this.disableReason,
      proxy: this.proxy, proxies: this.proxies,
      browserUp: this._activeBrowsers.size > 0, browserCount: this._activeBrowsers.size,
      perBrowserMax: this.perBrowserMax, maxBrowsers: this.maxBrowsers,
      contextCount: this._uaByAccount.size, maxContexts: this.maxContexts,
      ephemeral: true, // 标记：浏览器按需临时启动，空闲零代理连接
      contexts,
    };
  }

  async closeContext(accountId) {
    // 指纹映射保留（供 API 对齐），仅清会话计数引用（上下文本就按需开关，无需单独关）
    this._uaByAccount.delete(accountId);
  }

  async closeAll() {
    for (const b of this._activeBrowsers) { try { await b.close(); } catch (_) {} }
    this._activeBrowsers.clear();
    this._uaByAccount.clear();
    this.browsers = [];
    this.enabled = false;
  }
}

module.exports = { MobileDevicePool, CONSUME_TAGS, TZ_BY_OFFSET };
