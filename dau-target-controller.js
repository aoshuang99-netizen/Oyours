/**
 * dau-target-controller.js — MSCMS v14 DAU 目标驱动中枢
 *
 * 核心理念：全链路以"达成网站DAU目标"为终极目标，自动调度资源
 *
 * 核心能力：
 *   1. DAU 目标设定与分解（日目标 → 时段目标 → 平台配额）
 *   2. 实时进度监控（当前DAU、来源分布、缺口计算）
 *   3. Q-learning 策略调节（自动优化投入分配）
 *   4. 资源规划（设备分配、账号调度、内容生产配额）
 *   5. 自动决策触发（缺口大→加注册+加发帖+加营销）
 *   6. 闭环反馈（每15min检查→策略调整→效果评估）
 *
 * 用法：
 *   const { DAUTargetController } = require('./dau-target-controller.js');
 *   const ctrl = new DAUTargetController({ websiteAnalytics, socialBridge, ... });
 *   ctrl.setTarget(1000); // 设定日DAU目标1000
 *   ctrl.start(); // 启动自动调控
 */

const { EventEmitter } = require('events');

// ── Q-learning 状态空间 ──────────────────────────
const STATES = [
  'far_below',    // 进度 < 50%
  'below',        // 进度 50-80%
  'on_track',     // 进度 80-100%
  'exceeded',     // 进度 > 100%
];

const ACTIONS = [
  'increase_posts',       // 增加发帖量
  'increase_follows',     // 增加关注量
  'increase_dms',         // 增加私信量
  'increase_comments',    // 增加评论量
  'increase_accounts',    // 注册新账号
  'shift_platform',       // 切换平台重心
  'maintain',             // 维持当前策略
  'reduce',               // 减少投入（已超额）
];

// 平台权重默认值
const DEFAULT_PLATFORM_WEIGHTS = {
  reddit: 0.25,
  x: 0.25,
  discord: 0.15,
  instagram: 0.15,
  tiktok: 0.10,
  facebook: 0.10,
};

