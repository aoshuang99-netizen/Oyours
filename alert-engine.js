/**
 * alert-engine.js — MSCMS v14 实时告警系统
 *
 * 核心能力：
 *   1. 转化骤降告警 (阈值/趋势检测)
 *   2. Shadowban 批量检测告警
 *   3. 异常流量检测 (突增/突降)
 *   4. 规则引擎 (自定义阈值+动作)
 *   5. 告警分级 (info/warning/critical)
 *   6. 告警历史 & 去重
 *
 * 用法：
 *   const { AlertEngine } = require('./alert-engine.js');
 *   const alerts = new AlertEngine({ conversionEngine, channelHealth, dataStore });
 *   alerts.addRule({ name: '转化骤降', metric: 'conversionRate', threshold: -0.5 });
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 告警级别 ──────────────────────────────────────
const ALERT_LEVELS = {
  INFO:     { level: 0, label: 'info',     icon: 'ℹ️',  color: '#2196F3' },
  WARNING:  { level: 1, label: 'warning',  icon: '⚠️',  color: '#FF9800' },
  CRITICAL: { level: 2, label: 'critical', icon: '🚨',  color: '#F44336' }
};

// ── 告警 ──────────────────────────────────────────
class Alert {
  constructor(data) {
    this.id = data.id || `alert_${Date.now()}_${crypto.randomBytes(2'hex')}`;
    this.ruleName = data.ruleName || 'custom';
    this.level = data.level || 'warning';
    this.channel = data.channel || 'system';
    this.title = data.title || '';
    this.message = data.message || '';
    this.value = data.value || null;
    this.threshold = data.threshold || null;
    this.metadata = data.metadata || {};
    this.acknowledged = false;
    this.resolved = false;
    this.timestamp = data.timestamp || new Date().toISOString();
    this.resolvedAt = null;
  }
}

// ── 告警规则 ──────────────────────────────────────
class AlertRule {
  constructor(config) {
    this.id = config.id || `rule_${crypto.randomBytes(3'hex')}`;
    this.name = config.name;
    this.description = config.description || '';
    this.enabled = config.enabled !== false;
    this.metric = config.metric;           // 监控指标
    this.channel = config.channel || null; // 限���渠道
    this.condition = config.condition || 'lt'; // lt/gt/change_pct
    this.threshold = config.threshold;
    this.windowMinutes = config.windowMinutes || 60;
    this.cooldownMinutes = config.cooldownMinutes || 30;  // 去重冷却
    this.level = config.level || 'warning';
    this.actions = config.actions || ['log']; // log, emit, webhook
    this.webhookUrl = config.webhookUrl || null;
    this.lastTriggered = null;
  }
}

// ── 告警引擎 ──────────────────────────────────────
class AlertEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.conversionEngine = opts.conversionEngine || null;
    this.channelHealth = opts.channelHealth || null;
    this.trafficRouter = opts.trafficRouter || null;
    this.dataStore = opts.dataStore || null;

    // 规则
    this.rules = [];

    // 告警历史
    this.alerts = [];
    this.maxAlerts = opts.maxAlerts || 1000;

    // 指标快照 (用于趋势检测)
    this.snapshots = {};  // metric → {timestamp, value}

    // 默认规则
    this._initDefaultRules();

    // 检查间隔
    this._checkInterval = setInterval(() => this._evaluate(), opts.checkInterval || 60000);

    // 通知回调
    this.notifyCallback = opts.onNotify || null;
  }

  // ── 初始化默认规则 ───────────────────────────────
  _initDefaultRules() {
    // 转化骤降
    this.addRule(new AlertRule({
      name: '转化率骤降',
      description: '任意渠道转化率比1小时前下降超过50%',
      metric: 'conversionRate',
      condition: 'change_pct',
      threshold: -0.50,
      windowMinutes: 60,
      cooldownMinutes: 60,
      level: 'warning'
    }));

    // 无转化
    this.addRule(new AlertRule({
      name: '持续无转化',
      description: '渠道持续2小时零转化但流量>100',
      metric: 'zeroConversion',
      condition: 'eq',
      threshold: 1,
      windowMinutes: 120,
      cooldownMinutes: 120,
      level: 'critical'
    }));

    // Shadowban 率过高
    this.addRule(new AlertRule({
      name: 'Shadowban率告警',
      description: '渠道Shadowban率超过30%',
      metric: 'shadowBanRate',
      condition: 'gt',
      threshold: 0.30,
      windowMinutes: 30,
      cooldownMinutes: 120,
      level: 'warning'
    }));

    // 流量异常
    this.addRule(new AlertRule({
      name: '流量骤降',
      description: '渠道点击量与1小时前相比下降超过70%',
      metric: 'clickVolume',
      condition: 'change_pct',
      threshold: -0.70,
      windowMinutes: 60,
      cooldownMinutes: 60,
      level: 'warning'
    }));

    // Shadowban 大面积
    this.addRule(new AlertRule({
      name: '大面积Shadowban',
      description: '单渠道Shadowban账号超过20个',
      metric: 'shadowBanCount',
      condition: 'gt',
      threshold: 20,
      windowMinutes: 10,
      cooldownMinutes: 60,
      level: 'critical'
    }));

    // 高价值转化 (正向)
    this.addRule(new AlertRule({
      name: '高价值转化',
      description: '单次转化金额超过$500',
      metric: 'highValueConversion',
      condition: 'gt',
      threshold: 500,
      windowMinutes: 5,
      cooldownMinutes: 0,
      level: 'info'
    }));
  }

  // ── 添加规则 ─────────────────────────────────────
  addRule(rule) {
    this.rules.push(rule);
    this.emit('rule:added', rule);
    return rule;
  }

  // ── 更新规则 ─────────────────────────────────────
  updateRule(ruleId, updates) {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return null;
    Object.assign(rule, updates);
    this.emit('rule:updated', rule);
    return rule;
  }

  // ── 删除规则 ─────────────────────────────────────
  removeRule(ruleId) {
    const idx = this.rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.emit('rule:removed', { id: ruleId });
    return true;
  }

  // ── 获取规则 ─────────────────────────────────────
  getRules() {
    return this.rules.map(r => ({
      id: r.id, name: r.name, enabled: r.enabled,
      metric: r.metric, condition: r.condition, threshold: r.threshold,
      level: r.level, lastTriggered: r.lastTriggered
    }));
  }

  // ── 手动触发告警 ─────────────────────────────────
  triggerAlert(data = {}) {
    const alert = new Alert(data);

    // 去重: 相同规则在冷却期内不重复
    const existingRule = this.rules.find(r => r.name === alert.ruleName);
    if (existingRule && existingRule.lastTriggered) {
      const cooldownMs = existingRule.cooldownMinutes * 60000;
      if (Date.now() - new Date(existingRule.lastTriggered).getTime() < cooldownMs) {
        return null; // 冷却中
      }
      existingRule.lastTriggered = alert.timestamp;
    }

    this.alerts.push(alert);
    if (this.alerts.length > this.maxAlerts) {
      this.alerts.shift();
    }

    // 持久化
    if (this.dataStore) {
      try {
        this.dataStore.create('alert_logs', {
          id: alert.id, ruleName: alert.ruleName, level: alert.level,
          channel: alert.channel, title: alert.title, message: alert.message,
          value: alert.value, acknowledged: false, resolved: false,
          timestamp: alert.timestamp
        });
      } catch (e) { /* silent */ }
    }

    this.emit('alert', alert);
    this.emit(`alert:${alert.level}`, alert);

    // 外部通知
    if (this.notifyCallback) {
      this.notifyCallback(alert);
    }

    return alert;
  }

  // ── 确认告警 ─────────────────────────────────────
  acknowledgeAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      this.emit('alert:acknowledged', alert);
    }
    return alert;
  }

  // ── 解决告警 ─────────────────────────────────────
  resolveAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();
      this.emit('alert:resolved', alert);
    }
    return alert;
  }

  // ── 获取告警列表 ─────────────────────────────────
  getAlerts(filter = {}) {
    let results = [...this.alerts];
    const { level, channel, acknowledged, resolved, limit = 50, offset = 0 } = filter;

    if (level) results = results.filter(a => a.level === level);
    if (channel) results = results.filter(a => a.channel === channel);
    if (acknowledged !== undefined) results = results.filter(a => a.acknowledged === acknowledged);
    if (resolved !== undefined) results = results.filter(a => a.resolved === resolved);

    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const total = results.length;
    results = results.slice(offset, offset + limit);

    return { total, offset, limit, alerts: results };
  }

  // ── 获取未解决告警数 ─────────────────────────────
  getActiveAlertCount() {
    return this.alerts.filter(a => !a.resolved;
  }

  // ── 获取告警统计 ─────────────────────────────────
  getStats() {
    return {
      total: this.alerts.length,
      active: this.alerts.filter(a => !a.resolved,
      acknowledged: this.alerts.filter(a => a.acknowledged,
      byLevel: {
        info: this.alerts.filter(a => a.level === 'info',
        warning: this.alerts.filter(a => a.level === 'warning',
        critical: this.alerts.filter(a => a.level === 'critical'
      },
      byChannel: this._groupBy(this.alerts, 'channel'),
      rulesCount: this.rules.length,
      rulesEnabled: this.rules.filter(r => r.enabled
    };
  }

  // ── 评估所有规则 ─────────────────────────────────
  _evaluate() {
    if (!this.conversionEngine && !this.channelHealth && !this.trafficRouter) return;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      this._evaluateRule(rule);
    }
  }

  _evaluateRule(rule) {
    try {
      switch (rule.metric) {
        case 'conversionRate':
          this._checkConversionRate(rule);
          break;
        case 'zeroConversion':
          this._checkZeroConversion(rule);
          break;
        case 'shadowBanRate':
          this._checkShadowBanRate(rule);
          break;
        case 'shadowBanCount':
          this._checkShadowBanCount(rule);
          break;
        case 'clickVolume':
          this._checkClickVolume(rule);
          break;
        case 'highValueConversion':
          // 由 ConversionEngine 的 high_value 事件触发，无需轮询
          break;
      }
    } catch (e) { /* silent */ }
  }

  _checkConversionRate(rule) {
    if (!this.channelHealth) return;
    const allHealth = this.channelHealth.getAllHealth();
    for (const [ch, health] of Object.entries(allHealth)) {
      if (!health || rule.channel && ch !== rule.channel) continue;
      if (health.traffic.totalClicks < 100) continue;

      const currentRate = parseFloat(health.conversion.rate);
      const key = `conversionRate_${ch}`;
      const prev = this.snapshots[key];

      if (prev && prev.value > 0) {
        const change = (currentRate - prev.value) / prev.value;
        if (change <= rule.threshold) {
          this.triggerAlert({
            ruleName: rule.name, level: rule.level, channel: ch,
            title: `${health.name} 转化率骤降`,
            message: `转化率从 ${prev.value.toFixed(2)}% 降至 ${currentRate.toFixed(2)}% (下降 ${Math.abs(change * 100).toFixed(0)}%)`,
            value: currentRate, threshold: prev.value,
            metadata: { change, previousRate: prev.value, currentRate }
          });
        }
      }
      this.snapshots[key] = { timestamp: new Date().toISOString(), value: currentRate };
    }
  }

  _checkZeroConversion(rule) {
    if (!this.channelHealth || !this.conversionEngine) return;
    const allHealth = this.channelHealth.getAllHealth();
    for (const [ch, health] of Object.entries(allHealth)) {
      if (!health || rule.channel && ch !== rule.channel) continue;
      if (health.traffic.totalClicks < 100) continue;

      const events = this.conversionEngine.getEvents({
        source: ch,
        limit: 1,
        startDate: new Date(Date.now() - rule.windowMinutes * 60000).toISOString()
      });

      if (events.total === 0 && parseFloat(health.conversion.rate) > 1) {
        this.triggerAlert({
          ruleName: rule.name, level: rule.level, channel: ch,
          title: `${health.name} 持续无转化`,
          message: `${health.name} 近${rule.windowMinutes}分钟零转化，但历史转化率 ${health.conversion.rate}，流量 ${health.traffic.totalClicks}`,
          value: 0, threshold: rule.threshold
        });
      }
    }
  }

  _checkShadowBanRate(rule) {
    if (!this.channelHealth) return;
    const allHealth = this.channelHealth.getAllHealth();
    for (const [ch, health] of Object.entries(allHealth)) {
      if (!health || rule.channel && ch !== rule.channel) continue;
      const rate = parseFloat(health..shadowBanRate) / 100;
      if (rate > rule.threshold) {
        this.triggerAlert({
          ruleName: rule.name, level: rule.level, channel: ch,
          title: `${health.name} Shadowban率过高`,
          message: `Shadowban率 ${(rate * 100).toFixed(1)}% (阈值: ${(rule.threshold * 100).toFixed(0)}%)，共 ${health..shadowBanned} 个账号`,
          value: rate, threshold: rule.threshold,
          metadata: { shadowBanned: health..shadowBanned, total: health..total }
        });
      }
    }
  }

  _checkShadowBanCount(rule) {
    if (!this.channelHealth) return;
    const allHealth = this.channelHealth.getAllHealth();
    for (const [ch, health] of Object.entries(allHealth)) {
      if (!health || rule.channel && ch !== rule.channel) continue;
      if (health..shadowBanned > rule.threshold) {
        this.triggerAlert({
          ruleName: rule.name, level: rule.level, channel: ch,
          title: `${health.name} 大面积Shadowban`,
          message: `${health.name} 已有 ${health..shadowBanned} 个Shadowban账号 (阈值: ${rule.threshold})`,
          value: health..shadowBanned, threshold: rule.threshold
        });
      }
    }
  }

  _checkClickVolume(rule) {
    if (!this.channelHealth) return;
    const allHealth = this.channelHealth.getAllHealth();
    for (const [ch, health] of Object.entries(allHealth)) {
      if (!health || rule.channel && ch !== rule.channel) continue;
      if (health.traffic.clicksToday < 50) continue;

      const key = `clickVolume_${ch}`;
      const prev = this.snapshots[key];
      if (prev && prev.value > 0) {
        const change = (health.traffic.clicksToday - prev.value) / prev.value;
        if (change <= rule.threshold) {
          this.triggerAlert({
            ruleName: rule.name, level: rule.level, channel: ch,
            title: `${health.name} 流量骤降`,
            message: `点击量从 ${prev.value} 降至 ${health.traffic.clicksToday} (下降 ${Math.abs(change * 100).toFixed(0)}%)`,
            value: health.traffic.clicksToday, threshold: prev.value
          });
        }
      }
      this.snapshots[key] = { timestamp: new Date().toISOString(), value: health.traffic.clicksToday };
    }
  }

  // ── 重置 ─────────────────────────────────────────
  reset() {
    this.alerts = [];
    this.snapshots = {};
  }

  // ── 停止 ─────────────────────────────────────────
  stop() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
    this.removeAllListeners();
  }

  // ── 内部 ─────────────────────────────────────────
  _groupBy(arr, key) {
    const result = {};
    for (const item of arr) {
      const k = item[key] || 'unknown';
      result[k] = (result[k] || 0) + 1;
    }
    return result;
  }
}

module.exports = { AlertEngine, Alert, AlertRule, ALERT_LEVELS };
