'use strict';

/**
 * decision-bridge.js — 因果链智能下沉桥接器（Phase 4 / #524）
 * =========================================================================
 * 把自主决策引擎（QLearning / ABTest）智能下沉到因果链末梢，在 4 个决策点
 * 为每个账号做出「真实」决策，并把真实发布结果（visit / DAU / 自愈）回灌 Q 表，
 * 形成「决策 → 执行 → 反馈 → 进化」的闭环。
 *
 * ── 4 个决策点 ─────────────────────────────────────────────────────────────
 *   content  (决策点1 发什么内容)  触发: content.generated
 *   timing   (决策点2 何时发)      触发: content.generated
 *   device   (决策点3 用哪台设备)  触发: content.generated
 *   nurture  (决策点4 养号强度)    触发: account.healthy
 *
 * ── 反馈（回灌 Q 表）──────────────────────────────────────────────────────
 *   post.published  → 基础奖励 (+1)，确认决策可执行
 *   visit.recorded  → 按访问量奖励 (≤100*0.05)
 *   dau.updated     → 按 DAU 增量奖励 (≤100*0.02)
 *   heal.error      → 惩罚 (-3)，标记该账号近期决策失败
 *
 * 决策引擎不可用（decisionEngine 未注入）时安全降级：确定性默认选择，
 * 仍记录 account_decisions + emit decision.* 事件，保证 API / 看板可用。
 *
 * 依赖注入：{ decisionEngine, accountManager, eventBus, dataStore }
 * =========================================================================
 */

const crypto = require('crypto');
const { CAUSAL_EVENTS } = require('./event-bus');

// ── 决策点 + 动作空间定义 ─────────────────────────────────────────────────
const DECISION_POINTS = {
  content: {
    label: '内容变体',
    actions: ['text', 'image', 'video', 'quote', 'link'],
    def: 'text',
  },
  timing: {
    label: '发布时机',
    actions: ['slot_midnight', 'slot_morning', 'slot_afternoon', 'slot_evening'],
    def: 'slot_afternoon',
  },
  // device 动作空间动态生成（账号可选端口），此处仅占位标签
  device: {
    label: '发布端口',
    actions: [],
    def: 'none',
  },
  nurture: {
    label: '养号强度',
    actions: ['low', 'medium', 'high'],
    def: 'medium',
  },
};

// 因果阶段 → 数字进度（1..7），供因果进度显示
const PHASE_PROGRESS = {
  S1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S6: 6, S7: 7,
  none: 0, '': 0, null: 0,
};

function _genId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

// 把账号属性映射成 RL 状态（供 QLearning 选动作 / 回灌）
function _stateFor(account, point) {
  const phase = account.causal_phase || 'S1';
  const hs = account.health_score;
  const rl = account.risk_level;
  switch (point) {
    case 'content':
      // 阶段越深越能发富媒体；早期只发低风险文本
      if (phase === 'S1' || phase === 'S2') return 'low_engagement';
      if (phase === 'S3' || phase === 'S4') return 'normal_engagement';
      return 'high_engagement';
    case 'timing':
      if (hs == null) return 'normal_engagement';
      if (hs < 50) return 'low_engagement';
      if (hs >= 80) return 'high_engagement';
      return 'normal_engagement';
    case 'device':
      return 'normal_engagement';
    case 'nurture':
      if (rl === 'high' || rl === 'critical') return 'risk_high';
      if (hs != null && hs < 40) return 'cooldown';
      return 'normal_engagement';
    default:
      return 'normal_engagement';
  }
}

class DecisionBridge {
  constructor({ decisionEngine, accountManager, eventBus, dataStore } = {}) {
    this.decisionEngine = decisionEngine;
    this.accountManager = accountManager;
    this.eventBus = eventBus;
    this.dataStore = dataStore;
    // QLearning 可用才启用智能决策；否则确定性降级
    this._enabled = !!(decisionEngine && decisionEngine.qLearning);
    // accountId:point → 最近一次决策 { state, action, id, createdAt }
    this._latest = new Map();
    // 内容变体 A/B 探索测试（注册到 decisionEngine.abTest，真实累积曝光数据）
    this._contentAB = null;
  }

  // ── 初始化：订阅因果链事件 ──────────────────────────────────────────────
  init() {
    if (this._enabled && this.decisionEngine.abTest) {
      try {
        this._contentAB = this.decisionEngine.abTest.createTest(
          'content_variant_exploration',
          DECISION_POINTS.content.actions.map((a) => ({ name: a, config: { variant: a } })),
          ['ctr', 'engagement', 'visit']
        );
      } catch (_) { /* abTest 失败不阻塞 */ }
    }

    if (!this.eventBus) return;
    const bus = this.eventBus;
    // 决策点触发
    bus.on('content.generated', 'decision-bridge', (d) => this._onContentGenerated(d));
    bus.on('account.healthy', 'decision-bridge', (d) => this._onAccountHealthy(d));
    // 反馈（真实结果）回灌 Q 表
    bus.on('post.published', 'decision-bridge', (d) => this._onPostPublished(d));
    bus.on('visit.recorded', 'decision-bridge', (d) => this._onVisitRecorded(d));
    bus.on('dau.updated', 'decision-bridge', (d) => this._onDAUUpdated(d));
    bus.on('heal.error', 'decision-bridge', (d) => this._onHealError(d));
  }

