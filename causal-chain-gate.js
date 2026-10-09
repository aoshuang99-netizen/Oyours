/**
 * causal-chain-gate.js — MSCMS v14 因果链严格门控系统
 *
 * 核心设计：
 *   每个环节必须达成目标后才能自动触发下一环节。
 *   没有虚假数据，所有进度基于真实操作结果。
 *
 * 7 阶段因果链：
 *   S1: account.ed  → 目标: 注册 N 个账号    → S2
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
  // [P0-2 修复 · 2026-09-15] 停滞逃生阀标记。
  //   语义：该阶段在「无任何真实证据」下连续停滞达阈值，被显式跳过放行。
  //   它**不等于** completed —— 不伪造进度、不补假分、不计入 current；
  //   但允许后继阶段继续推进，避免整条因果链死锁。
  //   原实现没有跳过语义：停滞守卫只会无限 start() 同一阶段，
  //   实测 post.published 因此空转 224 轮 / 12.6 小时（零发布 + 零生成）。
  SKIPPED: 'skipped',
};

// 阶段配置
const PHASE_CONFIG = {
  'account.ed': {
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
    next: null,  // 循环回到 account.ed 或 post.published
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

    // [P0-2 修复] 停滞逃生阀计数：phaseName -> 连续停滞次数。
    //   同一阶段连续停滞达 _stallEscapeThreshold 次后，标记 SKIPPED 并放行后继，
    //   打破「重启 → 再停滞 → 再重启」的无限循环。
    //   真实进展（incrementProgress）或阶段完成时会清零该计数。
    this._stallCounts = new Map();
    this._stallEscapeThreshold = Number(
      opts.stallEscapeThreshold != null ? opts.stallEscapeThreshold
        : (process.env.MSCMS_CAUSAL_STALL_ESCAPE || 3)
    );

    // [P0-2 修复] 冷启动证据窗口：后 5 阶段（content.generated / post.published /
    //   visit.recorded / dau.updated / action.execute）的证据源必须落在「近期窗口」内。
    //   若用全量历史计数，每个周期都会瞬间达标 —— 那等价于补假分，会使门控形同虚设。
    //   默认 30 分钟，可用 env MSCMS_CAUSAL_EVIDENCE_WINDOW_MS 调整。
    this._evidenceWindowMs = Number(
      opts.evidenceWindowMs != null ? opts.evidenceWindowMs
        : (process.env.MSCMS_CAUSAL_EVIDENCE_WINDOW_MS || 30 * 60 * 1000)
    );

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
      totalSkips: 0,   // [P0-2] 逃生阀跳过次数（无真实证据而被放行的阶段数）
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

    // [P0-2 修复] 只有**真实事件驱动**的进展才清零停滞计数。
    //   冷启动积分（metadata.coldStart=true）不算真实进展 —— 否则
    //   「停滞重启 → 冷启动补 1 分 → 再次停滞 → 再重启」会无限循环，
    //   而停滞计数每次都被清零，永远到不了逃生阀阈值（这正是原死锁的形态）。
    if (!metadata || metadata.coldStart !== true) {
      this._stallCounts.delete(phaseName);
    }

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
    this._stallCounts.delete(phase.name);  // [P0-2] 阶段达标 → 清停滞计数
    if (phase.metadata) delete phase.metadata.skipped;  // 达标则撤销 skipped 痕迹

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
    // [P0-2 修复] SKIPPED 也视为「可放行」：逃生阀跳过的阶段不该继续堵住整条链。
    //   注意区别：SKIPPED 只放行后继，不改变该阶段自身 current（不补假分）。
    const prerequisites = this._getPrerequisites(phaseName);
    for (const prereq of prerequisites) {
      const p = this.phases.get(prereq);
      if (p && p.status === PhaseStatus.SKIPPED) {
        console.warn(`[chain-gate] ⚠️ ${phase.label} 放行：前置 ${p.label} 为 skipped(${p.current}/${p.target})，无真实证据，未补假分`);
        continue;
      }
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
    // 跳过 account.ed（已在 start() 中处理）
    if (phaseName !== 'account.ed' && !this._bootstrapPhase) {
      setTimeout(() => this._coldStartCredit(phaseName), 500);
    }

    return true;
  }

  // ── 启动因果链 ──────────────────────────────────
  async start(fromPhase = 'account.ed') {
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
    if (fromPhase === 'account.ed') {
      if (this._bootstrapPhase) {
        setTimeout(() => {
          const bootstrapData = {
            account_id: `bootstrap_cycle_${this.stats.totalCycles}`,
            : 'system',
            bootstrap: true,
          };
          if (this.eventBus) {
            this.eventBus.emit('account.ed', bootstrapData, 'chain-gate-bootstrap');
          } else {
            this.incrementProgress('account.ed', 1, {
              accountId: bootstrapData.account_id,
              : bootstrapData.,
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
    const { credit, source } = this._collectPhaseEvidence(fromPhase);

    // [P0-2 修复] 移除「credit<1 → 强行补 1 分」的兜底。
    //   该兜底是死锁的直接成因：post.published target=2，兜底只给 1 分，
    //   任何路径都到不了 2，阶段永久停在 50%。无真实证据时宁可 0 分，
    //   由停滞逃生阀标记 skipped 放行（打 WARN 留痕），也不伪造进度。
    if (credit < 1) {
      console.warn(`[chain-gate] ❄️ 冷启动: ${fromPhase} 无真实证据 (来源: ${source})，不补分（等真实事件 / 逃生阀放行）`);
      return;
    }

    const actual = Math.min(credit, target);
    this.incrementProgress(fromPhase, actual, {
      coldStart: true,
      source,
      credit,
      actual,
    });
    console.log(`[chain-gate] ❄️ 冷启动: ${fromPhase} += ${actual} (来源: ${source}, 目标: ${target})`);
  }

  // ── 阶段证据源（P0-2 新增）──────────────────────
  // 每个阶段对应一个**真实**数据源；后 5 阶段只认「近窗口内」的产物，
  // 避免用全量历史计数把门控变成走过场（那等价于补假分）。
  _collectPhaseEvidence(phaseName) {
    const windowMs = this._evidenceWindowMs;
    const cutoff = Date.now() - windowMs;
    const tag = `${Math.round(windowMs / 60000)}m`;
    try {
      switch (phaseName) {
        case 'account.ed': {
          // 累计口径：系统里已注册的账号数（注册是累积资产，不设时间窗）
          const c = this._countExistingAccounts();
          return { credit: c, source: c > 0 ? `DataStore(${c} )` : 'none' };
        }
        case 'account.healthy': {
          const c = this._countMatureAccounts();
          return { credit: c, source: c > 0 ? `DataStore(${c} mature)` : 'none' };
        }
        case 'content.generated':
          // 只认 createdAt：updatedAt 会被状态流转（ready→queued→published）误触，
          // 导致「发布动作」反过来给「生成阶段」加分。
          return { credit: this._countRecent('content', cutoff, 'createdAt'), source: `DataStore(content.createdAt@${tag})` };
        case 'post.published':
          return { credit: this._countRecent('publish', cutoff, 'published_at', 'createdAt'), source: `DataStore(publish@${tag})` };
        case 'visit.recorded':
          return { credit: this._countRecent('visits', cutoff, 'createdAt', 'timestamp'), source: `DataStore(visits@${tag})` };
        case 'dau.updated':
          return { credit: this._countRecent('dau_log', cutoff, 'timestamp', 'createdAt'), source: `DataStore(dau_log@${tag})` };
        case 'action.execute':
          return { credit: this._countRecent('decision_actions', cutoff, 'timestamp', 'createdAt'), source: `DataStore(decision_actions@${tag})` };
        default:
          return { credit: 0, source: 'unsupported-phase' };
      }
    } catch (e) {
      console.warn(`[chain-gate] 证据源统计失败 ${phaseName}: ${e.message}`);
      return { credit: 0, source: 'error' };
    }
  }

  // 统计模块中「时间字段落在 cutoff 之后」的记录数（按主字段优先，命中即计一次）
  _countRecent(module, cutoffMs, ...timeFields) {
    if (!this.dataStore) return 0;
    let result = null;
    try {
      result = this.dataStore.list(module, { limit: 100000 });
    } catch (e) {
      console.warn(`[chain-gate] 读取模块 ${module} 失败: ${e.message}`);
      return 0;
    }
    const items = (result && result.items) ? result.items : [];
    let n = 0;
    for (const it of items) {
      if (!it) continue;
      for (const f of timeFields) {
        const v = it[f];
        if (!v) continue;
        const t = Date.parse(v);
        if (!Number.isNaN(t)) { if (t >= cutoffMs) n++; break; }
      }
    }
    return n;
  }

  // 统计已有账号数
  _countExistingAccounts() {
    if (!this.dataStore) return 0;
    try {
      return this.dataStore.count('');
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
      const result = this.dataStore.list('', { limit: 99999 });
      if (!result || !result.items) return 0;
      // 已达注册之后的任意阶段（S2 健康 / S3 内容 / S4 发布 / S5 访问 / S6 DAU / S7 动作）均视为成熟
      const MATURE_PHASES = new Set(['S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
      return result.items.filter(a => MATURE_PHASES.has(a.causal_phase);
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
      if (elapsed < limit) return;
      this.handleStall(elapsed);
    }, 15000); // 每15秒检查一次
    console.log(`[chain-gate] 停滞守卫启动 (超时: ${limit/1000}s，含循环冷却 ${(this._cycleDelay||0)/1000}s；逃生阀阈值: ${this._stallEscapeThreshold} 次)`);
  }

  // ── 停滞处理（P0-2 抽出为独立方法，便于单测）──────────────
  // 返回：{ action: 'cycle' | 'skip' | 'restart', phase?, stallCount? }
  handleStall(elapsedMs) {
    console.error(`[chain-gate] ⚠️ 因果链停滞 ${Math.round((elapsedMs || 0)/1000)}s，处理中...`);

    // 找到第一个「既未达标、也未被跳过」的阶段作为重启点
    //  [P0-2 修复] 必须排除 SKIPPED，否则逃生阀跳过的阶段会被反复选中 → 又回到死循环。
    let restartFrom = null;
    for (const [name, phase] of this.phases) {
      if (phase.status !== PhaseStatus.COMPLETED && phase.status !== PhaseStatus.SKIPPED) {
        console.error(`[chain-gate] 停滞在阶段: ${phase.label} (${phase.current}/${phase.target})`);
        restartFrom = name;
        break;
      }
    }

    if (!restartFrom) {
      // 所有阶段都已达标/跳过 → 没有可重启的阶段，交由循环冷却排定下一周期
      console.log('[chain-gate] 停滞检查：所有阶段均已达标或跳过，排定下一周期');
      this._lastProgressTime = Date.now();
      this._scheduleCycleRestart();
      return { action: 'cycle' };
    }

    // ── P0-2 逃生阀：连续停滞升级 ────────────────────────────────
    // 原实现只会无限 start() 同一阶段：实测 post.published 空转 224 轮 / 12.6 小时。
    // 现改为计数升级 —— 达阈值即标记 SKIPPED 放行后继，且**不补任何假分**。
    const n = (this._stallCounts.get(restartFrom) || 0) + 1;
    this._stallCounts.set(restartFrom, n);
    const ph = this.phases.get(restartFrom);

    if (this._stallEscapeThreshold > 0 && n >= this._stallEscapeThreshold) {
      console.error(
        `[chain-gate] 🚪 逃生阀触发: ${ph.label}(${restartFrom}) 连续停滞 ${n} 次且无真实证据` +
        ` → 标记 skipped 并放行（进度保持 ${ph.current}/${ph.target}，不补假分）`
      );
      ph.status = PhaseStatus.SKIPPED;
      ph.error = `stalled x${n}, skipped without fake credit`;
      ph.metadata = {
        ...ph.metadata,
        skipped: true,
        stallCount: n,
        skippedAt: new Date().toISOString(),
        skipReason: 'no real evidence within successive stall windows',
      };
      this.stats.totalSkips = (this.stats.totalSkips || 0) + 1;
      this.emit('phase:skipped', {
        phase: restartFrom,
        label: ph.label,
        stallCount: n,
        current: ph.current,
        target: ph.target,
      });
      this._lastProgressTime = Date.now();

      if (ph.next) {
        // 放行后继（advanceTo 已支持前置为 SKIPPED 时通过）
        this.advanceTo(ph.next);
      } else {
        // 已是最后一阶段 → 排定下一周期，避免整链永久停摆
        console.warn('[chain-gate] 末段阶段被跳过 → 排定下一周期');
        this._scheduleCycleRestart();
      }
      return { action: 'skip', phase: restartFrom, stallCount: n };
    }

    console.error(`[chain-gate] ⏳ 停滞升级 ${n}/${this._stallEscapeThreshold}（连续无真实进展），从 ${ph.label} 重启`);
    this.start(restartFrom);
    return { action: 'restart', phase: restartFrom, stallCount: n };
  }

  // 排定下一周期启动（单一定时器去重 + 冷却窗口）
  // [P0-2] 从 action.execute 事件处理器中抽出，供逃生阀复用。
  _scheduleCycleRestart() {
    if (this._cycleTimer) return false;
    const delay = this._cycleDelay || 30000;
    // 冷却窗口是"有意的空闲" → 重置进度计时，避免停滞守卫把冷却误判为停滞
    this._lastProgressTime = Date.now();
    this._cycleTimer = setTimeout(() => {
      this._cycleTimer = null;
      this.start('account.ed');
    }, delay);
    return true;
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
  Executor(phaseName, fn) {
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
      // [P0-2] 可观测：停滞升级计数与逃生阀参数，便于诊断「谁在无证据空转」
      stallEscapeThreshold: this._stallEscapeThreshold,
      stallCounts: Object.fromEntries(this._stallCounts),
      evidenceWindowMs: this._evidenceWindowMs,
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
    eventBus.on('account.ed', 'chain-gate', (data) => {
      this.incrementProgress('account.ed', 1, {
        accountId: data.account_id,
        : data.,
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
        : data.,
        qualityScore: data.quality_score,
      });
    });

    eventBus.on('post.published', 'chain-gate', (data) => {
      this.incrementProgress('post.published', 1, {
        postId: data.post_id,
        accountId: data.account_id,
        : data.,
        contentId: data.content_id,
      });
    });

    eventBus.on('visit.recorded', 'chain-gate', (data) => {
      this.incrementProgress('visit.recorded', 1, {
        visitId: data.visit_id,
        : data.,
        contentId: data.content_id,
      });
    });

    // [ACCEL-2026-09-22 · P0-3] 假达标闸门。
    //   原判据 `data.currentDAU >= data.targetDAU` 在 targetDAU 被误置为 1 时**恒真**，
    //   使 dau.updated 阶段连续 14 天「达标」，彻底掩盖了真实 DAU=0 的事实。
    //   现要求同时满足：① targetDAU 有效(>0) ② 存在真实用户访问(realDAU>0) ③ 达标。
    //   任一不满足即**不推进**，并明确上报数据不足（INSUFFICIENT_REAL_DATA），
    //   杜绝用因果链 S5 自驱流量(system)刷 DAU 进度。
    let _lastDauGateLogTs = 0;
    eventBus.on('dau.updated', 'chain-gate', (data) => {
      const _tgt = Number(data.targetDAU || 0);
      const _real = Number((data.realDAU !== undefined && data.realDAU !== null)
        ? data.realDAU : (data.currentDAU || 0));
      const _now = Date.now();
      if (!(_tgt > 0)) {
        if (_now - _lastDauGateLogTs > 300000) {
          _lastDauGateLogTs = _now;
          console.warn('[chain-gate] ⛔ DAU 阶段不推进：INSUFFICIENT_TARGET（未配置 DAU 目标）');
        }
        return;
      }
      if (!(_real > 0)) {
        if (_now - _lastDauGateLogTs > 300000) {
          _lastDauGateLogTs = _now;
          console.warn('[chain-gate] ⛔ DAU 阶段不推进：INSUFFICIENT_REAL_DATA'
            + `（真实用户=0 / raw含自驱=${data.rawTodayDAU || 0} / system=${data.systemDAU || 0}`
            + ` / 目标=${_tgt}）—— 不计入进度，避免自驱流量造成假达标`);
        }
        return;
      }
      if (_real >= _tgt) {
        this.incrementProgress('dau.updated', 1, {
          currentDAU: _real,
          targetDAU: _tgt,
        });
      } else if (_now - _lastDauGateLogTs > 300000) {
        _lastDauGateLogTs = _now;
        console.log(`[chain-gate] DAU 进度 ${_real}/${_tgt}（未达标，等待真实用户增长）`);
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
        // [P0-2] 抽出为 _scheduleCycleRestart()，与逃生阀共用同一冷却闸门。
        this._scheduleCycleRestart();
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
