/**
 * conversion-engine.js — MSCMS v14 统一转化引擎
 *
 * 核心能力：
 *   1. 9级转化事件模型 (page_view → high_roller)
 *   2. 事件分级与价值计算
 *   3. Postback 多级回传
 *   4. DD.txt 质量权重动态调优
 *   5. 跨渠道转化归因
 *   6. 转化漏斗实时更新
 *
 * 用法：
 *   const { ConversionEngine } = require('./conversion-engine.js');
 *   const engine = new ConversionEngine({ trafficRouter, websiteAnalytics, dataStore });
 *   engine.recordConversion('cv_001', 'signup', { value: 50, source: 'reddit' });
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 转化事件分级 ──────────────────────────────────
const CONVERSION_TYPES = {
  PAGE_VIEW:    { level: 0, label: '浏览',       weight: 0.0,  icon: '👁️' },
  CLICK_CTA:    { level: 1, label: '点击CTA',    weight: 0.1,  icon: '👆' },
  FORM_START:   { level: 2, label: '开始填表',   weight: 0.2,  icon: '📝' },
  SIGNUP:       { level: 3, label: '注册',       weight: 0.3,  icon: '✅' },
  EMAIL_VERIFY: { level: 4, label: '邮箱验证',   weight: 0.5,  icon: '📧' },
  KYC:          { level: 5, label: '实名认证',   weight: 0.6,  icon: '🪪' },
  FIRST_DEPOSIT:{ level: 6, label: '首次充值',   weight: 0.8,  icon: '💳' },
  PURCHASE:     { level: 7, label: '购买',       weight: 1.0,  icon: '🛒' },
  SUBSCRIBE:    { level: 8, label: '订阅',       weight: 1.2,  icon: '🔄' },
  HIGH_ROLLER:  { level: 9, label: '大额',       weight: 2.0,  icon: '💎' }
};

const EVENT_ORDER = ['page_view','click_cta','form_start','signup','email_verify','kyc','first_deposit','purchase','subscribe','high_roller'];

// ── 转化事件 ──────────────────────────────────────
class ConversionEvent {
  constructor(data) {
    this.event_id = data.event_id || `cv_${Date.now()}_${crypto.randomBytes(3'hex')}`;
    this.visitor_id = data.visitor_id || null;
    this.session_id = data.session_id || null;

    // 来源追踪
    this.source = data.source || 'direct';
    this.sub_source = data.sub_source || null;
    this.campaign_id = data.campaign_id || null;
    this.short_code = data.short_code || null;
    this.utm = data.utm || {};

    // 设备/地域
    this.device = data.device || 'unknown';
    this.country = data.country || 'unknown';
    this.ip = data.ip || null;
    this.user_agent = data.user_agent || null;

    // 转化详情
    this.event_type = data.event_type || 'page_view';
    this.event_value = data.event_value || 0;
    this.currency = data.currency || 'USD';

    // Landing Page
    this.landing_url = data.landing_url || null;
    this.landing_duration = data.landing_duration || 0;
    this.landing_depth = data.landing_depth || 0;

    // 归因结果 (回填)
    this.attribution = data.attribution || null;

    // 关联账号
    this.bot_id = data.bot_id || null;

    // 回传状态
    this.postback_status = data.postback_status || 'pending'; // pending | sent | failed | retried
    this.postback_retries = data.postback_retries || 0;

    this.timestamp = data.timestamp || new Date().toISOString();
  }

  get typeInfo() {
    return CONVERSION_TYPES[this.event_type.toUpperCase().replace(/ /g,'_')] || CONVERSION_TYPES.PAGE_VIEW;
  }

  get level() {
    return this.typeInfo.level;
  }

  get weight() {
    return this.typeInfo.weight;
  }

  get label() {
    return this.typeInfo.label;
  }
}

// ── 转化引擎 ──────────────────────────────────────
class ConversionEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.trafficRouter = opts.trafficRouter || null;
    this.websiteAnalytics = opts.websiteAnalytics || null;
    this.dataStore = opts.dataStore || null;
    this.mysqlPool = opts.mysqlPool || null;

    // 转化事件存储 (内存 + DataStore持久化)
    this.events = [];
    this.eventsByVisitor = new Map();   // visitor_id → [event_ids]
    this.eventsBySource = new Map();    // source → [event_ids]
    this.eventsByType = new Map();      // event_type → [event_ids]
    this.eventsByShortCode = new Map(); // short_code → [event_ids]

    // 归因窗口内的触点
    this.touchpoints = new Map();       // visitor_id → [{channel, timestamp, type}]

    // 漏斗统计 (实时)
    this.funnel = {};
    for (const type of EVENT_ORDER) {
      this.funnel[type] = 0;
    }

    // 全局统计
    this.stats = {
      totalEvents: 0,
      totalConversions: 0,
      totalValue: 0,
      bySource: {},
      byType: {},
      byDate: {},
      postbackSuccess: 0,
      postbackFailed: 0
    };

    // 归因窗口 (天)
    this.attributionWindow = opts.attributionWindow || 30;

    // 最大内存事件数
    this.maxEvents = opts.maxEvents || 50000;

    // 清理间隔
    this._cleanupInterval = setInterval(() => this._cleanup(), 60000);

    // 启动时自动从 DataStore 恢复历史转化事件（同步读取内存缓存）
    this._hydrating = false;
    this.hydrate();
  }

  // ── 从 DataStore 恢复历史转化事件 ─────────────────
  hydrate() {
    if (this._hydrating || !this.dataStore) return;
    this._hydrating = true;
    try {
      const records = (this.dataStore.list('conversion_logs', { limit: 1000000 }).items) || [];
      let restored = 0;
      for (const record of records) {
        if (!record || !record.event_id) continue;
        // 避免重复加载
        if (this.events.some(e => e.event_id === record.event_id)) continue;
        const event = new ConversionEvent(record);
        this.events.push(event);
        this._indexEvent(event);
        if (this.funnel[event.event_type] !== undefined) {
          this.funnel[event.event_type]++;
        }
        this._updateStats(event);
        restored++;
      }
      if (restored > 0) {
        console.log(`[ConversionEngine] 已从 DataStore 恢复 ${restored} 条转化事件`);
      }
    } catch (e) {
      console.error('[ConversionEngine] hydrate failed:', e.message);
    } finally {
      this._hydrating = false;
    }
  }

  // ── 记录转化事件 ────────────────────────────────
  recordConversion(data = {}) {
    const event = new ConversionEvent(data);
    const typeKey = event.event_type;

    // 去重检查 (同visitor同类型1分钟内不重复)
    const visitorEvents = this.eventsByVisitor.get(event.visitor_id) || [];
    if (event.visitor_id) {
      const recent = visitorEvents.find(eid => {
        const e = this._getEvent(eid);
        if (!e) return false;
        const timeDiff = new Date(event.timestamp) - new Date(e.timestamp);
        return e.event_type === typeKey && Math.abs(timeDiff) < 60000;
      });
      if (recent) {
        // 静默跳过重复事件
        this.emit('duplicate', { event, existing: recent });
        return event;
      }
    }

    // 存储事件
    this.events.push(event);
    this._indexEvent(event);

    // 更新漏斗
    if (this.funnel[typeKey] !== undefined) {
      this.funnel[typeKey]++;
    }

    // 更新统计
    this._updateStats(event);

    // 持久化到 DataStore
    if (this.dataStore) {
      try {
        this.dataStore.create('conversion_logs', {
          event_id: event.event_id,
          event_type: event.event_type,
          event_value: event.event_value,
          source: event.source,
          sub_source: event.sub_source,
          short_code: event.short_code,
          visitor_id: event.visitor_id,
          device: event.device,
          country: event.country,
          bot_id: event.bot_id,
          timestamp: event.timestamp
        });
      } catch (e) { /* silent */ }
    }

    // 通知 TrafficRouter 更新转化记录
    if (this.trafficRouter && event.short_code && event.event_type !== 'page_view') {
      try {
        this.trafficRouter.recordConversion(event.short_code, {
          eventId: event.event_id,
          type: event.event_type,
          value: event.event_value,
          visitorId: event.visitor_id,
          timestamp: event.timestamp
        });
      } catch (e) { /* silent */ }
    }

    // 通知 WebsiteAnalytics 更新漏斗
    if (this.websiteAnalytics && ['signup','first_deposit','purchase','subscribe'].includes(typeKey)) {
      try {
        this.websiteAnalytics.trackConversion({
          type: event.event_type,
          value: event.event_value,
          visitorId: event.visitor_id,
          source: event.source,
          shortCode: event.short_code
        });
      } catch (e) { /* silent */ }
    }

    // 触发事件
    this.emit('conversion', event);
    this.emit(`conversion:${typeKey}`, event);

    // 高价值事件触发额外通知
    if (event.event_value > 100 || ['high_roller','subscribe'].includes(typeKey)) {
      this.emit('high_value', event);
    }

    return event;
  }

  // ── 批量记录 ─────────────────────────────────────
  batchRecord(events = []) {
    return events.map(e => this.recordConversion(e));
  }

  // ── 记录触点 (用于归因) ──────────────────────────
  recordTouchpoint(visitor_id, data = {}) {
    if (!visitor_id) return;

    if (!this.touchpoints.has(visitor_id)) {
      this.touchpoints.set(visitor_id, []);
    }

    const tp = {
      channel: data.channel || 'direct',
      touch_type: data.touch_type || 'click',
      timestamp: data.timestamp || new Date().toISOString(),
      utm: data.utm || {},
      url: data.url || null,
      short_code: data.short_code || null
    };

    const points = this.touchpoints.get(visitor_id);
    points.push(tp);

    // 只保留归因窗口内的触点
    const cutoff = Date.now() - this.attributionWindow * 86400000;
    this.touchpoints.set(visitor_id, points.filter(t => new Date(t.timestamp).getTime() > cutoff));

    // 持久化
    if (this.dataStore) {
      try {
        this.dataStore.create('attribution_touchpoints', tp);
      } catch (e) { /* silent */ }
    }
  }

  // ── 获取归因数据 ─────────────────────────────────
  getAttribution(visitor_id, model = 'last_click') {
    const points = this.touchpoints.get(visitor_id) || [];
    if (points.length === 0) return { model, touchpoints: [], credits: {} };

    const credits = {};
    const totalPoints = points.length;

    switch (model) {
      case 'last_click':
        // 最后一个触点得100%
        const last = points[points.length - 1];
        credits[last.channel] = 1.0;
        break;

      case 'linear':
        // 所有触点平均分配
        points.forEach(tp => {
          credits[tp.channel] = (credits[tp.channel] || 0) + (1.0 / totalPoints);
        });
        break;

      case 'time_decay':
        // 越近权重越高 (指数衰减, 半衰期7天)
        const now = Date.now();
        let totalWeight = 0;
        const weighted = points.map(tp => {
          const hoursAgo = (now - new Date(tp.timestamp).getTime()) / 3600000;
          const w = Math.pow(0.5, hoursAgo / (7 * 24)); // 7天半衰期
          return { ...tp, _weight: w };
        });
        totalWeight = weighted.reduce((s, t) => s + t._weight, 0);
        weighted.forEach(tp => {
          credits[tp.channel] = (credits[tp.channel] || 0) + (tp._weight / totalWeight);
        });
        break;

      case 'position_based':
        // 首次40% + 末次40% + 中间20%均分
        if (totalPoints === 1) {
          credits[points[0].channel] = 1.0;
        } else if (totalPoints === 2) {
          credits[points[0].channel] = 0.5;
          credits[points[1].channel] = 0.5;
        } else {
          credits[points[0].channel] = 0.40;
          credits[points[totalPoints - 1].channel] = 0.40;
          const middleWeight = 0.20 / (totalPoints - 2);
          for (let i = 1; i < totalPoints - 1; i++) {
            credits[points[i].channel] = (credits[points[i].channel] || 0) + middleWeight;
          }
        }
        break;
    }

    return { model, touchpoints: points, credits };
  }

  // ── 计算DD.txt权重增益 ───────────────────────────
  calculateWeightGain(conversionEvent, accountData = {}) {
    let base = conversionEvent.weight;
    if (base === 0) return 0;

    // 冷启动加成 (新账号 <10次转化)
    if ((accountData.totalConversions || 0) < 10) base *= 1.5;

    // 大额转化加成
    if (conversionEvent.event_value > 100) base *= 1.3;
    else if (conversionEvent.event_value > 500) base *= 1.5;

    // 快速转化加成 (假设有点击时间)
    if (conversionEvent.landing_duration < 300) base *= 1.2; // 5分钟内转化

    // Shadowban 降权
    if (accountData.status === 'shadowbanned') base *= 0.5;

    // 权重上限
    return Math.min(Math.round(base * 30), 78);
  }

  // ── 计算权重衰减 ─────────────────────────────────
  calculateWeightLoss(accountData = {}) {
    let loss = 0;

    // 连续24h零转化
    const lastConversion = accountData.last_conversion_at;
    if (lastConversion) {
      const hoursSince = (Date.now() - new Date(lastConversion).getTime()) / 3600000;
      if (hoursSince > 24) loss += Math.floor(hoursSince / 24) * 10;
    }

    // 连续7天零转化 → 标记dead
    const daysSince = lastConversion
      ? (Date.now() - new Date(lastConversion).getTime()) / 86400000
      : Infinity;
    if (daysSince > 30) loss += 80;

    return Math.min(loss, 480); // 不低于20
  }

  // ── 获取漏斗数据 ─────────────────────────────────
  getFunnel() {
    const stages = [];
    let prev = null;

    for (const type of EVENT_ORDER) {
      const count = this.funnel[type] || 0;
      const info = CONVERSION_TYPES[type.toUpperCase().replace(/ /g, '_')] || {};
      const stage = {
        id: type,
        label: info.label || type,
        icon: info.icon || '📊',
        level: info.level || 0,
        count,
        rate: prev ? (prev.count > 0 ? (count / prev.count * 100).toFixed(2) : '0.00') : '100.00',
        dropoff: prev ? (prev.count - count) : 0
      };
      stages.push(stage);
      prev = stage;
    }

    return stages;
  }

  // ── 获取来源归因汇总 ─────────────────────────────
  getSourceAttribution(days = 7, model = 'last_click') {
    const cutoff = Date.now() - days * 86400000;
    const sourceStats = {};

    for (const event of this.events) {
      if (new Date(event.timestamp).getTime() < cutoff) continue;
      if (['page_view','click_cta','form_start'].includes(event.event_type)) continue;

      const source = event.source || 'direct';
      if (!sourceStats[source]) {
        sourceStats[source] = { source, totalConversions: 0, totalValue: 0, events: {} };
      }

      sourceStats[source].totalConversions++;
      sourceStats[source].totalValue += event.event_value;
      sourceStats[source].events[event.event_type] = (sourceStats[source].events[event.event_type] || 0) + 1;
    }

    // 计算各来源ROI (如果有成本数据)
    const result = Object.values(sourceStats).map(s => ({
      ...s,
      conversionRate: this.stats.totalEvents > 0
        ? (s.totalConversions / Math.max(this.stats.totalEvents, 1) * 100).toFixed(2)
        : '0.00',
      avgValue: s.totalConversions > 0
        ? (s.totalValue / s.totalConversions).toFixed(2)
        : '0.00'
    }));

    result.sort((a, b) => b.totalConversions - a.totalConversions);
    return result;
  }

  // ── 获取统计 ─────────────────────────────────────
  getStats() {
    // 【修复】每次获取统计前自动加载历史数据
    this.hydrate();
    return {
      ...this.stats,
      funnel: this.getFunnel(),
      activeVisitors: this.eventsByVisitor.size,
      memoryEvents: this.events.length,
      touchpointsTracked: Array.from(this.touchpoints.values()).reduce((s, a) => s + a.length, 0)
    };
  }

  // ── 【新增】获取转化概览仪表盘数据 ──────────────
  getOverview(days = 30) {
    // 确保数据已加载
    this.hydrate();

    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentEvents = this.events.filter(e => e.timestamp >= cutoff);

    // 漏斗统计
    const funnel = { ...this.funnel };
    const dailyConversions = {};
    const bySource = {};
    const byType = {};

    for (const evt of recentEvents) {
      const dateKey = evt.timestamp.slice(0, 10);
      dailyConversions[dateKey] = (dailyConversions[dateKey] || 0) + 1;

      const source = evt.source || 'direct';
      bySource[source] = (bySource[source] || 0) + 1;

      const type = evt.event_type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    }

    // 每日趋势
    const dailyTrend = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      dailyTrend.push({ date, conversions: dailyConversions[date] || 0 });
    }

    // 总价值
    const totalValue = recentEvents.reduce((s, e) => s + (e.event_value || 0), 0);

    return {
      summary: {
        totalConversions: recentEvents.length,
        totalValue: Math.round(totalValue * 100) / 100,
        uniqueVisitors: new Set(recentEvents.map(e => e.visitor_id).filter(Boolean)).size,
        periodDays: days,
        conversionRate: 'N/A', // 需要与 touches 对比
      },
      funnel,
      bySource: Object.entries(bySource).map(([k, v]) => ({ source: k, count: v })),
      byType: Object.entries(byType).map(([k, v]) => ({ type: k, count: v })),
      dailyTrend,
    };
  }

  // ── 获取事件列表 ─────────────────────────────────
  getEvents(filter = {}) {
    // 【修复】每次查询前自动加载历史数据
    this.hydrate();
    let results = [...this.events];
    const { source, event_type, visitor_id, short_code, limit = 100, offset = 0, startDate, endDate } = filter;

    if (source) results = results.filter(e => e.source === source);
    if (event_type) results = results.filter(e => e.event_type === event_type);
    if (visitor_id) results = results.filter(e => e.visitor_id === visitor_id);
    if (short_code) results = results.filter(e => e.short_code === short_code);

    if (startDate) {
      const start = new Date(startDate).getTime();
      results = results.filter(e => new Date(e.timestamp).getTime() >= start);
    }
    if (endDate) {
      const end = new Date(endDate).getTime();
      results = results.filter(e => new Date(e.timestamp).getTime() <= end);
    }

    // 按时间倒序
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      total,
      offset,
      limit,
      records: results.map(e => ({
        event_id: e.event_id,
        event_type: e.event_type,
        event_label: e.label,
        event_value: e.event_value,
        source: e.source,
        visitor_id: e.visitor_id,
        short_code: e.short_code,
        device: e.device,
        country: e.country,
        bot_id: e.bot_id,
        timestamp: e.timestamp,
        postback_status: e.postback_status
      }))
    };
  }

  // ── 导出CSV ──────────────────────────────────────
  exportCSV(filter = {}) {
    const { records } = this.getEvents({ ...filter, limit: 999999 });
    const headers = ['event_id','event_type','event_label','event_value','source','visitor_id',
      'short_code','device','country','bot_id','timestamp','postback_status'];
    const lines = [headers.join(',')];

    for (const r of records) {
      const row = headers.map(h => {
        const v = r[h];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) return `"${v.replace(/"/g,'""')}"`;
        return String(v);
      });
      lines.push(row.join(','));
    }

    return lines.join('\n');
  }

  // ── 重置 ─────────────────────────────────────────
  reset() {
    this.events = [];
    this.eventsByVisitor.clear();
    this.eventsBySource.clear();
    this.eventsByType.clear();
    this.eventsByShortCode.clear();
    this.touchpoints.clear();
    for (const type of EVENT_ORDER) {
      this.funnel[type] = 0;
    }
    this.stats = {
      totalEvents: 0, totalConversions: 0, totalValue: 0,
      bySource: {}, byType: {}, byDate: {},
      postbackSuccess: 0, postbackFailed: 0
    };
  }

  // ── 停止 ─────────────────────────────────────────
  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.removeAllListeners();
  }

  // ── 内部方法 ─────────────────────────────────────
  _getEvent(eventId) {
    return this.events.find(e => e.event_id === eventId);
  }

  _indexEvent(event) {
    // visitor
    if (event.visitor_id) {
      if (!this.eventsByVisitor.has(event.visitor_id)) {
        this.eventsByVisitor.set(event.visitor_id, []);
      }
      this.eventsByVisitor.get(event.visitor_id).push(event.event_id);
    }

    // source
    if (event.source) {
      if (!this.eventsBySource.has(event.source)) {
        this.eventsBySource.set(event.source, []);
      }
      this.eventsBySource.get(event.source).push(event.event_id);
    }

    // type
    if (event.event_type) {
      if (!this.eventsByType.has(event.event_type)) {
        this.eventsByType.set(event.event_type, []);
      }
      this.eventsByType.get(event.event_type).push(event.event_id);
    }

    // short_code
    if (event.short_code) {
      if (!this.eventsByShortCode.has(event.short_code)) {
        this.eventsByShortCode.set(event.short_code, []);
      }
      this.eventsByShortCode.get(event.short_code).push(event.event_id);
    }
  }

  _updateStats(event) {
    this.stats.totalEvents++;
    if (event.event_type !== 'page_view' && event.event_type !== 'click_cta') {
      this.stats.totalConversions++;
      this.stats.totalValue += event.event_value;
    }

    // bySource
    if (event.source) {
      this.stats.bySource[event.source] = (this.stats.bySource[event.source] || 0) + 1;
    }

    // byType
    if (event.event_type) {
      this.stats.byType[event.event_type] = (this.stats.byType[event.event_type] || 0) + 1;
    }

    // byDate
    const date = event.timestamp.slice(0, 10);
    this.stats.byDate[date] = (this.stats.byDate[date] || 0) + 1;
  }

  _cleanup() {
    // 清理超出归因窗口的触点
    const cutoff = Date.now() - this.attributionWindow * 86400000;
    for (const [vid, points] of this.touchpoints) {
      const filtered = points.filter(t => new Date(t.timestamp).getTime() > cutoff);
      if (filtered.length === 0) {
        this.touchpoints.delete(vid);
      } else if (filtered.length !== points.length) {
        this.touchpoints.set(vid, filtered);
      }
    }

    // 限制内存事件数
    if (this.events.length > this.maxEvents) {
      const remove = this.events.length - this.maxEvents;
      const removed = this.events.splice(0, remove);
      // 清理索引中的引用
      for (const event of removed) {
        this._removeFromIndex(event);
      }
    }
  }

  _removeFromIndex(event) {
    if (event.visitor_id && this.eventsByVisitor.has(event.visitor_id)) {
      const arr = this.eventsByVisitor.get(event.visitor_id);
      const idx = arr.indexOf(event.event_id);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) this.eventsByVisitor.delete(event.visitor_id);
    }
    // 其他索引类似处理，但为性能考虑延迟清理
  }
}

module.exports = { ConversionEngine, ConversionEvent, CONVERSION_TYPES, EVENT_ORDER };
