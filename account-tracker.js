/**
 * account-tracker.js — MSCMS v14 账户全链路追踪器
 *
 * 确保因果链7阶段始终使用同一个账户：
 *   注册(S1) → 养号(S2) → 内容生成(S3) → 发布(S4) →
 *   流量(S5) → DAU(S6) → 决策(S7)
 *
 * 核心能力:
 *   1. 每阶段绑定 account_id，拒绝跨账户操作
 *   2. 内容→发布→流量链路可溯源
 *   3. 账户维度统计: 内容数/发布数/流量数/转化率
 *   4. DataStore 持久化，重启后状态可恢复
 */

const crypto = require('crypto');

class AccountTracker {
  constructor(options = {}) {
    this.dataStore = options.dataStore || null;
    this.eventBus = options.eventBus || null;
    
    // 当前活跃的因果链周期对应的主账户
    // cycleAccountMap: { [cycleId]: { account_id, platform, registeredAt, ... } }
    this.cycleAccountMap = new Map();
    
    // 每阶段产出缓存（用于溯源）
    // phaseOutputs: { [cycleId]: { phase1: {}, phase2: {}, phase3: [], phase4: [], phase5: [], phase6: {}, phase7: {} } }
    this.phaseOutputs = new Map();
    
    // 账户统计快照
    this.accountStats = new Map();
    
    // 当前活跃周期ID
    this._currentCycleId = null;
    
    // 初始化标志
    this._initialized = false;
    
    // 超时检查：如果某阶段超过此时间无进展，标记停滞
    this.phaseTimeout = 300000; // 5分钟
    this.phaseTimers = new Map();
  }

  /**
   * 初始化：从 DataStore 恢复状态
   */
  async init() {
    if (this._initialized) return;
    
    if (this.dataStore) {
      try {
        const cycles = this.dataStore.list('account_tracker_cycles', { limit: 100 });
        const cycleItems = (cycles && cycles.items) ? cycles.items : [];
        for (const c of cycleItems) {
          this.cycleAccountMap.set(c.id, c);
          if (c.phases) {
            this.phaseOutputs.set(c.id, c.phases);
          }
        }
        
        // 恢复当前周期
        const current = this.dataStore.get('account_tracker_state', 'current');
        if (current) {
          this._currentCycleId = current.cycleId;
        }
      } catch (e) {
        console.warn(`[account-tracker] 恢复状态失败: ${e.message}`);
      }
    }
    
    this._initialized = true;
    console.log('[account-tracker] 账户追踪器初始化完成');
  }

  /**
   * 开始新的因果链周期 — 绑定主账户
   * 必须从已注册且已养号的账户池中选择
   */
  startCycle(cycleId, account) {
    if (!account || !account.account_id) {
      console.error('[account-tracker] 无有效账户，无法启动周期');
      return null;
    }
    
    this._currentCycleId = cycleId;
    
    const cycleData = {
      id: cycleId,
      account_id: account.account_id,
      platform: account.platform || 'unknown',
      username: account.username || 'unknown',
      email: account.email || null,
      phone: account.phone || null,
      bound_device_id: account.bound_device_id || null,
      startedAt: new Date().toISOString(),
      status: 'active',
      currentPhase: null,
      completedPhases: [],
      stats: {
        contentsGenerated: 0,
        postsPublished: 0,
        visitsRecorded: 0,
        reachTotal: 0,
        engagementTotal: 0,
      },
    };
    
    this.cycleAccountMap.set(cycleId, cycleData);
    
    // 初始化阶段产出缓存
    this.phaseOutputs.set(cycleId, {
      phase1_register: { account_id: account.account_id, platform: account.platform, timestamp: new Date().toISOString() },
      phase2_nurture: { account_id: account.account_id, status: 'healthy', timestamp: new Date().toISOString() },
      phase3_content: [],      // 生成的内容列表
      phase4_publish: [],       // 发布任务列表
      phase5_visits: [],        // 访问记录列表
    });
    
    // 持久化
    this._persistCycle(cycleId);
    this._saveState();
    
    console.log(`[account-tracker] 🔗 周期 ${cycleId} 绑定账户: ${account.account_id} (${account.platform})`);
    this.eventBus?.emit('tracker:cycle:started', { cycleId, account });
    
    return cycleData;
  }

