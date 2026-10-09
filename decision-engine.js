/**
 * decision-engine.js — MSCMS v14 自主决策闭环与自进化系统
 *
 * 核心能力：
 *   1. RL-LLM-AB 混合决策框架
 *   2. 7状态决策状态机（IDLE→MONITORING→VIRAL_DETECTED→CLONING→SYNCING→LEARNING）
 *   3. Thompson Sampling + Epsilon-Greedy 策略优化
 *   4. Q-learning 状态-动作值更新
 *   5. Content DNA 进化机制
 *   6. 5维自适应学习（风格、时机、变异、同步、平台算法）
 *   7. 5大策略库
 *   8. 日/周自动进化报告
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 决策状态机 ───────────────────────────────────
const DecisionState = {
  IDLE: 'IDLE',
  MONITORING: 'MONITORING',
  VIRAL_DETECTED: 'VIRAL_DETECTED',
  CLONING: 'CLONING',
  SYNCING: 'SYNCING',
  LEARNING: 'LEARNING',
  COOLDOWN: 'COOLDOWN',
  PAUSED: 'PAUSED',
};

const StateTransitions = {
  IDLE: ['MONITORING', 'PAUSED'],
  MONITORING: ['VIRAL_DETECTED', 'LEARNING', 'IDLE', 'PAUSED'],
  VIRAL_DETECTED: ['CLONING', 'SYNCING', 'LEARNING', 'PAUSED'],
  CLONING: ['SYNCING', 'LEARNING', 'COOLDOWN', 'PAUSED'],
  SYNCING: ['LEARNING', 'COOLDOWN', 'IDLE', 'PAUSED'],
  LEARNING: ['IDLE', 'MONITORING', 'COOLDOWN', 'PAUSED'],
  COOLDOWN: ['IDLE', 'MONITORING', 'PAUSED'],
  PAUSED: ['IDLE', 'MONITORING'],
};

// ── Q-Learning 引擎 ──────────────────────────────
class QLearningEngine {
  constructor(opts = {}) {
    this.learningRate = opts.learningRate || 0.1;
    this.discountFactor = opts.discountFactor || 0.9;
    this.epsilon = opts.epsilon || 0.1;
    this.qTable = new Map(); // state_action → value
    this.actionSpace = [
      'browse', 'like', 'follow', 'comment', 'share', 'post',
      'clone', 'sync', 'boost', 'pause', 'resume', 'adjust_frequency',
    ];
    this.states = [
      'low_engagement', 'normal_engagement', 'high_engagement',
      'viral_detected', 'cooldown', 'risk_high',
    ];
  }

  _getKey(state, action) { return `${state}:${action}`; }

  getQValue(state, action) {
    return this.qTable.get(this._getKey(state, action)) || 0;
  }

  setQValue(state, action, value) {
    this.qTable.set(this._getKey(state, action), value);
  }

  // Epsilon-greedy 选择动作
  selectAction(state, availableActions) {
    if (Math.random() < this.epsilon) {
      // 探索：随机选择
      return availableActions[Math.floor(Math.random() * availableActions.length)];
    }
    // 利用：选择Q值最高的
    let bestAction = availableActions[0];
    let bestValue = -Infinity;
    for (const action of availableActions) {
      const value = this.getQValue(state, action);
      if (value > bestValue) {
        bestValue = value;
        bestAction = action;
      }
    }
    return bestAction;
  }

  // Q值更新
  update(state, action, reward, nextState) {
    const key = this._getKey(state, action);
    const currentQ = this.qTable.get(key) || 0;

    // 计算下一状态的最大Q值
    let maxNextQ = 0;
    for (const a of this.actionSpace) {
      const nextQ = this.getQValue(nextState, a);
      if (nextQ > maxNextQ) maxNextQ = nextQ;
    }

    // Q-learning 更新公式
    const newQ = currentQ + this.learningRate * (reward + this.discountFactor * maxNextQ - currentQ);
    this.qTable.set(key, newQ);

    return newQ;
  }

  // Thompson Sampling
  thompsonSample(state, actions) {
    const sampled = actions.map(action => {
      const q = this.getQValue(state, action);
      const variance = 0.1; // 简化版
      const sample = q + this._gaussianNoise(0, variance);
      return { action, sample };
    });
    sampled.sort((a, b) => b.sample - a.sample);
    return sampled[0].action;
  }

  _gaussianNoise(mean, std) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // 导出Q表（用于持久化）
  exportQTable() {
    return Array.from(this.qTable.entries()).map(([key, value]) => {
      const [state, action] = key.split(':');
      return { state, action, value };
    });
  }

  // 导入Q表
  importQTable(data) {
    for (const { state, action, value } of data) {
      this.qTable.set(`${state}:${action}`, value);
    }
  }
}

// ── AB测试引擎 ───────────────────────────────────
class ABTestEngine {
  constructor() {
    this.tests = new Map();
  }

  createTest(name, variants, metrics = ['ctr', 'engagement_rate', 'conversion_rate']) {
    const test = {
      id: `ab_${Date.now()}_${crypto.randomBytes(3'hex')}`,
      name,
      variants: variants.map((v, i) => ({
        id: `v${i}`,
        name: v.name || `Variant ${i + 1}`,
        config: v.config,
        impressions: 0,
        metrics: {},
        score: 0,
      })),
      metrics,
      status: 'running',
      startedAt: new Date().toISOString(),
      winner: null,
    };

    // 初始化指标
    for (const variant of test.variants) {
      for (const m of metrics) {
        variant.metrics[m] = { total: 0, count: 0, avg: 0 };
      }
    }

    this.tests.set(test.id, test);
    return test;
  }

  // 分配流量（Epsilon-greedy 分配）
  assignVariant(testId) {
    const test = this.tests.get(testId);
    if (!test) return null;

    // 如果某些变体还没有曝光，优先分配
    const minImpressions = Math.min(...test.variants.map(v => v.impressions));
    if (minImpressions < 10) {
      const leastTested = test.variants.find(v => v.impressions === minImpressions);
      return leastTested;
    }

    // Epsilon-greedy: 90% 最优, 10% 探索
    if (Math.random() < 0.1) {
      return test.variants[Math.floor(Math.random() * test.variants.length)];
    }

    return test.variants.reduce((best, v) => v.score > best.score ? v : best, test.variants[0]);
  }

  // 记录结果
  recordResult(testId, variantId, metricName, value) {
    const test = this.tests.get(testId);
    if (!test) return;

    const variant = test.variants.find(v => v.id === variantId);
    if (!variant) return;

    variant.impressions++;
    if (variant.metrics[metricName]) {
      variant.metrics[metricName].total += value;
      variant.metrics[metricName].count++;
      variant.metrics[metricName].avg = variant.metrics[metricName].total / variant.metrics[metricName].count;
    }

    // 更新综合分数
    variant.score = this._calculateScore(variant, test.metrics);
  }

  // 确定胜者
  determineWinner(testId, confidenceThreshold = 0.95) {
    const test = this.tests.get(testId);
    if (!test) return null;

    const sorted = [...test.variants].sort((a, b) => b.score - a.score);
    const winner = sorted[0];

    if (winner.impressions >= 100) {
      test.winner = winner;
      test.status = 'completed';
      return { winner, confidence: Math.min(1, winner.impressions / 200), allScores: sorted.map(v => ({ id: v.id, name: v.name, score: v.score, impressions: v.impressions })) };
    }

    return { winner, confidence: winner.impressions / 100, status: 'insufficient_data' };
  }

  _calculateScore(variant, metricNames) {
    let score = 0;
    for (const m of metricNames) {
      if (variant.metrics[m]) {
        score += variant.metrics[m].avg * (m === 'ctr' ? 100 : 1);
      }
    }
    return score / metricNames.length;
  }
}

// ── 自进化系统 ───────────────────────────────────
class EvolutionSystem extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.db = opts.db || null;
    this.eventBus = opts.eventBus || null;
    this.dataStore = opts.dataStore || null;
    this.qLearning = new QLearningEngine(opts);
    this.abTest = new ABTestEngine();
    this.Libraries = new Map();
    this.evolutionHistory = [];

    this._initStrategyLibraries();
    this._loadFromStore();
  }

  /**
   * 从 DataStore 加载已保存的策略权重（覆盖默认值）
   */
  _loadFromStore() {
    if (!this.dataStore) return;
    try {
      const saved = this.dataStore.list('evolution_strategies', { limit: 1000 }).items;
      for (const record of saved) {
        const lib = this.Libraries.get(record.library);
        if (lib) {
          const strat = lib.strategies.find(s => s.id === record._id);
          if (strat) {
            strat.weight = record.weight;
          }
        }
      }
      if (saved.length > 0) {
        console.log(`[evolution] Loaded ${saved.length}  weights from DataStore`);
      }
    } catch (e) {
      console.error('[evolution] Load from store failed:', e.message);
    }
  }

  /**
   * 保存策略权重到 DataStore
   */
  _saveToStore(library, ) {
    if (!this.dataStore) return;
    try {
      const existing = this.dataStore.list('evolution_strategies', {
        filter: { library, _id: .id }
      }).items;
      
      if (existing.length > 0) {
        this.dataStore.update('evolution_strategies', existing[0].id, {
          weight: .weight
        });
      } else {
        this.dataStore.create('evolution_strategies', {
          library,
          _id: .id,
          weight: .weight,
          params: .params
        });
      }
    } catch (e) {
      console.error('[evolution] Save to store failed:', e.message);
    }
  }

  _initStrategyLibraries() {
    this.Libraries.set('style', {
      name: '风格策略库',
      parameters: ['tone', 'emoji_level', 'hook_style', 'narrative_pattern', 'visual_style'],
      strategies: [
        { id: 'style_energetic', name: '高能量', weight: 1.0, params: { tone: 0.8, emoji_level: 0.7, hook_style: 'direct' } },
        { id: 'style_casual', name: '轻松随意', weight: 1.0, params: { tone: 0.4, emoji_level: 0.5, hook_style: 'question' } },
        { id: 'style_educational', name: '教育科普', weight: 1.0, params: { tone: 0.6, emoji_level: 0.3, hook_style: 'statistic' } },
        { id: 'style_emotional', name: '情感共鸣', weight: 1.0, params: { tone: 0.3, emoji_level: 0.6, hook_style: 'story' } },
        { id: 'style_mysterious', name: '悬念揭秘', weight: 1.0, params: { tone: 0.5, emoji_level: 0.2, hook_style: 'cliffhanger' } },
      ],
    });

    this.Libraries.set('timing', {
      name: '时机策略库',
      parameters: ['post_hour', 'post_day', 'frequency_per_day', 'interval_between_posts'],
      strategies: [
        { id: 'timing_morning', name: '早晨优先', weight: 1.0, params: { post_hour: 8, frequency_per_day: 2 } },
        { id: 'timing_evening', name: '晚间优先', weight: 1.0, params: { post_hour: 20, frequency_per_day: 3 } },
        { id: 'timing_peak', name: '高峰排期', weight: 1.0, params: { post_hour: 19, frequency_per_day: 4 } },
      ],
    });

    this.Libraries.set('variation', {
      name: '变异策略库',
      parameters: ['synonym_rate', 'sentence_reorder', 'semantic_rewrite', 'style_shift', 'structure_swap'],
      strategies: [
        { id: 'var_light', name: '轻度变异', weight: 1.0, params: { synonym_rate: 0.2, style_shift: 0.1 } },
        { id: 'var_moderate', name: '中度变异', weight: 1.0, params: { synonym_rate: 0.4, style_shift: 0.3 } },
        { id: 'var_heavy', name: '重度变异', weight: 1.0, params: { synonym_rate: 0.7, style_shift: 0.6 } },
      ],
    });

    this.Libraries.set('sync', {
      name: '同步策略库',
      parameters: ['sync_trigger_threshold', 'sync_batch_size', 'sync_delay_minutes', 'max_sync_per_day'],
      strategies: [
        { id: 'sync_aggressive', name: '激进同步', weight: 1.0, params: { sync_trigger_threshold: 60, sync_batch_size: 20 } },
        { id: 'sync_moderate', name: '适度同步', weight: 1.0, params: { sync_trigger_threshold: 75, sync_batch_size: 10 } },
        { id: 'sync_conservative', name: '保守同步', weight: 1.0, params: { sync_trigger_threshold: 85, sync_batch_size: 5 } },
      ],
    });

    this.Libraries.set('', {
      name: '平台算法策略库',
      parameters: ['hashtag_count', 'video_duration', 'caption_length', 'music_trending', 'first_frame_hook'],
      strategies: [
        { id: '_short', name: '短内容优先', weight: 1.0, params: { video_duration: 15, caption_length: 100 } },
        { id: '_medium', name: '中等内容', weight: 1.0, params: { video_duration: 30, caption_length: 200 } },
        { id: '_long', name: '长内容', weight: 1.0, params: { video_duration: 60, caption_length: 400 } },
      ],
    });
  }

  // 进化：基于表现数据调整策略权重
  evolve(performanceData) {
    const evolutions = [];

    for (const [libName, library] of this.Libraries) {
      for (const  of library.strategies) {
        // 检查该策略是否被使用且表现好
        const usage = performanceData.strategies?.[.id];
        if (usage) {
          const { impressions, engagement } = usage;

          // 表现好的策略增加权重
          if (engagement > 0.05 && impressions > 100) {
            .weight = Math.min(3.0, .weight * 1.05);
            this._saveToStore(libName, );
            evolutions.push({
              library: libName,
              : .id,
              oldWeight: .weight / 1.05,
              newWeight: .weight,
              reason: 'high_performance',
              improvement: 5,
            });
          }

          // 表现差的策略降低权重
          if (engagement < 0.01 && impressions > 100) {
            .weight = Math.max(0.3, .weight * 0.95);
            this._saveToStore(libName, );
            evolutions.push({
              library: libName,
              : .id,
              oldWeight: .weight / 0.95,
              newWeight: .weight,
              reason: 'low_performance',
              improvement: -5,
            });
          }
        }
      }
    }

    if (evolutions.length > 0) {
      this.evolutionHistory.push({
        timestamp: new Date().toISOString(),
        evolutions,
        performanceData,
      });

      this.emit('evolution:updated', { count: evolutions.length, evolutions });
    }

    return evolutions;
  }

  // 获取当前最优策略
  getBestStrategy(libraryName) {
    const library = this.Libraries.get(libraryName);
    if (!library) return null;

    // 按权重排序，选择最优
    const sorted = [...library.strategies].sort((a, b) => b.weight - a.weight);
    return sorted[0];
  }

  // 根据权重随机选择策略（Thompson Sampling）
  sampleStrategy(libraryName) {
    const library = this.Libraries.get(libraryName);
    if (!library) return null;

    const totalWeight = library.strategies.reduce((s, st) => s + st.weight, 0);
    let rand = Math.random() * totalWeight;

    for (const  of library.strategies) {
      rand -= .weight;
      if (rand <= 0) return ;
    }

    return library.strategies[library.strategies.length - 1];
  }

  // 生成进化报告
  generateReport(period = 'daily') {
    const recentEvolutions = this.evolutionHistory.filter(e => {
      const age = Date.now() - new Date(e.timestamp).getTime();
      return period === 'daily' ? age < 86400000 : age < 604800000;
    });

    const summary = {};
    for (const lib of this.Libraries.keys()) {
      summary[lib] = { evolved: 0, improved: 0, degraded: 0 };
    }

    for (const record of recentEvolutions) {
      for (const ev of record.evolutions) {
        if (!summary[ev.library]) summary[ev.library] = { evolved: 0, improved: 0, degraded: 0 };
        summary[ev.library].evolved++;
        if (ev.improvement > 0) summary[ev.library].improved++;
        else summary[ev.library].degraded++;
      }
    }

    return {
      period,
      generatedAt: new Date().toISOString(),
      totalEvolutions: recentEvolutions.reduce((s, e) => s + e.evolutions.length, 0),
      summary,
      currentBestStrategies: Object.fromEntries(
        Array.from(this.Libraries.keys()).map(name => [name, this.getBestStrategy(name)])
      ),
      recommendations: this._generateRecommendations(),
    };
  }

  _generateRecommendations() {
    const recs = [];
    for (const [name, lib] of this.Libraries) {
      const best = this.getBestStrategy(name);
      if (best && best.weight > 2.0) {
        recs.push({ library: name, : best.name, recommendation: '继续保持当前策略，性能优异' });
      } else if (best && best.weight < 0.5) {
        recs.push({ library: name, : best.name, recommendation: '建议尝试其他策略变体' });
      }
    }
    return recs;
  }

  // 根据进化调整Content DNA
  evolveDNA(dna, performanceData) {
    const evolved = JSON.parse(JSON.stringify(dna));
    
    // 根据表现调整变异参数
    if (performanceData.viralScore >= 85) {
      // 爆款：降低变异率，保留成功元素
      evolved.variationParams.synonymRate *= 0.7;
      evolved.variationParams.semanticRewrite *= 0.6;
      evolved.variationParams.styleShift *= 0.5;
    } else if (performanceData.viralScore < 30) {
      // 表现差：增加变异率，探索新方向
      evolved.variationParams.synonymRate = Math.min(1, evolved.variationParams.synonymRate * 1.3);
      evolved.variationParams.styleShift = Math.min(1, evolved.variationParams.styleShift * 1.5);
      evolved.variationParams.structureSwap = Math.min(1, evolved.variationParams.structureSwap * 1.4);
    }

    // 根据平台表现调整格式DNA
    if (performanceData.engagementRate > 5) {
      evolved.formatDNA.type = performanceData.bestFormat || evolved.formatDNA.type;
    }

    evolved.updatedAt = new Date().toISOString();
    evolved.evolutionVersion = (evolved.evolutionVersion || 1) + 1;

    return evolved;
  }
}

