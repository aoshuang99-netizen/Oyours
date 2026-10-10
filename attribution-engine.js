/**
 * attribution-engine.js — MSCMS v14 多渠道归因引擎
 *
 * 核心能力：
 *   1. 4种归因模型 (Last Click / Linear / Time Decay / Position Based)
 *   2. 跨渠道触点管理
 *   3. 渠道ROI计算
 *   4. 转化像素 (1x1 GIF tracking pixel)
 *
 * 用法：
 *   const { AttributionEngine } = require('./attribution-engine.js');
 *   const attr = new AttributionEngine({ conversionEngine, dataStore });
 *   attr.recordTouch(visitorId, { channel: 'reddit', touchType: 'click' });
 *   attr.getChannelROI(30) → { reddit: { conversions: 50, revenue: 2500, roi: 3.2 } }
 */

const { EventEmitter } = require('events');

// ── 归因模型 ──────────────────────────────────────
const ATTRIBUTION_MODELS = {
  LAST_CLICK:     { id: 'last_click',     label: '末次点击',   desc: '转化归功于最后一个触点' },
  FIRST_CLICK:    { id: 'first_click',    label: '首次点击',   desc: '转化归功于第一个触点' },
  LINEAR:         { id: 'linear',         label: '线性',       desc: '所有触点平均分配' },
  TIME_DECAY:     { id: 'time_decay',     label: '时间衰减',   desc: '越接近转化权重越高 (7天半衰期)' },
  POSITION_BASED:  { id: 'position_based',  label: '位置加权',   desc: '首次40% + 末次40% + 中间20%均分' },
  U_SHAPED:       { id: 'u_shaped',       label: 'U型',        desc: '首次40% + 末次40% + 中间20%' },
  W_SHAPED:       { id: 'w_shaped',       label: 'W型',        desc: '首次30% + 线索创建30% + 机会创建30% + 其他10%' }
};