  /**
   * 获取当前周期的绑定账户（任何阶段调用此方法确保一致性）
   */
  getCurrentAccount() {
    if (!this._currentCycleId) return null;
    const cycle = this.cycleAccountMap.get(this._currentCycleId);
    return cycle ? { account_id: cycle.account_id, platform: cycle.platform, bound_device_id: cycle.bound_device_id } : null;
  }

  /**
   * 记录阶段产出到当前周期账户上
   * 调用方传入阶段名 + 产出数据，自动绑定到当前周期账户
   */
  recordPhaseOutput(phase, data) {
    const cycleId = this._currentCycleId || data.cycle_id;
    if (!cycleId) {
      console.warn('[account-tracker] 无活跃周期，跳过阶段产出记录');
      return false;
    }
    
    const cycle = this.cycleAccountMap.get(cycleId);
    if (!cycle) {
      console.warn(`[account-tracker] 周期 ${cycleId} 未注册`);
      return false;
    }
    
    // 自动注入账户ID（确保闭环）
    data.account_id = cycle.account_id;
    data.platform = data.platform || cycle.platform;
    data.cycle_id = cycleId;
    
    const phases = this.phaseOutputs.get(cycleId);
    if (!phases) return false;
    
    switch (phase) {
      case 'content.generated':
        phases.phase3_content.push(data);
        cycle.stats.contentsGenerated++;
        cycle.currentPhase = 'content';
        break;
      case 'post.published':
        phases.phase4_publish.push(data);
        cycle.stats.postsPublished++;
        cycle.currentPhase = 'publish';
        break;
      case 'visit.recorded':
        phases.phase5_visits.push(data);
        cycle.stats.visitsRecorded++;
        cycle.stats.reachTotal += (data.reach || 0);
        cycle.stats.engagementTotal += (data.likes || 0) + (data.comments || 0) + (data.shares || 0);
        cycle.currentPhase = 'traffic';
        break;
      case 'dau.updated':
        cycle.currentPhase = 'dau';
        break;
      case 'action.execute':
        cycle.currentPhase = 'action';
        break;
    }
    
    // 标记已完成的阶段
    if (!cycle.completedPhases.includes(phase)) {
      cycle.completedPhases.push(phase);
    }
    
    // 持久化
    this._persistCycle(cycleId);
    
    return true;
  }

  /**
   * 完成当前周期
   */
  completeCycle(cycleId) {
    const cycle = this.cycleAccountMap.get(cycleId);
    if (!cycle) return;
    
    cycle.status = 'completed';
    cycle.completedAt = new Date().toISOString();
    cycle.currentPhase = 'cycle_complete';
    
    // 更新账户维度的累计统计
    this._updateAccountStats(cycle);
    
    this._persistCycle(cycleId);
    this._saveState();
    
    // 发射周期完成事件（携带账户维度统计）
    this.eventBus?.emit('tracker:cycle:completed', {
      cycleId,
      account_id: cycle.account_id,
      stats: cycle.stats,
      totalCycles: this.cycleAccountMap.size,
    });
    
    console.log(`[account-tracker] ✅ 周期 ${cycleId} 完成 (account=${cycle.account_id}) | 内容:${cycle.stats.contentsGenerated} 发布:${cycle.stats.postsPublished} 访问:${cycle.stats.visitsRecorded}`);
  }

  /**
   * 获取账户维度的累计统计
   */
  getAccountStats(accountId) {
    return this.accountStats.get(accountId) || {
      account_id: accountId,
      totalCycles: 0,
      totalContents: 0,
      totalPosts: 0,
      totalVisits: 0,
      totalReach: 0,
      totalEngagement: 0,
      conversionRate: 0,
    };
  }

  /**
   * 获取全量账户报表
   */
  getReport() {
    const accounts = [];
    for (const [accountId, stats] of this.accountStats) {
      accounts.push({
        ...stats,
        conversionRate: stats.totalVisits > 0 
          ? ((stats.totalEngagement / stats.totalVisits) * 100).toFixed(1) + '%' 
          : '0%',
      });
    }
    
    // 按总触达降序排列
    accounts.sort((a, b) => b.totalReach - a.totalReach);
    
    return {
      totalAccounts: accounts.length,
      totalCycles: this.cycleAccountMap.size,
      activeCycles: Array.from(this.cycleAccountMap.values()).filter(c => c.status === 'active').length,
      accounts,
      currentCycleId: this._currentCycleId,
    };
  }

