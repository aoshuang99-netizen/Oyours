'use strict';

/**
 * MSCMS v14 — HealEngine 错误自愈引擎
 * 贯穿因果链每个节点，提供检测/诊断/决策/执行/回滚 5 步流程
 * 
 * 12 种错误模式 × 3 级响应策略
 * 
 * 用法:
 *   const heal = new HealEngine(eventBus, dataStore);
 *   const result = await heal.execute('register', 'captcha_failed', { account, proxy });
 *   // result: { recovered: true, strategy: 'switch_solver', attempts: 1 }
 */

class HealEngine {
  constructor(eventBus, dataStore) {
    this.bus = eventBus;
    this.store = dataStore;
    this._log = [];        // 自愈日志
    this._snapshots = new Map(); // 回滚快照 (module:id → snapshot)
    this._retryCount = new Map(); // 错误重试计数 (errorKey → count)
    
    // 12 种错误模式 × 3 级响应策略
    this._strategies = {
      // ── 注册阶段 ──
      captcha_failed: {
        level1: { action: 'switch_solver', maxRetries: 2 },
        level2: { action: 'rotate_proxy', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      },
      ip_banned: {
        level1: { action: 'rotate_proxy', maxRetries: 2 },
        level2: { action: 'cooldown_30min', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      },
      // ── 设备阶段 ──
      device_offline: {
        level1: { action: 'restart_device', maxRetries: 1 },
        level2: { action: 'switch_backup_device', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      },
      // ── 内容阶段 ──
      llm_timeout: {
        level1: { action: 'retry_with_template', maxRetries: 2 },
        level2: { action: 'switch_model', maxRetries: 1 },
        level3: { action: 'use_cached_content', maxRetries: 0 }
      },
      content_low_quality: {
        level1: { action: 'regenerate_prompt', maxRetries: 2 },
        level2: { action: 'switch_style', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      },
      // ── 发布阶段 ──
      publish_rate_limited: {
        level1: { action: 'delay_retry_5min', maxRetries: 2 },
        level2: { action: 'reduce_frequency', maxRetries: 1 },
        level3: { action: 'pause_1h', maxRetries: 0 }
      },
      post_zero_reach: {
        level1: { action: 'trigger_appeal', maxRetries: 1 },
        level2: { action: 'mark_shadowban', maxRetries: 0 },
        level3: { action: 'move_to_backup_pool', maxRetries: 0 }
      },
      // ── 养号阶段 ──
      nurture_score_drop: {
        level1: { action: 'pause_operations', maxRetries: 1 },
        level2: { action: 'diagnose_account', maxRetries: 1 },
        level3: { action: 'move_to_recovery', maxRetries: 0 }
      },
      // ── 营销阶段 ──
      friend_request_rejected: {
        level1: { action: 'adjust_script', maxRetries: 2 },
        level2: { action: 'switch_target_segment', maxRetries: 1 },
        level3: { action: 'pause_24h', maxRetries: 0 }
      },
      // ── 引流阶段 ──
      dau_below_threshold: {
        level1: { action: 'increase_marketing', maxRetries: 1 },
        level2: { action: 'add_more_accounts', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      },
      low_ctr: {
        level1: { action: 'switch_prompt', maxRetries: 2 },
        level2: { action: 'ab_test_new_style', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      },
      // ── 回访阶段 ──
      followup_no_response: {
        level1: { action: 'retry_3d', maxRetries: 1 },
        level2: { action: 'change_channel', maxRetries: 1 },
        level3: { action: 'mark_churned', maxRetries: 0 }
      },
      // ── 账号级：封号/限流 → 重注册自愈（B2, P1-2）──
      // 触发路径：server.js 在账号状态变为 suspended/dead/banned 时 emit('heal.error', {errorType:'account_banned'})
      // → heal-engine level1 执行 reregister_account → emit('heal.action', {action:'reregister_account'})
      // → server.js 监听该事件执行真实重注册并回灌 S1（account.registered 事件）。
      account_banned: {
        level1: { action: 'reregister_account', maxRetries: 1 },
        level2: { action: 'cooldown_30min', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      },
      account_suspended: {
        level1: { action: 'reregister_account', maxRetries: 1 },
        level2: { action: 'cooldown_30min', maxRetries: 1 },
        level3: { action: 'escalate_human', maxRetries: 0 }
      }
    };

    // 监听自愈错误事件 → 驱动自愈流程（execute 内部 emit heal.action）
    if (this.bus) {
      this.bus.on('heal.error', 'heal-engine', (data) => {
        this._log.push({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          ts: new Date().toISOString(),
          level: 'error',
          ...data
        });
        // B2 修复：收到 heal.error 必须真正驱动 execute()，否则自愈链在第一步断开（仅记录日志不执行）。
        // 但 execute() 在 level3 穷尽所有策略后会「再次 emit heal.error」(escalated:true) 以告警人工；
        // 若此处无条件再调 execute()，会形成无限异步递归 → 撑爆事件循环使主服务假死（已发生一次）。
        // 因此 escalated:true（已升级人工）的信号只记录、不再驱动 execute，彻底斩断循环。
        if (data && data.escalated) {
          console.warn('[heal] 自愈已升级人工，停止自动重试:', (data.module || '?') + ':' + (data.errorType || '?'));
          return;
        }
        const mod = (data && data.module) || 'account';
        const et = (data && data.errorType) || 'unknown';
        const ctx = (data && data.context) || {};
        this.execute(mod, et, ctx).catch((e) => console.error('[heal] execute 失败:', e.message));
      });
    }
  }

  /**
   * 执行自愈流程
   * @param {string} module - 出错模块
   * @param {string} errorType - 错误类型（12种之一）
   * @param {object} context - 上下文数据
   * @returns {Promise<object>} { recovered, strategy, attempts, escalated }
   */
  async execute(module, errorType, context = {}) {
    const errorKey = `${module}:${errorType}`;
    const retryCount = this._retryCount.get(errorKey) || 0;
    
    // Step 1: 错误检测
    this._logHeal('detect', module, errorType, `Detected ${errorType} in ${module}`, context);

    // Step 2: 根因诊断
    const diagnosis = this._diagnose(module, errorType, context, retryCount);
    this._logHeal('diagnose', module, errorType, `Root cause: ${diagnosis.rootCause}, level: ${diagnosis.level}`, diagnosis);

    // Step 3: 自愈决策
    const strategy = this._decide(errorType, diagnosis.level);
    if (!strategy) {
      this._logHeal('fail', module, errorType, 'No strategy available', { errorType });
      return { recovered: false, strategy: null, attempts: retryCount, escalated: true };
    }

    // Step 4: 执行修复
    this._logHeal('execute', module, errorType, `Executing: ${strategy.action} (level ${diagnosis.level})`, { strategy });
    
    // 创建快照（用于回滚）
    this._createSnapshot(module, context);

    let recovered = false;
    try {
      recovered = await this._executeAction(module, strategy.action, context);
    } catch (e) {
      this._logHeal('error', module, errorType, `Execution failed: ${e.message}`, { error: e.message });
      recovered = false;
    }

    // Step 5: 结果验证 + 回滚
    if (recovered) {
      this._retryCount.delete(errorKey);
      this._logHeal('recover', module, errorType, `Recovered via ${strategy.action}`, { strategy });
      if (this.bus) {
        this.bus.emit('heal.recovered', { module, errorType, strategy: strategy.action, context }, 'heal-engine');
      }
      return { recovered: true, strategy: strategy.action, attempts: retryCount + 1, escalated: false };
    }

    // 未恢复 — 升级或回滚
    this._retryCount.set(errorKey, retryCount + 1);

    if (diagnosis.level < 3) {
      // 升级到下一级
      this._logHeal('escalate', module, errorType, `Escalating to level ${diagnosis.level + 1}`, {});
      return this.execute(module, errorType, context);
    }

    // Level 3 仍失败 → 回滚 + 人工告警
    this._rollback(module, context);
    this._logHeal('fail', module, errorType, `All levels exhausted, escalated to human`, { finalStrategy: strategy.action });
    
    if (this.bus) {
      this.bus.emit('heal.error', {
        module, errorType, context,
        message: `All self-healing strategies exhausted for ${errorType} in ${module}`,
        escalated: true
      }, 'heal-engine');
    }

    return { recovered: false, strategy: strategy.action, attempts: retryCount + 1, escalated: true };
  }

  /**
   * 根因诊断 — 根据重试次数决定响应级别
   */
  _diagnose(module, errorType, context, retryCount) {
    let level = 1;
    if (retryCount >= 2) level = 2;
    if (retryCount >= 4) level = 3;

    // 根据上下文调整级别
    if (context.severity === 'critical') level = Math.max(level, 3);
    if (context.consecutiveFailures >= 3) level = Math.max(level, 2);

    const rootCauses = {
      captcha_failed: 'CAPTCHA solver service unavailable or accuracy too low',
      ip_banned: 'Proxy IP detected and banned by target platform',
      device_offline: 'Cloud device crashed or network disconnected',
      llm_timeout: 'LLM API response timeout or rate limited',
      content_low_quality: 'Generated content quality score below threshold',
      publish_rate_limited: 'Platform rate limit exceeded for this account',
      post_zero_reach: 'Post received zero impressions (possible shadowban)',
      nurture_score_drop: 'Account health score dropped suddenly',
      friend_request_rejected: 'Friend request rejection rate exceeds 50%',
      dau_below_threshold: 'DAU below 50% of target for sustained period',
      low_ctr: 'Content click-through rate below 1%',
      followup_no_response: 'Customer did not respond to follow-up within 48h',
      account_banned: 'Account permanently banned by platform — requires fresh registration (new identity/IP)',
      account_suspended: 'Account suspended by platform — requires fresh registration or cooldown'
    };

    return {
      rootCause: rootCauses[errorType] || 'Unknown error pattern',
      level,
      retryCount,
      context
    };
  }

  /**
   * 自愈决策 — 选择策略
   */
  _decide(errorType, level) {
    const strategies = this._strategies[errorType];
    if (!strategies) return null;
    
    const levelKey = `level${level}`;
    return strategies[levelKey] || null;
  }

  /**
   * 执行具体修复动作
   */
  async _executeAction(module, action, context) {
    // 通知模块执行对应动作
    // 各模块可通过 EventBus 监听 'heal.action' 来执行具体逻辑
    if (this.bus) {
      this.bus.emit('heal.action', { module, action, context }, 'heal-engine');
    }

    // 内置简单动作（不需要模块配合的）
    switch (action) {
      case 'cooldown_30min':
      case 'delay_retry_5min':
      case 'pause_1h':
      case 'pause_24h':
      case 'retry_3d':
        // 这些是等待类动作，标记后返回 true（模块自行等待）
        return true;
      
      case 'escalate_human':
        // 人工告警 — 记录到 dataStore
        if (this.store) {
          this.store.create('heal_alerts', {
            module,
            action,
            context,
            status: 'pending',
            severity: 'high'
          });
        }
        return false; // 人工介入不算自动恢复
      
      case 'mark_churned':
      case 'move_to_backup_pool':
      case 'move_to_recovery':
      case 'mark_shadowban':
        // 标记类动作 — 记录到 dataStore
        if (this.store) {
          this.store.create('heal_actions', {
            module, action, context, executedAt: new Date().toISOString()
          });
        }
        return true;
      
      default:
        // 其他动作（switch_solver/rotate_proxy/restart_device等）
        // 由模块自行监听 heal.action 事件执行
        // 引擎假设模块会执行，返回 true
        return true;
    }
  }

  /**
   * 创建快照（用于回滚）
   */
  _createSnapshot(module, context) {
    const key = `${module}:${context.account_id || context.id || 'default'}`;
    this._snapshots.set(key, {
      module,
      context: JSON.parse(JSON.stringify(context)),
      ts: new Date().toISOString()
    });
  }

  /**
   * 回滚
   */
  _rollback(module, context) {
    const key = `${module}:${context.account_id || context.id || 'default'}`;
    const snapshot = this._snapshots.get(key);
    if (snapshot) {
      this._logHeal('rollback', module, 'rollback', `Rolled back to ${snapshot.ts}`, { snapshot });
      this._snapshots.delete(key);
      if (this.bus) {
        this.bus.emit('heal.rollback', { module, snapshot, context }, 'heal-engine');
      }
    }
  }

  /**
   * 获取自愈日志
   */
  getLog(limit = 100) {
    return this._log.slice(-limit);
  }

  /**
   * 获取统计
   */
  getStats() {
    const total = this._log.length;
    const recovered = this._log.filter(l => l.phase === 'recover').length;
    const failed = this._log.filter(l => l.phase === 'fail').length;
    return {
      totalHeals: total,
      totalHealed: recovered,
      recovered,
      failed,
      escalated: this._log.filter(l => l.phase === 'escalate').length,
      successRate: total > 0 ? Math.round((recovered / total) * 100) + '%' : '0%',
      pending: this._retryCount.size,
      activeSnapshots: this._snapshots.size,
      activeRetries: this._retryCount.size,
      errorTypes: Array.from(new Set(this._log.map(l => l.errorType))).filter(Boolean)
    };
  }

  /**
   * 获取所有错误模式
   */
  getErrorPatterns() {
    return Object.keys(this._strategies).map(type => ({
      errorType: type,
      levels: Object.keys(this._strategies[type]).length,
      strategies: this._strategies[type]
    }));
  }

  /**
   * 内部日志
   */
  _logHeal(phase, module, errorType, message, data) {
    this._log.push({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      ts: new Date().toISOString(),
      phase, // detect/diagnose/execute/recover/fail/escalate/rollback
      module,
      errorType,
      message,
      data: data ? JSON.parse(JSON.stringify(data)) : undefined
    });
    // 保留最近 500 条
    if (this._log.length > 500) {
      this._log = this._log.slice(-500);
    }
  }
}

module.exports = { HealEngine };
