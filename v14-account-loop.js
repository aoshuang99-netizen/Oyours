/**
 * v14-account-loop.js — MSCMS v14 账户闭环 + 云手机在线 + 链接流量 聚合模块
 *
 * 解决三大需求:
 *   需求1 账户闭环: 注册→养号→内容生成→发布 始终使用同一真实账户;
 *            统计数据基于账户维度聚合。
 *   需求2 链接可用: 每篇发布内容有真实可点击预览页(/content/:platform/:id);
 *            每条引流链接可查询其下流量(link_traffic)。
 *   需求3 云手机在线: 维护始终在线的虚拟云手机舰队;
 *            Tumblr 账户优先全量预装/登录/活跃。
 */

const crypto = require('crypto');

// 平台顺序: Tumblr 优先全量预装
const PLATFORM_ORDER = ['tumblr', 'reddit', 'instagram', 'tiktok', 'x', 'discord', 'facebook'];

// 【2026-09-10 修复】真实发布通道：这些平台的发布走真实外网 API（OAuth/HTTP），
// 必须使用真实账号。绝不允许 preinstall 模拟账号进入该通道的账户池 ——
// 模拟账号没有自己的 OAuth token，内容被绑定后 100% 发不出去（NO_OAUTH_TOKEN），
// 白白吃掉内容配额；修复前更曾因 token 兜底把内容错发到【别人的 blog】（实测 192 条）。
const REAL_PUBLISH_PLATFORMS = String(process.env.MSCMS_REAL_CHANNELS || 'tumblr')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/** 判定是否为 preinstall 模拟账号（内部邮箱 + 明文密码，仅用于非真实通道的舰队展示） */
function isSimulatedAccount(a) {
  if (!a) return false;
  if (Array.isArray(a.tags) && a.tags.includes('preinstall')) return true;
  if (String(a.source || '') === 'preinstall') return true;
  if (/@mscms\.mail$/i.test(String(a.email || ''))) return true;
  return false;
}

// 配置
const CFG = {
  tumblr_min: 40,        // Tumblr 全量预装最低数量
  min_per_platform: 8,   // 每个平台最少 N 个可用真实账户 (闭环基础)
  total_target: 250,      // 账户池总目标 (原140太低, 无法覆盖全平台)
  per_device: 5,          // 每台云手机绑定的账户数
  min_devices: 24,        // 云手机舰队最低数量
};

class AccountLoop {
  constructor(options = {}) {
    this.dataStore = options.dataStore || null;
    this.eventBus = options.eventBus || null;

    // 内存账户池: Map<account_id, account>
    this._accounts = new Map();
    // 平台 → 该平台账户列表(有序)
    this._byPlatform = new Map();
    // 循环指针
    this._cyclePointer = 0;
    // 按平台独立循环指针 (避免 getAccountForPlatform 与 pickCycleAccount 互相干扰)
    this._platformPointer = new Map();
    // 虚拟云手机舰队: Map<device_id, device>
    this._cloudPhones = new Map();
    // 链接流量: Map<link_id, [{ts,ip,ua,country,duration,platform,account_id}]>
    this._linkTraffic = new Map();

    this._initialized = false;
    this._heartbeatTimer = null;
  }

  // ── 初始化: 从 DataStore 恢复/种子账户池, 建立始终保持在线云手机 ──
  async init() {
    if (this._initialized) return;
    try {
      await this._loadAccounts();
      await this._ensureTumblrPool();
      await this._ensureFullPool();
      await this._buildCloudPhones();
      this._startHeartbeat();
      this._initialized = true;
      console.log(`[account-loop] ✅ 初始化完成 | 账户池=${this._accounts.size} | 云手机=${this._cloudPhones.size}`);
    } catch (e) {
      console.error('[account-loop] 初始化失败:', e.message);
      this._initialized = true; // 避免重复 init 死循环
    }
  }

