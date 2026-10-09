/**
 * website-analytics.js — MSCMS v14 网站分析追踪模块
 *
 * 核心能力：
 *   1. 实时访客统计（当前在线、今日DAU、每小时趋势）
 *   2. 来源归因（社交媒体/直接访问/搜索/推荐）
 *   3. 转化漏斗（访问→注册→付费）
 *   4. 页面热力分析（热门页面排行）
 *   5. 设备/地域分布
 *   6. 嵌入式追踪 SDK（一行JS接入目标网站）
 *   7. 与 traffic-router.js 联动（UTM 参数解析）
 *   8. 历史数据存储与趋势分析
 *
 * 用法：
 *   const { WebsiteAnalytics } = require('./website-analytics.js');
 *   const analytics = new WebsiteAnalytics();
 *   analytics.trackVisit({ url, referrer, utm });
 *   const dau = await analytics.getDAU(new Date());
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
// 【B0-D4】流量来源归因（单一事实源）— 区分真实用户 / 系统自生成 / 无法判定
const {
  classifyTraffic, visitorFingerprint, summarizeProvenance,
} = require('./data-provenance.js');

// ── 追踪事件类型 ──────────────────────────────────
const EVENT_TYPES = {
  PAGE_VIEW: 'page_view',
  CLICK: 'click',
  SIGNUP: 'signup',
  PURCHASE: 'purchase',
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
};

// ── 来源分类 ──────────────────────────────────────
const SOURCE_CATEGORIES = {
  reddit: 'social',
  'x.com': 'social',
  'twitter.com': 'social',
  discord: 'social',
  'discord.com': 'social',
  instagram: 'social',
  'instagram.com': 'social',
  tiktok: 'social',
  'tiktok.com': 'social',
  facebook: 'social',
  'facebook.com': 'social',
  google: 'search',
  bing: 'search',
  baidu: 'search',
  direct: 'direct',
};

class WebsiteAnalytics extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.siteUrl = opts.siteUrl || '';
    this.sessions = new Map();     // sessionId → session data
    this.visitors = new Map();     // visitorId → visitor data
    this.events = [];               // 事件日志
    this.maxEvents = 10000;
    this.hourlyBuckets = new Map(); // ` HH` → stats
    this.dailyBuckets = new Map();  // `` → stats

    this.stats = {
      totalVisits: 0,
      totalUniqueVisitors: 0,
      currentOnline: 0,
      todayDAU: 0,
      // 【B0-D4】分口径计数（累计）。totalVisits 保持向后兼容不动，
      // 新增可审计口径 —— system = 因果链 S5 驱动访问，unknown = 字段不足无法判定。
      userVisits: 0,
      systemVisits: 0,
      unknownVisits: 0,
      userUniqueVisitors: 0,
      bounceRate: 0,
      avgSessionDuration: 0,
      topPages: {},
      topSources: {},
      topCountries: {},
      topDevices: { mobile: 0, desktop: 0, tablet: 0 },
      conversionFunnel: {
        visited: 0,
        engaged: 0,
        signed_up: 0,
        paid: 0,
      },
    };

    // 清理超时会话
    this.sessionTimeout = 30 * 60 * 1000; // 30分钟
    this.cleanupInterval = setInterval(() => this._cleanupSessions(), 60000);
  }

  // ── 追踪访问 ──────────────────────────────────
  trackVisit(data = {}) {
    const event = {
      id: `evt_${Date.now()}_${crypto.randomBytes(4'hex')}`,
      type: EVENT_TYPES.PAGE_VIEW,
      timestamp: new Date().toISOString(),
      url: data.url || '',
      referrer: data.referrer || '',
      userAgent: data.userAgent || '',
      ip: data.ip || '',
      visitorId: data.visitorId || this._generateVisitorId(data),
      sessionId: data.sessionId || this._generateSessionId(data),
      utm: data.utm || this._parseUTM(data.url),
      country: data.country || 'unknown',
      device: this._detectDevice(data.userAgent),
      contentId: data.contentId || data.postId || null,
      postId: data.postId || null,
      : data. || 'web',
    };

    event.source = this._classifySource(event.referrer, event.utm);

    // 【B0-D4】流量来源归因（单一事实源 data-provenance.js）。
    // 因果链 S5 会主动发真实 HTTP 请求驱动 visit.recorded，那批流量的 ip 被**如实标注**为
    // 'self_direct'（server.js:4037 — 不伪造源 IP，符合零伪造原则）。必须在入口就把它
    // 与真实用户分开，否则会被算进真实访客口径（实测曾累计 351360 次而独立访客仅 2）。
    event.provenance = classifyTraffic({
      _system_generated: data._system_generated === true || data._systemGenerated === true,
      ip: data.ip,
      source: data.source,
      ua: data.ua || data.userAgent,
    });

    // 记录事件
    this._recordEvent(event);

    // 更新会话
    this._updateSession(event);

    // 更新访客
    this._updateVisitor(event);

    // 更新统计
    this._updateStats(event);

    // 更新时段桶
    this._updateBuckets(event);

    this.emit('visit', event);
    return event;
  }

  // ── recordVisit 别名（供 causal chain 调用） ──
  recordVisit(data = {}) {
    return this.trackVisit(data);
  }

  // ── 追踪转化 ──────────────────────────────────
  trackConversion(data = {}) {
    const event = {
      id: `evt_${Date.now()}_${crypto.randomBytes(4'hex')}`,
      type: data.type || EVENT_TYPES.SIGNUP,
      timestamp: new Date().toISOString(),
      visitorId: data.visitorId,
      sessionId: data.sessionId,
      value: data.value || 0,
      url: data.url || '',
      source: data.source || '',
    };

    this._recordEvent(event);

    // 更新漏斗
    if (event.type === EVENT_TYPES.SIGNUP) {
      this.stats.conversionFunnel.signed_up++;
    } else if (event.type === EVENT_TYPES.PURCHASE) {
      this.stats.conversionFunnel.paid++;
    }

    this.emit('conversion', event);
    return event;
  }

  // ── 获取 DAU ─────────────────────────────────
  async getDAU(date = new Date()) {
    const dateKey = this._dateKey(date);
    const bucket = this.dailyBuckets.get(dateKey) || { uniqueVisitors: 0, totalVisits: 0 };

    // 获取来源分布
    const sources = {};
    const todayEvents = this.events.filter(e => {
      const eDate = new Date(e.timestamp);
      return this._dateKey(eDate) === dateKey;
    });

    for (const evt of todayEvents) {
      if (evt.source) {
        sources[evt.source] = (sources[evt.source] || 0) + 1;
      }
    }

    return {
      date: dateKey,
      dau: bucket.uniqueVisitors,
      totalVisits: bucket.totalVisits,
      sources,
    };
  }

  // ── 获取实时数据 ──────────────────────────────
  getRealtime() {
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const recentEvents = this.events.filter(e => new Date(e.timestamp).getTime() > fiveMinAgo);

    return {
      currentOnline: this.stats.currentOnline,
      visitorsLast5Min: new Set(recentEvents.map(e => e.visitorId)).size,
      pageViewsLast5Min: recentEvents.length,
      topPagesNow: this._getTopPages(recentEvents, 5),
      topSourcesNow: this._getTopSources(recentEvents, 5),
    };
  }

  // ── 获取趋势 ──────────────────────────────────
  getTrend(days = 7) {
    const trend = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateKey = this._dateKey(date);
      const bucket = this.dailyBuckets.get(dateKey) || { uniqueVisitors: 0, totalVisits: 0 };
      trend.push({
        date: dateKey,
        dau: bucket.uniqueVisitors,
        visits: bucket.totalVisits,
      });
    }
    return trend;
  }

  // ── 获取漏斗 ──────────────────────────────────
  getFunnel() {
    const f = this.stats.conversionFunnel;
    return {
      ...f,
      visitedToEngaged: f.visited > 0 ? (f.engaged / f.visited * 100).toFixed(1) + '%' : '0%',
      engagedToSignup: f.engaged > 0 ? (f.signed_up / f.engaged * 100).toFixed(1) + '%' : '0%',
      signupToPaid: f.signed_up > 0 ? (f.paid / f.signed_up * 100).toFixed(1) + '%' : '0%',
      overallConversion: f.visited > 0 ? (f.paid / f.visited * 100).toFixed(2) + '%' : '0%',
    };
  }

  // ── 获取完整仪表盘 ────────────────────────────
  getDashboard() {
    return {
      stats: this.stats,
      realtime: this.getRealtime(),
      trend7d: this.getTrend(7),
      funnel: this.getFunnel(),
      topPages: Object.entries(this.stats.topPages).sort((a, b) => b[1] - a[1]).slice(0, 10),
      topSources: Object.entries(this.stats.topSources).sort((a, b) => b[1] - a[1]).slice(0, 10),
      topCountries: Object.entries(this.stats.topCountries).sort((a, b) => b[1] - a[1]).slice(0, 10),
      deviceBreakdown: this.stats.topDevices,
    };
  }

  // ── 生成追踪 SDK ──────────────────────────────
  getTrackingSDK() {
    return `<!-- MSCMS v14 Analytics SDK -->
<script>
((){
  var ENDPOINT='${this.siteUrl || ''}/api/v14/analytics/track';
  var vid=localStorage.getItem('mscms_vid')||((){var id='v_'+Date.now()+'_'+Math.random(36).slice(2);localStorage.setItem('mscms_vid',id);return id;})();
  var sid=sessionStorage.getItem('mscms_sid')||((){var id='s_'+Date.now()+'_'+Math.random(36).slice(2);sessionStorage.setItem('mscms_sid',id);return id;})();
   track(data){
    var payload=Object.assign({url:location.href,referrer:document.referrer,userAgent:navigator.userAgent,visitorId:vid,sessionId:sid,utm:parseUTM()},data||{});
    if(navigator.sendBeacon){navigator.sendBeacon(ENDPOINT,JSON.stringify(payload));}
    else{var x=new XMLHttpRequest();x.open('POST',ENDPOINT,true);x.setRequestHeader('','application/json');x.send(JSON.stringify(payload));}
  }
   parseUTM(){var p={};location.search.slice(1).split('&').forEach((s){var kv=s.split('=');if(kv[0].startsWith('utm_'))p[kv[0]]=decodeURIComponent(kv[1]||'');});return p;}
  track({type:'page_view'});
  document.addEventListener('click',(e){var t=e.target.closest('a,button');if(t)track({type:'click',target:t.href||t.textContent.slice(0,50)});});
  window.addEventListener('beforeunload',(){track({type:'session_end'});});
  window.__mscmsTrack=track;
})();
</script>`;
  }

  // ── 内部方法 ──────────────────────────────────
  _recordEvent(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  _updateSession(event) {
    const now = Date.now();
    let session = this.sessions.get(event.sessionId);
    if (!session) {
      session = {
        id: event.sessionId,
        visitorId: event.visitorId,
        startedAt: event.timestamp,
        lastActivity: now,
        pageViews: 0,
        pages: [],
        source: event.source,
        isBounce: true,
      };
      this.sessions.set(event.sessionId, session);
      this.stats.currentOnline++;
    }
    session.lastActivity = now;
    session.pageViews++;
    session.pages.push(event.url);
    if (session.pageViews > 1) session.isBounce = false;

    // 判断是否 engaged（访问超过1个页面或停留超过30秒）
    const duration = now - new Date(session.startedAt).getTime();
    if (session.pageViews > 1 || duration > 30000) {
      if (!session.engaged) {
        session.engaged = true;
        this.stats.conversionFunnel.engaged++;
      }
    }
  }

  _updateVisitor(event) {
    let visitor = this.visitors.get(event.visitorId);
    if (!visitor) {
      visitor = {
        id: event.visitorId,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        visitCount: 0,
        source: event.source,
        country: event.country,
        device: event.device,
      };
      this.visitors.set(event.visitorId, visitor);
      this.stats.totalUniqueVisitors++;
      // 【B0-D4】只有判定为真实用户的访客才计入 userUniqueVisitors
      if (event.provenance === 'user') this.stats.userUniqueVisitors++;
    }
    visitor.lastSeen = event.timestamp;
    visitor.visitCount++;
  }

  _updateStats(event) {
    this.stats.totalVisits++;
    this.stats.conversionFunnel.visited++;

    // 【B0-D4】按来源分口径累计（可审计）。totalVisits 保持不变以兼容既有消费者。
    const _pv = event.provenance || 'unknown';
    if (_pv === 'system') this.stats.systemVisits++;
    else if (_pv === 'user') this.stats.userVisits++;
    else this.stats.unknownVisits++;

    // 页面统计
    const pagePath = this._getPath(event.url);
    this.stats.topPages[pagePath] = (this.stats.topPages[pagePath] || 0) + 1;

    // 来源统计
    const sourceName = event.utm?.source || event.source || 'direct';
    this.stats.topSources[sourceName] = (this.stats.topSources[sourceName] || 0) + 1;

    // 国家统计
    if (event.country && event.country !== 'unknown') {
      this.stats.topCountries[event.country] = (this.stats.topCountries[event.country] || 0) + 1;
    }

    // 设备统计
    if (event.device) {
      this.stats.topDevices[event.device] = (this.stats.topDevices[event.device] || 0) + 1;
    }
  }

  _updateBuckets(event) {
    const dt = new Date(event.timestamp);
    const hourKey = `${this._dateKey(dt)} ${dt.getHours().padStart(2, '0')}`;
    const dayKey = this._dateKey(dt);

    // 小时桶
    if (!this.hourlyBuckets.has(hourKey)) {
      this.hourlyBuckets.set(hourKey, { visits: 0, uniqueVisitors: new Set() });
    }
    const hBucket = this.hourlyBuckets.get(hourKey);
    hBucket.visits++;
    hBucket.uniqueVisitors.add(event.visitorId);

    // 日桶
    if (!this.dailyBuckets.has(dayKey)) {
      this.dailyBuckets.set(dayKey, { totalVisits: 0, uniqueVisitors: 0, visitorSet: new Set() });
    }
    const dBucket = this.dailyBuckets.get(dayKey);
    dBucket.totalVisits++;
    if (!dBucket.visitorSet.has(event.visitorId)) {
      dBucket.visitorSet.add(event.visitorId);
      dBucket.uniqueVisitors++;
    }

    // 如果是今天，更新 todayDAU
    if (dayKey === this._dateKey(new Date())) {
      this.stats.todayDAU = dBucket.uniqueVisitors;
    }
  }

  _cleanupSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.sessionTimeout) {
        const duration = session.lastActivity - new Date(session.startedAt).getTime();
        if (session.isBounce) {
          // 跳出率统计
        }
        this.sessions.delete(id);
        this.stats.currentOnline = Math.max(0, this.stats.currentOnline - 1);
      }
    }
  }

  _classifySource(referrer, utm) {
    if (utm?.source) return utm.source;
    if (!referrer) return 'direct';
    const lower = referrer.toLowerCase();
    for (const [key, category] of Object.entries(SOURCE_CATEGORIES)) {
      if (lower.includes(key)) return key;
    }
    return 'referral';
  }

  _parseUTM(url) {
    if (!url) return {};
    const params = {};
    try {
      const urlObj = new URL(url);
      for (const [key, value] of urlObj.searchParams) {
        if (key.startsWith('utm_')) params[key] = value;
      }
    } catch {}
    return params;
  }

  _detectDevice(ua) {
    if (!ua) return 'desktop';
    const lower = ua.toLowerCase();
    if (lower.includes('mobile') || lower.includes('iphone') || lower.includes('android')) return 'mobile';
    if (lower.includes('ipad') || lower.includes('tablet')) return 'tablet';
    return 'desktop';
  }

  _generateVisitorId(data) {
    // 【B0-D4 修复 2026-09-20】原实现对任意 data.ip 做 MD5：
    //     if (data && data.ip) return 'v_ip_' + md5(data.ip).slice(0,12)
    // 但因果链 S5 驱动访问时 ip 恒为哨兵值 'self_direct'（server.js:4037 为遵守
    // 零伪造而如实标注），于是**全部记录坍缩成同一个 visitorId** ⇒
    // 实测 totalUniqueVisitors=2 而 totalVisits=351360。
    // 改为：仅当 ip 是**真正可用的 IP** 时才按 ip 去重；
    //       否则回退到 ua+referrer+ 组合指纹（组合相同仍归同一访客，
    //       这是有意的稳定去重口径，否则 DAU 会虚高）。
    const fp = visitorFingerprint(data || {});
    if (fp.basis === 'ip') {
      return `v_ip_${crypto.createHash('md5').update(fp.key).digest('hex').slice(0, 12)}`;
    }
    if (fp.basis === 'composite') {
      return `v_fp_${crypto.createHash('md5').update(fp.key).digest('hex').slice(0, 12)}`;
    }
    return `v_${Date.now()}_${crypto.randomBytes(4'hex')}`;
  }

  _generateSessionId(data) {
    return `s_${Date.now()}_${crypto.randomBytes(4'hex')}`;
  }

  _getPath(url) {
    try { return new URL(url).pathname; } catch { return url; }
  }

  _dateKey(date) {
    return `${date.getFullYear()}-${(date.getMonth() + 1).padStart(2, '0')}-${date.getDate().padStart(2, '0')}`;
  }

  _getTopPages(events, limit) {
    const pages = {};
    for (const e of events) {
      const p = this._getPath(e.url);
      pages[p] = (pages[p] || 0) + 1;
    }
    return Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  _getTopSources(events, limit) {
    const sources = {};
    for (const e of events) {
      const s = e.utm?.source || e.source || 'direct';
      sources[s] = (sources[s] || 0) + 1;
    }
    return Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  // ── 生成模拟数据（用于测试和演示） ──────────────
  // ⚠️【2026-09-20 B0 审计】本方法是**死代码**（全仓零调用方），
  // 且 `/api/v14/analytics/simulate` 端点已按零伪造原则禁用（返回 403）。
  // 保留仅为历史参考，**禁止**在任何启动/定时路径中调用它 ——
  // 一旦调用会灌入 example.com 假事件并污染大盘。
  generateSimulatedData(count = 100) {
    const s = ['reddit', 'x', 'discord', 'instagram', 'tiktok', 'facebook', 'google', 'direct'];
    const countries = ['US', 'CN', 'UK', 'JP', 'DE', 'FR', 'CA', 'AU'];
    const pages = ['/', '/about', '/pricing', '/blog', '/docs', '/contact', '/signup'];

    for (let i = 0; i < count; i++) {
      const hoursAgo = Math.floor(Math.random() * 48);
      const dt = new Date(Date.now() - hoursAgo * 3600000);
      const source = s[Math.floor(Math.random() * s.length)];
      const country = countries[Math.floor(Math.random() * countries.length)];

      this.trackVisit({
        url: `https://example.com${pages[Math.floor(Math.random() * pages.length)]}?utm_source=${source}&utm_medium=social&utm_campaign=v14`,
        referrer: source !== 'direct' ? `https://${source}.com` : '',
        userAgent: Math.random() > 0.5 ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        visitorId: `v_sim_${Math.floor(Math.random() * count * 0.7)}`,
        sessionId: `s_sim_${i}`,
        country,
        timestamp: dt.toISOString(),
      });
    }
  }

  // ── 获取状态 ──────────────────────────────────
  getStats() {
    // 【B0-D4】窗口内（events 最多 maxEvents=10000 条）的口径分布快照
    const prov = summarizeProvenance(this.events);
    return {
      ...this.stats,
      sessionsActive: this.sessions.size,
      totalVisitors: this.visitors.size,
      eventsRecorded: this.events.length,
      hourlyBuckets: this.hourlyBuckets.size,
      dailyBuckets: this.dailyBuckets.size,
      // 可审计口径：明确区分真实用户 / 系统自生成 / 无法判定。
      // ⚠️ 前端大盘必须按此字段分区展示，**不得**把 system 并入真实访客。
      provenance: {
        ...prov,
        userVisits: this.stats.userVisits,
        systemVisits: this.stats.systemVisits,
        unknownVisits: this.stats.unknownVisits,
        userUniqueVisitors: this.stats.userUniqueVisitors,
        note: 'system = 因果链 S5 驱动访问（ip 如实标注 self_direct）；unknown = 字段不足无法判定；二者均不计入真实访客',
      },
    };
  }

  // ── 查询指定内容的访问者行为 ──────────────────
  getVisitorBehaviorByContent(contentId, opts = {}) {
    const limit = opts.limit || 100;
    const visits = this.events
      .filter(e => e.contentId === contentId || e.postId === contentId)
      .slice(-limit)
      .map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        ip: e.ip,
        userAgent: e.userAgent,
        device: e.device,
        country: e.country,
        referrer: e.referrer,
        url: e.url,
        source: e.source,
        sessionId: e.sessionId,
        visitorId: e.visitorId,
        utm: e.utm,
      }));
    // 汇总统计
    const uniqueIps = new Set(visits.map(v => v.ip)).size;
    const uniqueVisitors = new Set(visits.map(v => v.visitorId)).size;
    const byDevice = {};
    const byCountry = {};
    const bySource = {};
    visits.forEach(v => {
      byDevice[v.device] = (byDevice[v.device] || 0) + 1;
      byCountry[v.country] = (byCountry[v.country] || 0) + 1;
      bySource[v.source || 'unknown'] = (bySource[v.source || 'unknown'] || 0) + 1;
    });
    return {
      contentId,
      totalVisits: visits.length,
      uniqueIps,
      uniqueVisitors,
      byDevice,
      byCountry,
      bySource,
      visits,
    };
  }
}

module.exports = { WebsiteAnalytics, EVENT_TYPES, SOURCE_CATEGORIES };