  // ── 账号归一 ────────────────────────────────────────────────────────────
  _acctId(d) {
    if (!d) return null;
    return d.accountId || d.account_id || d.id ||
      (d.data && (d.data.accountId || d.data.account_id || d.data.id)) || null;
  }

  _getAccount(accountId) {
    if (!accountId) return null;
    if (this.accountManager && typeof this.accountManager.getAccount === 'function') {
      const a = this.accountManager.getAccount(accountId);
      if (a) return a;
    }
    if (this.dataStore) {
      const raw = this.dataStore.get('accounts', accountId);
      if (raw) {
        return {
          id: raw.id,
          causal_phase: raw.causal_phase || 'S1',
          health_score: raw.health_score != null ? raw.health_score : null,
          risk_level: raw.risk_level || 'unknown',
          bound_device_id: raw.bound_device_id != null ? Number(raw.bound_device_id) : null,
          publish_device_override: raw.publish_device_override != null ? Number(raw.publish_device_override) : null,
        };
      }
    }
    return null;
  }

  // ── 核心：在单决策点做一次决策 ───────────────────────────────────────────
  _decide(point, account, ctx = {}, { persist = true, emit = true } = {}) {
    const accountId = account && account.id;
    const def = DECISION_POINTS[point];
    const state = _stateFor(account, point);

    // 动态动作空间（device 取决于账号绑定）
    let available = def.actions.slice();
    if (point === 'device') {
      available = [];
      if (account.bound_device_id != null) available.push(String(account.bound_device_id));
      if (account.publish_device_override != null &&
          String(account.publish_device_override) !== String(account.bound_device_id)) {
        available.push(String(account.publish_device_override));
      }
      if (available.length === 0) available.push('none');
    }

    let action;
    if (this._enabled) {
      try {
        action = this.decisionEngine.qLearning.selectAction(state, available);
      } catch (_) {
        action = def.def;
      }
    } else {
      action = def.def;
    }

    const record = {
      id: _genId('dec'),
      accountId,
      point,
      state,
      action,
      context: ctx || {},
      enabled: this._enabled,
      reward: 0,
      createdAt: new Date().toISOString(),
    };

    if (persist && this.dataStore) {
      try { this.dataStore.create('account_decisions', record); } catch (_) { /* 持久化失败不阻塞 */ }
    }
    // 维护内存索引（bounded by #accounts × 4）
    if (accountId) this._latest.set(`${accountId}:${point}`, {
      state, action, id: record.id, createdAt: record.createdAt,
    });

    // 内容变体 A/B 曝光累积（真实数据）
    if (point === 'content' && this._contentAB && this.decisionEngine.abTest) {
      try {
        const v = this._contentAB.variants.find((x) => x.name === action);
        if (v) { v.impressions = (v.impressions || 0) + 1; }
      } catch (_) {}
    }

    if (emit && this.eventBus) {
      this.eventBus.emit(`decision.${point}`, { accountId, point, state, action, enabled: this._enabled }, 'decision-bridge');
    }
    return record;
  }

  // 决策点 1+2+3 —— 内容生成时一次性决策「发什么 / 何时发 / 用哪台设备」
  _onContentGenerated(d) {
    const accountId = this._acctId(d);
    if (!accountId) return;
    const account = this._getAccount(accountId);
    if (!account) return;
    const ctx = { contentId: d.contentId || d.content_id || d.id || null };
    const content = this._decide('content', account, ctx);
    const timing = this._decide('timing', account, ctx);
    const device = this._decide('device', account, ctx);
    return { content, timing, device };
  }

  // 决策点 4 —— 账号健康时决策「养号强度」
  _onAccountHealthy(d) {
    const accountId = this._acctId(d);
    if (!accountId) return;
    const account = this._getAccount(accountId);
    if (!account) return;
    return this._decide('nurture', account, {});
  }

