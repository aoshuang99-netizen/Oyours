/**
 * content-strategy-decider.js — MSCMS v14 数据驱动内容策略决定器
 *
 * 核心能力:
 *   1. 读取 ChannelHealth 每平台指标（存活率/转化率/ROI/健康评分）
 *   2. 读取 ConversionEngine 归因数据（哪个平台带最多转化）
 *   3. 读取 DataStore 历史内容表现数据
 *   4. 综合评估产出策略决策:
 *      - 各平台内容分配权重 (allocationWeights)
 *      - 各平台内容风格推荐 (styleRecommendations)
 *      - 各平台话题推荐 (topicRecommendations)
 *      - 禁发/降权平台 (disabledPlatforms / deprioritizedPlatforms)
 *      - 最佳发布时间窗口 (timingRecommendations)
 *
 * 用法:
 *   const { ContentStrategyDecider } = require('./content-strategy-decider.js');
 *   const decider = new ContentStrategyDecider({ channelHealth, conversionEngine, dataStore });
 *   const strategy = decider.decide();  // 返回完整策略对象
 *   decider.getPlatformAllocation();     // 返回 {reddit:0.30, tumblr:0.15, ...}
 */

const { EventEmitter } = require('events');

// ── 默认平台分配权重 (冷启动) ──────────────────────
const DEFAULT_WEIGHTS = {
  reddit: 0.25,
  instagram: 0.20,
  tiktok: 0.15,
  x: 0.10,
  tumblr: 0.10,
  discord: 0.10,
  facebook: 0.10,
};

// ── 话题平台适配矩阵 ──────────────────────────────
const TOPIC_PLATFORM_AFFINITY = {
  programming: { reddit: 0.95, x: 0.85, discord: 0.90, tumblr: 0.50 },
  design: { instagram: 0.95, tumblr: 0.90, tiktok: 0.70, reddit: 0.55 },
  lifestyle: { instagram: 0.95, tiktok: 0.90, facebook: 0.80, tumblr: 0.75 },
  tech: { reddit: 0.90, x: 0.85, discord: 0.80, tumblr: 0.55 },
  gaming: { reddit: 0.90, discord: 0.95, tiktok: 0.80, x: 0.70 },
  art: { instagram: 0.95, tumblr: 0.95, tiktok: 0.85, reddit: 0.50 },
  music: { tiktok: 0.95, tumblr: 0.85, instagram: 0.75, reddit: 0.40 },
  photography: { instagram: 0.95, tumblr: 0.90, reddit: 0.50, facebook: 0.60 },
  books: { tumblr: 0.90, reddit: 0.80, instagram: 0.60, facebook: 0.50 },
  philosophy: { tumblr: 0.85, reddit: 0.80, x: 0.60 },
  culture: { tumblr: 0.85, reddit: 0.70, instagram: 0.65, facebook: 0.60 },
  'self-improvement': { tumblr: 0.75, reddit: 0.80, instagram: 0.70, tiktok: 0.85 },
  gardening: { instagram: 0.90, tumblr: 0.85, facebook: 0.75, tiktok: 0.70 },
  'mental-health': { tumblr: 0.85, reddit: 0.75, instagram: 0.70 },
  startups: { reddit: 0.85, x: 0.90, tumblr: 0.45 },
  devops: { reddit: 0.90, x: 0.80, discord: 0.75 },
  career: { reddit: 0.85, x: 0.80, tumblr: 0.50 },
  agile: { reddit: 0.80, x: 0.75, discord: 0.70 },
  adventure: { instagram: 0.90, tiktok: 0.85, tumblr: 0.80 },
};