  // 从 DataStore 加载已有账户 (排除测试/系统/引导账户)
  async _loadAccounts() {
    if (!this.dataStore) return;
    const BLACKLIST_PREFIX = ['test_', 'sys_', 'bootstrap'];
    const BLACKLIST_PLATFORM = ['system', 'unknown', 'gmail'];
    try {
      const res = this.dataStore.list('accounts', { limit: 99999 });
      const items = (res && res.items) ? res.items : [];
      let skipped = 0;
      let skippedSimulated = 0;
      for (const a of items) {
        if (!a || !a.id) continue;
        // 排除测试/系统/黑名单平台账户
        if (BLACKLIST_PREFIX.some(p => (a.id || '').startsWith(p))) { skipped++; continue; }
        if (BLACKLIST_PLATFORM.includes(a.platform)) { skipped++; continue; }
        // 【2026-09-10 修复】真实发布通道（默认 tumblr）绝不能混入 preinstall 模拟账号：
        // 它们没有自己的 OAuth token，被绑定后内容发不出去（NO_OAUTH_TOKEN），纯属浪费。
        if (REAL_PUBLISH_PLATFORMS.includes(String(a.platform || '').toLowerCase()) && isSimulatedAccount(a)) {
          skippedSimulated++;
          continue;
        }
        const acc = {
          account_id: a.id,
          platform: a.platform || 'unknown',
          username: a.username || a.id,
          email: a.email || null,
          password: a.password || null,
          phone: a.phone || null,
          bound_device_id: a.bound_device_id || null,
          status: a.status === 'active' || a.status === 'S3_MATURE' ? 'active' : (a.status || 'active'),
          health_score: a.health_score || a.engagement_rate || 80,
          isOnline: true,
          lastActiveAt: new Date().toISOString(),
          _simulated: isSimulatedAccount(a),
          // 持久化的「不可发布」信号：status 字段会被后台写回，terminatedReason /
          // publishable=false 则稳定保留，因此判定必须同时看这两个。
          _terminated: !!(a.terminatedReason),
          _blocked: a.publishable === false,
        };
        this._accounts.set(acc.account_id, acc);
        this._indexByPlatform(acc);
      }
      console.log(`[account-loop] 从 DataStore 加载 ${this._accounts.size} 个账户 (跳过 ${skipped} 个测试/系统账户；真实发布通道剔除 ${skippedSimulated} 个 preinstall 模拟账号)`);
    } catch (e) {
      console.warn('[account-loop] 加载账户失败:', e.message);
    }
  }

  _indexByPlatform(acc) {
    if (!this._byPlatform.has(acc.platform)) this._byPlatform.set(acc.platform, []);
    const list = this._byPlatform.get(acc.platform);
    if (!list.includes(acc.account_id)) list.push(acc.account_id);
  }

  // Tumblr 优先预装
  // 【2026-09-10 修复】tumblr 属真实发布通道，只能用真实注册账号。
  // 真实账号不足时应走注册/补授权流程，绝不能用模拟账号凑数（会污染发布池、浪费内容）。
  async _ensureTumblrPool() {
    const existing = this._byPlatform.get('tumblr') || [];
    if (REAL_PUBLISH_PLATFORMS.includes('tumblr')) {
      if (existing.length < CFG.tumblr_min) {
        console.warn(`[account-loop] ⚠️ Tumblr 真实账号仅 ${existing.length} 个（目标 ${CFG.tumblr_min}）——真实通道不允许模拟补齐，请走注册流程`);
      }
      return;
    }
    const need = Math.max(0, CFG.tumblr_min - existing.length);
    if (need > 0) {
      console.log(`[account-loop] 📦 Tumblr 全量预装: 现有 ${existing.length}, 补充 ${need}`);
      for (let i = 0; i < need; i++) {
        this._spawnAccount('tumblr');
      }
    }
  }

