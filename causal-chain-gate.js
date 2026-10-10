/**
 * causal-chain-gate.js — MSCMS v14 因果链严格门控系统
 *
 * 核心设计：
 *   每个环节必须达成目标后才能自动触发下一环节。
 *   没有虚假数据，所有进度基于真实操作结果。
 *
 * 7 阶段因果链：
 *   S1: account.registered  → 目标: 注册 N 个账号    → S2
 *   S2: account.healthy     → 目标: 养号 N 个成熟    → S3
 *   S3: content.generated   → 目标: 生成 N 条内容    → S4
 *   S4: post.published      → 目标: 发布 N 篇帖子    → S5
 *   S5: visit.recorded      → 目标: 获得 N 次访问    → S6
 *   S6: dau.updated         → 目标: 达到 N DAU       → S7
 *   S7: action.execute      → 目标: 执行 N 个动作    → 循环
 */

const { EventEmitter } = require('events');

// 阶段状态
const PhaseStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
};

// 阶段配置
const PHASE_CONFIG = {
  'account.registered': {
    order: 1,
    label: '账号注册',
    next: 'account.healthy',
    defaultTarget: 10,
    description: '注册足够账号进入养号阶段',
  },
  'account.healthy': {
    order: 2,
    label: '养号成熟',
    next: 'content.generated',
    defaultTarget: 5,
    description: '养号达到健康标准后开始内容生成',
  },
  'content.generated': {
    order: 3,
    label: '内容生成',
    next: 'post.published',
    defaultTarget: 10,
    description: '生成足够内容后开始发布',
  },
  'post.published': {
    order: 4,
    label: '内容发布',
    next: 'visit.recorded',
    defaultTarget: 5,
    description: '通过云手机发布后开始获取流量',
  },
  'visit.recorded': {
    order: 5,
    label: '流量获取',
    next: 'dau.updated',
    defaultTarget: 50,
    description: '获得足够真实访客后更新DAU',
  },
  'dau.updated': {
    order: 6,
    label: 'DAU达标',
    next: 'action.execute',
    defaultTarget: 1,  // 1次达标即可
    description: 'DAU达到目标后触发决策',
  },
  'action.execute': {
    order: 7,
    label: '决策执行',
    next: null,  // 循环回到 account.registered 或 post.published
    defaultTarget: 1,
    description: '执行决策动作后循环',
  },
};

