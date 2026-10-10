'use strict';

/**
 * account-manager.js — MSCMS v14 账号管理模块 中央服务
 * =========================================================================
 * 职责（复用既有成熟模块，不重建）：
 *   - 账号生命周期状态机（registered/warmup/active/suspended/banned/retired）
 *   - 一机一号分配器：assignDeviceForAccount / releaseDevice（基于 cloud_phones 注册表）
 *   - cloud_phones 注册表：从运行时 DeviceManager.devices 拉真实指纹/代理填充元信息
 *   - 5 级闭环漏斗统计：computeLoopStats（建档→登录健康→养号内容→发布→流量DAU）
 *   - 一键登录魔链下发：issueLogin（HMAC 时效令牌，下发到绑定云手机 App）
 *   - 发布端口 API：账号级默认端口(bound_device_id) + 任务级覆盖(publish_device_override)
 *
 * ── 模块间事件契约（谁 emit / 谁 listen）────────────────────────────────────
 *  emit (本模块发出):
 *    account.device.bound   { accountId, deviceId }                  — 一机一号绑定成功
 *    account.login.issued    { accountId, deviceId, link }           — 一键登录魔链下发
 *    account.status.changed  { accountId, from, to, reason }         — 生命周期状态变更
 *  listen (本模块订阅):
 *    account.registered → 确保账号已绑设备（无则 least-loaded 分配）
 *    account.healthy / content.generated / post.published /
 *    visit.recorded / dau.updated / action.execute → 回灌账号 causal_phase + 设备阶段分布
 *    heal.error → 账号级异常（封号/限流信号回灌，置 suspended，触发自愈闭环）
 *
 * 依赖注入：{ dataStore, deviceManager, eventBus }（server.js 的 v14Modules）
 * =========================================================================
 */

const { issueLoginToken, verifyLoginToken, issueLoginLink } = require('./account-crypto');
const { CAUSAL_EVENTS } = require('./event-bus.js');

// ── 生命周期状态机 ──────────────────────────────────────────────────────────
const ACTIVE_STATUS = {
  REGISTERED: 'registered',
  WARMUP: 'warmup',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  BANNED: 'banned',
  RETIRED: 'retired',
};

// 合法状态转移（决策引擎 / 自愈回灌时校验，杜绝非法跳变）
const TRANSITIONS = {
  registered: ['warmup', 'active', 'suspended', 'retired'],
  warmup: ['active', 'suspended', 'banned', 'retired'],
  active: ['suspended', 'banned', 'retired', 'warmup'],
  suspended: ['warmup', 'active', 'banned', 'retired'],
  banned: ['retired'],
  retired: [],
};

// ── 因果阶段 → 数字进度（1..7），供闭环进度展示 ───────────────────────────
const PHASE_PROGRESS = { S1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S6: 6, S7: 7 };

// ── 5 级闭环漏斗：把因果链阶段(S1..S7) 映射到 5 个业务层 ─────────────────────
const FUNNEL_LEVELS = [
  { level: 1, key: 'registered', label: '建档',       phases: ['S1', null, 'none', ''] },
  { level: 2, key: 'healthy',    label: '登录健康',   phases: ['S2'] },
  { level: 3, key: 'nurtured',   label: '养号内容',   phases: ['S3'] },
  { level: 4, key: 'published',  label: '发布',       phases: ['S4'] },
  { level: 5, key: 'monetized',  label: '流量/DAU',   phases: ['S5', 'S6', 'S7'] },
];

function maskEmail(email) {
  if (!email) return '';
  const at = String(email).indexOf('@');
  if (at <= 0) return email;
  const name = email.slice(0, at);
  const domain = email.slice(at);
  if (name.length <= 2) return name[0] + '***' + domain;
  return name.slice(0, 2) + '***' + domain;
}

class AccountManager {
  constructor({ dataStore, deviceManager, eventBus } = {}) {
    this.dataStore = dataStore;
    this.deviceManager = deviceManager;
    this.eventBus = eventBus;
    this._loginIntents = new Map(); // accountId -> { token, issuedAt, expiresAt }
    this._cache = new Map();        // LRU + TTL 缓存: key -> { at, ttl, value }
    this._statsCache = null;
    this._statsCacheAt = 0;
    this._statsTtl = 60000;         // stats 缓存 60s（原 15s 提升，配合 WS 推送失效）
    // 各查询缓存 TTL（ms）
    this._ttl = { listAccounts: 60000, listCloudPhones: 20000, getAccount: 30000 };
    this._cacheMax = 300;           // LRU 上限（61 账号 + list + stats + cloudphones 余量）
  }