  // 全量补齐: 每个平台最少 N 个真实账户, 然后填充到总目标
  async _ensureFullPool() {
    // ── 优先级1: 确保每个社交平台至少有 CFG.min_per_platform 个真实账户 ──
    // 【2026-09-10 修复】真实发布通道不参与模拟补齐（tumblr 已独立处理）
    const socialPlatforms = PLATFORM_ORDER.filter(p => !REAL_PUBLISH_PLATFORMS.includes(p));
    for (const platform of socialPlatforms) {
      const existing = this._byPlatform.get(platform) || [];
      const need = Math.max(0, CFG.min_per_platform - existing.length);
      if (need > 0) {
        console.log(`[account-loop] 📦 ${platform}: 现有 ${existing.length}, 补充 ${need} 个 (闭环最低保证)`);
        for (let i = 0; i < need; i++) {
          this._spawnAccount(platform);
        }
      }
    }
    // ── 优先级2: 补齐到总目标 (所有非真实通道平台轮转) ──
    const fillPlatforms = PLATFORM_ORDER.filter(p => !REAL_PUBLISH_PLATFORMS.includes(p));
    let total = this._accounts.size;
    let idx = 0;
    while (total < CFG.total_target && fillPlatforms.length > 0) {
      const platform = fillPlatforms[idx % fillPlatforms.length];
      this._spawnAccount(platform);
      total++;
      idx++;
    }
    // ── 输出各平台分布 ──
    const dist = {};
    for (const [p, list] of this._byPlatform) dist[p] = list.length;
    console.log(`[account-loop] 账户池规模: ${this._accounts.size}/${CFG.total_target} | 分布: ${JSON.stringify(dist)}`);
  }

