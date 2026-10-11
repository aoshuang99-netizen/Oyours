/**
 * channel-health.js — MSCMS v14 渠道健康评分模块
 *
 * 核心能力：
 *   1. 多渠道健康评分 (存活率/转化率/ROI/趋势)
 *   2. EventBus 监听各渠道指标变化实时更新
 *   3. 渠道预算智能分配建议
 *   4. Shadowban / 异常检测
 *
 * 用法：
 *   const { ChannelHealth } = require('./channel-health.js');
 *   const health = new ChannelHealth({ trafficRouter, conversionEngine, dataStore });
 *   health.getHealth('reddit') → { aliveRate, conversionRate, roi, trend, score }
 */

const { EventEmitter } = require('events');

// ── 渠道定义 ──────────────────────────────────────
const DEFAULT_CHANNELS = {
  reddit: {
    id: 'reddit', name: 'Reddit', icon: '🤖',
    strategies: [
      { type: 'kol_intercept', priority: 1, maxDaily: 50 },
      { type: 'topic_participate', priority: 2, maxDaily: 30 },
      { type: 'dm_outreach', priority: 3, maxDaily: 20 }
    ]
  },
  x: {
    id: 'x', name: 'X (Twitter)', icon: '🐦',
    strategies: [
      { type: 'competitor_intercept', priority: 1, maxDaily: 100 },
      { type: 'follow_target', priority: 2, maxDaily: 50 }
    ]
  },
  discord: {
    id: 'discord', name: 'Discord', icon: '💬',
    strategies: [
      { type: 'dm_outreach', priority: 1, maxDaily: 30 }
    ]
  },
  tiktok: {
    id: 'tiktok', name: 'TikTok', icon: '🎵',
    strategies: [
      { type: 'kol_intercept', priority: 1, maxDaily: 20 }
    ]
  },
  instagram: {
    id: 'instagram', name: 'Instagram', icon: '📷',
    strategies: [
      { type: 'kol_intercept', priority: 1, maxDaily: 30 }
    ]
  },
  tumblr: {
    id: 'tumblr', name: 'Tumblr', icon: '📝',
    strategies: [
      { type: 'topic_participate', priority: 1, maxDaily: 20 }
    ]
  }
};