// ── 归因引擎 ──────────────────────────────────────
class AttributionEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.conversionEngine = opts.conversionEngine || null;
    this.dataStore = opts.dataStore || null;

    // 触点存储: visitor_id → [{channel, touch_type, timestamp, url, short_code}]
    this.touchpoints = new Map();

    // 归因结果缓存: conversion_event_id → attribution
    this.attributionCache = new Map();

    // 渠道归因汇总
    this.channelAttribution = {}; // channel → {conversions, revenue, touches}

    // 配置
    this.config = {
      defaultModel: opts.defaultModel || 'last_click',
      attributionWindow: opts.attributionWindow || 30,  // 天
      timeDecayHalfLife: opts.timeDecayHalfLife || 168,  // 小时 (7天)
      maxTouchpoints: opts.maxTouchpoints || 100          // 每用户最多触点
    };
  }

  // ── 记录触点 ─────────────────────────────────────
  recordTouch(visitorId, data = {}) {
    if (!visitorId) return;

    if (!this.touchpoints.has(visitorId)) {
      this.touchpoints.set(visitorId, []);
    }

    const tp = {
      id: `tp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      channel: data.channel || 'direct',
      touch_type: data.touch_type || 'click',
      timestamp: data.timestamp || new Date().toISOString(),
      url: data.url || null,
      short_code: data.short_code || null,
      campaign_id: data.campaign_id || null,
      utm: data.utm || {},
      device: data.device || 'unknown',
      country: data.country || 'unknown'
    };

    const points = this.touchpoints.get(visitorId);
    points.push(tp);

    // 限制触点数量
    if (points.length > this.config.maxTouchpoints) {
      points.shift();
    }

    // 清理过期触点
    this._cleanVisitorTouchpoints(visitorId);

    // 持久化
    if (this.dataStore) {
      try {
        this.dataStore.create('attribution_touchpoints', tp);
      } catch (e) { /* silent */ }
    }

    this.emit('touch', { visitorId, touchpoint: tp });

    // 通知 ConversionEngine
    if (this.conversionEngine) {
      this.conversionEngine.recordTouchpoint(visitorId, tp);
    }
  }

  // ── 计算归因 ─────────────────────────────────────
  calculate(conversionEvent, model = null) {
    const visitorId = conversionEvent.visitor_id;
    if (!visitorId) return { model: model || this.config.defaultModel, credits: {}, touchpoints: [] };

    const modelId = model || this.config.defaultModel;
    const allPoints = this.touchpoints.get(visitorId) || [];

    // 过滤归因窗口内的触点
    const convTime = new Date(conversionEvent.timestamp).getTime();
    const windowStart = convTime - this.config.attributionWindow * 86400000;
    const relevantPoints = allPoints.filter(tp =>
      new Date(tp.timestamp).getTime() >= windowStart &&
      new Date(tp.timestamp).getTime() <= convTime
    );

    if (relevantPoints.length === 0) {
      return {
        model: modelId,
        conversionId: conversionEvent.event_id,
        credits: { direct: 1.0 },
        touchpoints: []
      };
    }

    const credits = this._applyModel(relevantPoints, modelId);

    // 缓存
    this.attributionCache.set(conversionEvent.event_id, {
      model: modelId,
      credits,
      touchpoints: relevantPoints.map(tp => tp.id)
    });

    // 更新渠道汇总
    for (const [channel, credit] of Object.entries(credits)) {
      if (!this.channelAttribution[channel]) {
        this.channelAttribution[channel] = { conversions: 0, revenue: 0, touches: 0 };
      }
      this.channelAttribution[channel].conversions += credit;
      this.channelAttribution[channel].revenue += conversionEvent.event_value * credit;
    }

    this.emit('attributed', {
      conversionId: conversionEvent.event_id,
      model: modelId,
      credits,
      value: conversionEvent.event_value
    });

    return {
      model: modelId,
      conversionId: conversionEvent.event_id,
      credits,
      touchpoints: relevantPoints.map(tp => ({
        id: tp.id, channel: tp.channel, touch_type: tp.touch_type, timestamp: tp.timestamp
      }))
    };
  }

  // ── 应用归因模型 ─────────────────────────────────
  _applyModel(touchpoints, model) {
    const credits = {};
    const total = touchpoints.length;

    switch (model) {
      case 'last_click':
        credits[touchpoints[total - 1].channel] = 1.0;
        break;

      case 'first_click':
        credits[touchpoints[0].channel] = 1.0;
        break;

      case 'linear':
        for (const tp of touchpoints) {
          credits[tp.channel] = (credits[tp.channel] || 0) + (1.0 / total);
        }
        break;

      case 'time_decay':
        const now = Date.now();
        let totalW = 0;
        const weighted = touchpoints.map(tp => {
          const hoursAgo = (now - new Date(tp.timestamp).getTime()) / 3600000;
          const w = Math.pow(0.5, hoursAgo / this.config.timeDecayHalfLife);
          return { ...tp, _w: w };
        });
        totalW = weighted.reduce((s, t) => s + t._w, 0);
        for (const tp of weighted) {
          credits[tp.channel] = (credits[tp.channel] || 0) + (tp._w / totalW);
        }
        break;

      case 'position_based':
      case 'u_shaped':
        if (total === 1) {
          credits[touchpoints[0].channel] = 1.0;
        } else if (total === 2) {
          credits[touchpoints[0].channel] = 0.5;
          credits[touchpoints[1].channel] = 0.5;
        } else {
          credits[touchpoints[0].channel] = 0.40;
          credits[touchpoints[total - 1].channel] = 0.40;
          const midW = 0.20 / (total - 2);
          for (let i = 1; i < total - 1; i++) {
            credits[touchpoints[i].channel] = (credits[touchpoints[i].channel] || 0) + midW;
          }
        }
        break;

      case 'w_shaped':
        if (total === 1) {
          credits[touchpoints[0].channel] = 1.0;
        } else if (total === 2) {
          credits[touchpoints[0].channel] = 0.5;
          credits[touchpoints[1].channel] = 0.5;
        } else if (total === 3) {
          credits[touchpoints[0].channel] = 0.33;
          credits[touchpoints[1].channel] = 0.34;
          credits[touchpoints[2].channel] = 0.33;
        } else {
          // 首次30%, 中期30%(如果有lead/opp), 末次30%, 其他10%
          const midIdx = Math.floor(total / 2);
          credits[touchpoints[0].channel] = 0.30;
          credits[touchpoints[total - 1].channel] = 0.30;
          if (total > 3) {
            credits[touchpoints[midIdx].channel] = (credits[touchpoints[midIdx].channel] || 0) + 0.30;
            const otherW = 0.10 / (total - 3);
            for (let i = 1; i < total - 1; i++) {
              if (i !== midIdx) {
                credits[touchpoints[i].channel] = (credits[touchpoints[i].channel] || 0) + otherW;
              }
            }
          } else {
            credits[touchpoints[1].channel] = 0.40;
          }
        }
        break;
    }

    return credits;
  }

  // ── 获取渠道ROI ─────────────────────────────────
  getChannelROI(days = 30, model = null) {
    const modelId = model || this.config.defaultModel;
    const cutoff = Date.now() - days * 86400000;
    const channelData = {};

    // 遍历最近的触点和转化
    for (const [visitorId, points] of this.touchpoints) {
      const recentPoints = points.filter(tp => new Date(tp.timestamp).getTime() >= cutoff);
      for (const tp of recentPoints) {
        if (!channelData[tp.channel]) {
          channelData[tp.channel] = { channel: tp.channel, touches: 0, conversions: 0, revenue: 0 };
        }
        channelData[tp.channel].touches++;
      }
    }

    // 合并归因数据
    for (const [channel, attr] of Object.entries(this.channelAttribution)) {
      if (!channelData[channel]) {
        channelData[channel] = { channel, touches: 0, conversions: 0, revenue: 0 };
      }
      channelData[channel].conversions = Math.round(attr.conversions * 100) / 100;
      channelData[channel].revenue = Math.round(attr.revenue * 100) / 100;
    }

    const result = Object.values(channelData).map(c => ({
      ...c,
      attributionModel: modelId,
      days,
      conversionRate: c.touches > 0 ? (c.conversions / c.touches * 100).toFixed(2) + '%' : '0%',
      revenuePerTouch: c.touches > 0 ? (c.revenue / c.touches).toFixed(2) : '0.00',
      touchesPerConversion: c.conversions > 0 ? (c.touches / c.conversions).toFixed(1) : '0'
    }));

    result.sort((a, b) => b.conversions - a.conversions);
    return result;
  }

  // ── 多模型对比 ───────────────────────────────────
  compareModels(conversionEvent) {
    const results = {};
    for (const modelId of Object.keys(ATTRIBUTION_MODELS)) {
      results[modelId] = this.calculate(conversionEvent, modelId);
    }
    return {
      conversionId: conversionEvent.event_id,
      value: conversionEvent.event_value,
      source: conversionEvent.source,
      models: results
    };
  }

  // ── 获取渠道触点路径 ─────────────────────────────
  getTouchPath(visitorId) {
    const points = this.touchpoints.get(visitorId) || [];
    return points.map(tp => ({
      channel: tp.channel,
      touchType: tp.touch_type,
      timestamp: tp.timestamp,
      shortCode: tp.short_code
    }));
  }

  // ── 生成转化像素 ─────────────────────────────────
  generatePixel(campaignId, shortCode) {
    const baseUrl = this.config.trackingDomain || 'localhost:3002';
    const params = new URLSearchParams();
    if (campaignId) params.set('cid', campaignId);
    if (shortCode) params.set('sc', shortCode);
    params.set('t', Date.now().toString());

    const pixelUrl = `http://${baseUrl}/api/v14/postback/pixel?${params.toString()}`;

    return {
      url: pixelUrl,
      html: `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`,
      script: `<script>
        (function(){
          var i=new Image(1,1);
          i.src="${pixelUrl}";
        })();
      </script>`,
      noscript: `<noscript><img src="${pixelUrl}" width="1" height="1" alt="" /></noscript>`
    };
  }

  // ── 获取触点统计数据 ─────────────────────────────
  getTouchStats(days = 7) {
    const cutoff = Date.now() - days * 86400000;
    const stats = {
      totalTouches: 0,
      uniqueVisitors: new Set(),
      byChannel: {},
      byType: {},
      hourlyDistribution: new Array(24).fill(0)
    };

    for (const [visitorId, points] of this.touchpoints) {
      for (const tp of points) {
        if (new Date(tp.timestamp).getTime() < cutoff) continue;
        stats.totalTouches++;
        stats.uniqueVisitors.add(visitorId);

        stats.byChannel[tp.channel] = (stats.byChannel[tp.channel] || 0) + 1;
        stats.byType[tp.touch_type] = (stats.byType[tp.touch_type] || 0) + 1;

        const hour = new Date(tp.timestamp).getHours();
        stats.hourlyDistribution[hour]++;
      }
    }

    stats.uniqueVisitors = stats.uniqueVisitors.size;
    return stats;
  }

  // ── 获取统计 ─────────────────────────────────────
  getStats() {
    // 【修复】每次获取统计前自动从 DataStore 加载历史数据，防止数据丢失
    this.hydrate();
    return {
      totalTouchpoints: Array.from(this.touchpoints.values()).reduce((s, a) => s + a.length, 0),
      uniqueVisitors: this.touchpoints.size,
      cachedAttributions: this.attributionCache.size,
      activeChannels: Object.keys(this.channelAttribution).length,
      defaultModel: this.config.defaultModel,
      attributionWindow: this.config.attributionWindow,
      touchStats: this.getTouchStats(30)
    };
  }

  // ── 【新增】从 DataStore 加载历史数据 ────────────
  hydrate() {
    if (!this.dataStore) return;
    try {
      // 加载触点数据
      const tpResult = this.dataStore.list('attribution_touchpoints', { limit: 100000 });
      const touchRecords = (tpResult && tpResult.items) ? tpResult.items : [];
      let loaded = 0;
      for (const rec of touchRecords) {
        if (!rec || !rec.id) continue;
        // 避免重复
        const existing = this.touchpoints.get(rec.channel + '_' + rec.id);
        if (existing) continue;
        // 重构触点
        const visitorId = rec.channel || 'unknown';
        if (!this.touchpoints.has(visitorId)) {
          this.touchpoints.set(visitorId, []);
        }
        const points = this.touchpoints.get(visitorId);
        // 检查是否已存在同ID
        if (!points.some(p => p.id === rec.id)) {
          points.push({
            id: rec.id,
            channel: rec.channel || 'direct',
            touch_type: rec.touch_type || 'click',
            timestamp: rec.timestamp || rec.created_at || new Date().toISOString(),
            url: rec.url || null,
            short_code: rec.short_code || null,
            campaign_id: rec.campaign_id || null,
            utm: rec.utm || {},
            device: rec.device || 'unknown',
            country: rec.country || 'unknown'
          });
          // 限制触点数量
          if (points.length > this.config.maxTouchpoints) points.shift();
          loaded++;
        }
      }

      // 加载归因汇总
      const attrResult = this.dataStore.list('attribution_summary', { limit: 1000 });
      const attrRecords = (attrResult && attrResult.items) ? attrResult.items : [];
      for (const rec of attrRecords) {
        if (rec.channel && !this.channelAttribution[rec.channel]) {
          this.channelAttribution[rec.channel] = {
            conversions: rec.conversions || 0,
            revenue: rec.revenue || 0,
            touches: rec.touches || 0,
          };
        }
      }

      if (loaded > 0) {
        console.log(`[AttributionEngine] 已从 DataStore 恢复 ${loaded} 个触点，${attrRecords.length} 个渠道汇总`);
      }
    } catch (e) {
      console.error('[AttributionEngine] hydrate failed:', e.message);
    }
  }

  // ── 【新增】获取归因概览仪表盘数据 ──────────────
  getOverview(days = 30) {
    // 确保数据已加载
    this.hydrate();

    const cutoff = Date.now() - days * 86400000;
    const channelStats = {};
    let totalTouches = 0;
    let totalConversions = 0;
    let totalRevenue = 0;
    const dailyTouches = {};
    const dailyConversions = {};

    // 遍历触点计算
    for (const [visitorId, points] of this.touchpoints) {
      for (const tp of points) {
        const ts = new Date(tp.timestamp).getTime();
        if (ts < cutoff) continue;
        totalTouches++;

        if (!channelStats[tp.channel]) {
          channelStats[tp.channel] = { channel: tp.channel, touches: 0, conversions: 0, revenue: 0 };
        }
        channelStats[tp.channel].touches++;

        const dateKey = tp.timestamp.slice(0, 10);
        dailyTouches[dateKey] = (dailyTouches[dateKey] || 0) + 1;
      }
    }

    // 合并归因数据
    for (const [channel, attr] of Object.entries(this.channelAttribution)) {
      if (!channelStats[channel]) {
        channelStats[channel] = { channel, touches: 0, conversions: 0, revenue: 0 };
      }
      channelStats[channel].conversions = Math.round(attr.conversions * 100) / 100;
      channelStats[channel].revenue = Math.round(attr.revenue * 100) / 100;
      totalConversions += attr.conversions;
      totalRevenue += attr.revenue;
    }

    // 每日趋势（最近30天）
    const dailyTrend = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      dailyTrend.push({
        date,
        touches: dailyTouches[date] || 0,
        conversions: dailyConversions[date] || 0,
      });
    }

    const channels = Object.values(channelStats).map(c => ({
      ...c,
      conversionRate: c.touches > 0 ? ((c.conversions / c.touches) * 100).toFixed(1) + '%' : '0%',
      revenuePerTouch: c.touches > 0 ? (c.revenue / c.touches).toFixed(2) : '0.00',
    }));
    channels.sort((a, b) => b.conversions - a.conversions);

    return {
      summary: {
        totalTouches,
        totalConversions: Math.round(totalConversions * 100) / 100,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        uniqueVisitors: this.touchpoints.size,
        activeChannels: channels.length,
        conversionRate: totalTouches > 0 ? ((totalConversions / totalTouches) * 100).toFixed(1) + '%' : '0%',
        defaultModel: this.config.defaultModel,
        periodDays: days,
      },
      channels,
      dailyTrend,
      topModels: this._getModelComparison(days),
    };
  }

  // ── 内部：获取模型对比 ──────────────────────────
  _getModelComparison(days) {
    const models = Object.keys(ATTRIBUTION_MODELS);
    return models.map(m => ({
      model: m,
      label: ATTRIBUTION_MODELS[m].label,
      desc: ATTRIBUTION_MODELS[m].desc,
    }));
  }

  // ── 更新配置 ─────────────────────────────────────
  updateConfig(config = {}) {
    Object.assign(this.config, config);
    this.emit('config:updated', this.config);
  }

  // ── 重置 ─────────────────────────────────────────
  reset() {
    this.touchpoints.clear();
    this.attributionCache.clear();
    this.channelAttribution = {};
  }

  // ── 停止 ─────────────────────────────────────────
  stop() {
    this.removeAllListeners();
  }

  // ── 内部方法 ─────────────────────────────────────
  _cleanVisitorTouchpoints(visitorId) {
    const points = this.touchpoints.get(visitorId);
    if (!points) return;

    const cutoff = Date.now() - this.config.attributionWindow * 86400000;
    const filtered = points.filter(tp => new Date(tp.timestamp).getTime() >= cutoff);
    if (filtered.length === 0) {
      this.touchpoints.delete(visitorId);
    } else {
      this.touchpoints.set(visitorId, filtered);
    }
  }
}

module.exports = { AttributionEngine, ATTRIBUTION_MODELS };