class CausalChainGate extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.setMaxListeners(50);
    this.eventBus = opts.eventBus || null;
    this.dataStore = opts.dataStore || null;

    // 全局开关
    this.enabled = opts.enabled !== false;
    this.autoAdvance = opts.autoAdvance !== false;
    this._bootstrapPhase = opts.bootstrapPhase === true;  // 默认关闭自举模式，需要显式启用
    this._cycleDelay = opts.cycleDelay || 30000;  // 循环冷却时间 (ms)，默认30秒
    // [2026-09-12] 循环冷却的「硬门闩」：action.execute 事件可能在一个周期内到达多次，
    //   原实现每次都给 start() 排一个 setTimeout → 待执行定时器越堆越多，
    //   循环冷却形同虚设（实测 180s 冷却下仍每 ~29s 自启一个周期，生成速率 3 倍超标）。
    //   现改为单一定时器 + 启动即取消，保证两次循环之间至少有 _cycleDelay 的间隔。
    this._cycleTimer = null;

    // 阶段状态 Map<phaseName, PhaseState>
    this.phases = new Map();

    // 阶段执行器
    this._executors = new Map();

    // 停滞守卫：如果任何阶段超过 120 秒无进展，自动重启因果链
    this._stallTimeout = opts.stallTimeout || 120000;  // 默认 120 秒
    this._stallTimer = null;
    this._lastProgressTime = Date.now();

    // 初始化所有阶段
    for (const [name, cfg] of Object.entries(PHASE_CONFIG)) {
      this.phases.set(name, {
        name,
        order: cfg.order,
        label: cfg.label,
        next: cfg.next,
        target: cfg.defaultTarget,
        current: 0,
        status: PhaseStatus.IDLE,
        startedAt: null,
        completedAt: null,
        error: null,
        metadata: {},
      });
    }

    // 统计
    this.stats = {
      totalCycles: 0,
      totalAdvancements: 0,
      totalBlocks: 0,
      currentCycleStart: null,
    };
  }

  // ── 配置目标 ───────────────────────────────────
  setTarget(phaseName, target) {
    const phase = this.phases.get(phaseName);
    if (!phase) return false;
    phase.target = target;
    // 如果目标已达成，标记完成
    if (phase.current >= target && phase.status === PhaseStatus.RUNNING) {
      this._completePhase(phase);
    }
    this.emit('target:updated', { phase: phaseName, target, current: phase.current });
    return true;
  }

  batchSetTargets(targets) {
    for (const [name, target] of Object.entries(targets)) {
      this.setTarget(name, target);
    }
  }

  // ── 累进进度（核心方法）─────────────────────────
  incrementProgress(phaseName, delta = 1, metadata = {}) {
    const phase = this.phases.get(phaseName);
    // 阻止已完成和空闲阶段的递增：IDLE 阶段尚未通过 advanceTo 激活，
    // 此时收到的事件属于旧周期残留，不应计入新周期计数器
    if (!phase || phase.status === PhaseStatus.COMPLETED || phase.status === PhaseStatus.IDLE) return this;

    this._lastProgressTime = Date.now();  // 记录最后进展时间

    const prevCurrent = phase.current;
    phase.current += delta;
    phase.metadata = { ...phase.metadata, ...metadata };

    this.emit('progress', {
      phase: phaseName,
      current: phase.current,
      target: phase.target,
      delta,
      progress: Math.min(100, (phase.current / phase.target) * 100),
      metadata,
    });

    // 检查是否达标
    if (prevCurrent < phase.target && phase.current >= phase.target) {
      this._completePhase(phase);
    }

    return this;
  }

  // 设置绝对进度
  setProgress(phaseName, current, metadata = {}) {
    const phase = this.phases.get(phaseName);
    if (!phase || phase.status === PhaseStatus.COMPLETED) return this;

    const delta = current - phase.current;
    if (delta <= 0) return this;

    return this.incrementProgress(phaseName, delta, metadata);
  }

  // ── 内部：完成阶段并推进 ────────────────────────
  async _completePhase(phase) {
    phase.status = PhaseStatus.COMPLETED;
    phase.completedAt = new Date().toISOString();
    this._lastProgressTime = Date.now();  // 记录进展

    console.log(`[chain-gate] ✅ ${phase.label}(${phase.name}) 达标: ${phase.current}/${phase.target}`);
    this.emit('phase:complete', {
      phase: phase.name,
      label: phase.label,
      current: phase.current,
      target: phase.target,
    });

    this.stats.totalAdvancements++;

    // 自动推进到下一阶段
    if (this.autoAdvance && phase.next) {
      await this.advanceTo(phase.next);
    }
  }

  // ── 推进到指定阶段 ──────────────────────────────
  async advanceTo(phaseName) {
    const phase = this.phases.get(phaseName);
    if (!phase) return false;

    // 检查前置阶段是否完成
    const prerequisites = this._getPrerequisites(phaseName);
    for (const prereq of prerequisites) {
      const p = this.phases.get(prereq);
      if (p && p.status !== PhaseStatus.COMPLETED) {
        console.log(`[chain-gate] ⛔ ${phase.label} 阻塞: 前置 ${p.label} 未完成 (${p.current}/${p.target})`);
        phase.status = PhaseStatus.BLOCKED;
        this.stats.totalBlocks++;
        this.emit('phase:blocked', {
          phase: phaseName,
          blockedBy: prereq,
          reason: `${p.label} 未完成 (${p.current}/${p.target})`,
        });
        return false;
      }
    }

    // 启动阶段
    phase.status = PhaseStatus.RUNNING;
    phase.startedAt = new Date().toISOString();
    phase.error = null;

    console.log(`[chain-gate] 🚀 启动阶段: ${phase.label} (目标: ${phase.target})`);
    this.emit('phase:started', {
      phase: phaseName,
      label: phase.label,
      target: phase.target,
      current: phase.current,
    });

    // 调用执行器
    const executor = this._executors.get(phaseName);
    if (executor) {
      try {
        await executor(phase);
      } catch (e) {
        console.error(`[chain-gate] ${phase.label} 执行器失败: ${e.message}`);
        phase.error = e.message;
        this.emit('phase:error', { phase: phaseName, error: e.message });
      }
    }

    // 冷启动自动积分：当阶段推进且非自举模式时，从已有数据推进
    // 跳过 account.registered（已在 start() 中处理）
    if (phaseName !== 'account.registered' && !this._bootstrapPhase) {
      setTimeout(() => this._coldStartCredit(phaseName), 500);
    }

    return true;
  }

  // ── 启动因果链 ──────────────────────────────────
  async start(fromPhase = 'account.registered') {
    if (!this.enabled) return;

    // [2026-09-12] 本次启动即消费掉循环冷却窗口：清掉待执行的冷却定时器，
    //   避免「停滞守卫/手动重启」与「上一周期排定的冷却」叠加 → 周期叠加跑飞。
    if (this._cycleTimer) { clearTimeout(this._cycleTimer); this._cycleTimer = null; }

    this.stats.currentCycleStart = new Date().toISOString();
    this.stats.totalCycles++;

    console.log(`[chain-gate] 🔗 因果链启动 (周期 #${this.stats.totalCycles})，起始: ${fromPhase}`);

    // 重置所有阶段（清除上次循环的 completed 状态）
    for (const [, phase] of this.phases) {
      if (phase.order >= PHASE_CONFIG[fromPhase].order) {
        phase.status = PhaseStatus.IDLE;
        phase.current = 0;
        phase.startedAt = null;
        phase.completedAt = null;
        phase.error = null;
        phase.metadata = {};
      }
    }

    this.emit('chain:started', { cycle: this.stats.totalCycles, fromPhase });
    
    // 启动停滞守卫
    this._startStallGuard();
    
    // ── 冷启动 / 自举引导 ──────────────────────────
    // bootstrapPhase=true: 通过 EventBus 发射合成事件（旧行为保持兼容）
    // bootstrapPhase=false: 从 DataStore 统计已有账号，冷启动推进
    if (fromPhase === 'account.registered') {
      if (this._bootstrapPhase) {
        setTimeout(() => {
          const bootstrapData = {
            account_id: `bootstrap_cycle_${this.stats.totalCycles}`,
            platform: 'system',
            bootstrap: true,
          };
          if (this.eventBus) {
            this.eventBus.emit('account.registered', bootstrapData, 'chain-gate-bootstrap');
          } else {
            this.incrementProgress('account.registered', 1, {
              accountId: bootstrapData.account_id,
              platform: bootstrapData.platform,
              bootstrap: true,
            });
          }
        }, 1000);
      } else {
        // 冷启动：延迟 500ms 后从 DataStore 统计已有账号
        setTimeout(() => this._coldStartCredit(fromPhase), 500);
      }
    }
    
    await this.advanceTo(fromPhase);
  }

  // ── 冷启动积分：从已有数据推进第一阶段 ────────
  async _coldStartCredit(fromPhase) {
    const phase = this.phases.get(fromPhase);
    if (!phase || phase.status !== PhaseStatus.RUNNING) {
      // advanceTo 可能还未完成，重试一次
      await new Promise(r => setTimeout(r, 1500));
      const retryPhase = this.phases.get(fromPhase);
      if (!retryPhase || retryPhase.status !== PhaseStatus.RUNNING) {
        console.log(`[chain-gate] ❄️ 冷启动跳过: ${fromPhase} 状态=${retryPhase?.status}`);
        return;
      }
    }

    const target = phase.target;
    let credit = 0;
    let source = 'none';

    if (fromPhase === 'account.registered') {
      // 从 DataStore 统计已有账号数
      credit = this._countExistingAccounts();
      source = credit > 0 ? `DataStore(${credit} accounts)` : 'bootstrap(1)';
    } else if (fromPhase === 'account.healthy') {
      // 统计已成熟的账号数（S2/S3）
      credit = this._countMatureAccounts();
      source = credit > 0 ? `DataStore(${credit} mature)` : 'bootstrap(1)';
    }

    // 至少给 1 分保证管线启动
    if (credit < 1) credit = 1;

    const actual = Math.min(credit, target);
    this.incrementProgress(fromPhase, actual, {
      coldStart: true,
      source,
      credit,
      actual,
    });
    console.log(`[chain-gate] ❄️ 冷启动: ${fromPhase} += ${actual} (来源: ${source}, 目标: ${target})`);
  }

  // 统计已有账号数
  _countExistingAccounts() {
    if (!this.dataStore) return 0;
    try {
      return this.dataStore.count('accounts');
    } catch (e) {
      console.warn(`[chain-gate] 统计账号失败: ${e.message}`);
      return 0;
    }
  }

  // 统计已成熟账号数（已达 account.healthy 阶段，causal_phase >= S2）
  // 注意：账号真实阶段字段是 causal_phase（值 S1..S7），不是 status / phase。
  // 早期误用 status 字段判成熟，导致冷启动 credit 恒为 0。
  _countMatureAccounts() {
    if (!this.dataStore) return 0;
    try {
      const result = this.dataStore.list('accounts', { limit: 99999 });
      if (!result || !result.items) return 0;
      // 已达注册之后的任意阶段（S2 健康 / S3 内容 / S4 发布 / S5 访问 / S6 DAU / S7 动作）均视为成熟
      const MATURE_PHASES = new Set(['S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
      return result.items.filter(a => MATURE_PHASES.has(a.causal_phase)).length;
    } catch (e) {
      console.warn(`[chain-gate] 统计成熟账号失败: ${e.message}`);
      return 0;
    }
  }

  // ── 停滞守卫 ───────────────────────────────────
  // [2026-09-12] 有效超时必须 **大于** 循环冷却窗口：一个周期跑完后的 `_cycleDelay`
  //   属于"有意的空闲"，不是停滞。若 stallTimeout(120s) < cycleDelay(180s)，
  //   停滞守卫会在冷却未到期时就抢跑重启 → 等效周期被压到 stallTimeout，
  //   冷却形同虚设（实测 180s 冷却档下周期仍是 ~120s，即此因）。
  _effectiveStallTimeout() {
    const slack = 60000;   // 留 60s 余量：冷却到期后还需时间启动下一周期
    return Math.max(this._stallTimeout, (this._cycleDelay || 0) + slack);
  }

  _startStallGuard() {
    this._stopStallGuard();
    this._lastProgressTime = Date.now();
    const limit = this._effectiveStallTimeout();
    this._stallTimer = setInterval(() => {
      const elapsed = Date.now() - this._lastProgressTime;
      if (elapsed >= limit) {
        console.error(`[chain-gate] ⚠️ 因果链停滞 ${Math.round(elapsed/1000)}s，自动重启...`);
        // 找到第一个未完成的阶段（非 IDLE、非 COMPLETED）
        let restartFrom = 'account.registered';
        for (const [name, phase] of this.phases) {
          if (phase.status !== PhaseStatus.COMPLETED) {
            console.error(`[chain-gate] 停滞在阶段: ${phase.label} (${phase.current}/${phase.target})`);
            restartFrom = name;
            break;
          }
        }
        // 从停滞的阶段重启，保留已完成阶段的进度
        this.start(restartFrom);
      }
    }, 15000); // 每15秒检查一次
    console.log(`[chain-gate] 停滞守卫启动 (超时: ${limit/1000}s，含循环冷却 ${(this._cycleDelay||0)/1000}s)`);
  }

  _stopStallGuard() {
    if (this._stallTimer) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
  }

  // ── 暂停/恢复 ────────────────────────────────────
  pause() {
    this.autoAdvance = false;
    this.emit('chain:paused');
    console.log('[chain-gate] ⏸ 因果链暂停');
  }

  resume() {
    this.autoAdvance = true;
    this.emit('chain:resumed');
    console.log('[chain-gate] ▶ 因果链恢复');
    // 检查是否有阻塞的阶段
    for (const [name, phase] of this.phases) {
      if (phase.status === PhaseStatus.BLOCKED) {
        this.advanceTo(name);
      }
    }
  }

  // ── 注册执行器 ───────────────────────────────────
  registerExecutor(phaseName, fn) {
    this._executors.set(phaseName, fn);
    return this;
  }

  // ── 查询方法 ─────────────────────────────────────
  getPhase(phaseName) {
    const phase = this.phases.get(phaseName);
    if (!phase) return null;
    return {
      ...phase,
      progress: phase.target > 0 ? Math.min(100, (phase.current / phase.target) * 100) : 0,
      remaining: Math.max(0, phase.target - phase.current),
    };
  }

  getAllPhases() {
    const result = [];
    for (const [name, phase] of this.phases) {
      result.push(this.getPhase(name));
    }
    result.sort((a, b) => a.order - b.order);
    return result;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      autoAdvance: this.autoAdvance,
      stats: this.stats,
      phases: this.getAllPhases(),
      currentPhase: this._getCurrentPhase(),
      // [2026-09-12] 可观测：循环冷却是否已排定（true 表示距下次自启还有 ≤_cycleDelay）
      cycleCooldownPending: !!this._cycleTimer,
      cycleDelayMs: this._cycleDelay,
    };
  }

  _getCurrentPhase() {
    // 找第一个 RUNNING 的阶段
    for (const [, phase] of this.phases) {
      if (phase.status === PhaseStatus.RUNNING) return phase.name;
    }
    // 找第一个 IDLE 的
    for (const [, phase] of this.phases) {
      if (phase.status === PhaseStatus.IDLE) return phase.name;
    }
    // 所有阶段都已完成 → 周期完成，等待重启
    return 'cycle_complete';
  }

  _getPrerequisites(phaseName) {
    const cfg = PHASE_CONFIG[phaseName];
    if (!cfg) return [];
    const prereqs = [];
    for (const [name, otherCfg] of Object.entries(PHASE_CONFIG)) {
      if (otherCfg.next === phaseName) {
        prereqs.push(name);
      }
    }
    return prereqs;
  }

  // ── 连接 EventBus ────────────────────────────────
  connectEventBus(eventBus) {
    if (!eventBus) return;

    // 监听真实事件，自动累进进度
    eventBus.on('account.registered', 'chain-gate', (data) => {
      this.incrementProgress('account.registered', 1, {
        accountId: data.account_id,
        platform: data.platform,
      });
    });

    eventBus.on('account.healthy', 'chain-gate', (data) => {
      this.incrementProgress('account.healthy', 1, {
        accountId: data.account_id,
        score: data.score,
      });
    });

    eventBus.on('content.generated', 'chain-gate', (data) => {
      this.incrementProgress('content.generated', 1, {
        contentId: data.content_id,
        platform: data.platform,
        qualityScore: data.quality_score,
      });
    });

    eventBus.on('post.published', 'chain-gate', (data) => {
      this.incrementProgress('post.published', 1, {
        postId: data.post_id,
        accountId: data.account_id,
        platform: data.platform,
        contentId: data.content_id,
      });
    });

    eventBus.on('visit.recorded', 'chain-gate', (data) => {
      this.incrementProgress('visit.recorded', 1, {
        visitId: data.visit_id,
        platform: data.platform,
        contentId: data.content_id,
      });
    });

    eventBus.on('dau.updated', 'chain-gate', (data) => {
      // DAU 仅在达标时推进
      if (data.currentDAU >= data.targetDAU) {
        this.incrementProgress('dau.updated', 1, {
          currentDAU: data.currentDAU,
          targetDAU: data.targetDAU,
        });
      }
    });

    eventBus.on('action.execute', 'chain-gate', (data) => {
      this.incrementProgress('action.execute', 1, {
        actionType: data.action_type,
      });
      // 循环：仅当所有阶段都完成后才重置并重新开始
      const actionPhase = this.phases.get('action.execute');
      if (actionPhase && actionPhase.status === PhaseStatus.COMPLETED) {
        // [2026-09-12] 单一定时器去重：一个周期内 action.execute 可能到达多次，
        //   重复排定时器会让冷却失效（周期叠加）。已有待执行冷却时直接返回。
        if (this._cycleTimer) return;
        const delay = this._cycleDelay || 30000; // 默认30秒冷却
        // 冷却窗口是"有意的空闲"→ 重置进度计时，避免停滞守卫把冷却误判为停滞
        this._lastProgressTime = Date.now();
        this._cycleTimer = setTimeout(() => {
          this._cycleTimer = null;
          this.start('account.registered');
        }, delay);
      }
    });

    return this;
  }

  // ── 持久化 ──────────────────────────────────────
  toJSON() {
    const phases = {};
    for (const [name, phase] of this.phases) {
      phases[name] = {
        target: phase.target,
        current: phase.current,
        status: phase.status,
        startedAt: phase.startedAt,
        completedAt: phase.completedAt,
      };
    }
    return { phases, stats: this.stats };
  }

  fromJSON(data) {
    if (!data || !data.phases) return;
    for (const [name, saved] of Object.entries(data.phases)) {
      const phase = this.phases.get(name);
      if (phase) {
        phase.target = saved.target || phase.target;
        phase.current = saved.current || 0;
        phase.status = saved.status || PhaseStatus.IDLE;
        phase.startedAt = saved.startedAt || null;
        phase.completedAt = saved.completedAt || null;
      }
    }
    if (data.stats) this.stats = { ...this.stats, ...data.stats };
  }
}

module.exports = { CausalChainGate, PhaseStatus, PHASE_CONFIG };
