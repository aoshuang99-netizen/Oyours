'use strict';

/**
 * MSCMS v14 — EventBus 统一事件总线
 * 基于 Node.js EventEmitter，0 外部依赖
 * 
 * 7 条因果链事件:
 *   account.ed  (S1注册 → S3养号)
 *   account.healthy     (S3养号 → S5发布)
 *   content.generated   (S4内容 → S5发布)
 *   post.published      (S5发布 → S6营销)
 *   visit.recorded      (S6营销 → S7分析)
 *   dau.updated         (S7分析 → 决策引擎)
 *   action.execute      (决策引擎 → S6营销)
 * 
 * 错误事件:
 *   heal.error          (任何模块自愈失败)
 *   heal.recovered      (自愈成功)
 *   chain.stalled       (因果链停滞>10min)
 */

const { EventEmitter } = require('events');

class EventBus {
  constructor() {
    this._bus = new EventEmitter();
    this._bus.setMaxListeners(100); // 21模块 × 5子页 = 105 潜在监听器
    this._subscriptions = new Map(); // 记录订阅关系，便于调试
    this._eventLog = [];            // 最近 500 条事件日志
    this._stats = {
      emitted: 0,
      handled: 0,
      errors: 0
    };
    this._causalChainState = new Map(); // Track last fired time per chain
  }

  /**
   * 订阅事件
   * @param {string} event - 事件名
   * @param {string} subscriber - 订阅者名称（模块名）
   * @param {} handler - 处理函数 (data) => void | Promise
   */
  on(event, subscriber, handler) {
    const wrapped = async (data) => {
      const ts = new Date().toISOString();
      try {
        this._stats.handled++;
        await handler(data);
      } catch (err) {
        this._stats.errors++;
        this._log('ERROR', event, `Subscriber "${subscriber}" failed: ${err.message}`);
        // 自愈失败事件
        this.emit('heal.error', {
          event, subscriber, error: err.message,
          data, ts, source: 'event-bus'
        });
      }
    };
    this._bus.on(event, wrapped);
    
    if (!this._subscriptions.has(event)) {
      this._subscriptions.set(event, []);
    }
    this._subscriptions.get(event).push({ subscriber, handler: wrapped });
    this._log('SUBSCRIBE', event, `${subscriber} subscribed`);
  }

  /**
   * 订阅一次
   */
  once(event, subscriber, handler) {
    const wrapped = async (data) => {
      try {
        await handler(data);
      } catch (err) {
        this._stats.errors++;
        this._log('ERROR', event, `Once subscriber "${subscriber}" failed: ${err.message}`);
        this.emit('heal.error', { event, subscriber, error: err.message, data, source: 'event-bus' });
      }
    };
    this._bus.once(event, wrapped);
    this._log('SUBSCRIBE', event, `${subscriber} subscribed (once)`);
  }

  /**
   * 发布事件（同步触发所有监听器）
   * @param {string} event - 事件名
   * @param {object} data - 事件数据（必须含数据契约字段）
   * @param {string} source - 发布者
   */
  emit(event, data = {}, source = 'unknown') {
    const ts = new Date().toISOString();
    const payload = { ...data, _event: event, _source: source, _ts: ts };
    this._stats.emitted++;
    this._log('EMIT', event, `${source} → ${JSON.stringify(data).substring(0, 200)}`);
    this._bus.emit(event, payload);
    
    // Track causal chain state
    this._causalChainState.set(event, { lastFired: Date.now() });
  }

  /**
   * 取消订阅
   */
  off(event, subscriber) {
    const subs = this._subscriptions.get(event);
    if (subs) {
      const idx = subs.findIndex(s => s.subscriber === subscriber);
      if (idx >= 0) {
        this._bus.removeListener(event, subs[idx].handler);
        subs.splice(idx, 1);
        this._log('UNSUBSCRIBE', event, `${subscriber} unsubscribed`);
      }
    }
  }

  /**
   * 获取事件日志（最近 N 条）
   */
  getLog(limit = 100) {
    return this._eventLog.slice(-limit);
  }

  /**
   * 获取统计
   */
  getStats() {
    const subscribers = {};
    for (const [event, subs] of this._subscriptions) {
      subscribers[event] = subs.length;
    }
    // Build event counts from the log
    const eventCounts = {};
    let lastEvent = '';
    for (const e of this._eventLog) {
      const name = e.eventName || e.event || 'unknown';
      eventCounts[name] = (eventCounts[name] || 0) + 1;
      lastEvent = name;
    }
    // Check stalled chains
    const stalledChains = [];
    const now = Date.now();
    for (const [name, info] of this._causalChainState) {
      if (info.lastFired && (now - info.lastFired) > 600000) { // 10 min
        stalledChains.push({ name, stalledSeconds: Math.round((now - info.lastFired) / 1000) });
      }
    }
    return {
      totalEmitted: this._stats.emitted,
      totalHandled: this._stats.handled,
      totalErrors: this._stats.errors,
      listeners: this._subscriptions.size,
      activeSubscribers: subscribers,
      logSize: this._eventLog.length,
      eventCounts,
      lastEvent,
      stalledChains
    };
  }

  /**
   * 获取所有已注册的事件名
   */
  getRegisteredEvents() {
    return Array.from(this._subscriptions.keys());
  }

  /**
   * 链路停滞检测 — 启动 30s 巡检
   * 如果某因果链事件超过 10 分钟未触发，发出 chain.stalled 告警
   */
  startChainMonitor(causalEvents) {
    this._chainTimers = new Map();
    for (const evt of causalEvents) {
      this._chainTimers.set(evt, Date.now());
    }
    
    this._monitorInterval = setInterval(() => {
      const now = Date.now();
      for (const [evt, lastTime] of this._chainTimers) {
        const elapsed = (now - lastTime) / 1000 / 60; // 分钟
        if (elapsed > 10) {
          this.emit('chain.stalled', {
            event: evt,
            stalledMinutes: Math.round(elapsed),
            lastActivity: new Date(lastTime).toISOString()
          }, 'event-bus-monitor');
          // 重置计时器避免重复告警
          this._chainTimers.set(evt, now);
        }
      }
    }, 30000); // 30s 巡检
    
    this._log('SYSTEM', 'chain-monitor', `Started monitoring ${causalEvents.length} causal events`);
  }

  /**
   * 停止链路监控
   */
  stopChainMonitor() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
      this._log('SYSTEM', 'chain-monitor', 'Stopped');
    }
  }

  /**
   * 内部日志
   */
  _log(level, event, message) {
    const entry = {
      id: `${Date.now()}-${Math.random(36).substr(2, 6)}`,
      ts: new Date().toISOString(),
      level,
      event,
      message
    };
    this._eventLog.push(entry);
    if (this._eventLog.length > 500) {
      this._eventLog = this._eventLog.slice(-500);
    }
  }
}

// 7 条因果链事件常量
const CAUSAL_EVENTS = [
  'account.ed',
  'account.healthy',
  'content.generated',
  'post.published',
  'visit.recorded',
  'dau.updated',
  'action.execute'
];

// 错误/系统事件常量
const SYSTEM_EVENTS = [
  'heal.error',
  'heal.recovered',
  'chain.stalled',
  'module.started',
  'module.stopped',
  'module.error'
];

module.exports = { EventBus, CAUSAL_EVENTS, SYSTEM_EVENTS };