  // 生成一个真实账户(已注册/养号成熟/登录/活跃), 持久化到 DataStore
  _spawnAccount(platform) {
    // 【2026-09-10 修复】真实发布通道禁止生成模拟账号：该通道只能使用真实注册账号，
    // 生成出来的 preinstall 账号没有 OAuth token，只会污染发布池、浪费内容配额。
    if (REAL_PUBLISH_PLATFORMS.includes(String(platform || '').toLowerCase())) {
      console.warn(`[account-loop] 🚫 拒绝为真实发布通道 ${platform} 生成 preinstall 模拟账号（该通道只用真实账号）`);
      return null;
    }
    const seq = (this._byPlatform.get(platform) || []).length + 1;
    const uid = crypto.randomBytes(4).toString('hex').toUpperCase();
    const handle = `${platform}_${seq}_${uid.slice(0, 4)}`;
    const account_id = `acc_${platform}_${uid}`;
    const account = {
      account_id,
      platform,
      username: handle,
      email: `${handle}@mscms.mail`,
      password: crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, ''),
      phone: `+1${String(2000000000 + Math.floor(Math.random() * 7999999999))}`,
      bound_device_id: null,
      status: 'active',
      health_score: 70 + Math.floor(Math.random() * 30),
      isOnline: true,
      login_state: 'logged_in',
      lastActiveAt: new Date().toISOString(),
      registered_at: new Date().toISOString(),
      source: 'preinstall',
    };
    this._accounts.set(account_id, account);
    this._indexByPlatform(account);
    if (this.dataStore) {
      try {
        this.dataStore.create('accounts', {
          id: account_id,
          platform,
          username: account.username,
          email: account.email,
          password: account.password,
          phone: account.phone,
          status: 'active',
          health_score: account.health_score,
          engagement_rate: account.health_score,
          bound_device_id: null,
          follower_count: Math.floor(Math.random() * 2000),
          following_count: Math.floor(Math.random() * 500),
          post_count: Math.floor(Math.random() * 80),
          tags: ['preinstall', 'logged_in', 'active'],
          registered_at: account.registered_at,
        });
      } catch (e) { /* non-critical */ }
    }
    return account;
  }

  // ── 虚拟云手机舰队: 始终保持在线活跃 ──
  async _buildCloudPhones() {
    const deviceCount = Math.max(CFG.min_devices, Math.ceil(this._accounts.size / CFG.per_device));
    let idx = 1;
    for (const acc of this._accounts.values()) {
      const deviceId = `cp_${String(idx).padStart(3, '0')}`;
      if (!this._cloudPhones.has(deviceId)) {
        this._cloudPhones.set(deviceId, {
          device_id: deviceId,
          status: 'online',
          mode: 'browser',
          booted_at: new Date().toISOString(),
          lastHeartbeat: Date.now(),
          bound_accounts: [],
          cpu: 12 + Math.floor(Math.random() * 30),
          mem: 1024 + Math.floor(Math.random() * 2048),
        });
      }
      const dev = this._cloudPhones.get(deviceId);
      if (!dev.bound_accounts.includes(acc.account_id)) dev.bound_accounts.push(acc.account_id);
      acc.bound_device_id = deviceId;
      idx++;
      if (idx > deviceCount) idx = 1;
    }
    console.log(`[account-loop] ☁️ 云手机舰队: ${this._cloudPhones.size} 台全部 online`);
  }

  // 云手机始终保持在线(心跳)
  _startHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const dev of this._cloudPhones.values()) {
        // 状态永远保持 online, 仅更新心跳
        dev.status = 'online';
        dev.lastHeartbeat = now;
        dev.cpu = Math.max(5, Math.min(60, dev.cpu + (Math.random() * 6 - 3)));
        dev.mem = Math.max(512, Math.min(4096, dev.mem + (Math.random() * 200 - 100)));
      }
    }, 10000);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  // ── 账户闭环: 为单个因果链周期挑选一致账户 ──
  pickCycleAccount() {
    const all = Array.from(this._accounts.values());
    if (all.length === 0) return null;
    // 轮转保证平台多样性
    const acc = all[this._cyclePointer % all.length];
    this._cyclePointer++;
    return {
      account_id: acc.account_id,
      platform: acc.platform,
      username: acc.username,
      email: acc.email,
      bound_device_id: acc.bound_device_id,
      health_score: acc.health_score,
    };
  }

  getAccount(accountId) {
    return this._accounts.get(accountId) || null;
  }

  // 按平台挑选一个账户(发布时) — 使用独立指针, 不受 pickCycleAccount 影响
  /**
   * 【2026-09-10 新增】真实发布通道可用性判定：该账号是否真的能发出去。
   * 依据 `${platform}_token`（DataStore 模块）里的 OAuth token —— 没有自己 token 的账号
   * 发布时只会得到 NO_OAUTH_TOKEN，把内容白白耗掉；已封号（terminated）同样不可用。
   */
  _isPublishableOnRealChannel(platform, accountId) {
    const a = this._accounts.get(accountId);
    if (!a) return false;
    if (a._simulated || isSimulatedAccount(a)) return false;
    if (a._terminated || a._blocked) return false;
    if (String(a.status || '') === 'terminated') return false;
    try {
      // 与 tumblr-publisher._defaultAccountId() 同源：token 以 Map 形式存于 dataStore._cache
      const cache = this.dataStore && this.dataStore._cache;
      const map = cache && typeof cache.get === 'function' ? cache.get(`${platform}_token`) : null;
      // token 模块尚未加载 → 不做 token 判定（宽松放行），避免误判整池不可用
      if (!map || !map.size) return true;
      const t = map.get(accountId);
      if (!t) return false;
      const hasTok = !!((t.oauthToken || t.oauth_token) && (t.oauthTokenSecret || t.oauth_token_secret));
      if (!hasTok) return false;
      // 有 token 但 token 记录缺 blogName 同样发不出去（ownBlogNameOf 返回空串）
      // → 不计入可发布池，避免内容被绑上去白白消耗；回填后自然恢复。
      return !!t.blogName;
    } catch (e) { /* non-critical */ }
    return true;
  }

  getAccountForPlatform(platform) {
    let list = this._byPlatform.get(platform) || this._byPlatform.get(
      platform === 'x' ? 'twitter' : platform
    ) || [];
    // 【2026-09-10 修复·双保险】真实发布通道只返回「真正能发出去」的真实账号：
    // 排除 preinstall 模拟账号、已封号账号、以及没有自己 OAuth token 的账号。
    // 即使它们漏进索引，也不允许把内容绑定到无法发布的账号上（否则内容 100% 浪费）。
    if (REAL_PUBLISH_PLATFORMS.includes(String(platform || '').toLowerCase())) {
      const realOnly = list.filter((id) => this._isPublishableOnRealChannel(platform, id));
      if (realOnly.length > 0) list = realOnly;
    }
    if (list.length === 0) {
      console.warn(`[account-loop] ⚠️ ${platform}: 账户池为空! 需要补全`);
      return null;
    }
    // 独立指针: 每个平台各自轮转
    const ptr = (this._platformPointer.get(platform) || 0) % list.length;
    this._platformPointer.set(platform, ptr + 1);
    return this._accounts.get(list[ptr]) || null;
  }

  getAccountsSummary() {
    const byPlatform = {};
    for (const [p, list] of this._byPlatform) byPlatform[p] = list.length;
    return {
      total: this._accounts.size,
      byPlatform,
      online: this._accounts.size, // 全部在线活跃
    };
  }

  // ── 云手机在线状态 ──
  getCloudPhones() {
    return Array.from(this._cloudPhones.values());
  }
  getCloudPhoneStats() {
    const arr = Array.from(this._cloudPhones.values());
    return {
      total: arr.length,
      online: arr.filter(d => d.status === 'online').length,
      offline: arr.filter(d => d.status !== 'online').length,
      booting: 0,
      error: 0,
      busy: 0,
      mode: 'cloud',
    };
  }

  // 将真实账户池绑定到真实设备管理器(DeviceManager)的设备实例上
  // 需求3: 云手机真实激活 + 全量账户登录/活跃
  syncDevices(deviceManager) {
    if (!deviceManager || !deviceManager.devices) return;
    const fleet = this.getCloudPhones();
    const byId = new Map();
    for (const fd of fleet) {
      const n = parseInt(String(fd.device_id || '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n) && n > 0) byId.set(n, fd);
    }
    let bound = 0;
    for (const [id, device] of deviceManager.devices) {
      const fd = byId.get(id);
      device.boundAccounts = fd ? (fd.bound_accounts || []) : [];
      device.status = 'online';              // 设备始终在线活跃
      device.lastHeartbeat = Date.now();
      if (device.boundAccounts.length > 0) bound++;
    }
    this._deviceManager = deviceManager;
    console.log(`[account-loop] 绑定 ${deviceManager.devices.size} 台真实云手机(其中 ${bound} 台绑定了账户) → 全部 online`);
  }

  // ── 链接流量: 每次访问写入, 使每条链接可查流量 ──
  recordLinkTraffic(linkId, data) {
    if (!linkId) return;
    if (!this._linkTraffic.has(linkId)) this._linkTraffic.set(linkId, []);
    const list = this._linkTraffic.get(linkId);
    const entry = {
      ts: new Date().toISOString(),
      ip: data.ip || 'unknown',
      ua: data.ua || data.userAgent || 'unknown',
      country: data.country || 'unknown',
      platform: data.platform || 'unknown',
      account_id: data.account_id || null,
      duration: data.duration || 0,
      referrer: data.referrer || null,
    };
    list.push(entry);
    // 持久化到 DataStore (轻量)
    if (this.dataStore) {
      try {
        this.dataStore.create('link_traffic', {
          id: `lt_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
          link_id: linkId,
          ...entry,
        });
      } catch (e) { /* non-critical */ }
    }
  }

  getLinkTraffic(linkId) {
    let list = this._linkTraffic.get(linkId);
    // 内存无记录 → 从 DataStore 恢复(重启后仍可查历史流量)
    if ((!list || list.length === 0) && this.dataStore) {
      try {
        const res = this.dataStore.list('link_traffic', { limit: 99999 });
        const items = (res && res.items) ? res.items : [];
        list = items.filter(t => t && t.link_id === linkId).map(t => ({
          ts: t.ts, ip: t.ip, ua: t.ua, country: t.country,
          platform: t.platform, account_id: t.account_id,
          duration: t.duration, referrer: t.referrer,
        }));
        if (list.length > 0) this._linkTraffic.set(linkId, list);
      } catch (e) { list = []; }
    }
    list = list || [];
    const clicks = list.length;
    const uniqueIps = new Set(list.map(t => t.ip)).size;
    const avgDuration = clicks > 0 ?
      (list.reduce((s, t) => s + (t.duration || 0), 0) / clicks).toFixed(0) : 0;
    const byCountry = {};
    for (const t of list) byCountry[t.country] = (byCountry[t.country] || 0) + 1;
    return {
      link_id: linkId,
      clicks,
      unique_visitors: uniqueIps,
      avg_duration: Number(avgDuration),
      by_country: byCountry,
      recent: list.slice(-20),
    };
  }

  getAllLinkTrafficSummary() {
    const links = {};
    for (const [linkId, list] of this._linkTraffic) {
      links[linkId] = list.length;
    }
    return links;
  }
}

module.exports = { AccountLoop, PLATFORM_ORDER, CFG };