// ── 渠道健康 ──────────────────────────────────────
class ChannelHealth extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.trafficRouter = opts.trafficRouter || null;
    this.conversionEngine = opts.conversionEngine || null;
    this.dataStore = opts.dataStore || null;

    // 渠道配置
    this.channels = { ...DEFAULT_CHANNELS, ...(opts.channels || {}) };

    // 每个渠道的实时指标
    this.metrics = {};
    for (const channelId of Object.keys(this.channels)) {
      this.metrics[channelId] = this._initMetrics(channelId);
    }

    // 总成本估算 (代理 + 设备 + 养号)
    this.costEstimates = {
      proxyPerAccount: 0.08,      // 单账号代理日成本
      devicePerAccount: 0.02,     // 单账号设备日成本
      nurturingPerAccount: 0.01   // 单账号养号日成本
    };

    // 更新间隔 (秒)
    this._updateInterval = setInterval(() => this._recalculate(), 30000);
  }

  // ── 初始化指标 ───────────────────────────────────
  _initMetrics(channelId) {
    return {
      channelId,
      // 账号指标
      totalAccounts: 0,
      activeAccounts: 0,
      shadowBannedAccounts: 0,
      deadAccounts: 0,

      // 流量指标
      totalClicks: 0,
      uniqueClicks: 0,
      clicksToday: 0,
      clicksTrend: [],           // [{date, count}]

      // 转化指标
      totalConversions: 0,
      conversionsToday: 0,
      conversionRate: 0,
      conversionValue: 0,
      conversionEvents: {},     // {signup: N, deposit: N, ...}

      // 成本/收益
      estimatedCost: 0,
      estimatedRevenue: 0,
      roi: 0,

      // 健康评分
      // 【B0-D3 修复 2026-09-20】原值为 accountAliveRate: 1.0 / healthScore: 100 ——
      // 但此时**一个账号都还没接入**，"0 个账号的存活率"并不是 100%。
      // 那两个初始值会被 _recalculate() 算成 30(aliveRate×30) + 5(trend down) = **35 分**，
      // 于是 /api/v14/channel/health 长期返回一个看起来像真实评分的 35，
      // 用户无法分辨「健康度真的是 35」还是「根本还没数据」。现改为 0，
      // 并由 dataQuality 明确指出该渠道是骨架还是已接真实数据。
      accountAliveRate: 0,
      shadowBanRate: 0,
      healthScore: 0,
      trend: 'unknown',         // up | stable | down | unknown(无数据)
      trendPercent: 0,

      // 数据质量：'skeleton' = 尚无任何真实数据接入；'live' = 已接入真实指标
      dataQuality: 'skeleton',
      dataUpdatedAt: null,

      // 时间
      lastUpdated: null,
      alerts: []
    };
  }

  // ── 更新账号数据 ─────────────────────────────────
  updateAccounts(channelId, accounts = []) {
    const m = this.metrics[channelId];
    if (!m) return;

    const active = accounts.filter(a => a.status === 'active').length;
    const shadowBanned = accounts.filter(a => a.status === 'shadowbanned').length;
    const dead = accounts.filter(a => a.status === 'dead').length;

    m.totalAccounts = accounts.length;
    m.activeAccounts = active;
    m.shadowBannedAccounts = shadowBanned;
    m.deadAccounts = dead;

    m.accountAliveRate = accounts.length > 0 ? active / accounts.length : 0;
    m.shadowBanRate = accounts.length > 0 ? shadowBanned / accounts.length : 0;

    // 估算成本
    m.estimatedCost = active * (
      this.costEstimates.proxyPerAccount +
      this.costEstimates.devicePerAccount +
      this.costEstimates.nurturingPerAccount
    );

    this._checkAlerts(channelId);
  }

  // ── 更新点击数据 ─────────────────────────────────
  updateClicks(channelId, stats = {}) {
    const m = this.metrics[channelId];
    if (!m) return;

    m.totalClicks = stats.totalClicks || m.totalClicks;
    m.uniqueClicks = stats.uniqueClicks || m.uniqueClicks;

    const today = new Date().toISOString().slice(0, 10);
    if (stats.clicksToday) m.clicksToday = stats.clicksToday;

    if (stats.clickCount && stats.clickCount > 0) {
      // 追加到趋势
      const existing = m.clicksTrend.find(t => t.date === today);
      if (existing) {
        existing.count += stats.clickCount;
      } else {
        m.clicksTrend.push({ date: today, count: stats.clickCount });
        // 保留30天
        if (m.clicksTrend.length > 30) m.clicksTrend.shift();
      }
    }

    m.lastUpdated = new Date().toISOString();
  }

  // ── 更新转化数据 ─────────────────────────────────
  updateConversions(channelId, convData = {}) {
    const m = this.metrics[channelId];
    if (!m) return;

    m.totalConversions += (convData.count || 0);
    m.conversionValue += (convData.value || 0);

    if (convData.eventType && convData.eventType !== 'page_view') {
      m.conversionEvents[convData.eventType] = (m.conversionEvents[convData.eventType] || 0) + 1;
    }

    // 计算转化率
    m.conversionRate = m.totalClicks > 0
      ? (m.totalConversions / m.totalClicks * 100)
      : 0;

    // 计算ROI
    m.estimatedRevenue = m.conversionValue;
    m.roi = m.estimatedCost > 0
      ? (m.estimatedRevenue / m.estimatedCost)
      : 0;
  }

  // ── 获取单个渠道健康 ─────────────────────────────
  getHealth(channelId) {
    const m = this.metrics[channelId];
    if (!m) return null;

    return {
      channelId: m.channelId,
      name: this.channels[channelId]?.name || channelId,
      icon: this.channels[channelId]?.icon || '📊',

      accounts: {
        total: m.totalAccounts,
        active: m.activeAccounts,
        shadowBanned: m.shadowBannedAccounts,
        dead: m.deadAccounts,
        aliveRate: (m.accountAliveRate * 100).toFixed(1) + '%',
        shadowBanRate: (m.shadowBanRate * 100).toFixed(1) + '%'
      },

      traffic: {
        totalClicks: m.totalClicks,
        clicksToday: m.clicksToday,
        avgClickPerAccount: m.activeAccounts > 0
          ? Math.round(m.totalClicks / m.activeAccounts)
          : 0
      },

      conversion: {
        total: m.totalConversions,
        rate: m.conversionRate.toFixed(2) + '%',
        value: m.conversionValue.toFixed(2),
        byType: { ...m.conversionEvents }
      },

      financial: {
        estimatedCost: m.estimatedCost.toFixed(2),
        estimatedRevenue: m.estimatedRevenue.toFixed(2),
        roi: m.roi.toFixed(2) + 'x',
        costPerConversion: m.totalConversions > 0
          ? (m.estimatedCost / m.totalConversions).toFixed(2)
          : '0.00'
      },

      health: {
        score: m.healthScore,
        trend: m.trend,
        trendPercent: m.trendPercent,
        // 【B0-D3】骨架渠道返回 'unknown' 而非按 0 分算出的 'critical' ——
        // 「没有数据」不等于「健康状况极差」，两者对决策的含义完全相反。
        status: this._isSkeleton(m) ? 'unknown' : this._getStatusLabel(m.healthScore),
        dataQuality: this._isSkeleton(m) ? 'skeleton' : 'live',
        scoreMeaningful: !this._isSkeleton(m),
      },

      // 渠道级数据质量标记（供前端角标/置灰）
      dataQuality: this._isSkeleton(m) ? 'skeleton' : 'live',
      dataQualityNote: this._isSkeleton(m)
        ? '该渠道尚未接入真实数据（账号/点击/转化均为 0），下列指标与评分均为占位值'
        : null,
      dataUpdatedAt: m.dataUpdatedAt || null,

      alerts: m.alerts.slice(-10),
      lastUpdated: m.lastUpdated
    };
  }

  // ── 获取所有渠道健康 ─────────────────────────────
  getAllHealth() {
    const result = {};
    for (const channelId of Object.keys(this.channels)) {
      result[channelId] = this.getHealth(channelId);
    }
    return result;
  }

  // ── 获取渠道排行 ─────────────────────────────────
  getRanking(sortBy = 'roi') {
    const list = Object.keys(this.channels)
      .map(id => {
        const h = this.getHealth(id);
        return {
          channelId: id,
          name: h.name,
          icon: h.icon,
          score: h.health.score,
          conversionRate: parseFloat(h.conversion.rate),
          roi: parseFloat(h.financial.roi),
          clicks: h.traffic.totalClicks,
          conversions: h.conversion.total,
          trend: h.health.trend
        };
      });

    switch (sortBy) {
      case 'roi': list.sort((a, b) => b.roi - a.roi); break;
      case 'conversionRate': list.sort((a, b) => b.conversionRate - a.conversionRate); break;
      case 'clicks': list.sort((a, b) => b.clicks - a.clicks); break;
      case 'score': list.sort((a, b) => b.score - a.score); break;
      default: list.sort((a, b) => b.conversions - a.conversions);
    }

    return list;
  }

  // ── 智能预算分配建议 ─────────────────────────────
  getBudgetAllocation(totalBudget = 100) {
    const ranking = this.getRanking('roi');
    const active = ranking.filter(r => r.roi > 0);
    if (active.length === 0) return [];

    const totalRoi = active.reduce((s, r) => s + r.roi, 0);
    return active.map(r => ({
      channelId: r.channelId,
      name: r.name,
      roi: r.roi.toFixed(2) + 'x',
      suggestedAllocation: totalRoi > 0
        ? Math.round((r.roi / totalRoi) * totalBudget)
        : Math.round(totalBudget / active.length),
      percentage: totalRoi > 0
        ? ((r.roi / totalRoi) * 100).toFixed(1) + '%'
        : (100 / active.length).toFixed(1) + '%'
    }));
  }

  // ── 获取渠道配置 ─────────────────────────────────
  getChannelConfig(channelId) {
    return this.channels[channelId] || null;
  }

  // ── 更新渠道配置 ─────────────────────────────────
  updateChannelConfig(channelId, config = {}) {
    if (!this.channels[channelId]) return null;
    this.channels[channelId] = { ...this.channels[channelId], ...config };
    this.emit('config:updated', { channelId, config: this.channels[channelId] });
    return this.channels[channelId];
  }

  // ── 获取全局统计 ─────────────────────────────────
  getGlobalStats() {
    let totalClicks = 0, totalConversions = 0, totalValue = 0, totalCost = 0;
    for (const id of Object.keys(this.metrics)) {
      const m = this.metrics[id];
      totalClicks += m.totalClicks;
      totalConversions += m.totalConversions;
      totalValue += m.conversionValue;
      totalCost += m.estimatedCost;
    }

    return {
      totalClicks,
      totalConversions,
      totalValue: totalValue.toFixed(2),
      totalCost: totalCost.toFixed(2),
      overallROI: totalCost > 0 ? (totalValue / totalCost).toFixed(2) + 'x' : '0x',
      overallConversionRate: totalClicks > 0
        ? (totalConversions / totalClicks * 100).toFixed(2) + '%'
        : '0%',
      channelsCount: Object.keys(this.channels).length,
      activeChannels: Object.values(this.metrics).filter(m => m.activeAccounts > 0).length
    };
  }

  // ── 重置 ─────────────────────────────────────────
  reset() {
    for (const channelId of Object.keys(this.channels)) {
      this.metrics[channelId] = this._initMetrics(channelId);
    }
  }

  // ── 停止 ─────────────────────────────────────────
  stop() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
    this.removeAllListeners();
  }

  // ── 数据质量判定（B0-D3）───────────────────────────
  // 「骨架渠道」= 从未接入任何真实指标。此时 healthScore 不具业务含义，
  // 前端必须显式标注，不能把它当成真实健康度展示。
  _isSkeleton(m) {
    if (!m) return true;
    return (m.totalAccounts || 0) === 0
      && (m.totalClicks || 0) === 0
      && (m.totalConversions || 0) === 0
      && m.dataQuality !== 'live';
  }

  // ── 注入真实数据（B0-D3）───────────────────────────
  // 供 server.js 从真实数据源（账号库 / 发布记录 / 链接点击）灌入。
  // 只覆盖传入的字段，未传字段保持不变；调用后该渠道标记为 live。
  applyLiveData(channelId, patch = {}) {
    const m = this.metrics[channelId];
    if (!m) return null;
    const ALLOWED = [
      'totalAccounts', 'activeAccounts', 'shadowBannedAccounts', 'deadAccounts',
      'accountAliveRate', 'shadowBanRate',
      'totalClicks', 'uniqueClicks', 'clicksToday',
      'totalConversions', 'conversionsToday', 'conversionRate', 'conversionValue', 'conversionEvents',
      'estimatedCost', 'estimatedRevenue', 'roi',
    ];
    for (const k of ALLOWED) {
      if (patch[k] !== undefined && patch[k] !== null) m[k] = patch[k];
    }
    if (patch.alerts !== undefined) m.alerts = patch.alerts;
    // 只有确实灌入了账号或点击数据才算 live，避免「传了个空对象就变绿的」假活
    if ((m.totalAccounts || 0) > 0 || (m.totalClicks || 0) > 0) {
      m.dataQuality = 'live';
    }
    m.dataUpdatedAt = new Date().toISOString();
    this._recalculate();
    return this.getHealth(channelId);
  }

  // ── 内部方法 ─────────────────────────────────────
  _recalculate() {
    for (const channelId of Object.keys(this.metrics)) {
      const m = this.metrics[channelId];

      // 【B0-D3】骨架渠道不计算分数 —— 无数据时算出来的任何数字都是噪声。
      if (this._isSkeleton(m)) {
        m.healthScore = 0;
        m.trend = 'unknown';
        m.trendPercent = 0;
        continue;
      }

      // 综合评分: 存活率×30 + 转化率×30 + ROI×25 + 趋势×15
      const aliveScore = m.accountAliveRate * 30;
      const convScore = Math.min(m.conversionRate * 10, 30); // 3%转化率=30分
      const roiScore = Math.min(m.roi * 5, 25);              // 5xROI=25分
      const trendScore = m.trend === 'up' ? 15 : m.trend === 'stable' ? 10 : 5;

      const prevScore = m.healthScore;
      m.healthScore = Math.round(aliveScore + convScore + roiScore + trendScore);

      // 计算趋势
      if (m.healthScore > prevScore + 2) {
        m.trend = 'up';
        m.trendPercent = prevScore > 0 ? Math.round((m.healthScore - prevScore) / prevScore * 100) : 0;
      } else if (m.healthScore < prevScore - 2) {
        m.trend = 'down';
        m.trendPercent = prevScore > 0 ? Math.round((prevScore - m.healthScore) / prevScore * 100) : 0;
      } else {
        m.trend = 'stable';
        m.trendPercent = 0;
      }
    }

    this.emit('recalculated', this.getAllHealth());
  }

  _checkAlerts(channelId) {
    const m = this.metrics[channelId];
    if (!m) return;

    // Shadowban 告警
    if (m.shadowBanRate > 0.3) {
      const alert = {
        level: 'warning',
        channel: channelId,
        message: `${this.channels[channelId]?.name} Shadowban率超过30% (当前: ${(m.shadowBanRate * 100).toFixed(1)}%)`,
        timestamp: new Date().toISOString()
      };
      m.alerts.push(alert);
      this.emit('alert', alert);
    }

    // 账号大量死亡
    if (m.deadAccounts > m.activeAccounts && m.activeAccounts > 0) {
      const alert = {
        level: 'critical',
        channel: channelId,
        message: `${this.channels[channelId]?.name} 死亡账号(${m.deadAccounts})超过活跃账号(${m.activeAccounts})`,
        timestamp: new Date().toISOString()
      };
      m.alerts.push(alert);
      this.emit('alert', alert);
    }

    // 转化率骤降
    if (m.conversionRate > 0 && m.totalClicks > 100) {
      // 与历史对比 (简化: 检查过去1小时是否有转化)
      const recentEvents = this.conversionEngine
        ? this.conversionEngine.events.filter(e =>
            e.source === channelId &&
            new Date(e.timestamp).getTime() > Date.now() - 3600000)
        : [];
      if (recentEvents.length === 0 && m.conversionRate > 1) {
        const alert = {
          level: 'warning',
          channel: channelId,
          message: `${this.channels[channelId]?.name} 最近1小时无转化 (历史转化率: ${m.conversionRate.toFixed(2)}%)`,
          timestamp: new Date().toISOString()
        };
        m.alerts.push(alert);
        this.emit('alert', alert);
      }
    }

    // 限制告警数量
    if (m.alerts.length > 100) m.alerts = m.alerts.slice(-50);
  }

  _getStatusLabel(score) {
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'fair';
    if (score >= 20) return 'poor';
    return 'critical';
  }
}

module.exports = { ChannelHealth, DEFAULT_CHANNELS };
