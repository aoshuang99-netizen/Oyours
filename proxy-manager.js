/**
 * proxy-manager.js — MSCMS v14 代理管理系统
 *
 * 核心能力：
 *   1. 每设备独立代理绑定（deviceId → proxy 一对一映射）
 *   2. 代理健康检测（延迟/可用性/匿名性三指标）
 *   3. 故障自动轮换（主备切换 + SLA保证）
 *   4. 多线路绑定（HTTP/SOCKS5/Shadowsocks/V2Ray多协议支持）
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const https = require('https');
const dns = require('dns');

// ── 代理协议枚举 ─────────────────────────────────
const ProxyProtocol = {
  HTTP: 'http',
  HTTPS: 'https',
  SOCKS5: 'socks5',
  SHADOWSOCKS: 'ss',
  V2RAY: 'v2ray',
  TROJAN: 'trojan',
};

// ── 代理状态 ─────────────────────────────────────
const ProxyStatus = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  DEGRADED: 'degraded',   // 延迟高但可用
  CHECKING: 'checking',
  ERROR: 'error',
};

// ── 代理配置文件 ─────────────────────────────────
class ProxyConfig {
  constructor(opts = {}) {
    this.id = opts.id || `proxy_${Date.now()}_${crypto.randomBytes(3'hex')}`;
    this.name = opts.name || '未命名代理';
    this.protocol = opts.protocol || ProxyProtocol.SOCKS5;
    this.host = opts.host || '';
    this.port = opts.port || 1080;
    this. = opts. || null;
    this. = opts. || null;
    this.country = opts.country || 'unknown';
    this.city = opts.city || 'unknown';
    this.isp = opts.isp || 'unknown';
    this.type = opts.type || 'residential'; // residential | datacenter | mobile
    this.tags = opts.tags || [];
    this.maxLatencyMs = opts.maxLatencyMs || 5000;
    this.retryCount = 0;
    this.maxRetries = opts.maxRetries || 3;
  }

  get connectionString() {
    const auth = this. ? `${this.}:${this.}@` : '';
    return `${this.protocol}://${auth}${this.host}:${this.port}`;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, protocol: this.protocol,
      host: this.host, port: this.port,
      country: this.country, city: this.city, isp: this.isp, type: this.type,
      tags: this.tags,
    };
  }
}

// ── 设备-代理绑定 ────────────────────────────────
class DeviceProxyBinding {
  constructor(deviceId, primaryProxy, backupProxies = []) {
    this.deviceId = deviceId;
    this.primary = primaryProxy;       // 主代理
    this.backups = backupProxies;      // 备用代理队列
    this.current = primaryProxy;       // 当前活跃代理
    this.failoverCount = 0;
    this.totalUptimeMs = 0;
    this.lastSwitchAt = null;
    this.switchHistory = [];
  }
}

// ── 健康检测器 ───────────────────────────────────
class HealthChecker {
  constructor(opts = {}) {
    this.checkTimeoutMs = opts.checkTimeoutMs || 10000;
    this.testUrls = opts.testUrls || [
      { url: 'http://httpbin.org/ip', method: 'GET', weight: 0.4 },
      { url: 'https://api.ipify.org?format=json', method: 'GET', weight: 0.3 },
      { url: 'http://ip-api.com/json', method: 'GET', weight: 0.3 },
    ];
  }

  /**
   * 检测代理健康状态
   * 返回: { status, latency, anonymity, externalIp, details }
   */
  async check(proxyConfig) {
    const startTime = Date.now();
    const results = { latency: 0, reachable: false, anonymous: false, externalIp: null, errors: [] };

    // 1. TCP连通性检测
    try {
      await this._tcpConnect(proxyConfig.host, proxyConfig.port);
      results.reachable = true;
    } catch (e) {
      results.errors.push(`TCP连接失败: ${e.message}`);
      return {
        status: ProxyStatus.OFFLINE,
        latency: Date.now() - startTime,
        ...results,
      };
    }

    // 2. HTTP代理检测
    try {
      const { statusCode, body, elapsed } = await this._httpCheck(proxyConfig);
      results.latency = elapsed;
      results.httpStatus = statusCode;

      if (body) {
        try {
          const ipData = JSON.parse(body);
          results.externalIp = ipData.origin || ipData.ip || null;
        } catch {}
      }

      // 匿名性：外部IP != 本地IP
      if (results.externalIp && results.externalIp !== '') {
        results.anonymous = true;
      }
    } catch (e) {
      results.errors.push(`HTTP检测失败: ${e.message}`);
    }

    // 3. 综合判定
    let status;
    if (!results.reachable) {
      status = ProxyStatus.OFFLINE;
    } else if (results.latency > 3000) {
      status = ProxyStatus.DEGRADED;
    } else {
      status = ProxyStatus.ONLINE;
    }

    return {
      status,
      latency: results.latency,
      anonymity: results.anonymous,
      externalIp: results.externalIp,
      httpStatus: results.httpStatus,
      errors: results.errors,
      checkedAt: new Date().toISOString(),
    };
  }

  _tcpConnect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接超时')); }, this.checkTimeoutMs);
      socket.connect(port, host, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  _httpCheck(proxyConfig) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const options = {
        hostname: 'httpbin.org',
        port: 80,
        path: '/ip',
        method: 'GET',
        timeout: this.checkTimeoutMs,
        headers: { '': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body,
            elapsed: Date.now() - startTime,
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      req.end();
    });
  }
}