  // ── 反馈：回灌 Q 表 ─────────────────────────────────────────────────────
  _reward(accountId, points, reward, nextStateOverride) {
    if (!accountId || !this._enabled) return;
    const account = this._getAccount(accountId);
    const nextState = nextStateOverride || (account ? _stateFor(account, 'content') : 'normal_engagement');
    for (const point of points) {
      const key = `${accountId}:${point}`;
      const last = this._latest.get(key);
      if (!last) continue;
      try {
        this.decisionEngine.qLearning.update(last.state, last.action, reward, nextState);
      } catch (_) {}
      // 把累积奖励写回持久化记录（审计 + 看板）
      if (this.dataStore && last.id) {
        try {
          const rec = this.dataStore.get('account_decisions', last.id);
          if (rec) {
            this.dataStore.update('account_decisions', last.id, {
              reward: (rec.reward || 0) + reward,
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (_) {}
      }
    }
  }

  _onPostPublished(d) {
    const accountId = this._acctId(d);
    if (!accountId) return;
    this._reward(accountId, ['content', 'timing', 'device'], 1.0);
  }

  _onVisitRecorded(d) {
    const accountId = this._acctId(d);
    if (!accountId) return;
    const visits = Number(d.visits || d.visit_count || d.count || 1);
    const reward = Math.min(visits, 100) * 0.05;
    this._reward(accountId, ['content', 'timing', 'device'], reward);
  }

  _onDAUUpdated(d) {
    const accountId = this._acctId(d);
    if (!accountId) return;
    const dau = Number(d.currentDAU || d.dau || d.value || 0);
    const reward = Math.min(dau, 100) * 0.02;
    this._reward(accountId, ['content', 'timing', 'device', 'nurture'], reward);
  }

  _onHealError(d) {
    const accountId = this._acctId(d);
    if (!accountId) return;
    // 惩罚近期决策，标记该账号策略失败
    this._reward(accountId, ['content', 'timing', 'device', 'nurture'], -3.0);
  }

  // ── 对外 API（供 server 路由调用）────────────────────────────────────────
  getDecisionsForAccount(accountId, opts = {}) {
    if (!this.dataStore) return [];
    const all = (this.dataStore.list('account_decisions', { limit: 1e9 }).items) || [];
    let rows = all.filter((r) => r.accountId === accountId);
    if (opts.point) rows = rows.filter((r) => r.point === opts.point);
    rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  }

  getCausal(accountId) {
    const account = this._getAccount(accountId);
    if (!account) return null;
    const phase = account.causal_phase || 'S1';
    const progress = PHASE_PROGRESS[phase] != null ? PHASE_PROGRESS[phase] : 0;
    const decisions = this.getDecisionsForAccount(accountId, { limit: 8 });
    const latest = {};
    for (const p of Object.keys(DECISION_POINTS)) {
      const recs = this.getDecisionsForAccount(accountId, { point: p, limit: 1 });
      latest[p] = recs[0] || null;
    }
    return {
      accountId,
      causal_phase: phase,
      causal_progress: progress,
      funnel_level: account.funnel_level || null,
      decisions_summary: { total: this.getDecisionsForAccount(accountId).length },
      latest_decisions: latest,
      recent_decisions: decisions,
    };
  }

  // 模拟（不持久化）：返回该账号 4 个决策点的快照
  simulate(accountId) {
    const account = this._getAccount(accountId);
    if (!account) return { accountId, error: 'account not found' };
    const out = { accountId, enabled: this._enabled, decisions: {} };
    for (const point of Object.keys(DECISION_POINTS)) {
      const r = this._decide(point, account, { simulate: true }, { persist: false, emit: false });
      out.decisions[point] = { state: r.state, action: r.action, label: DECISION_POINTS[point].label };
    }
    return out;
  }

  getSummary() {
    const total = this.dataStore
      ? (this.dataStore.list('account_decisions', { limit: 1e9 }).items || []).length
      : 0;
    const byPoint = {};
    const byAction = {};
    if (this.dataStore) {
      const all = (this.dataStore.list('account_decisions', { limit: 1e9 }).items) || [];
      for (const r of all) {
        byPoint[r.point] = (byPoint[r.point] || 0) + 1;
        const k = `${r.point}:${r.action}`;
        byAction[k] = (byAction[k] || 0) + 1;
      }
    }
    const qTop = (this._enabled && this.decisionEngine.qLearning.getQValue)
      ? this._topQ(10)
      : [];
    return {
      enabled: this._enabled,
      totalDecisions: total,
      byPoint,
      byAction,
      qTableTop: qTop,
      contentAB: this._contentAB
        ? { id: this._contentAB.id, variants: this._contentAB.variants.map((v) => ({ name: v.name, impressions: v.impressions || 0 })) }
        : null,
    };
  }

  _topQ(n) {
    try {
      const entries = Array.from(this.decisionEngine.qLearning.qTable.entries());
      return entries.sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([key, value]) => {
          const [state, action] = key.split(':');
          return { state, action, value };
        });
    } catch (_) { return []; }
  }
}

module.exports = { DecisionBridge, DECISION_POINTS, PHASE_PROGRESS };