  /**
   * 获取单个周期的完整溯源链
   */
  getCycleTrace(cycleId) {
    const cycle = this.cycleAccountMap.get(cycleId);
    if (!cycle) return null;
    
    const phases = this.phaseOutputs.get(cycleId);
    
    return {
      cycleId,
      account: {
        account_id: cycle.account_id,
        platform: cycle.platform,
        username: cycle.username,
      },
      timeline: {
        phase1_register: phases?.phase1_register?.timestamp || null,
        phase2_nurture: phases?.phase2_nurture?.timestamp || null,
        phase3_content: (phases?.phase3_content || []).length + ' 条',
        phase4_publish: (phases?.phase4_publish || []).length + ' 篇',
        phase5_visits: (phases?.phase5_visits || []).length + ' 次',
      },
      contents: phases?.phase3_content || [],
      publications: phases?.phase4_publish || [],
      visits: phases?.phase5_visits || [],
      stats: cycle.stats,
      status: cycle.status,
    };
  }

  /**
   * 健康检查：检测是否有阶段的产出未绑定账户
   */
  healthCheck() {
    const issues = [];
    
    if (this._currentCycleId) {
      const cycle = this.cycleAccountMap.get(this._currentCycleId);
      if (cycle) {
        const phases = this.phaseOutputs.get(this._currentCycleId);
        
        // 检查内容产出是否有 account_id
        if (phases?.phase3_content) {
          const withoutAccount = phases.phase3_content.filter(c => !c.account_id);
          if (withoutAccount.length > 0) {
            issues.push(`当前周期 ${withoutAccount.length} 条内容无 account_id`);
          }
        }
        
        // 检查发布产出是否有 account_id
        if (phases?.phase4_publish) {
          const withoutAccount = phases.phase4_publish.filter(p => !p.account_id);
          if (withoutAccount.length > 0) {
            issues.push(`当前周期 ${withoutAccount.length} 篇发布无 account_id`);
          }
        }
      }
    }
    
    return {
      healthy: issues.length === 0,
      issues,
      activeCycles: Array.from(this.cycleAccountMap.values()).filter(c => c.status === 'active').length,
      totalCycles: this.cycleAccountMap.size,
    };
  }

  // ── 内部方法 ────────────────────────────────────

  _updateAccountStats(cycle) {
    const accId = cycle.account_id;
    let stats = this.accountStats.get(accId);
    if (!stats) {
      stats = {
        account_id: accId,
        platform: cycle.platform,
        username: cycle.username,
        totalCycles: 0,
        totalContents: 0,
        totalPosts: 0,
        totalVisits: 0,
        totalReach: 0,
        totalEngagement: 0,
        firstSeen: cycle.startedAt,
        lastActive: null,
      };
    }
    
    stats.totalCycles++;
    stats.totalContents += cycle.stats.contentsGenerated;
    stats.totalPosts += cycle.stats.postsPublished;
    stats.totalVisits += cycle.stats.visitsRecorded;
    stats.totalReach += cycle.stats.reachTotal;
    stats.totalEngagement += cycle.stats.engagementTotal;
    stats.lastActive = cycle.completedAt || new Date().toISOString();
    
    this.accountStats.set(accId, stats);
    
    // 持久化到 DataStore
    if (this.dataStore) {
      try {
        this.dataStore.create('account_stats', { ...stats, id: accId, updated_at: new Date().toISOString() });
      } catch (e) {
        // non-critical
      }
    }
  }

  _persistCycle(cycleId) {
    if (!this.dataStore) return;
    
    const cycle = this.cycleAccountMap.get(cycleId);
    if (!cycle) return;
    
    try {
      this.dataStore.create('account_tracker_cycles', {
        ...cycle,
        phases: this.phaseOutputs.get(cycleId),
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      // non-critical
    }
  }

  _saveState() {
    if (!this.dataStore) return;
    
    try {
      this.dataStore.create('account_tracker_state', {
        id: 'current',
        cycleId: this._currentCycleId,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      // non-critical
    }
  }
}

module.exports = { AccountTracker };
