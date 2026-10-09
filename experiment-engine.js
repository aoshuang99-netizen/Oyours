/**
 * experiment-engine.js — MSCMS v14 A/B测试引擎
 *
 * 核心能力：
 *   1. 实验CRUD管理
 *   2. 贝叶斯A/B分析 (probability_to_be_best, expected_loss, uplift)
 *   3. 频率学派检验 (p-value, 置信区间, 效应量)
 *   4. 序贯检验 (提前停止判定)
 *   5. 护栏指标检测
 *   6. 自动停止 & 胜出判定
 *
 * 用法：
 *   const { ExperimentEngine } = require('./experiment-engine.js');
 *   const engine = new ExperimentEngine({ dataStore });
 *   const exp = engine.createExperiment({ name: 'CTA Test', variants: [...], metrics: {...} });
 *   engine.recordImpression(expId, variantId);
 *   engine.recordConversion(expId, variantId, 'signup');
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 实验状态 ──────────────────────────────────────
const EXPERIMENT_STATUS = {
  DRAFT:     'draft',
  RUNNING:   'running',
  PAUSED:    'paused',
  STOPPED:   'stopped',
  COMPLETED: 'completed'
};

// ── A/B测试实验 ───────────────────────────────────
class Experiment {
  constructor(config) {
    this.id = config.id || `exp_${Date.now()}_${crypto.randomBytes(3'hex')}`;
    this.name = config.name;
    this.hypothesis = config.hypothesis || '';
    this.status = config.status || EXPERIMENT_STATUS.DRAFT;
    this.trafficSplit = config.trafficSplit || 0.5;

    // 变体
    this.variants = (config.variants || []).map(v => ({
      id: v.id || `var_${crypto.randomBytes(2'hex')}`,
      name: v.name || v.id,
      weight: v.weight || (100 / (config.variants?.length || 2)),
      config: v.config || {},
      // 实时数据
      impressions: 0,
      conversions: {},
      revenue: 0
    }));

    // 指标
    this.metrics = {
      primary: config.metrics?.primary || 'signup',
      secondary: config.metrics?.secondary || [],
      guardrail: config.metrics?.guardrail || null
    };

    // 定向
    this.targeting = {
      s: config.targeting?.s || [],
      countries: config.targeting?.countries || [],
      minSampleSize: config.targeting?.minSampleSize || 1000
    };

    // 停止规则
    this.stoppingRule = {
      maxDuration: config.stoppingRule?.maxDuration || 14,
      confidenceLevel: config.stoppingRule?.confidenceLevel || 0.95,
      autoStop: config.stoppingRule?.autoStop !== false
    };

    // 结果
    this.winnerVariantId = null;
    this.confidenceLevel = 0;
    this.uplift = 0;
    this.results = null;

    // 时间
    this.startedAt = config.startedAt || null;
    this.stoppedAt = config.stoppedAt || null;
    this.createdAt = config.createdAt || new Date().toISOString();
  }

  // 总样本量
  get totalSampleSize() {
    return this.variants.reduce((s, v) => s + v.impressions, 0);
  }

  // 是否达到最小样本量
  get hasMinSample() {
    return this.variants.every(v => v.impressions >= this.targeting.minSampleSize);
  }

  // 运行天数
  get daysRunning() {
    if (!this.startedAt) return 0;
    return Math.ceil((Date.now() - new Date(this.startedAt).getTime()) / 86400000);
  }
}

// ── 分析器 ────────────────────────────────────────
class ExperimentAnalyzer {
  // 贝叶斯分析: 使用Beta-Binomial模型
  bayesianAnalysis(control, variant, metric = 'signup') {
    const cConversions = control.conversions[metric] || 0;
    const vConversions = variant.conversions[metric] || 0;
    const cImpressions = control.impressions || 1;
    const vImpressions = variant.impressions || 1;

    // Beta posterior parameters (Beta(α + conversions, β + non-conversions))
    const cAlpha = 1 + cConversions;
    const cBeta = 1 + (cImpressions - cConversions);
    const vAlpha = 1 + vConversions;
    const vBeta = 1 + (vImpressions - vConversions);

    // Monte Carlo simulation (10K samples) for P(variant > control)
    let variantBetter = 0;
    const samples = 10000;
    const losses = [];

    for (let i = 0; i < samples; i++) {
      // Sample from Beta distributions using Gamma approximation
      const cSample = this._sampleBeta(cAlpha, cBeta);
      const vSample = this._sampleBeta(vAlpha, vBeta);

      if (vSample > cSample) variantBetter++;
      losses.push(Math.max(0, cSample - vSample));
    }

    const probabilityToBeBest = variantBetter / samples;
    const expectedLoss = losses.reduce((a, b) => a + b, 0) / samples;
    const controlRate = cConversions / cImpressions;
    const variantRate = vConversions / vImpressions;
    const uplift = controlRate > 0 ? (variantRate - controlRate) / controlRate : 0;

    return {
      probabilityToBeBest,
      expectedLoss,
      uplift,
      upliftPercent: (uplift * 100).toFixed(2) + '%',
      controlRate: (controlRate * 100).toFixed(2) + '%',
      variantRate: (variantRate * 100).toFixed(2) + '%',
      isSignificant: probabilityToBeBest >= 0.95,
      sampleSize: { control: cImpressions, variant: vImpressions }
    };
  }

  // 频率学派: 双比例Z检验
  frequentistAnalysis(control, variant, metric = 'signup') {
    const cConversions = control.conversions[metric] || 0;
    const vConversions = variant.conversions[metric] || 0;
    const cImpressions = control.impressions || 1;
    const vImpressions = variant.impressions || 1;

    const p1 = cConversions / cImpressions;
    const p2 = vConversions / vImpressions;
    const pPool = (cConversions + vConversions) / (cImpressions + vImpressions);

    const se = Math.sqrt(pPool * (1 - pPool) * (1 / cImpressions + 1 / vImpressions));
    const zScore = (p2 - p1) / (se || 0.0001);

    // P-value from z-score (two-tailed)
    const pValue = 2 * (1 - this._normalCDF(Math.abs(zScore)));

    // 95% CI for difference
    const margin = 1.96 * Math.sqrt(
      (p1 * (1 - p1) / cImpressions) + (p2 * (1 - p2) / vImpressions)
    );
    const diff = p2 - p1;

    // Cohen's h (effect size)
    const cohenH = 2 * (Math.asin(Math.sqrt(p2)) - Math.asin(Math.sqrt(p1)));

    return {
      zScore: zScore.toFixed(3),
      pValue: pValue.toFixed(6),
      isSignificant: pValue < 0.05,
      confidenceInterval: {
        lower: (diff - margin).toFixed(4),
        upper: (diff + margin).toFixed(4)
      },
      effectSize: {
        cohenH: Math.abs(cohenH).toFixed(3),
        interpretation: Math.abs(cohenH) < 0.2 ? 'negligible'
          : Math.abs(cohenH) < 0.5 ? 'small'
          : Math.abs(cohenH) < 0.8 ? 'medium' : 'large'
      }
    };
  }

  // 序贯检验: 简化版 (基于固定样本量里程碑)
  sequentialTest(experiment, control, variant, metric) {
    const milestone = Math.floor(experiment.targeting.minSampleSize / 3);
    const analysis = this.bayesianAnalysis(control, variant, metric);

    if (analysis.probabilityToBeBest >= 0.99) {
      return { decision: 'stop_winner', reason: 'P(best) >= 99%', variant };
    }
    if (analysis.probabilityToBeBest <= 0.01) {
      return { decision: 'stop_loser', reason: 'P(best) <= 1%', variant };
    }
    if (experiment.daysRunning >= experiment.stoppingRule.maxDuration) {
      if (analysis.probabilityToBeBest >= experiment.stoppingRule.confidenceLevel) {
        return { decision: 'stop_winner', reason: 'Max duration + significant', variant };
      }
      return { decision: 'inconclusive', reason: 'Max duration reached, no conclusive result' };
    }

    return { decision: 'continue', reason: `Need more data (milestone: ${milestone})` };
  }

  // 护栏指标检查
  checkGuardrail(experiment, control, variant) {
    if (!experiment.metrics.guardrail) return { safe: true };

    const metric = experiment.metrics.guardrail;
    const cRate = (control.conversions[metric] || 0) / (control.impressions || 1);
    const vRate = (variant.conversions[metric] || 0) / (variant.impressions || 1);

    const relativeChange = cRate > 0 ? (vRate - cRate) / cRate : 0;

    // 护栏: 不能显著下降 (>5%)
    if (relativeChange < -0.05) {
      const analysis = this.frequentistAnalysis(control, variant, metric);
      if (analysis.pValue < 0.05) {
        return {
          safe: false,
          reason: `Guardrail metric '${metric}' significantly decreased by ${(relativeChange * 100).toFixed(1)}%`,
          pValue: analysis.pValue
        };
      }
    }

    return { safe: true, change: (relativeChange * 100).toFixed(1) + '%' };
  }

  // 内部: Beta分布采样 (使用Gamma近似)
  _sampleBeta(alpha, beta) {
    // Gamma(α,1) / (Gamma(α,1) + Gamma(β,1)) ~ Beta(α,β)
    const x = this._sampleGamma(alpha);
    const y = this._sampleGamma(beta);
    return x / (x + y);
  }

  // Marsaglia-Tsang Gamma sampler
  _sampleGamma(shape) {
    if (shape < 1) {
      const u = Math.random();
      return this._sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        x = this._normalRandom();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  // Box-Muller
  _normalRandom() {
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // Standard normal CDF approximation
  _normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * x);
    const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * erf);
  }
}

// ── 实验引擎 ──────────────────────────────────────
class ExperimentEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dataStore = opts.dataStore || null;
    this.experiments = new Map();
    this.analyzer = new ExperimentAnalyzer();

    // 恢复持久化数据
    if (this.dataStore) {
      this._restore();
    }
  }

  // ── 创建实验 ─────────────────────────────────────
  createExperiment(config) {
    const exp = new Experiment(config);
    this.experiments.set(exp.id, exp);

    if (this.dataStore) {
      this.dataStore.create('experiments', {
        id: exp.id, name: exp.name, hypothesis: exp.hypothesis,
        status: exp.status, variants: exp.variants, metrics: exp.metrics,
        targeting: exp.targeting, stoppingRule: exp.stoppingRule, createdAt: exp.createdAt
      });
    }

    this.emit('experiment:created', exp);
    return exp;
  }

  // ── 启动实验 ─────────────────────────────────────
  startExperiment(expId) {
    const exp = this.experiments.get(expId);
    if (!exp) return null;
    if (exp.status !== EXPERIMENT_STATUS.DRAFT) return null;

    exp.status = EXPERIMENT_STATUS.RUNNING;
    exp.startedAt = new Date().toISOString();
    this.emit('experiment:started', exp);
    return exp;
  }

  // ── 暂停实验 ─────────────────────────────────────
  pauseExperiment(expId) {
    const exp = this.experiments.get(expId);
    if (!exp) return null;
    if (exp.status !== EXPERIMENT_STATUS.RUNNING) return null;

    exp.status = EXPERIMENT_STATUS.PAUSED;
    this.emit('experiment:paused', exp);
    return exp;
  }

  // ── 停止实验 ─────────────────────────────────────
  stopExperiment(expId, winnerId = null) {
    const exp = this.experiments.get(expId);
    if (!exp) return null;

    exp.status = EXPERIMENT_STATUS.STOPPED;
    exp.stoppedAt = new Date().toISOString();

    if (winnerId) {
      exp.winnerVariantId = winnerId;
    }

    // 运行最终分析
    const results = this._analyzeExperiment(exp);
    exp.results = results;

    this.emit('experiment:stopped', { experiment: exp, results });
    return exp;
  }

  // ── 完成实验 ─────────────────────────────────────
  completeExperiment(expId) {
    const exp = this.experiments.get(expId);
    if (!exp) return null;

    exp.status = EXPERIMENT_STATUS.COMPLETED;
    exp.stoppedAt = new Date().toISOString();

    const results = this._analyzeExperiment(exp);
    exp.results = results;

    // 判定胜出
    if (results.winner) {
      exp.winnerVariantId = results.winner.id;
      exp.confidenceLevel = results.probabilityToBeBest;
      exp.uplift = results.uplift;
    }

    this.emit('experiment:completed', { experiment: exp, results });
    return exp;
  }

  // ── 记录展示 ─────────────────────────────────────
  recordImpression(expId, variantId) {
    const exp = this.experiments.get(expId);
    if (!exp) return;
    if (exp.status !== EXPERIMENT_STATUS.RUNNING) return;

    const variant = exp.variants.find(v => v.id === variantId);
    if (!variant) return;
    variant.impressions++;

    // 检查是否需要自动分析
    if (exp.hasMinSample && exp.stoppingRule.autoStop) {
      this._checkAutoStop(exp);
    }
  }

  // ── 记录转化 ─────────────────────────────────────
  recordConversion(expId, variantId, eventType, value = 0) {
    const exp = this.experiments.get(expId);
    if (!exp) return;
    if (exp.status !== EXPERIMENT_STATUS.RUNNING) return;

    const variant = exp.variants.find(v => v.id === variantId);
    if (!variant) return;
    variant.conversions[eventType] = (variant.conversions[eventType] || 0) + 1;
    variant.revenue += value;
  }

  // ── 获取实验详情 ─────────────────────────────────
  getExperiment(expId) {
    const exp = this.experiments.get(expId);
    if (!exp) return null;

    const analysis = exp.status === EXPERIMENT_STATUS.RUNNING
      ? this._analyzeExperiment(exp) : exp.results;

    return {
      id: exp.id,
      name: exp.name,
      hypothesis: exp.hypothesis,
      status: exp.status,
      trafficSplit: exp.trafficSplit,
      variants: exp.variants.map(v => ({
        id: v.id, name: v.name, weight: v.weight,
        impressions: v.impressions,
        conversions: { ...v.conversions },
        conversionRate: v.impressions > 0
          ? ((v.conversions[exp.metrics.primary] || 0) / v.impressions * 100).toFixed(2) + '%'
          : '0%',
        revenue: v.revenue
      })),
      metrics: exp.metrics,
      targeting: exp.targeting,
      stoppingRule: exp.stoppingRule,
      winnerVariantId: exp.winnerVariantId,
      confidenceLevel: exp.confidenceLevel,
      uplift: exp.uplift,
      results: analysis,
      totalSamples: exp.totalSampleSize,
      daysRunning: exp.daysRunning,
      startedAt: exp.startedAt,
      stoppedAt: exp.stoppedAt,
      createdAt: exp.createdAt
    };
  }

  // ── 获取所有实验 ─────────────────────────────────
  listExperiments(statusFilter = null) {
    let list = Array.from(this.experiments.values());
    if (statusFilter) list = list.filter(e => e.status === statusFilter);

    return list.map(e => ({
      id: e.id,
      name: e.name,
      status: e.status,
      variants: e.variants.length,
      totalSamples: e.totalSampleSize,
      daysRunning: e.daysRunning,
      winnerId: e.winnerVariantId,
      createdAt: e.createdAt
    }));
  }

  // ── 获取统计 ─────────────────────────────────────
  getStats() {
    const list = Array.from(this.experiments.values());
    return {
      total: list.length,
      running: list.filter(e => e.status === EXPERIMENT_STATUS.RUNNING,
      completed: list.filter(e => e.status === EXPERIMENT_STATUS.COMPLETED,
      stopped: list.filter(e => e.status === EXPERIMENT_STATUS.STOPPED,
      paused: list.filter(e => e.status === EXPERIMENT_STATUS.PAUSED,
      draft: list.filter(e => e.status === EXPERIMENT_STATUS.DRAFT
    };
  }

  // ── 删除实验 ─────────────────────────────────────
  deleteExperiment(expId) {
    if (this.experiments.has(expId)) {
      const exp = this.experiments.get(expId);
      if (exp.status === EXPERIMENT_STATUS.RUNNING) return false;
      this.experiments.delete(expId);
      this.emit('experiment:deleted', { id: expId });
      return true;
    }
    return false;
  }

  // ── 重置 ─────────────────────────────────────────
  reset() {
    this.experiments.clear();
  }

  // ── 停止 ─────────────────────────────────────────
  stop() {
    this.removeAllListeners();
  }

  // ── 内部方法 ─────────────────────────────────────
  _analyzeExperiment(exp) {
    if (exp.variants.length < 2) return { error: 'Need at least 2 variants' };

    const control = exp.variants[0];
    const results = {
      metric: exp.metrics.primary,
      comparisons: [],
      winner: null,
      probabilityToBeBest: 0,
      uplift: 0,
      timeSeries: []
    };

    let bestVariant = control;
    let bestProb = 0;

    for (let i = 1; i < exp.variants.length; i++) {
      const variant = exp.variants[i];

      // Bayesian analysis
      const bayes = this.analyzer.bayesianAnalysis(control, variant, exp.metrics.primary);

      // Frequentist
      const freq = this.analyzer.frequentistAnalysis(control, variant, exp.metrics.primary);

      // Guardrail check
      const guardrail = exp.metrics.guardrail
        ? this.analyzer.checkGuardrail(exp, control, variant)
        : { safe: true };

      results.comparisons.push({
        variantId: variant.id,
        variantName: variant.name,
        bayesian: bayes,
        frequentist: freq,
        guardrail,
        isWinner: bayes.isSignificant && bayes.uplift > 0 && guardrail.safe
      });

      if (bayes.probabilityToBeBest > bestProb && bayes.uplift > 0 && guardrail.safe) {
        bestProb = bayes.probabilityToBeBest;
        bestVariant = variant;
      }
    }

    if (bestProb > 0 && bestVariant !== control) {
      results.winner = {
        id: bestVariant.id,
        name: bestVariant.name,
        variant: bestVariant
      };
      results.probabilityToBeBest = bestProb;
    }

    return results;
  }

  _checkAutoStop(exp) {
    const analysis = this._analyzeExperiment(exp);

    if (analysis.comparisons.length === 0) return;

    // 检查序贯检验
    const control = exp.variants[0];
    for (const comp of analysis.comparisons) {
      const variant = exp.variants.find(v => v.id === comp.variantId);
      if (!variant) continue;

      const decision = this.analyzer.sequentialTest(exp, control, variant, exp.metrics.primary);

      if (decision.decision === 'stop_winner') {
        this.completeExperiment(exp.id);
        this.emit('experiment:auto_won', { experiment: exp, winner: variant });
        return;
      }
      if (decision.decision === 'stop_loser') {
        this.completeExperiment(exp.id);
        this.emit('experiment:auto_lost', { experiment: exp, loser: variant });
        return;
      }
    }
  }

  _restore() {
    try {
      const data = this.dataStore.getAll('experiments') || [];
      for (const expData of data) {
        const exp = new Experiment(expData);
        this.experiments.set(exp.id, exp);
      }
    } catch (e) { /* silent */ }
  }
}

module.exports = { ExperimentEngine, Experiment, ExperimentAnalyzer, EXPERIMENT_STATUS };