// ── 平台风格描述 ──────────────────────────────────
const PLATFORM_STYLE_DESCRIPTORS = {
  reddit: { tone: 'genuine, helpful, curious', length: 'long', emoji: 'minimal', hook: 'question or hot take' },
  instagram: { tone: 'aesthetic, warm, inspirational', length: 'medium', emoji: 'moderate', hook: 'visual description' },
  tiktok: { tone: 'energetic, trendy, casual', length: 'short', emoji: 'high', hook: '5-second grab' },
  x: { tone: 'witty, concise, provocative', length: 'very short', emoji: 'minimal', hook: 'scroll-stopper' },
  tumblr: { tone: 'creative, personal, journal-like', length: 'medium-long', emoji: 'low', hook: 'personal story' },
  discord: { tone: 'friendly, helpful, conversational', length: 'medium', emoji: 'moderate', hook: 'question' },
  facebook: { tone: 'warm, storytelling, relatable', length: 'medium-long', emoji: 'moderate', hook: 'personal anecdote' },
};

// ── 最佳发布时间窗口 (UTC) ────────────────────────
const DEFAULT_BEST_TIMES = {
  reddit: { bestHours: [12, 13, 14, 15, 16], bestDays: [0, 1, 2, 3, 4], description: '工作日中午到下午 (美东)' },
  instagram: { bestHours: [11, 12, 17, 18, 19], bestDays: [1, 2, 3, 4, 5], description: '午休和下班后' },
  tiktok: { bestHours: [10, 11, 17, 18, 19, 20], bestDays: [0, 1, 2, 3, 4, 5, 6], description: '上午和傍晚' },
  x: { bestHours: [12, 13, 14, 15, 16, 17], bestDays: [1, 2, 3, 4], description: '工作日下午' },
  tumblr: { bestHours: [14, 15, 16, 17, 20, 21, 22], bestDays: [0, 1, 2, 3, 4, 5, 6], description: '下午到深夜' },
  discord: { bestHours: [10, 11, 12, 13, 14, 15, 16], bestDays: [0, 1, 2, 3, 4], description: '上午到下午' },
  facebook: { bestHours: [11, 12, 13, 17, 18], bestDays: [2, 3, 4], description: '工作日午休和傍晚' },
};