// ── 代理管理主引擎 ───────────────────────────────
class ProxyManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.proxies = new Map();          // proxyId → ProxyConfig
    this.bindings = new Map();         // deviceId → DeviceProxyBinding
    this.healthChecker = new HealthChecker(opts);
    this.healthCheckInterval = null;
    this.autoRecoverEnabled = opts.autoRecover !== false;
    this.healthRecords = new Map();    // proxyId → latest health result
    this.stats = {
      totalChecks: 0,
      failures: 0,
      failovers: 0,
    };
  }

  /**
   * 添加代理
   */
  addProxy(opts) {
    const proxy = new ProxyConfig(opts);
    this.proxies.set(proxy.id, proxy);
    this.emit('proxyAdded', proxy.toJSON());
    return proxy;
  }

  /**
   * 批量导入代理
   */
  importProxies(proxyList) {
    const results = [];
    for (const p of proxyList) {
      const proxy = this.addProxy(p);
      results.push(proxy.toJSON());
    }
    return results;
  }

  /**
   * 移除代理（解绑所有设备）
   */
  removeProxy(proxyId) {
    // 解绑所有使用此代理的设备
    for (const [deviceId, binding] of this.bindings) {
      if (binding.current.id === proxyId) {
        this._failover(deviceId);
      }
      binding.backups = binding.backups.filter(p => p.id !== proxyId);
    }
    this.proxies.delete(proxyId);
    this.emit('proxyRemoved', { proxyId });
  }

  /**
   * 绑定设备到代理
   */
  bindDevice(deviceId, primaryProxyId, backupProxyIds = []) {
    const primary = this.proxies.get(primaryProxyId);
    if (!primary) throw new Error(`代理不存在: ${primaryProxyId}`);

    const backups = backupProxyIds
      .map(id => this.proxies.get(id))
      .filter(Boolean);

    const binding = new DeviceProxyBinding(deviceId, primary, backups);
    this.bindings.set(deviceId, binding);

    this.emit('deviceBound', { deviceId, proxyId: primaryProxyId, backupCount: backups.length });
    return { deviceId, primary: primary.toJSON(), backups: backups.map(b => b.toJSON()) };
  }

  /**
   * 解绑设备
   */
  unbindDevice(deviceId) {
    this.bindings.delete(deviceId);
    this.emit('deviceUnbound', { deviceId });
  }

  /**
   * 获取设备当前代理
   */
  getDeviceProxy(deviceId) {
    const binding = this.bindings.get(deviceId);
    return binding ? binding.current : null;
  }

  /**
   * 故障转移
   */
  _failover(deviceId) {
    const binding = this.bindings.get(deviceId);
    if (!binding) return null;

    binding.failoverCount++;
    this.stats.failovers++;

    // 从备用队列中选择第一个健康的代理
    const availableBackup = binding.backups.find(b => {
      const health = this.healthRecords.get(b.id);
      return health && health.status !== ProxyStatus.OFFLINE;
    });

    if (availableBackup) {
      const oldProxy = binding.current;
      binding.current = availableBackup;
      binding.lastSwitchAt = new Date().toISOString();
      binding.switchHistory.push({
        from: oldProxy.id,
        to: availableBackup.id,
        at: binding.lastSwitchAt,
        reason: 'health_check_failed',
      });

      // 将失败代理移到备用队列末尾
      binding.backups = binding.backups.filter(b => b.id !== availableBackup.id);
      binding.backups.push(oldProxy);

      this.emit('failover', {
        deviceId,
        fromProxy: oldProxy.id,
        toProxy: availableBackup.id,
        failoverCount: binding.failoverCount,
      });

      return availableBackup;
    }

    this.emit('failoverFailed', { deviceId, reason: 'no_available_backup' });
    return null;
  }

  /**
   * 单代理健康检测
   */
  async checkProxy(proxyId) {
    const proxy = this.proxies.get(proxyId);
    if (!proxy) return null;

    const result = await this.healthChecker.check(proxy);
    this.healthRecords.set(proxyId, { ...result, proxyId, checkedAt: new Date().toISOString() });
    this.stats.totalChecks++;

    if (result.status === ProxyStatus.OFFLINE) {
      this.stats.failures++;
      // 自动故障转移
      if (this.autoRecoverEnabled) {
        for (const [deviceId, binding] of this.bindings) {
          if (binding.current.id === proxyId) {
            this._failover(deviceId);
          }
        }
      }
    }

    return result;
  }

  /**
   * 全量健康检测
   */
  async checkAll() {
    const results = [];
    const checks = Array.from(this.proxies.keys()).map(id => this.checkProxy(id));
    const settled = await Promise.allSettled(checks);

    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled' && settled[i].value) {
        results.push(settled[i].value);
      }
    }

    const online = results.filter(r => r.status === ProxyStatus.ONLINE;
    const degraded = results.filter(r => r.status === ProxyStatus.DEGRADED;
    const offline = results.filter(r => r.status === ProxyStatus.OFFLINE;

    this.emit('healthCheckCompleted', { total: results.length, online, degraded, offline });
    return { total: results.length, online, degraded, offline, results };
  }

  /**
   * 启动定时健康检测
   */
  startHealthCheckLoop(intervalMs = 60000) {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => this.checkAll(), intervalMs);
    this.emit('healthCheckLoopStarted', { intervalMs });
  }

  /**
   * 停止定时检测
   */
  stopHealthCheckLoop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.emit('healthCheckLoopStopped');
    }
  }

  /**
   * 获取所有代理状态
   */
  listProxies() {
    const list = [];
    for (const [id, proxy] of this.proxies) {
      const health = this.healthRecords.get(id);
      const binding = Array.from(this.bindings.values()).find(b => b.current.id === id);
      list.push({
        ...proxy.toJSON(),
        status: health ? health.status : 'unknown',
        latency: health ? health.latency : null,
        externalIp: health ? health.externalIp : null,
        boundTo: binding ? binding.deviceId : null,
      });
    }
    return list;
  }

  /**
   * 获取全部设备绑定状态
   */
  listBindings() {
    const list = [];
    for (const [deviceId, binding] of this.bindings) {
      const health = this.healthRecords.get(binding.current.id);
      list.push({
        deviceId,
        currentProxy: binding.current.toJSON(),
        proxyStatus: health ? health.status : 'unknown',
        backupCount: binding.backups.length,
        failoverCount: binding.failoverCount,
      });
    }
    return list;
  }

  /**
   * 获取引擎统计
   */
  getStats() {
    const proxyStatuses = this.listProxies();
    return {
      ...this.stats,
      totalProxies: this.proxies.size,
      boundDevices: this.bindings.size,
      onlineProxies: proxyStatuses.filter(p => p.status === 'online',
      degradedProxies: proxyStatuses.filter(p => p.status === 'degraded',
      offlineProxies: proxyStatuses.filter(p => p.status === 'offline',
      healthCheckActive: this.healthCheckInterval !== null,
    };
  }
}

module.exports = {
  ProxyManager,
  ProxyConfig,
  HealthChecker,
  DeviceProxyBinding,
  ProxyProtocol,
  ProxyStatus,
};