class DAUTargetController extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.websiteAnalytics = opts.websiteAnalytics || null;
    this.socialBridge = opts.socialBridge || null;
    this.contentGenerator = opts.contentGenerator || null;
    this.proactiveMarketing = opts.proactiveMarketing || null;
    this.trafficRouter = opts.trafficRouter || null;
    this.deviceManager = opts.deviceManager || null;

    // 目标
    this.dailyTarget = (opts.dailyTarget !== undefined && opts.dailyTarget !== null) ? opts.dailyTarget : 0;
    this.timezone = opts.timezone || 'Asia/Shanghai';

    // 当前进度
    this.currentDAU = 0;
    this.yesterdayDAU = 0;
    this.last7DaysDAU = [];
    this.sourceBreakdown = {};

    // 调度状态
    this.running = false;
    this.checkInterval = 15 * 60 * 1000; // 15分钟
    this.intervalHandle = null;

    // Q-learning
    this.qTable = {}; // `${state}` → { action: qValue }
    this.learningRate = 0.1;
    this.discountFactor = 0.9;
    this.explorationRate = 0.15;
    this.lastState = null;
    this.lastAction = null;

    // 平台权重（可被 Q-learning 调节）
    this.platformWeights = { ...DEFAULT_PLATFORM_WEIGHTS };

    // 时段目标分解
    this.hourlyTargets = [];

    // 操作配额（当前时段）
    this.currentQuota = {
      posts: 0,
      comments: 0,
      follows: 0,
      dms: 0,
      newAccounts: 0,
    };

    // 执行记录
    this.executionLog = [];
    this.maxLog = 200;

    // 统计
    this.stats = {
      checksRun: 0,
      adjustmentsMade: 0,
      avgGap: 0,
      bestStrategy: null,
      strategyEffectiveness: {}, // action → avg DAU improvement
    };
  }

  // ── 设定目标 ──────────────────────────────────
  setTarget(dau) {
    this.dailyTarget = dau;
    this._decomposeTarget();
    this.emit('target:set', { target: dau });
  }

  // ── 目标分解到时段 ────────────────────────────
  _decomposeTarget() {
    // 按照白天活跃度高分配时段目标
    const hourWeights = [];
    for (let h = 0; h < 24; h++) {
      let w = 0.3; // 基础权重
      if (h >= 7 && h <= 9) w = 0.8;    // 早高峰
      if (h >= 12 && h <= 14) w = 1.0;  // 午高峰
      if (h >= 18 && h <= 22) w = 1.2;  // 晚高峰
      if (h >= 0 && h <= 6) w = 0.15;   // 深夜低谷
      hourWeights.push(w);
    }
    const totalWeight = hourWeights.reduce((a, b) => a + b, 0);
    this.hourlyTargets = hourWeights.map((w, h) => ({
      hour: h,
      target: Math.round(this.dailyTarget * w / totalWeight),
      achieved: 0,
    }));
  }

  // ── 启动控制器 ────────────────────────────────
  start() {
    if (this.running) return;
    this.running = true;
    this._decomposeTarget();
    // 立即执行一次
    this._runCheckCycle();
    // 定时执行
    this.intervalHandle = setInterval(() => this._runCheckCycle(), this.checkInterval);
    this.emit('started', { target: this.dailyTarget, checkInterval: this.checkInterval });
  }

  stop() {
    this.running = false;
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.emit('stopped');
  }

  // ── 核心检查循环 ──────────────────────────────
  async _runCheckCycle() {
    this.stats.checksRun++;
    const now = new Date();
    const hour = now.getHours();

    // 获取当前 DAU
    if (this.websiteAnalytics) {
      try {
        const data = await this.websiteAnalytics.getDAU(now);
        this.currentDAU = data.dau || 0;
        this.sourceBreakdown = data.sources || {};
      } catch (e) {
        this.emit('error', { phase: 'fetch_dau', error: e.message });
      }
    }

    // 计算进度
    const expectedProgress = this._getExpectedProgressByHour(hour);
    const actualProgress = this.dailyTarget > 0 ? this.currentDAU / this.dailyTarget : 0;
    const gap = this.dailyTarget - this.currentDAU;
    const gapPercent = this.dailyTarget > 0 ? (gap / this.dailyTarget * 100) : 0;

    // 确定状态
    const state = this._getState(actualProgress, expectedProgress);

    // Q-learning 选择动作
    const action = this._selectAction(state);

    // 执行动作
    const result = await this._executeAction(action, gap, gapPercent);

    // 更新 Q-table
    if (this.lastState && this.lastAction) {
      const reward = this._calculateReward(actualProgress, expectedProgress);
      this._updateQValue(this.lastState, this.lastAction, reward, state);
    }
    this.lastState = state;
    this.lastAction = action;

    // 记录日志
    this._logExecution({
      timestamp: now.toISOString(),
      hour,
      currentDAU: this.currentDAU,
      dailyTarget: this.dailyTarget,
      expectedProgress: (expectedProgress * 100).toFixed(1) + '%',
      actualProgress: (actualProgress * 100).toFixed(1) + '%',
      gap,
      gapPercent: gapPercent.toFixed(1) + '%',
      state,
      action,
      result,
    });

    this.emit('cycle:complete', {
      currentDAU: this.currentDAU,
      target: this.dailyTarget,
      gap,
      state,
      action,
      result,
    });
  }

  // ── 状态判断 ──────────────────────────────────
  _getState(actualProgress, expectedProgress) {
    const ratio = expectedProgress > 0 ? actualProgress / expectedProgress : actualProgress;
    if (ratio < 0.5) return 'far_below';
    if (ratio < 0.8) return 'below';
    if (ratio < 1.1) return 'on_track';
    return 'exceeded';
  }

  // ── 时段预期进度 ──────────────────────────────
  _getExpectedProgressByHour(hour) {
    let cumulative = 0;
    for (let h = 0; h <= hour; h++) {
      cumulative += this.hourlyTargets[h]?.target || 0;
    }
    return this.dailyTarget > 0 ? cumulative / this.dailyTarget : 0;
  }

  // ── Q-learning 选择动作 ───────────────────────
  _selectAction(state) {
    // 探索
    if (Math.random() < this.explorationRate) {
      return ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    }
    // 利用
    const qValues = this.qTable[state] || {};
    let bestAction = 'maintain';
    let bestQ = -Infinity;
    for (const action of ACTIONS) {
      const q = qValues[action] || 0;
      if (q > bestQ) {
        bestQ = q;
        bestAction = action;
      }
    }
    return bestAction;
  }

  // ── 更新 Q 值 ────────────────────────────────
  _updateQValue(state, action, reward, nextState) {
    if (!this.qTable[state]) this.qTable[state] = {};
    if (!this.qTable[nextState]) this.qTable[nextState] = {};

    const maxNextQ = Math.max(...ACTIONS.map(a => this.qTable[nextState][a] || 0), 0);
    const currentQ = this.qTable[state][action] || 0;
    const newQ = currentQ + this.learningRate * (reward + this.discountFactor * maxNextQ - currentQ);
    this.qTable[state][action] = newQ;

    // 记录策略效果
    if (!this.stats.strategyEffectiveness[action]) {
      this.stats.strategyEffectiveness[action] = { count: 0, totalReward: 0, avgReward: 0 };
    }
    const eff = this.stats.strategyEffectiveness[action];
    eff.count++;
    eff.totalReward += reward;
    eff.avgReward = eff.totalReward / eff.count;
  }

  // ── 计算奖励 ──────────────────────────────────
  _calculateReward(actualProgress, expectedProgress) {
    const ratio = expectedProgress > 0 ? actualProgress / expectedProgress : actualProgress;
    // 进度越接近预期，奖励越高
    if (ratio >= 0.9 && ratio <= 1.1) return 1.0;       // 完美
    if (ratio >= 0.8 && ratio < 0.9) return 0.5;        // 接近
    if (ratio >= 1.1 && ratio < 1.3) return 0.3;        // 略超
    if (ratio < 0.5) return -0.5;                        // 严重不足
    if (ratio < 0.8) return -0.2;                        // 不足
    if (ratio >= 1.3) return -0.1;                       // 过度投入
    return 0;
  }

  // ── 执行动作 ──────────────────────────────────
  async _executeAction(action, gap, gapPercent) {
    const result = { action, executed: false, details: {} };

    try {
      switch (action) {
        case 'increase_posts':
          result.details = await this._increasePosts(gap);
          result.executed = true;
          break;
        case 'increase_follows':
          result.details = await this._increaseFollows(gap);
          result.executed = true;
          break;
        case 'increase_dms':
          result.details = await this._increaseDMs(gap);
          result.executed = true;
          break;
        case 'increase_comments':
          result.details = await this._increaseComments(gap);
          result.executed = true;
          break;
        case 'increase_accounts':
          result.details = await this._increaseAccounts(gap);
          result.executed = true;
          break;
        case 'shift_platform':
          result.details = this._shiftPlatform();
          result.executed = true;
          break;
        case 'maintain':
          result.details = { message: 'Strategy maintained' };
          result.executed = true;
          break;
        case 'reduce':
          result.details = this._reduceEffort();
          result.executed = true;
          break;
      }
      this.stats.adjustmentsMade++;
    } catch (e) {
      result.error = e.message;
    }

    return result;
  }

  // ── 增加发帖 ──────────────────────────────────
  async _increasePosts(gap) {
    const additional = Math.min(Math.ceil(gap / 50), 20); // 每50缺口增加1帖，最多20
    this.currentQuota.posts += additional;
    if (this.contentGenerator) {
      // 触发内容生成
      const platforms = Object.keys(this.platformWeights).sort((a, b) => this.platformWeights[b] - this.platformWeights[a]);
      for (const platform of platforms.slice(0, 3)) {
        const count = Math.ceil(additional * this.platformWeights[platform]);
        if (count > 0) {
          this.contentGenerator.enqueueGeneration(platform, count);
        }
      }
    }
    return { additionalPosts: additional, platforms: Object.keys(this.platformWeights) };
  }

  // ── 增加关注 ──────────────────────────────────
  async _increaseFollows(gap) {
    const additional = Math.min(Math.ceil(gap / 20), 50); // 每20缺口增加1关注，最多50
    this.currentQuota.follows += additional;
    if (this.socialBridge) {
      // 入队关注操作
      const platforms = Object.keys(this.platformWeights);
      for (const platform of platforms) {
        const count = Math.ceil(additional * this.platformWeights[platform]);
        // 实际执行需要设备分配
      }
    }
    return { additionalFollows: additional };
  }

  // ── 增加私信 ──────────────────────────────────
  async _increaseDMs(gap) {
    const additional = Math.min(Math.ceil(gap / 30), 30);
    this.currentQuota.dms += additional;
    return { additionalDMs: additional };
  }

  // ── 增加评论 ──────────────────────────────────
  async _increaseComments(gap) {
    const additional = Math.min(Math.ceil(gap / 15), 40);
    this.currentQuota.comments += additional;
    return { additionalComments: additional };
  }

  // ── 注册新账号 ────────────────────────────────
  async _increaseAccounts(gap) {
    const additional = Math.min(Math.ceil(gap / 100), 10); // 每100缺口注册1新号
    this.currentQuota.newAccounts += additional;
    return { additionalAccounts: additional };
  }

  // ── 切换平台重心 ──────────────────────────────
  _shiftPlatform() {
    // 找到效果最好的平台，增加权重
    let bestPlatform = null;
    let bestEffect = -Infinity;
    for (const [platform, weight] of Object.entries(this.platformWeights)) {
      const sourceCount = this.sourceBreakdown[platform] || 0;
      const effect = sourceCount / weight; // 单位权重带来的流量
      if (effect > bestEffect) {
        bestEffect = effect;
        bestPlatform = platform;
      }
    }
    if (bestPlatform) {
      // 增加该平台权重，减少其他
      const delta = 0.05;
      this.platformWeights[bestPlatform] = Math.min(0.5, this.platformWeights[bestPlatform] + delta);
      const others = Object.keys(this.platformWeights).filter(p => p !== bestPlatform);
      const totalOther = others.reduce((s, p) => s + this.platformWeights[p], 0);
      for (const p of others) {
        this.platformWeights[p] = this.platformWeights[p] * (1 - delta / totalOther);
      }
    }
    return { shiftedTo: bestPlatform, newWeights: { ...this.platformWeights } };
  }

  // ── 减少投入 ──────────────────────────────────
  _reduceEffort() {
    const factor = 0.7;
    this.currentQuota.posts = Math.floor(this.currentQuota.posts * factor);
    this.currentQuota.comments = Math.floor(this.currentQuota.comments * factor);
    this.currentQuota.follows = Math.floor(this.currentQuota.follows * factor);
    this.currentQuota.dms = Math.floor(this.currentQuota.dms * factor);
    return { reducedBy: (1 - factor) * 100 + '%' };
  }

  // ── 日志记录 ──────────────────────────────────
  _logExecution(entry) {
    this.executionLog.unshift(entry);
    if (this.executionLog.length > this.maxLog) {
      this.executionLog = this.executionLog.slice(0, this.maxLog);
    }
  }

  // ── 获取状态 ──────────────────────────────────
  getStatus() {
    const progress = this.dailyTarget > 0 ? (this.currentDAU / this.dailyTarget * 100).toFixed(1) : '0';
    return {
      dailyTarget: this.dailyTarget,
      currentDAU: this.currentDAU,
      progress: parseFloat(progress),
      gap: this.dailyTarget - this.currentDAU,
      running: this.running,
      currentQuota: this.currentQuota,
      platformWeights: this.platformWeights,
      hourlyTargets: this.hourlyTargets,
      stats: this.stats,
      qTableSize: Object.keys(this.qTable).length,
      lastExecution: this.executionLog[0] || null,
    };
  }

  getExecutionLog(limit = 20) {
    return this.executionLog.slice(0, limit);
  }

  // ── 接收 DAU 更新事件（由 eventBus dau.updated 驱动） ──
  onDAUUpdate(data) {
    if (data.currentDAU !== undefined) {
      this.currentDAU = data.currentDAU;
    }
    if (data.sources) {
      this.sourceBreakdown = data.sources;
    }
    this.emit('dau:updated', { currentDAU: this.currentDAU, target: this.dailyTarget });
  }

  getQTable() {
    return this.qTable;
  }

  // ── 手动注入 DAU 数据（用于无 website-analytics 时） ──
  injectDAU(dau, sources = {}) {
    this.currentDAU = dau;
    this.sourceBreakdown = sources;
    this.emit('dau:injected', { dau, sources });
  }
}

module.exports = { DAUTargetController, STATES, ACTIONS, DEFAULT_PLATFORM_WEIGHTS };