// ── 自主决策引擎 ─────────────────────────────────
class AutonomousDecisionEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.db = opts.db || null;
    this.eventBus = opts.eventBus || null;
    this.dataStore = opts.dataStore || null;
    // B3 (P1-3): 接收病毒信号真实克隆/同步的执行结果，回灌 Q-learning
    if (this.eventBus && typeof this.eventBus.on === '') {
      this.eventBus.on('decision:viral-result', 'decision-engine', (r) => this._onViralResult(r));
    }
    this.qLearning = new QLearningEngine(opts);
    this.evolution = new EvolutionSystem(opts);
    this.abTest = new ABTestEngine();
    this.state = DecisionState.IDLE;
    this.decisionHistory = [];
    this.currentContent = null;
    this.stateTimers = new Map();
    this._modules = null;
    this._cycleInterval = null;
    this._lastDAU = { current: 0, target: 0, gap: 0 };
    this._cycleCount = 0;
  }

  /**
   * 启动自动巡检 — 每 30s 读取 7 阶段真实 getStats()
   */
  startAutoCycle(modules) {
    this._modules = modules;
    if (this._cycleInterval) clearInterval(this._cycleInterval);
    
    // 首次延迟 10s 启动
    setTimeout(() => this._runCycle(), 10000);
    
    this._cycleInterval = setInterval(() => this._runCycle(), 30000);
    console.log('[decision] Auto-cycle started: 30s interval');
  }

  /**
   * 停止自动巡检
   */
  stopAutoCycle() {
    if (this._cycleInterval) {
      clearInterval(this._cycleInterval);
      this._cycleInterval = null;
    }
  }

  /**
   * 自动巡检主循环 — 读取真实数据，驱动决策
   */
  async _runCycle() {
    if (!this._modules) return;
    this._cycleCount++;
    
    try {
      // 采集 7 阶段真实 KPI
      const stats = this._collectStageStats();
      
      // 判断当前状态
      const newState = this._evaluateState(stats);
      if (newState !== this.state) {
        this.transition(newState);
      }
      
      // 如果不在 IDLE/PAUSED，执行决策
      if (this.state !== DecisionState.IDLE && this.state !== DecisionState.PAUSED) {
        const action = this.getOptimalAction();
        if (action) {
          await this._executeAction(action, stats);
        }
      }
      
      // DAU 低于目标 50% → emit action.execute 加大营销
      if (stats.dau) {
        const tgt = stats.dau.targetDAU || stats.dau.dailyTarget || 0;
        const ratio = tgt > 0 ? stats.dau.currentDAU / tgt : 0;
        if (ratio > 0 && ratio < 0.5) {
          if (this.eventBus) {
            this.eventBus.emit('action.execute', {
              action_type: 'increase_marketing',
              params: { intensity: 'high', reason: `DAU at ${Math.round(ratio * 100)}% of target` },
              reason: `DAU below 50% threshold (${stats.dau.currentDAU}/${stats.dau.targetDAU})`
            }, 'decision-engine');
          }
        }
      }
      
      // 内容 CTR < 1% → emit action.execute 切换 prompt
      if (stats.content && stats.content.avgCTR !== undefined && stats.content.avgCTR < 0.01) {
        if (this.eventBus) {
          this.eventBus.emit('action.execute', {
            action_type: 'switch_prompt',
            params: { reason: 'low_ctr', currentCTR: stats.content.avgCTR },
            reason: `Content CTR below 1% (${(stats.content.avgCTR * 100).toFixed(2)}%)`
          }, 'decision-engine');
        }
      }
      
    } catch (e) {
      console.error('[decision] Cycle error:', e.message);
    }
  }

  /**
   * 采集 7 阶段真实统计
   */
  _collectStageStats() {
    const m = this._modules;
    const stats = {};
    
    try { stats. = m.deviceManager?.getStats?.() || {}; } catch {}
    try { stats.devices = m.deviceManager?.getStats?.() || {}; } catch {}
    try { stats.nurturing = m.nurturing?.getStats?.() || {}; } catch {}
    try { stats.content = m.contentGenerator?.getStats?.() || {}; } catch {}
    try { stats.publish = m.publisher?.getStats?.() || {}; } catch {}
    try { stats.marketing = m.proactiveMarketing?.getStats?.() || {}; } catch {}
    try { stats.analytics = m.websiteAnalytics?.getStats?.() || {}; } catch {}
    try { stats.traffic = m.trafficRouter?.getStats?.() || {}; } catch {}
    try { stats.dau = m.dauController?.getStatus?.() || {}; } catch {}
    
    return stats;
  }

  /**
   * 根据真实数据评估状态
   */
  _evaluateState(stats) {
    // DAU 远低于目标 → MONITORING（主动监控+调节）
    if (stats.dau) {
      const tgt = stats.dau.targetDAU || stats.dau.dailyTarget || 0;
      if (tgt > 0) {
        const ratio = stats.dau.currentDAU / tgt;
        if (ratio < 0.5) return DecisionState.MONITORING;
      }
    }
    
    // 营销触达量大 → MONITORING
    if (stats.marketing && stats.marketing.totalReached > 100) {
      return DecisionState.MONITORING;
    }
    
    // 设备在线 < 3 → COOLDOWN（资源不足）
    if (stats.devices && stats.devices.online < 3 && stats.devices.total > 0) {
      return DecisionState.COOLDOWN;
    }
    
    return DecisionState.IDLE;
  }

  /**
   * 执行决策动作
   */
  async _executeAction(action, stats) {
    const decision = {
      id: `dec_${Date.now()}_${crypto.randomBytes(3'hex')}`,
      action,
      state: this.state,
      stats: JSON.parse(JSON.stringify(stats)),
      timestamp: new Date().toISOString()
    };
    
    this.decisionHistory.push(decision);
    if (this.decisionHistory.length > 200) {
      this.decisionHistory = this.decisionHistory.slice(-200);
    }
    
    this.emit('decision:made', decision);
  }

  /**
   * DAU 更新回调（由 EventBus 触发）
   */
  onDAUUpdate(data) {
    this._lastDAU = {
      current: data.currentDAU || 0,
      target: data.targetDAU || 0,
      gap: data.gap || 0
    };
    
    // 如果 DAU 有目标且差距大 → 切换到 MONITORING
    if (data.targetDAU > 0 && data.gap > data.targetDAU * 0.3) {
      if (this.state === DecisionState.IDLE) {
        this.transition(DecisionState.MONITORING);
      }
    }
  }

  /**
   * 链路停滞回调
   */
  onChainStalled(data) {
    console.warn(`[decision] Chain stalled: ${data.event}`);
    if (this.state !== DecisionState.PAUSED) {
      this.transition(DecisionState.MONITORING);
    }
    // 如果停滞超过 10 分钟，触发全局诊断
    if (data.stalledMinutes > 10) {
      this.emit('decision:chain_stalled', data);
    }
  }

  // 转换状态
  transition(newState) {
    const valid = StateTransitions[this.state];
    if (!valid || !valid.includes(newState)) {
      this.emit('decision:invalid_transition', { from: this.state, to: newState });
      return false;
    }

    const oldState = this.state;
    this.state = newState;

    // 状态超时保护
    this._setupStateTimeout(newState);

    this.emit('decision:transition', { from: oldState, to: newState, timestamp: new Date().toISOString() });
    return true;
  }

  // 处理病毒信号
  async handleViralSignal(signal) {
    if (signal.signalType === 'VIRAL_IMMINENT' || signal.signalType === 'STRONG_UPWARD') {
      if (!this.transition(DecisionState.VIRAL_DETECTED)) return;

      this.currentContent = signal;

      // 决策：克隆策略选择
      const bestStrategy = this.evolution.getBestStrategy('variation');
      const cloneCount = signal.signalType === 'VIRAL_IMMINENT' ? 10 : 5;
      const variationIntensity = bestStrategy?.params?.synonym_rate || 0.4;

      const decision = {
        id: `dec_${Date.now()}_${crypto.randomBytes(3'hex')}`,
        signal,
        action: 'clone_and_sync',
        params: {
          cloneCount,
          variationIntensity,
          Id: bestStrategy?.id || 'var_moderate',
          syncAll: signal.signalType === 'VIRAL_IMMINENT',
        },
        state: this.state,
        timestamp: new Date().toISOString(),
      };

      this.decisionHistory.push(decision);
      this.emit('decision:made', decision);

      // 进入克隆状态
      if (this.transition(DecisionState.CLONING)) {
        this.emit('decision:cloning', decision);

        // B3 (P1-3): 真实执行克隆+发布（移除 setTimeout 模拟）
        // 通过 eventBus 把克隆/同步任务派发给主服务的真实执行器（v14Modules.tumblrPublisher），
        // 执行器完成真实发布后回灌 decision:viral-result（含真实成功数）。
        if (this.eventBus) {
          this.eventBus.emit('decision:viral-execute', {
            decision,
            signal,
            cloneCount,
            variationIntensity,
            Id: bestStrategy?.id || 'var_moderate',
            syncAll: signal.signalType === 'VIRAL_IMMINENT',
            variantId: signal.variantId,
            accountId: signal.accountId,
          }, 'decision-engine');
        } else {
          console.warn('[decision] 无 eventBus，病毒信号克隆未执行（诚实，不伪造成功）');
        }

        // 进入同步状态（真实发布在后台执行；结果经 decision:viral-result 回灌 Q-learning）
        if (this.transition(DecisionState.SYNCING)) {
          this.emit('decision:syncing', decision.params);
        }
      }

      return decision;
    }

    return null;
  }

  /**
   * B3 (P1-3): 病毒信号真实执行结果回灌
   * 由主服务真实克隆/发布执行器通过 eventBus 派发 decision:viral-result 调用。
   * 用真实发布成功数更新 Q-learning，而非模拟奖励。
   */
  _onViralResult(r) {
    if (!r) return;
    const cloneCount = Math.max(1, r.cloneCount || 1);
    const successCount = r.successCount || 0;
    // 真实奖励：成功发布占比 × 10（0~10）
    const reward = (successCount / cloneCount) * 10;
    try {
      this.qLearning.update('viral_detected', 'clone_and_sync', reward, 'learning');
    } catch (e) { /* Q-learning 容错 */ }
    this.emit('decision:learning', {
      reward,
      successCount,
      cloneCount,
      qValue: this.qLearning.getQValue ? this.qLearning.getQValue('viral_detected', 'clone_and_sync') : undefined,
    });
    // 学习完成，回到监控（仅状态机复位，不再模拟克隆/同步本身）
    if (this.transition(DecisionState.LEARNING)) {
      setTimeout(() => this.transition(DecisionState.MONITORING), 1000);
    } else {
      this.transition(DecisionState.MONITORING);
    }
  }

  // 获取下一个最优动作
  getOptimalAction(state) {
    const stateStr = state || this._mapState(this.state);
    const availableActions = this._getAvailableActions(stateStr);
    return this.qLearning.thompsonSample(stateStr, availableActions);
  }

  // 记录决策结果
  recordOutcome(decisionId, outcome, reward) {
    const decision = this.decisionHistory.find(d => d.id === decisionId);
    if (!decision) return;

    decision.outcome = outcome;
    decision.reward = reward;

    const stateStr = this._mapState(decision.state);
    this.qLearning.update(stateStr, decision.action, reward, this._mapState(this.state));

    // 触发进化
    this.evolution.evolve({
      strategies: {
        [decision.params?.Id || 'unknown']: {
          impressions: 1,
          engagement: reward / 10,
        },
      },
      viralScore: reward * 10,
      engagementRate: reward,
    });
  }

  // 获取统计信息
  getStats() {
    return {
      currentState: this.state,
      totalDecisions: this.decisionHistory.length,
      cycleCount: this._cycleCount,
      lastDAU: this._lastDAU,
      autoCycleActive: !!this._cycleInterval,
      recentDecisions: this.decisionHistory.slice(-20),
      qTableSize: this.qLearning.qTable.size,
      bestActions: this._getTopActions(5),
      evolutionStats: this.evolution.generateReport('daily'),
    };
  }

  // ── 内部 ─────────────────────────────────────
  _mapState(state) {
    const map = {
      [DecisionState.IDLE]: 'normal_engagement',
      [DecisionState.MONITORING]: 'normal_engagement',
      [DecisionState.VIRAL_DETECTED]: 'high_engagement',
      [DecisionState.CLONING]: 'viral_detected',
      [DecisionState.SYNCING]: 'viral_detected',
      [DecisionState.LEARNING]: 'normal_engagement',
      [DecisionState.COOLDOWN]: 'cooldown',
      [DecisionState.PAUSED]: 'risk_high',
    };
    return map[state] || 'normal_engagement';
  }

  _getAvailableActions(state) {
    const actions = {
      normal_engagement: ['browse', 'like', 'follow', 'comment', 'adjust_frequency'],
      high_engagement: ['clone', 'sync', 'boost', 'post'],
      viral_detected: ['clone', 'sync', 'boost'],
      cooldown: ['browse', 'like', 'pause'],
      risk_high: ['pause', 'resume', 'adjust_frequency'],
    };
    return actions[state] || ['browse', 'like'];
  }

  _getTopActions(n) {
    const entries = Array.from(this.qLearning.qTable.entries());
    return entries.sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, value]) => {
      const [state, action] = key.split(':');
      return { state, action, value };
    });
  }

  _setupStateTimeout(state) {
    const timeouts = {
      [DecisionState.CLONING]: 300000,    // 5分钟
      [DecisionState.SYNCING]: 600000,     // 10分钟
      [DecisionState.LEARNING]: 300000,    // 5分钟
      [DecisionState.COOLDOWN]: 1800000,   // 30分钟
    };

    if (timeouts[state]) {
      const existing = this.stateTimers.get(state);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.emit('decision:timeout', { state });
        this.transition(DecisionState.IDLE);
      }, timeouts[state]);

      this.stateTimers.set(state, timer);
    }
  }
}

// ── 导出 ─────────────────────────────────────────
module.exports = {
  AutonomousDecisionEngine,
  QLearningEngine,
  ABTestEngine,
  EvolutionSystem,
  DecisionState,
  StateTransitions,
};