// ── 策略决定器 ─────────────────────────────────────
class ContentStrategyDecider extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.channelHealth = opts.channelHealth || null;
    this.conversionEngine = opts.conversionEngine || null;
    this.dataStore = opts.dataStore || null;
    this.decisionEngine = opts.decisionEngine || null;

    // 策略缓存
    this._lastStrategy = null;
    this._lastDecideTime = 0;
    this._cacheTTL = 60000; // 1 分钟缓存

    // 学习权重 (随时间调整)
    this._learnedWeights = { ...DEFAULT_WEIGHTS };
    this._weightHistory = [];   // 保留最近 100 次权重记录
    this._topicPerformance = {}; // {topic: {platform: score}}
  }

  /**
   * 主入口: 综合评估产出内容策略
   * @returns {Object} strategy 决策对象
   */
  decide() {
    // 缓存检查
    if (this._lastStrategy && (Date.now() - this._lastDecideTime) < this._cacheTTL) {
      return this._lastStrategy;
    }

    // Phase 1: 收集渠道健康数据
    const channelHealths = this._collectChannelHealth();

    // Phase 2: 收集转化归因数据
    const attributionData = this._collectAttributionData();

    // Phase 3: 收集历史内容表现
    const contentPerformance = this._collectContentPerformance();

    // Phase 4: 计算平台权重
    const allocationWeights = this._computeAllocation(channelHealths, attributionData, contentPerformance);

    // Phase 5: 识别禁发/降权平台
    const { disabledPlatforms, deprioritizedPlatforms } = this._identifyPlatformIssues(channelHealths);

    // Phase 6: 话题推荐
    const topicRecommendations = this._computeTopicRecommendations(contentPerformance, allocationWeights);

    // Phase 7: 风格推荐
    const styleRecommendations = this._computeStyleRecommendations(allocationWeights);

    // Phase 8: 时间推荐
    const timingRecommendations = this._computeTimingRecommendations();

    // 组装策略
    const strategy = {
      timestamp: new Date().toISOString(),
      allocationWeights,
      disabledPlatforms,
      deprioritizedPlatforms,
      topicRecommendations,
      styleRecommendations,
      timingRecommendations,
      platformHealth: channelHealths,
      attributionSummary: this._summarizeAttribution(attributionData),
    };

    // 缓存 & 更新历史
    this._lastStrategy = strategy;
    this._lastDecideTime = Date.now();
    this._weightHistory.push({ ...allocationWeights });
    if (this._weightHistory.length > 100) this._weightHistory.shift();

    this.emit('strategy:updated', strategy);
    return strategy;
  }

  /**
   * 获取仅平台分配权重 (便捷方法)
   */
  getPlatformAllocation() {
    const strategy = this.decide();
    // 将禁发平台权重置零，重新归一化
    const weights = { ...strategy.allocationWeights };
    for (const p of strategy.disabledPlatforms) {
      weights[p] = 0;
    }
    return this._normalize(weights);
  }

  /**
   * 获取推荐的平台列表（按权重排序）
   */
  getRecommendedPlatforms() {
    const alloc = this.getPlatformAllocation();
    const { disabledPlatforms, deprioritizedPlatforms } = this.decide();

    return Object.entries(alloc)
      .filter(([p]) => !disabledPlatforms.includes(p))
      .sort((a, b) => b[1] - a[1])
      .map(([platform, weight]) => ({
        platform,
        weight: (weight * 100).toFixed(1) + '%',
        deprioritized: deprioritizedPlatforms.includes(platform),
        style: PLATFORM_STYLE_DESCRIPTORS[platform] || null,
        topics: this._getTopicsForPlatform(platform),
      }));
  }

  // ═══════════════════════════════════════════════════
  // Phase 1: 渠道健康数据收集
  // ═══════════════════════════════════════════════════
  _collectChannelHealth() {
    if (this.channelHealth) {
      try {
        const all = this.channelHealth.getAllHealth();
        if (all && Object.keys(all).length > 0) return all;
      } catch (e) {
        console.warn(`[ContentStrategy] ChannelHealth 读取失败: ${e.message}`);
      }
    }

    // 从 DataStore 构建快速健康检查
    if (this.dataStore) {
      return this._buildHealthFromDataStore();
    }
    return {};
  }

  _buildHealthFromDataStore() {
    const health = {};
    try {
      const platforms = Object.keys(DEFAULT_WEIGHTS);
      for (const platform of platforms) {
        let accounts = 0, active = 0;
        try {
          const accResult = this.dataStore.list('accounts', { platform });
          const accs = accResult?.items || [];
          accounts = accs.length;
          active = accs.filter(a => a.status === 'active' || a.status === 'S3_MATURE').length;
        } catch (e) { /* ignore */ }

        let totalClicks = 0, totalConversions = 0;
        try {
          // 从 analytics 统计
          const anaResult = this.dataStore.list('analytics', { source: platform });
          const items = anaResult?.items || [];
          totalClicks = items.length;
          totalConversions = items.filter(i => i.conversion_event).length;
        } catch (e) { /* ignore */ }

        health[platform] = {
          accounts: { total: accounts, active, aliveRate: accounts > 0 ? ((active / accounts) * 100).toFixed(1) + '%' : '0%' },
          traffic: { totalClicks, clicksToday: 0 },
          conversion: { total: totalConversions, rate: totalClicks > 0 ? ((totalConversions / totalClicks) * 100).toFixed(2) + '%' : '0%' },
          health: { score: accounts > 0 ? Math.min(100, (active / Math.max(accounts, 1)) * 80 + 20) : 0, trend: 'stable', status: 'unknown' },
        };
      }
    } catch (e) {
      console.warn(`[ContentStrategy] DataStore 健康数据构建失败: ${e.message}`);
    }
    return health;
  }

  // ═══════════════════════════════════════════════════
  // Phase 2: 归因数据收集
  // ═══════════════════════════════════════════════════
  _collectAttributionData() {
    if (this.conversionEngine) {
      try {
        const attr = this.conversionEngine.getSourceAttribution(7, 'last_click');
        if (attr && Object.keys(attr).length > 0) return attr;
      } catch (e) {
        console.warn(`[ContentStrategy] 归因数据读取失败: ${e.message}`);
      }
    }
    return {};
  }

  _summarizeAttribution(attribution) {
    const summary = {};
    for (const [source, data] of Object.entries(attribution)) {
      summary[source] = {
        conversions: data.conversions || data.total || 0,
        value: data.value || data.revenue || 0,
      };
    }
    return summary;
  }

  // ═══════════════════════════════════════════════════
  // Phase 3: 历史内容表现
  // ═══════════════════════════════════════════════════
  _collectContentPerformance() {
    const perf = {};
    if (!this.dataStore) return perf;

    try {
      // 最近 500 条已发布内容
      const result = this.dataStore.list('content', { limit: 500, sort: '-createdAt' });
      const items = result?.items || [];

      for (const item of items) {
        const platform = item.platform || 'unknown';
        const topic = item.topic || 'general';
        const quality = item.quality_score || 50;
        const status = item.status;

        if (!perf[platform]) {
          perf[platform] = { count: 0, totalQuality: 0, topics: {} };
        }
        perf[platform].count++;
        perf[platform].totalQuality += quality;

        if (!perf[platform].topics[topic]) {
          perf[platform].topics[topic] = { count: 0, totalQuality: 0 };
        }
        perf[platform].topics[topic].count++;
        perf[platform].topics[topic].totalQuality += quality;
      }
    } catch (e) {
      console.warn(`[ContentStrategy] 内容表现数据收集失败: ${e.message}`);
    }
    return perf;
  }

  // ═══════════════════════════════════════════════════
  // Phase 4: 权重计算 (核心算法)
  // ═══════════════════════════════════════════════════
  _computeAllocation(channelHealths, attributionData, contentPerformance) {
    const weights = { ...DEFAULT_WEIGHTS };
    const factors = {}; // 记录各因子

    for (const platform of Object.keys(weights)) {
      const ch = channelHealths[platform];
      let score = weights[platform] * 100; // 基础分
      const appliedFactors = [];

      // 因子 1: 账号存活率 (权重 0.25)
      const aliveRate = ch?.accounts?.aliveRate ? parseFloat(ch.accounts.aliveRate) : 0;
      const aliveFactor = aliveRate / 100; // 0-1
      score *= (0.5 + aliveFactor * 0.5); // 最多打 5 折
      appliedFactors.push(`存活率=${aliveRate.toFixed(0)}%`);

      // 因子 2: 健康评分 (权重 0.20)
      const healthScore = ch?.health?.score || 50;
      score *= (0.5 + (healthScore / 100) * 0.5);
      appliedFactors.push(`健康=${healthScore.toFixed(0)}`);

      // 因子 3: 转化效果 (权重 0.30)
      const attribInfo = attributionData[platform];
      if (attribInfo?.conversions > 0) {
        // 有转化的平台加分
        score *= 1.3;
        appliedFactors.push(`转化=${attribInfo.conversions}`);
      } else if (ch?.conversion?.total > 0) {
        score *= 1.15;
        appliedFactors.push(`转化=${ch.conversion.total}`);
      }

      // 因子 4: 内容质量趋势 (权重 0.15)
      const cp = contentPerformance[platform];
      if (cp && cp.count > 0) {
        const avgQuality = cp.totalQuality / cp.count;
        score *= (0.7 + (avgQuality / 100) * 0.6);
        appliedFactors.push(`质量=${avgQuality.toFixed(0)}`);
      }

      // 因子 5: 趋势调整 (权重 0.10)
      const trend = ch?.health?.trend || 'stable';
      if (trend === 'up') { score *= 1.1; appliedFactors.push('趋势↑'); }
      else if (trend === 'down') { score *= 0.8; appliedFactors.push('趋势↓'); }

      // 0 账号的平台直接清零
      if (aliveRate === 0 && (ch?.accounts?.total || 0) === 0) {
        score = 0;
        appliedFactors.push('无账号');
      }

      weights[platform] = score;
      factors[platform] = appliedFactors;
    }

    // 归一化
    const normalized = this._normalize(weights);

    // 平滑：与上一次权重做 EMA（指数移动平均）
    const lastWeights = this._learnedWeights;
    const smoothed = {};
    for (const platform of Object.keys(normalized)) {
      const alpha = 0.3; // 平滑因子
      smoothed[platform] = normalized[platform] * alpha + (lastWeights[platform] || DEFAULT_WEIGHTS[platform]) * (1 - alpha);
    }

    this._learnedWeights = this._normalize(smoothed);

    // 附加调试信息
    this._lastFactors = factors;

    return this._learnedWeights;
  }

  _normalize(weights) {
    const total = Object.values(weights).reduce((s, w) => s + Math.max(0, w), 0);
    if (total <= 0) return { ...DEFAULT_WEIGHTS };

    const normalized = {};
    for (const [key, val] of Object.entries(weights)) {
      normalized[key] = Math.max(0, val) / total;
    }
    return normalized;
  }

  // ═══════════════════════════════════════════════════
  // Phase 5: 平台问题识别
  // ═══════════════════════════════════════════════════
  _identifyPlatformIssues(channelHealths) {
    const disabledPlatforms = [];
    const deprioritizedPlatforms = [];

    for (const [platform, ch] of Object.entries(channelHealths)) {
      if (!ch) continue;

      const aliveRate = ch?.accounts?.aliveRate ? parseFloat(ch.accounts.aliveRate) : 0;
      const healthScore = ch?.health?.score || 100;
      const shadowBanRate = ch?.accounts?.shadowBanRate
        ? parseFloat(ch.accounts.shadowBanRate)
        : 0;

      // 禁发条件: 0 存活账号 或 健康评分 < 10
      if (aliveRate <= 0 || healthScore < 10) {
        disabledPlatforms.push(platform);
      }
      // 降权条件: shadowban > 50% 或 健康评分 < 30 或 趋势下降且评分 < 50
      else if (shadowBanRate > 50 || healthScore < 30 ||
               (ch.health.trend === 'down' && healthScore < 50)) {
        deprioritizedPlatforms.push(platform);
      }
    }

    return { disabledPlatforms, deprioritizedPlatforms };
  }

  // ═══════════════════════════════════════════════════
  // Phase 6: 话题推荐
  // ═══════════════════════════════════════════════════
  _computeTopicRecommendations(contentPerformance, allocationWeights) {
    const recommendations = {};

    // 从历史表现计算每个平台最佳话题
    for (const [platform, weight] of Object.entries(allocationWeights)) {
      if (weight <= 0.01) continue;

      const cp = contentPerformance[platform];
      if (!cp || Object.keys(cp.topics).length === 0) {
        // 无历史数据 → 从话题亲和度矩阵获取
        const affinityTopics = this._getTopicsForPlatform(platform);
        recommendations[platform] = affinityTopics.slice(0, 5);
        continue;
      }

      // 计算每个话题的表现分
      const topicScores = [];
      for (const [topic, data] of Object.entries(cp.topics)) {
        const avgQuality = data.totalQuality / data.count;
        const cntBonus = Math.min(data.count / 10, 1); // 样本量加成
        const affinityBonus = TOPIC_PLATFORM_AFFINITY[topic]?.[platform] || 0.5;

        const score = avgQuality * 0.5 + cntBonus * 30 + affinityBonus * 20;
        topicScores.push({ topic, score, count: data.count });
      }
      topicScores.sort((a, b) => b.score - a.score);
      recommendations[platform] = topicScores.slice(0, 5).map(t => t.topic);
    }

    return recommendations;
  }

  _getTopicsForPlatform(platform) {
    const entries = Object.entries(TOPIC_PLATFORM_AFFINITY)
      .filter(([_, scores]) => scores[platform] >= 0.4)
      .map(([topic, scores]) => ({ topic, affinity: scores[platform] }))
      .sort((a, b) => b.affinity - a.affinity);
    return entries.map(e => e.topic);
  }

  // ═══════════════════════════════════════════════════
  // Phase 7: 风格推荐
  // ═══════════════════════════════════════════════════
  _computeStyleRecommendations(allocationWeights) {
    const styles = {};
    for (const [platform, weight] of Object.entries(allocationWeights)) {
      if (weight <= 0.01) continue;
      const descriptor = PLATFORM_STYLE_DESCRIPTORS[platform];
      if (descriptor) {
        styles[platform] = {
          ...descriptor,
          priority: (weight * 100).toFixed(1) + '%',
        };
      }
    }
    return styles;
  }

  // ═══════════════════════════════════════════════════
  // Phase 8: 时间推荐
  // ═══════════════════════════════════════════════════
  _computeTimingRecommendations() {
    return { ...DEFAULT_BEST_TIMES };
  }

  /**
   * 获取当前策略摘要（用于 API）
   */
  getSummary() {
    const s = this.decide();
    return {
      generation_time: s.timestamp,
      active_platforms: Object.keys(s.allocationWeights).filter(p => !s.disabledPlatforms.includes(p)),
      disabled_platforms: s.disabledPlatforms,
      deprioritized_platforms: s.deprioritizedPlatforms,
      top_platforms: Object.entries(s.allocationWeights)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([p, w]) => ({ platform: p, weight: (w * 100).toFixed(1) + '%' })),
      allocation_factors: this._lastFactors || {},
    };
  }

  /**
   * 获取分配给指定平台的内容数量（基于 totalBudget）
   */
  allocateContentQuota(totalBudget, platforms = null) {
    const alloc = this.getPlatformAllocation();
    const targetPlatforms = platforms || Object.keys(alloc).filter(p => alloc[p] > 0);

    const quota = {};
    let assignedInt = 0;
    const fractional = [];

    // 先分配整数部分
    for (const platform of targetPlatforms) {
      const raw = alloc[platform] * totalBudget;
      const intPart = Math.floor(raw);
      quota[platform] = intPart;
      assignedInt += intPart;
      if (raw - intPart > 0.001) {
        fractional.push({ platform, fraction: raw - intPart });
      }
    }

    // 按小数部分从大到小补足剩余
    const remaining = totalBudget - assignedInt;
    fractional.sort((a, b) => b.fraction - a.fraction);
    for (let i = 0; i < remaining; i++) {
      if (i < fractional.length) {
        quota[fractional[i].platform]++;
      }
    }

    return quota;
  }

  /**
   * 记录发布结果，更新话题表现
   */
  recordPublishResult(platform, topic, qualityScore, success) {
    if (!topic) return;

    if (!this._topicPerformance[topic]) {
      this._topicPerformance[topic] = {};
    }
    if (!this._topicPerformance[topic][platform]) {
      this._topicPerformance[topic][platform] = { count: 0, success: 0, totalQuality: 0 };
    }

    const tp = this._topicPerformance[topic][platform];
    tp.count++;
    if (success) tp.success++;
    tp.totalQuality += qualityScore || 0;
  }

  /**
   * 获取调试信息
   */
  getDebugInfo() {
    const s = this.decide();
    return {
      strategy: s,
      learnedWeights: { ...this._learnedWeights },
      weightHistory: this._weightHistory.slice(-10),
      topicPerformance: { ...this._topicPerformance },
    };
  }
}

module.exports = { ContentStrategyDecider, DEFAULT_WEIGHTS, PLATFORM_STYLE_DESCRIPTORS, TOPIC_PLATFORM_AFFINITY };