  // ── LRU + TTL 缓存原语 ──────────────────────────────────────────────────
  _cacheGet(key) {
    const e = this._cache.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at >= e.ttl) { this._cache.delete(key); return undefined; }
    // LRU：命中后移到末尾（最近使用）
    this._cache.delete(key);
    this._cache.set(key, e);
    return e.value;
  }

  _cacheSet(key, value, ttl) {
    this._cache.delete(key); // 先删后插，保证 move-to-end（LRU 语义）
    this._cache.set(key, { at: Date.now(), ttl, value });
    while (this._cache.size > this._cacheMax) {
      const oldest = this._cache.keys().next().value;
      if (oldest == null) break;
      this._cache.delete(oldest);
    }
  }

  /**
   * 数据变更后失效全部缓存，保证 WS 推送触发重算后为新鲜数据。
   * 全量清：账号数 ≤ 61，真实阶段推进频率低（分钟/小时级），全清代价可忽略。
   */
  _invalidate() {
    this._cache.clear();
    this._statsCache = null;
    this._statsCacheAt = 0;
  }

  // ── 初始化：订阅事件总线 + 初始拉取注册表 ────────────────────────────────
  init() {
    if (!this.eventBus) return;
    const bus = this.eventBus;
    bus.on('account.registered', 'account-manager', (d) => this._onAccountRegistered(d));
    bus.on('account.healthy', 'account-manager', (d) => this._onCausalPhase(d, 'S2'));
    bus.on('content.generated', 'account-manager', (d) => this._onCausalPhase(d, 'S3'));
    bus.on('post.published', 'account-manager', (d) => this._onCausalPhase(d, 'S4'));
    bus.on('visit.recorded', 'account-manager', (d) => this._onCausalPhase(d, 'S5'));
    bus.on('dau.updated', 'account-manager', (d) => this._onCausalPhase(d, 'S6'));
    bus.on('action.execute', 'account-manager', (d) => this._onCausalPhase(d, 'S7'));
    bus.on('heal.error', 'account-manager', (d) => this._onHealError(d));
    // 初始同步注册表（同步方法，返回数组；失败不阻塞启动）
    try { this.syncCloudPhones(); } catch (_) { /* 失败不阻塞启动 */ }
  }

  // 取某模块全部记录（绕过 DataStore 默认 20 条分页）
  _all(module) {
    const r = this.dataStore.list(module, { limit: 1e9, page: 1 });
    return (r && r.items) ? r.items : [];
  }

  // ── Phase 1：cloud_phones 注册表（从运行时 DeviceManager 拉真实指纹/代理）─
  /**
   * 用运行时设备信息回填 cloud_phones 元信息；owner_account 始终由账号绑定关系推导，
   * 保证 一机一号 真相单一来源（accounts.bound_device_id）。
   * @returns {Array} cloud_phones 列表
   */
  syncCloudPhones() {
    const ds = this.dataStore;
    const devices = (this.deviceManager && this.deviceManager.devices) ? this.deviceManager.devices : new Map();

    // 由账号绑定关系推导每台设备的 owner
    const accounts = this._all('accounts');
    const ownersByDevice = {};
    for (const a of accounts) {
      const did = a.bound_device_id;
      if (did != null) (ownersByDevice[did] = ownersByDevice[did] || []).push(a.id);
    }

    const TOTAL = 50; // 与 CLOUD_PHONE_COUNT 对齐
    for (let id = 1; id <= TOTAL; id++) {
      const dev = devices.get(id);
      const existing = ds.get('cloud_phones', id);
      const rec = existing || {
        id, model: null, hw_fingerprint: null, proxy: null,
        owner_account: [], status: 'ready', capacity: 1,
        last_used_at: null, causal_phase_dist: {},
      };
      if (dev) {
        rec.model = (dev.fingerprint && dev.fingerprint.model) || rec.model || null;
        rec.hw_fingerprint = this._fp(dev.fingerprint);
        rec.proxy = dev.proxy || rec.proxy || null;
        rec.status = this._mapStatus(dev.status);
        rec.capacity = dev.capacity || rec.capacity || 1;
      }
      rec.owner_account = ownersByDevice[id] || rec.owner_account || [];
      rec.causal_phase_dist = this._phaseDist(rec.owner_account);
      if (existing) ds.update('cloud_phones', id, rec);
      else ds.create('cloud_phones', rec);
    }
    // 注册表刚重写，整体失效后返回最新（绕过 cloudphones 缓存）
    this._invalidate();
    return this._listCloudPhonesImpl();
  }

  _listCloudPhonesImpl() {
    const list = this._all('cloud_phones');
    return list
      .map((d) => ({
        id: d.id,
        model: d.model || null,
        hw_fingerprint: d.hw_fingerprint || null,
        proxy: d.proxy || null,
        owner_account: d.owner_account || [],
        owner_count: (d.owner_account || []).length,
        capacity: d.capacity || 1,
        status: d.status || 'ready',
        last_used_at: d.last_used_at || null,
        causal_phase_dist: d.causal_phase_dist || {},
      }))
      .sort((a, b) => a.id - b.id);
  }

  listCloudPhones() {
    const key = 'cloudphones';
    const cached = this._cacheGet(key);
    if (cached !== undefined) return cached;
    const list = this._listCloudPhonesImpl();
    this._cacheSet(key, list, this._ttl.listCloudPhones);
    return list;
  }

  getCloudPhone(id) {
    return this._listCloudPhonesImpl().find((d) => String(d.id) === String(id)) || null;
  }

  // ── Phase 1：一机一号分配器 ──────────────────────────────────────────────
  /**
   * 为账号分配（或重绑）云手机。
   * @param {string} accountId
   * @param {object} [opts] { deviceId? } 不传则自动选 least-loaded 且未达容量设备
   * @returns {object} { accountId, deviceId }
   */
  assignDeviceForAccount(accountId, opts = {}) {
    const ds = this.dataStore;
    const acct = ds.get('accounts', accountId);
    if (!acct) throw new Error('account not found: ' + accountId);

    // 先解绑旧设备（双向清理）
    if (acct.bound_device_id != null) this._unbind(acct, acct.bound_device_id);

    let target = opts.deviceId != null ? Number(opts.deviceId) : this._pickLeastLoadedDevice();
    if (!target) throw new Error('no available device (all at capacity)');

    const dev = ds.get('cloud_phones', target);
    if (!dev) throw new Error('device not found: ' + target);

    const cap = dev.capacity || 1;
    const owners = dev.owner_account || [];
    if (owners.includes(accountId)) {
      // 已在该设备，无需重复加
    } else if (owners.length >= cap) {
      throw new Error(`device ${target} at capacity (${owners.length}/${cap})`);
    } else {
      owners.push(accountId);
    }

    ds.update('cloud_phones', target, {
      owner_account: owners,
      last_used_at: new Date().toISOString(),
      status: dev.status || 'online',
    });
    ds.update('accounts', accountId, {
      bound_device_id: target,
      owner_device_capacity: cap,
      bound_proxy: dev.proxy || acct.bound_proxy || null,
      device_fingerprint: dev.hw_fingerprint || acct.device_fingerprint || null,
    });

    if (this.eventBus) {
      this.eventBus.emit('account.device.bound', { accountId, deviceId: target }, 'account-manager');
    }
    this._invalidate();
    return { accountId, deviceId: target };
  }

  /**
   * 解绑账号与云手机（双向清理）。
   */
  releaseDevice(accountId) {
    const ds = this.dataStore;
    const acct = ds.get('accounts', accountId);
    if (!acct) throw new Error('account not found: ' + accountId);
    if (acct.bound_device_id != null) this._unbind(acct, acct.bound_device_id);
    ds.update('accounts', accountId, {
      bound_device_id: null,
      owner_device_capacity: null,
      device_fingerprint: null,
    });
    this._invalidate();
    return { accountId, released: true };
  }

  _unbind(acct, deviceId) {
    const dev = this.dataStore.get('cloud_phones', deviceId);
    if (!dev) return;
    const owners = (dev.owner_account || []).filter((id) => id !== acct.id);
    this.dataStore.update('cloud_phones', deviceId, { owner_account: owners });
  }

  _pickLeastLoadedDevice() {
    const phones = this._all('cloud_phones');
    let best = null;
    let bestLoad = Infinity;
    for (const d of phones) {
      const cap = d.capacity || 1;
      const load = (d.owner_account || []).length;
      if (load < cap && load < bestLoad) {
        best = d.id;
        bestLoad = load;
      }
    }
    return best;
  }

  // ── 发布端口 API：账号级默认端口 + 任务级覆盖 ───────────────────────────
  setPublishDevice(accountId, deviceId) {
    const ds = this.dataStore;
    const acct = ds.get('accounts', accountId);
    if (!acct) throw new Error('account not found: ' + accountId);
    if (deviceId != null) {
      const dev = ds.get('cloud_phones', Number(deviceId));
      if (!dev) throw new Error('device not found: ' + deviceId);
    }
    ds.update('accounts', accountId, {
      publish_device_override: deviceId == null ? null : Number(deviceId),
    });
    this._invalidate();
    return { accountId, publishDevice: deviceId == null ? null : Number(deviceId) };
  }

  /**
   * 解析账号的发布端口：任务级覆盖优先，否则账号级默认(bound_device_id)。
   */
  publishDeviceFor(accountId) {
    const acct = this.dataStore.get('accounts', accountId);
    if (!acct) throw new Error('account not found: ' + accountId);
    if (acct.publish_device_override != null) return acct.publish_device_override;
    return acct.bound_device_id != null ? Number(acct.bound_device_id) : null;
  }

  // ── Phase 2：一键登录魔链（下发到绑定云手机 App）─────────────────────────
  /**
   * 签发一键登录魔链。要求账号已绑定设备（按方案：登录必须走绑定云手机 App）。
   * @returns {object} { accountId, deviceId, token, loginLink, expiresAt }
   */
  issueLogin(accountId, opts = {}) {
    const ds = this.dataStore;
    const acct = ds.get('accounts', accountId);
    if (!acct) throw new Error('account not found: ' + accountId);
    if (acct.bound_device_id == null) {
      throw new Error('account has no bound device; bind a cloud phone first (call assign-device)');
    }
    const ttl = opts.ttlMin || 15;
    const token = issueLoginToken(accountId, ttl);
    const link = issueLoginLink(accountId, '/account/login', ttl);
    const now = Date.now();
    this._loginIntents.set(accountId, { token, issuedAt: now, expiresAt: now + ttl * 60000 });

    // 账号卡记录魔链（不含明文 token），供控制台展示 + 下次下发刷新
    ds.update('accounts', accountId, { login_link: link });

    if (this.eventBus) {
      this.eventBus.emit('account.login.issued', {
        accountId, deviceId: acct.bound_device_id, link,
      }, 'account-manager');
    }
    this._invalidate();
    return {
      accountId,
      deviceId: acct.bound_device_id,
      token,
      loginLink: link,
      expiresAt: new Date(now + ttl * 60000).toISOString(),
    };
  }

  verifyLogin(token) {
    return verifyLoginToken(token);
  }

  // ── Phase 2：生命周期状态机 ──────────────────────────────────────────────
  setStatus(accountId, newStatus, reason = '') {
    const ds = this.dataStore;
    const acct = ds.get('accounts', accountId);
    if (!acct) throw new Error('account not found: ' + accountId);
    const cur = acct.active_status || acct.status || 'registered';
    if (newStatus === cur) {
      return { accountId, from: cur, to: cur, noop: true };
    }
    const allowed = TRANSITIONS[cur] || [];
    if (!allowed.includes(newStatus)) {
      throw new Error(`illegal status transition ${cur} -> ${newStatus}`);
    }
    ds.update('accounts', accountId, {
      active_status: newStatus,
      status: newStatus,
      statusReason: reason,
    });
    if (this.eventBus) {
      this.eventBus.emit('account.status.changed', {
        accountId, from: cur, to: newStatus, reason,
      }, 'account-manager');
    }
    this._invalidate();
    return { accountId, from: cur, to: newStatus };
  }

  // ── Phase 2：5 级闭环漏斗统计 ───────────────────────────────────────────
  computeLoopStats() {
    const now = Date.now();
    if (this._statsCache && (now - this._statsCacheAt) < this._statsTtl) {
      return this._statsCache;
    }
    const stats = this._computeLoopStatsImpl();
    this._statsCache = stats;
    this._statsCacheAt = now;
    return stats;
  }

  _computeLoopStatsImpl() {
    const accounts = this._all('accounts');
    const funnel = FUNNEL_LEVELS.map((l) => ({ level: l.level, key: l.key, label: l.label, count: 0 }));
    const byPhase = {};
    let bound = 0;
    let unbound = 0;
    const statusCount = {};

    for (const a of accounts) {
      const phase = a.causal_phase || 'S1';
      byPhase[phase] = (byPhase[phase] || 0) + 1;
      const lvl = FUNNEL_LEVELS.find((l) => l.phases.includes(phase));
      if (lvl) funnel[lvl.level - 1].count++;
      if (a.bound_device_id != null) bound++; else unbound++;
      const st = a.active_status || a.status || 'unknown';
      statusCount[st] = (statusCount[st] || 0) + 1;
    }

    const devicePhase = this.listCloudPhones().map((d) => ({
      deviceId: d.id,
      owners: d.owner_count,
      capacity: d.capacity,
      status: d.status,
      phaseDist: d.causal_phase_dist,
    }));

    return {
      total: accounts.length,
      funnel,
      byPhase,
      bound,
      unbound,
      statusCount,
      devicePhase,
    };
  }

  // ── 列表 / 详情（密码脱敏 + 闭环字段富化）────────────────────────────────
  listAccounts(opts = {}) {
    const key = 'list:' + JSON.stringify(opts);
    const cached = this._cacheGet(key);
    if (cached !== undefined) return cached;
    let rows = this._all('accounts');
    if (opts.activeStatus) rows = rows.filter((a) => (a.active_status || a.status) === opts.activeStatus);
    if (opts.deviceId != null) rows = rows.filter((a) => Number(a.bound_device_id) === Number(opts.deviceId));
    if (opts.search) {
      const q = String(opts.search).toLowerCase();
      rows = rows.filter((a) =>
        (a.username || '').toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q) ||
        (a.id || '').toLowerCase().includes(q) ||
        (a.display_name || '').toLowerCase().includes(q) ||
        (a.promo_site || '').toLowerCase().includes(q));
    }
    const result = rows.map((a) => this._mask(a));
    this._cacheSet(key, result, this._ttl.listAccounts);
    return result;
  }

  getAccount(id) {
    const key = 'acct:' + id;
    const cached = this._cacheGet(key);
    if (cached !== undefined) return cached;
    const a = this.dataStore.get('accounts', id);
    if (!a) return null; // 不缓存缺失（避免新建后读到陈旧 null）
    const masked = this._mask(a);
    const dev = a.bound_device_id != null ? this.getCloudPhone(a.bound_device_id) : null;
    const result = { ...masked, device: dev };
    this._cacheSet(key, result, this._ttl.getAccount);
    return result;
  }

  _mask(a) {
    const phase = a.causal_phase || 'S1';
    const lvl = FUNNEL_LEVELS.find((l) => l.phases.includes(phase));
    return {
      id: a.id,
      platform: a.platform || '',
      username: a.username || '',
      // ── 展示名 / 推广站点归属（promo-names.js 生成，只读展示，不改登录名）──
      display_name: a.display_name || null,
      promo_site: a.promo_site || null,
      promo_prefix: a.promo_prefix || null,
      promo_seq: a.promo_seq != null ? a.promo_seq : null,
      promo_url: a.promo_url || null,
      email: maskEmail(a.email),
      reg_email: a.reg_email || a.email || '',
      reg_time: a.reg_time || a.createdAt || '',
      active_status: a.active_status || a.status || 'registered',
      bound_device_id: a.bound_device_id != null ? Number(a.bound_device_id) : null,
      publish_device_override: a.publish_device_override != null ? Number(a.publish_device_override) : null,
      app_logged_in: !!a.app_logged_in,
      inbox_unread: a.inbox_unread || 0,
      causal_phase: phase,
      causal_progress: PHASE_PROGRESS[phase] != null ? PHASE_PROGRESS[phase] : 0,
      causal_cycles: a.causal_cycles || 0,
      funnel_level: lvl ? lvl.level : 1,
      health_score: a.health_score != null ? a.health_score : null,
      risk_level: a.risk_level || 'unknown',
      content_quota: a.content_quota != null ? a.content_quota : null,
      last_action_at: a.last_action_at || null,
      owner_device_capacity: a.owner_device_capacity != null ? a.owner_device_capacity : null,
      hasPassword: !!(a.password && String(a.password).length && !String(a.password).startsWith('v1:') ? true : String(a.password || '').startsWith('v1:')),
      login_link: a.login_link || null,
      tags: Array.isArray(a.tags) ? a.tags : [],
    };
  }

  // ── 事件处理 ────────────────────────────────────────────────────────────
  _onAccountRegistered(d) {
    const id = d.accountId || d.id || d.account_id;
    if (!id) return;
    const acct = this.dataStore.get('accounts', id);
    if (!acct) return;
    // 建档即确保已绑设备（一机一号从 L1 起就确定）
    if (acct.bound_device_id == null) {
      try { this.assignDeviceForAccount(id); } catch (_) { /* 无可用设备时跳过，等设备就绪 */ }
    }
  }

  _onCausalPhase(d, phase) {
    const id = d.accountId || d.id || d.account_id;
    if (!id) return;
    const acct = this.dataStore.get('accounts', id);
    if (!acct) return;
    const now = new Date().toISOString();
    const prevPhase = acct.causal_phase || 'S1';
    // 每账号时间线（最多保留最近 50 条，避免 accounts 单条膨胀）
    const timeline = Array.isArray(acct.causal_timeline) ? acct.causal_timeline.slice(-49) : [];
    timeline.push({ phase, at: now, from: prevPhase });
    // 完成一次闭环（进入 S7 且上一次不是 S7）计数 +1
    const cycles = (acct.causal_cycles || 0) + (phase === 'S7' && prevPhase !== 'S7' ? 1 : 0);
    this.dataStore.update('accounts', id, {
      causal_phase: phase,
      causal_cycles: cycles,
      causal_timeline: timeline,
      last_action_at: now,
    });
    if (acct.bound_device_id != null) {
      const dev = this.dataStore.get('cloud_phones', acct.bound_device_id);
      if (dev) {
        this.dataStore.update('cloud_phones', acct.bound_device_id, {
          causal_phase_dist: this._phaseDist(dev.owner_account || []),
        });
      }
    }
    this._invalidate();
  }

  /**
   * 取某账号的因果闭环时间线（阶段推进轨迹 + 完成圈数）。
   */
  getCausalTimeline(accountId) {
    const a = this.dataStore.get('accounts', accountId);
    if (!a) return null;
    return {
      accountId,
      causal_phase: a.causal_phase || 'S1',
      causal_progress: PHASE_PROGRESS[a.causal_phase] != null ? PHASE_PROGRESS[a.causal_phase] : 0,
      causal_cycles: a.causal_cycles || 0,
      timeline: Array.isArray(a.causal_timeline) ? a.causal_timeline : [],
    };
  }

  _onHealError(d) {
    // 账号级异常信号（封号/限流）回灌：置 suspended，触发自愈闭环重绑/重注册。
    const id = d && (d.accountId || (d.data && (d.data.accountId || d.data.id)));
    if (!id) return;
    const acct = this.dataStore.get('accounts', id);
    if (!acct) return;
    const cur = acct.active_status || acct.status || 'registered';
    if (cur === 'active' || cur === 'warmup') {
      try { this.setStatus(id, 'suspended', 'heal.error: ' + (d.error || 'unknown')); } catch (_) {}
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  _fp(fp) {
    if (!fp || typeof fp !== 'object') return null;
    return {
      model: fp.model || null,
      manufacturer: fp.manufacturer || null,
      buildFingerprint: fp.buildFingerprint || fp.ro_build_fingerprint || null,
      androidId: fp.androidId || null,
      imei1: fp.imei1 || null,
      deviceTemplate: fp.deviceTemplate || null,
      language: fp.language || null,
      timezone: fp.timezone || null,
    };
  }

  _mapStatus(s) {
    if (!s) return 'ready';
    switch (s) {
      case 'READY':
      case 'ONLINE':
      case 'BUSY':
        return 'online';
      case 'OFFLINE':
      case 'STOPPING':
        return 'offline';
      case 'ERROR':
        return 'error';
      case 'STARTING':
      case 'BOOTING':
        return 'booting';
      default:
        return 'ready';
    }
  }

  _phaseDist(ownerIds) {
    const dist = {};
    const accounts = this._all('accounts');
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const oid of (ownerIds || [])) {
      const a = byId.get(oid);
      const phase = a ? (a.causal_phase || 'S1') : 'S1';
      dist[phase] = (dist[phase] || 0) + 1;
    }
    return dist;
  }
}

module.exports = { AccountManager, ACTIVE_STATUS, TRANSITIONS, FUNNEL_LEVELS, PHASE_PROGRESS, CAUSAL_EVENTS };
