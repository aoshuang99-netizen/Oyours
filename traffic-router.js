/**
 * traffic-router.js — MSCMS v14 引流链接管理系统
 *
 * 核心能力：
 *   1. 短链生成与管理（base62 编码，6位短码）
 *   2. UTM 参数自动附加（source/medium/campaign/content/term）
 *   3. 点击追踪与来源归因（IP/UA/Referer/时间）
 *   4. 智能路由（按平台/地域/设备跳转不同落地页）
 *   5. A/B 测试分流（按权重分配不同URL）
 *   6. 链接有效期与限额控制
 *   7. 批量生成（每个账号/帖子独立追踪链接）
 *   8. 与 website-analytics.js 联动（自动注入追踪参数）
 *
 * 用法：
 *   const { TrafficRouter } = require('./traffic-router.js');
 *   const router = new TrafficRouter({ baseUrl: 'https://s.example.com' });
 *   const link = await router.createLink({ url: 'https://example.com', source: 'reddit', campaign: 'launch' });
 *   // link.shortUrl → https://s.example.com/Ab3xY9
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── Base62 编码 ──────────────────────────────────
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function encodeBase62(num) {
  if (num === 0) return '0';
  let result = '';
  while (num > 0) {
    result = BASE62[num % 62] + result;
    num = Math.floor(num / 62);
  }
  return result;
}

function decodeBase62(str) {
  let num = 0;
  for (const ch of str) {
    num = num * 62 + BASE62.indexOf(ch);
  }
  return num;
}

// ── 链接记录 ──────────────────────────────────────
class TrackedLink {
  constructor(config) {
    this.id = `link_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    this.shortCode = config.shortCode;
    this.originalUrl = config.url;
    this.utm = config.utm || {};
    this.source = config.source || this.utm.utm_source || 'unknown';
    this.medium = config.medium || this.utm.utm_medium || 'social';
    this.campaign = config.campaign || this.utm.utm_campaign || 'default';
    this.content = config.content || this.utm.utm_content || '';
    this.term = config.term || this.utm.utm_term || '';

    // 智能路由规则
    this.routingRules = config.routingRules || []; // [{ condition, url }]

    // A/B 测试
    this.abTest = config.abTest || null; // { variants: [{ url, weight }] }

    // 限制
    this.expiresAt = config.expiresAt || null;
    this.clickLimit = config.clickLimit || null;
    this.dailyLimit = config.dailyLimit || null;
    this.autoDeactivate = config.autoDeactivate !== false;

    // 统计
    this.clicks = 0;
    this.uniqueClicks = 0;
    this.uniqueClickers = new Set();
    this.clickHistory = [];
    this.dailyClicks = {};  // { 'YYYY-MM-DD': count }

    // 标签
    this.tags = config.tags || [];
    this.notes = config.notes || '';

    // 时间
    this.createdAt = new Date().toISOString();
    this.createdBy = config.createdBy || 'system';

    // 状态
    this.active = true;
  }

  isExpired() {
    if (this.expiresAt && new Date() > new Date(this.expiresAt)) return true;
    if (this.clickLimit && this.clicks >= this.clickLimit) return true;
    // 检查每日限额
    if (this.dailyLimit) {
      const today = new Date().toISOString().slice(0, 10);
      if ((this.dailyClicks[today] || 0) >= this.dailyLimit) return true;
    }
    return false;
  }

  resolveUrl(requestData = {}) {
    // A/B 测试分流
    if (this.abTest && this.abTest.variants) {
      const rand = Math.random() * 100;
      let cumulative = 0;
      for (const variant of this.abTest.variants) {
        cumulative += variant.weight || 50;
        if (rand < cumulative) return this._appendUTM(variant.url);
      }
    }

    // 智能路由
    for (const rule of this.routingRules) {
      if (this._matchRule(rule, requestData)) {
        return this._appendUTM(rule.url);
      }
    }

    // 默认 URL
    return this._appendUTM(this.originalUrl);
  }

  _matchRule(rule, data) {
    if (rule.condition.platform && data.platform === rule.condition.platform) return true;
    if (rule.condition.country && data.country === rule.condition.country) return true;
    if (rule.condition.device && data.device === rule.condition.device) return true;
    return false;
  }

  _appendUTM(url) {
    try {
      const urlObj = new URL(url);
      if (this.source) urlObj.searchParams.set('utm_source', this.source);
      if (this.medium) urlObj.searchParams.set('utm_medium', this.medium);
      if (this.campaign) urlObj.searchParams.set('utm_campaign', this.campaign);
      if (this.content) urlObj.searchParams.set('utm_content', this.content);
      if (this.term) urlObj.searchParams.set('utm_term', this.term);
      return urlObj.toString();
    } catch {
      return url;
    }
  }
}

// ── TrafficRouter 主类 ──────────────────────────
class TrafficRouter extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.baseUrl = opts.baseUrl || 'https://s.example.com';
    this.links = new Map();        // shortCode → TrackedLink
    this.linkIndex = new Map();    // id → shortCode
    this.counter = Math.floor(Math.random() * 1000000); // 短码计数器

    // 【修复】引用外部模块
    this.websiteAnalytics = opts.websiteAnalytics || null;
    this.nurturing = opts.nurturing || null;  // 用于创作者筛选

    // 【修复】引用数仓，用于短链持久化回填（解决点击 link_id 幻影、点击无法归因到账号）
    this.dataStore = opts.dataStore || null;
    if (this.dataStore) {
      try { this.hydrate(); } catch (e) { /* hydrate 非关键，失败不影响启动 */ }
    }

    // 点击统计
    this.clickStats = {
      totalClicks: 0,
      totalUniqueClicks: 0,
      bySource: {},
      byPlatform: {},
      byCountry: {},
      byDevice: {},
      byHour: {},
      conversionRate: 0,
    };

    // 转化追踪
    this.conversions = [];
    this.maxConversions = 5000;

    // 生命周期清理定时器 (每60秒检查过期/超限链接)
    this._lifecycleInterval = setInterval(() => this._runLifecycle(), 60000);
  }

  // ── 生命周期管理 ──────────────────────────────
  _runLifecycle() {
    const now = Date.now();
    for (const [code, link] of this.links) {
      if (!link.active) continue;
      if (link.expiresAt && now > new Date(link.expiresAt).getTime()) {
        link.active = false;
        this.emit('link:expired', link);
      }
      if (link.clickLimit && link.clicks >= link.clickLimit) {
        link.active = false;
        this.emit('link:limit_reached', link);
      }
    }
  }

  stop() {
    if (this._lifecycleInterval) {
      clearInterval(this._lifecycleInterval);
      this._lifecycleInterval = null;
    }
    this.removeAllListeners();
  }

  // ── 【新增】从数仓回填短链（重启后点击仍可解析+归因）──
  _loadWarehouseLinks() {
    if (!this.dataStore) return [];
    try {
      const res = this.dataStore.list('traffic_links', { limit: 100000 }) || {};
      // DataStore.list 返回分页对象 {items,total,...}，非数组
      const recs = Array.isArray(res) ? res : (res.items || []);
      return recs;
    } catch (e) { return []; }
  }

  hydrate() {
    const recs = this._loadWarehouseLinks();
    let loaded = 0, skipped = 0;
    for (const rec of recs) {
      const sc = rec.short_code;
      if (!sc) { skipped++; continue; }
      if (this.links.has(sc)) continue;
      try {
        const link = new TrackedLink({
          shortCode: sc,
          url: rec.target_url || rec.original_url || '',
          source: rec.platform || rec.source,
          tags: [rec.platform, rec.account_id, rec.content_id].filter(Boolean),
          notes: `Platform:${rec.platform || ''}|Account:${rec.account_id || ''}|Content:${rec.content_id || ''}`,
        });
        link.id = rec.link_id;
        this.links.set(sc, link);
        this.linkIndex.set(rec.link_id, sc);
        loaded++;
      } catch (e) {
        skipped++;
        console.warn(`[TrafficRouter.hydrate] skip record ${rec.short_code || rec.link_id || '?'}: ${e.message}`);
      }
    }
    console.log(`[TrafficRouter.hydrate] loaded ${loaded}/${recs.length} (skipped ${skipped})`);
  }

  // ── 【新增】按 shortCode 解析链接，内存无则回退数仓 ──
  getLinkByShortCode(shortCode) {
    if (this.links.has(shortCode)) return this.links.get(shortCode);
    if (this.dataStore) {
      const recs = this._loadWarehouseLinks();
      const rec = recs.find(r => r.short_code === shortCode || r.link_id === shortCode);
      if (rec) {
        try {
          const link = new TrackedLink({
            shortCode: rec.short_code,
            url: rec.target_url || rec.original_url || '',
            source: rec.platform || rec.source,
            tags: [rec.platform, rec.account_id, rec.content_id].filter(Boolean),
            notes: `Platform:${rec.platform || ''}|Account:${rec.account_id || ''}|Content:${rec.content_id || ''}`,
          });
          link.id = rec.link_id;
          this.links.set(rec.short_code, link);
          this.linkIndex.set(rec.link_id, rec.short_code);
          return link;
        } catch (e) { /* ignore */ }
      }
    }
    return null;
  }

  // ── 【新增】从链接对象提取账号 ID（用于点击直接归因）──
  extractAccountId(link) {
    if (!link) return null;
    const tags = link.tags || [];
    const m = tags.find(t => /^(acc_|X_|tumblr_|reddit_|discord_|instagram_|x_|twitter_|facebook_|tiktok_)/i.test(String(t)));
    if (m) return m;
    const notes = link.notes || '';
    const mm = notes.match(/Account:([^\|]+)/);
    if (mm && mm[1]) return mm[1].trim();
    return null;
  }

  // ── 创建短链 ──────────────────────────────────
  async createLink(config) {
    const shortCode = this._generateShortCode();
    const link = new TrackedLink({
      ...config,
      shortCode,
    });

    this.links.set(shortCode, link);
    this.linkIndex.set(link.id, shortCode);
    link.shortUrl = `${this.baseUrl}/${shortCode}`;

    this.emit('link:created', link);
    return {
      id: link.id,
      shortCode,
      shortUrl: link.shortUrl,
      originalUrl: link.originalUrl,
      utm: link.utm,
      source: link.source,
      campaign: link.campaign,
      platform: config.platform || config.source || null,
      accountId: config.accountId || null,
      createdAt: link.createdAt,
    };
  }

  // ── 【新增】获取爆款创作者的高绩效链接 ──────────
  getTopCreatorLinks(limit = 10, platform = null) {
    // 从养号模块获取高评分账号（爆款创作者）
    let topAccounts = [];
    if (this.nurturing && this.nurturing.accounts) {
      const accounts = Array.from(this.nurturing.accounts.values());
      topAccounts = accounts
        .filter(a => a.healthScore >= 75 && a.state && ['S3_MATURE', 'S4_PEAK'].includes(a.state))
        .sort((a, b) => b.healthScore - a.healthScore);
    }

    // 获取所有活跃链接，按点击数过滤
    let allLinks = Array.from(this.links.values())
      .filter(l => l.active)
      .map(l => ({
        id: l.id,
        shortCode: l.shortCode,
        shortUrl: `${this.baseUrl}/${l.shortCode}`,
        originalUrl: l.originalUrl,
        source: l.source,
        platform: l.tags?.find(t => ['reddit','instagram','tiktok','x','twitter','discord','facebook','tumblr'].includes(t)) || l.source,
        campaign: l.campaign,
        clicks: l.clicks,
        uniqueClicks: l.uniqueClicks,
        conversionRate: l.clicks > 0 ? (l.uniqueClicks / l.clicks * 100).toFixed(1) + '%' : '0%',
        createdAt: l.createdAt,
        creatorScore: 0,
        isTopCreator: false,
      }));

    // 如果有养号数据，按账号健康分匹配筛选
    if (topAccounts.length > 0) {
      const topPlatforms = new Set(topAccounts.map(a => a.platform));
      // 标记与高评分账号同平台的链接
      for (const link of allLinks) {
        if (topPlatforms.has(link.platform || link.source)) {
          const matchedAccount = topAccounts.find(a => a.platform === (link.platform || link.source));
          if (matchedAccount) {
            link.creatorScore = matchedAccount.healthScore;
            link.isTopCreator = true;
            link.creatorUsername = matchedAccount.username;
            link.creatorTier = matchedAccount.tier;
          }
        }
      }
    }

    // 排序：先按创作者分数，再按点击数
    allLinks.sort((a, b) => {
      if (a.isTopCreator !== b.isTopCreator) return b.isTopCreator ? 1 : -1;
      if (a.creatorScore !== b.creatorScore) return b.creatorScore - a.creatorScore;
      return b.clicks - a.clicks;
    });

    // 平台过滤
    if (platform) {
      allLinks = allLinks.filter(l => (l.platform || l.source) === platform);
    }

    return allLinks.slice(0, limit);
  }

  // ── 批量创建 ──────────────────────────────────
  async batchCreate(baseConfig, count) {
    const links = [];
    for (let i = 0; i < count; i++) {
      const config = {
        ...baseConfig,
        content: baseConfig.content ? `${baseConfig.content}_${i}` : `variant_${i}`,
      };
      const link = await this.createLink(config);
      links.push(link);
    }
    return links;
  }

  // ── 处理点击（重定向） ────────────────────────
  async handleClick(shortCode, requestData = {}) {
    const link = this.getLinkByShortCode(shortCode);
    if (!link) return { error: 'Link not found', status: 404 };
    if (!link.active) return { error: 'Link inactive', status: 410 };
    if (link.isExpired()) return { error: 'Link expired', status: 410 };

    // 记录点击
    const clickRecord = {
      linkId: link.id,
      shortCode,
      timestamp: new Date().toISOString(),
      ip: requestData.ip || '',
      userAgent: requestData.userAgent || '',
      referrer: requestData.referrer || '',
      platform: requestData.platform || this._detectPlatform(requestData),
      country: requestData.country || 'unknown',
      device: this._detectDevice(requestData.userAgent),
      contentId: requestData.contentId || requestData.postId || null,
      postId: requestData.postId || null,
    };

    link.clicks++;
    const today = new Date().toISOString().slice(0, 10);
    link.dailyClicks[today] = (link.dailyClicks[today] || 0) + 1;
    if (!link.uniqueClickers.has(clickRecord.ip || clickRecord.userAgent)) {
      link.uniqueClickers.add(clickRecord.ip || clickRecord.userAgent);
      link.uniqueClicks++;
    }
    link.clickHistory.push(clickRecord);
    if (link.clickHistory.length > 1000) link.clickHistory = link.clickHistory.slice(-1000);

    // 自动停用检查
    if (link.autoDeactivate && link.isExpired()) {
      link.active = false;
      this.emit('link:deactivated', link);
    }

    // 更新全局统计
    this._updateClickStats(clickRecord);

    // 【修复】将点击事件同步到 WebsiteAnalytics 访客管线
    if (this.websiteAnalytics) {
      try {
        this.websiteAnalytics.trackVisit({
          ip: clickRecord.ip || 'unknown',
          userAgent: clickRecord.userAgent || '',
          referrer: clickRecord.referrer || '',
          url: link.originalUrl,
          source: link.source || clickRecord.platform || 'social',
          platform: clickRecord.platform || link.source || 'unknown',
          country: clickRecord.country || 'unknown',
          contentId: clickRecord.contentId || null,
          postId: clickRecord.postId || null,
          shortCode: shortCode,
          campaign: link.campaign || null,
        });
      } catch(e) { /* visitor tracking non-critical */ }
    }

    // 解析目标 URL
    const targetUrl = link.resolveUrl(requestData);

    this.emit('click', { link, clickRecord, targetUrl, accountId: this.extractAccountId(link), platform: link.source || clickRecord.platform || null });

    return {
      status: 302,
      redirectUrl: targetUrl,
      linkId: link.id,
    };
  }

  // ── 记录转化 ──────────────────────────────────
  recordConversion(shortCode, conversionData = {}) {
    const link = this.links.get(shortCode);
    if (!link) return;

    const conversion = {
      linkId: link.id,
      shortCode,
      timestamp: new Date().toISOString(),
      type: conversionData.type || 'signup',
      value: conversionData.value || 0,
      visitorId: conversionData.visitorId || '',
    };

    this.conversions.unshift(conversion);
    if (this.conversions.length > this.maxConversions) {
      this.conversions = this.conversions.slice(0, this.maxConversions);
    }

    this.clickStats.conversionRate = link.clicks > 0
      ? (this.conversions.filter(c => c.linkId === link.id).length / link.clicks * 100).toFixed(2) + '%'
      : '0%';

    this.emit('conversion', conversion);
  }

  // ── 查询链接 ──────────────────────────────────
  getLink(shortCode) {
    const link = this.links.get(shortCode);
    if (!link) return null;
    return {
      id: link.id,
      shortCode: link.shortCode,
      shortUrl: `${this.baseUrl}/${link.shortCode}`,
      originalUrl: link.originalUrl,
      source: link.source,
      medium: link.medium,
      campaign: link.campaign,
      content: link.content,
      clicks: link.clicks,
      uniqueClicks: link.uniqueClicks,
      active: link.active,
      expiresAt: link.expiresAt,
      clickLimit: link.clickLimit,
      createdAt: link.createdAt,
      abTest: link.abTest,
      routingRules: link.routingRules,
      dailyLimit: link.dailyLimit,
      autoDeactivate: link.autoDeactivate,
      tags: link.tags,
      notes: link.notes,
      dailyClicks: link.dailyClicks,
    };
  }

  getLinkById(id) {
    const shortCode = this.linkIndex.get(id);
    return shortCode ? this.getLink(shortCode) : null;
  }

  listLinks(filter = {}) {
    let links = Array.from(this.links.values());
    if (filter.source) links = links.filter(l => l.source === filter.source);
    if (filter.campaign) links = links.filter(l => l.campaign === filter.campaign);
    if (filter.active !== undefined) links = links.filter(l => l.active === filter.active);
    return links.map(l => ({
      id: l.id,
      shortCode: l.shortCode,
      shortUrl: `${this.baseUrl}/${l.shortCode}`,
      originalUrl: l.originalUrl,
      source: l.source,
      campaign: l.campaign,
      clicks: l.clicks,
      uniqueClicks: l.uniqueClicks,
      active: l.active,
      createdAt: l.createdAt,
    }));
  }

  // ── 停用/启用链接 ─────────────────────────────
  deactivateLink(shortCode) {
    const link = this.links.get(shortCode);
    if (link) {
      link.active = false;
      this.emit('link:deactivated', link);
    }
  }

  activateLink(shortCode) {
    const link = this.links.get(shortCode);
    if (link) {
      link.active = true;
      this.emit('link:activated', link);
    }
  }

  // ── 生成短码 ──────────────────────────────────
  _generateShortCode() {
    this.counter++;
    let code = encodeBase62(this.counter);
    // 补齐到至少6位
    while (code.length < 6) code = BASE62[Math.floor(Math.random() * 62)] + code;
    // 确保唯一
    while (this.links.has(code)) {
      this.counter++;
      code = encodeBase62(this.counter);
    }
    return code;
  }

  // ── 更新点击统计 ──────────────────────────────
  _updateClickStats(record) {
    this.clickStats.totalClicks++;
    this.clickStats.totalUniqueClicks++; // 简化：每次唯一IP/UA计数

    const source = this._detectPlatform(record);
    this.clickStats.bySource[source] = (this.clickStats.bySource[source] || 0) + 1;
    this.clickStats.byPlatform[record.platform] = (this.clickStats.byPlatform[record.platform] || 0) + 1;
    this.clickStats.byCountry[record.country] = (this.clickStats.byCountry[record.country] || 0) + 1;
    this.clickStats.byDevice[record.device] = (this.clickStats.byDevice[record.device] || 0) + 1;

    const hour = new Date(record.timestamp).getHours();
    this.clickStats.byHour[hour] = (this.clickStats.byHour[hour] || 0) + 1;
  }

  // ── 检测平台 ──────────────────────────────────
  _detectPlatform(data) {
    const ref = (data.referrer || '').toLowerCase();
    if (ref.includes('reddit')) return 'reddit';
    if (ref.includes('x.com') || ref.includes('twitter')) return 'x';
    if (ref.includes('discord')) return 'discord';
    if (ref.includes('instagram')) return 'instagram';
    if (ref.includes('tiktok')) return 'tiktok';
    if (ref.includes('facebook')) return 'facebook';
    if (ref.includes('google')) return 'google';
    return 'direct';
  }

  // ── 检测设备 ──────────────────────────────────
  _detectDevice(ua) {
    if (!ua) return 'desktop';
    const lower = ua.toLowerCase();
    if (lower.includes('mobile') || lower.includes('iphone') || lower.includes('android')) return 'mobile';
    if (lower.includes('ipad') || lower.includes('tablet')) return 'tablet';
    return 'desktop';
  }

  // ── 获取统计 ──────────────────────────────────
  getStats() {
    return {
      ...this.clickStats,
      totalLinks: this.links.size,
      activeLinks: Array.from(this.links.values()).filter(l => l.active).length,
      totalConversions: this.conversions.length,
    };
  }

  getClickHistory(shortCode, limit = 50) {
    const link = this.links.get(shortCode);
    if (!link) return [];
    return link.clickHistory.slice(-limit).reverse();
  }

  getRecentConversions(limit = 50) {
    return this.conversions.slice(0, limit);
  }

  // ── 生成模拟点击数据 ──────────────────────────
  generateSimulatedClicks(count = 50) {
    const platforms = ['reddit', 'x', 'discord', 'instagram', 'tiktok', 'facebook'];
    const countries = ['US', 'CN', 'UK', 'JP', 'DE'];
    const devices = ['mobile', 'desktop', 'tablet'];

    return this.batchCreate({
      url: 'https://example.com/landing',
      source: 'reddit',
      campaign: 'sim_test',
    }, 5).then(links => {
      for (const link of links) {
        for (let i = 0; i < count; i++) {
          this.handleClick(link.shortCode, {
            ip: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
            userAgent: devices[Math.floor(Math.random() * devices.length)] === 'mobile'
              ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'
              : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            referrer: `https://${platforms[Math.floor(Math.random() * platforms.length)]}.com`,
            country: countries[Math.floor(Math.random() * countries.length)],
          });
        }
      }
    });
  }

  // ── 查询指定内容的点击行为 ──────────────────
  getClickBehaviorByContent(contentId, opts = {}) {
    const limit = opts.limit || 100;
    const clicks = [];
    for (const [, link] of this.links) {
      for (const c of link.clickHistory || []) {
        if (c.contentId === contentId || c.postId === contentId) {
          clicks.push({
            id: c.linkId + '_' + c.timestamp,
            timestamp: c.timestamp,
            shortCode: c.shortCode,
            linkId: c.linkId,
            ip: c.ip,
            userAgent: c.userAgent,
            referrer: c.referrer,
            platform: c.platform,
            country: c.country,
            device: c.device,
          });
        }
      }
    }
    clicks.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const sliced = clicks.slice(0, limit);
    const uniqueIps = new Set(sliced.map(c => c.ip)).size;
    const byCountry = {};
    const byPlatform = {};
    sliced.forEach(c => {
      byCountry[c.country] = (byCountry[c.country] || 0) + 1;
      byPlatform[c.platform] = (byPlatform[c.platform] || 0) + 1;
    });
    return {
      contentId,
      totalClicks: clicks.length,
      uniqueIps,
      byCountry,
      byPlatform,
      clicks: sliced,
    };
  }
}

module.exports = { TrafficRouter, TrackedLink, encodeBase62, decodeBase62 };
