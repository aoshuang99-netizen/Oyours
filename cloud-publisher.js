/**
 * cloud-publisher.js — MSCMS v14 云手机智能发布引擎
 *
 * 确保智能发布的推送在云手机里面完成，目标是安全的发布成功：
 *   1. 通过云手机设备模拟真人发布操作
 *   2. 发布前安全检查（养号阶段、风控评分、内容合规）
 *   3. 模拟真人发布行为（延迟、输入模拟、页面交互）
 *   4. 发布后验证（确认发布成功）
 *   5. 失败重试机制（安全重试策略）
 *   6. 发布日志与审计
 *   7. 多平台发布适配（Reddit/X/Instagram/TikTok/Facebook/Discord）
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
// 【2026-09-10 修复】path 此前未 require，而 `_proxyCandidates()` 里用了 `path.join(...)`：
//   该调用原本位于 try{} 内 → 抛 ReferenceError: path is not defined 被 catch 静默吞掉
//   → 候选出口池恒为空 → `_refreshProxyHealth` 判定「0 条全部探测失败」→
//   发布代理退化为单一中继 10808（27 个 CF 出口形同虚设，回到「唯一出口 IP 只有 1 个」）。
//   修掉这个 ReferenceError 后，27 个出口才真正进入发布轮换。
const path = require('path');

// ── 发布状态 ─────────────────────────────────────────
const PublishStatus = {
  PENDING: 'pending',
  PRE_CHECK: 'pre_check',
  NAVIGATING: 'navigating',
  TYPING: 'typing',
  UPLOADING: 'uploading',
  SUBMITTING: 'submitting',
  VERIFYING: 'verifying',
  SUCCESS: 'success',
  FAILED: 'failed',
  RETRYING: 'retrying',
  CANCELLED: 'cancelled',
};

// ── 平台发布配置 ─────────────────────────────────────
const PlatformPublishConfig = {
  reddit: {
    name: 'Reddit',
    publishUrl: 'https://www.reddit.com/submit',
    selectors: {
      titleInput: 'textarea[name="title"]',
      bodyInput: 'div[contenteditable="true"] textarea, div.PublicationEditorContent [contenteditable]',
      submitButton: 'button[type="submit"]',
      communitySelector: 'select[name="community"]',
    },
    prePublishDelay: { min: 3000, max: 8000 },
    typingDelay: { perChar: 80, jitter: 40 },
    postSubmitDelay: { min: 5000, max: 10000 },
    verifySelector: 'div.Post, article[data-testid="post-container"]',
    maxRetries: 2,
    retryDelay: 300000, // 5分钟
  },
  x: {
    name: 'X (Twitter)',
    publishUrl: 'https://x.com/compose/post',
    selectors: {
      tweetInput: 'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
      submitButton: 'button[data-testid="tweetButton"]',
    },
    prePublishDelay: { min: 2000, max: 5000 },
    typingDelay: { perChar: 60, jitter: 30 },
    postSubmitDelay: { min: 3000, max: 6000 },
    verifySelector: 'article[data-testid="tweet"]',
    maxRetries: 2,
    retryDelay: 180000,
  },
  twitter: {
    name: 'X (Twitter)',
    publishUrl: 'https://x.com/compose/post',
    selectors: {
      tweetInput: 'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
      submitButton: 'button[data-testid="tweetButton"]',
    },
    prePublishDelay: { min: 2000, max: 5000 },
    typingDelay: { perChar: 60, jitter: 30 },
    postSubmitDelay: { min: 3000, max: 6000 },
    verifySelector: 'article[data-testid="tweet"]',
    maxRetries: 2,
    retryDelay: 180000,
  },
  instagram: {
    name: 'Instagram',
    publishUrl: 'https://www.instagram.com/',
    selectors: {
      newPostButton: 'div[role="button"] svg[aria-label="New post"]',
      captionInput: 'textarea[aria-label="Write a caption..."]',
      shareButton: 'button:has-text("Share")',
    },
    prePublishDelay: { min: 5000, max: 10000 },
    typingDelay: { perChar: 100, jitter: 50 },
    postSubmitDelay: { min: 8000, max: 15000 },
    verifySelector: 'article header img',
    maxRetries: 1,
    retryDelay: 600000,
    requiresMedia: true, // Instagram需要图片/视频
  },
  tiktok: {
    name: 'TikTok',
    publishUrl: 'https://www.tiktok.com/upload',
    selectors: {
      captionInput: 'div[contenteditable="true"]',
      postButton: 'button:has-text("Post")',
    },
    prePublishDelay: { min: 5000, max: 12000 },
    typingDelay: { perChar: 90, jitter: 40 },
    postSubmitDelay: { min: 10000, max: 20000 },
    verifySelector: 'div[data-e2e="video-feed"]',
    maxRetries: 1,
    retryDelay: 600000,
    requiresMedia: true,
  },
  facebook: {
    name: 'Facebook',
    publishUrl: 'https://www.facebook.com/',
    selectors: {
      postInput: 'div[contenteditable="true"][role="textbox"]',
      postButton: 'div[role="button"]:has-text("Post")',
    },
    prePublishDelay: { min: 3000, max: 7000 },
    typingDelay: { perChar: 80, jitter: 40 },
    postSubmitDelay: { min: 5000, max: 10000 },
    verifySelector: 'div[data-ad-comet-preview="story"]',
    maxRetries: 2,
    retryDelay: 300000,
  },
  discord: {
    name: 'Discord',
    publishUrl: null, // 需要指定服务器和频道
    selectors: {
      messageInput: 'div[contenteditable="true"][role="textbox"][data-slate-editor="true"]',
      sendButton: 'button[aria-label="Send message"]',
    },
    prePublishDelay: { min: 1000, max: 3000 },
    typingDelay: { perChar: 50, jitter: 25 },
    postSubmitDelay: { min: 1000, max: 2000 },
    verifySelector: 'li[data-list-item-id]',
    maxRetries: 3,
    retryDelay: 60000,
  },
  tumblr: {
    name: 'Tumblr',
    publishUrl: 'https://www.tumblr.com/new/text',
    selectors: {
      titleInput: 'div[role="textbox"][data-text="true"]:first-of-type',
      bodyInput: 'div[role="textbox"][data-text="true"]:last-of-type',
      postButton: 'button:has-text("Post")',
    },
    prePublishDelay: { min: 3000, max: 6000 },
    typingDelay: { perChar: 70, jitter: 35 },
    postSubmitDelay: { min: 4000, max: 8000 },
    verifySelector: 'article, div[data-post-id]',
    maxRetries: 2,
    retryDelay: 180000,
  },
};

// ── 云手机发布引擎 ───────────────────────────────────
class CloudPublisher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.deviceManager = opts.deviceManager || null;
    this.nurturingRules = opts.nurturingRules || null;
    this.contentRules = opts.contentRules || null;
    this.tumblrPublisher = opts.tumblrPublisher || null;
    this.dataStore = opts.dataStore || null;

    // ── 媒体解析器（由 content-media-bridge 注入）────────────────────
    // 背景：内容管线产出的正文是纯文本，媒体（配图/视频）由桥接异步生成并写入
    //       matrix_content_generated.media_path。发布器此前完全不读媒体字段，
    //       导致真实发布 100% 为无图纯文本。
    // 用法：mediaResolver(contentId, timeoutMs) → { path, type } | null
    //       由 server.js 在桥接就绪后注入；未注入时静默降级为纯文本发布。
    this.mediaResolver = opts.mediaResolver || null;
    // 仅当配图「正在生成」时才等待，默认 30s；调 0 可完全关闭等待
    this.mediaWaitMs = Number(process.env.MSCMS_PUBLISH_MEDIA_WAIT_MS || 30000);

    // ── Phase 3: 发布端口设备选择 ──
    this.accountManager = opts.accountManager || null;     // 账号管理器：解析发布端口（覆盖 > 绑定设备）
    this.requireBoundDevice = !!opts.requireBoundDevice;   // 全局「强制一机一号」开关（env REQUIRE_BOUND_DEVICE）

    this.publishQueue = [];
    this.publishHistory = [];
    this.activePublishes = new Map();  // deviceId -> publish task
    this.maxConcurrent = opts.maxConcurrent || 3;
    // P0-6：单出口代理(10808)在并发下会出现 fetch failed / socket hang up，
    //       故 Tumblr 真实发布默认串行化；可用 MSCMS_TUMBLR_SERIAL=0 关闭。
    this._tumblrSerial = process.env.MSCMS_TUMBLR_SERIAL !== '0';
    this._tumblrLock = Promise.resolve();
    // 同账号两次发布的【最小间隔】：作为自然节奏控制而非失败判据（未到间隔 → 推迟任务，不计失败）
    // 默认 45 分钟：配合默认 6 帖/账号/天的配额，一个账号可在活跃时段内较自然地铺开，
    // 又不会形成「分钟级连发」的 bot 特征。（原值 2 小时是「每日 1 帖」时代的遗留，
    // 会把配额上限压到一天最多 12 帖都达不到的有效节奏。）
    this.minIntervalMs = Number(process.env.MSCMS_MIN_PUBLISH_INTERVAL_MS || opts.minIntervalMs || 2700000);
    this.processing = false;
    this._processorInterval = null;

    // 平台配额冷却：命中每日限额/限流后暂停发布，避免无效重试刷屏并耗尽账号信誉。
    // _quotaPausedUntil 为毫秒时间戳；0 = 未冷却。冷却期内任务被推迟而非失败（不消耗重试次数）。
    this._quotaPausedUntil = 0;
    this._quotaPauseReason = null;

    // ── 429 分层退避（2026-09-12 重构，P0）────────────────────────────────
    // 旧行为：任意一次 429 → _quotaPausedUntil 直接设到【次日 00:05】（上限 6h）。
    //   于是单个博客的 per-blog 限额会把【全部账号】的发布冻住数小时
    //   （09-12 实测：当日 820 帖/125 账号，一条 429 使 41 个队列任务各被推迟 309~317 分钟）。
    //   根因是「per-blog 限流」与「出口/平台级限流」被当成同一件事处理。
    // 新行为：
    //   ① 命中 429 → 只退避【该账号】（默认 30 分钟，env MSCMS_QUOTA_ACCOUNT_BACKOFF_MIN）；
    //   ② 仅当【多个不同账号】在窗口内先后 429（默认 ≥3 个 / 10 分钟）才升级为全局暂停，
    //      且全局时长只有 15 分钟（env MSCMS_QUOTA_GLOBAL_PAUSE_MIN）—— 那才是
    //      「出口 IP 或平台整体被打限流」的特征，此时继续打只会烧账号信誉。
    /** @type {Map<string, number>} accountId → 退避截止时间戳(ms) */
    this._accountCooldown = new Map();
    /** @type {{at:number, acct:string|null}[]} 近期限流样本（用于是否升级为全局的判定） */
    this._recentRateLimits = [];

    // 统计
    this.stats = {
      totalAttempts: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalRetries: 0,
      avgPublishTime: 0,
      byPlatform: {},
    };
  }

  // ── Phase 4: 取账号当前因果阶段，给发布历史打因果归属 ──
  _causalPhase(accountId) {
    if (!accountId) return null;
    if (this.accountManager && typeof this.accountManager.getAccount === 'function') {
      try {
        const a = this.accountManager.getAccount(accountId);
        if (a && a.causal_phase) return a.causal_phase;
      } catch (_) { /* ignore */ }
    }
    if (this.dataStore) {
      try {
        const a = this.dataStore.get('accounts', accountId);
        if (a && a.causal_phase) return a.causal_phase;
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  // 启动发布处理器
  start() {
    if (this.processing) return;
    this.processing = true;
    this._processorInterval = setInterval(() => this._processQueue(), 10000);
    // 【2026-09-10 新增】启动时回收「孤儿 queued」内容。
    // 背景：发布队列(publishQueue)只在内存里。进程重启后，队列中尚未执行的任务会丢失
    //   （包括新引入的「配额/间隔推迟」任务），而它们的内容状态已被置为 'queued'，
    //   S4 只挑 'ready' → 这些内容将永久卡死（存量已积累 171 条 queued）。
    // 处理：启动时把「queued 且入队超过 30 分钟」的内容放回 'ready'，
    //   由 S4 按配额/间隔重新排期；已被真实发布过的内容由 MySQL 24h (账号,内容)
    //   去重闸门与 status='published' 双重拦下，不会重复外发。
    setTimeout(() => { try { this._recoverStaleQueued(); } catch (e) { console.warn('[cloud-publisher] 孤儿 queued 回收失败:', e.message); } }, 20000);
    this.emit('started');
  }

  // 把因进程重启而失去队列的 'queued' 内容放回 'ready'
  _recoverStaleQueued() {
    if (!this.dataStore || !this.dataStore.list) return;
    const res = this.dataStore.list('content', { filter: { status: 'queued' }, limit: 2000 });
    const items = Array.isArray(res) ? res : (res && res.items) || [];
    const cutoff = Date.now() - 30 * 60 * 1000;
    const tooOld = Date.now() - 24 * 3600 * 1000;
    let back = 0;
    for (const c of items) {
      if (!c || !c.id) continue;
      const t = Date.parse(c.queued_at || c.createdAt || '');
      if (!isNaN(t) && t > cutoff) continue;      // 30 分钟内入队的当作仍在途，不动
      // 只回收 24 小时内的：超过 24h 的内容已脱离 MySQL (账号,内容) 去重窗口，
      // 复活它们有重复外发风险，保持 queued 交给人工/清理脚本处理。
      if (!isNaN(t) && t < tooOld) continue;
      try {
        this.dataStore.update('content', c.id, {
          status: 'ready',
          requeued_at: new Date().toISOString(),
          requeue_reason: 'startup_recover_stale_queued',
        });
        back++;
      } catch (_) {}
    }
    if (back) console.log(`[cloud-publisher] ♻️ 启动回收孤儿 queued 内容 ${back} 条 → 放回 ready（重启导致队列丢失，非内容问题）`);
  }

  stop() {
    this.processing = false;
    if (this._processorInterval) clearInterval(this._processorInterval);
    this.emit('stopped');
  }

  // 入队发布任务
  enqueuePublish(content, account, opts = {}) {
    // ── 发布端口解析（优先级）：任务级 deviceId > 账号级 publish_device_override > 绑定设备 bound_device_id ──
    // 这样「自动内容编辑发布任务」也能自动带上账号默认/覆盖端口，落实一机一号。
    let resolvedDeviceId = (opts.deviceId != null) ? opts.deviceId : null;
    if (resolvedDeviceId == null && this.accountManager && account && account.id) {
      try { resolvedDeviceId = this.accountManager.publishDeviceFor(account.id); } catch (_) {}
    }
    if (resolvedDeviceId == null) resolvedDeviceId = account.bound_device_id || null;
    const requireBoundDevice = (opts.requireBoundDevice != null) ? !!opts.requireBoundDevice : this.requireBoundDevice;

    const task = {
      id: `pub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      content,
      account,
      platform: content.platform || account.platform,
      deviceId: resolvedDeviceId != null ? Number(resolvedDeviceId) : null,
      requireBoundDevice,
      priority: opts.priority || 'normal',
      scheduledAt: opts.scheduledAt || null,
      status: PublishStatus.PENDING,
      retryCount: 0,
      maxRetries: PlatformPublishConfig[content.platform]?.maxRetries || 2,
      createdAt: new Date().toISOString(),
      opts,
    };

    // ── Phase 3 修复：强制一机一号模式，无指定发布端口 → 立即 FAILED ──
    // 在入队时同步判定，保证语义确定且即时（不依赖 10s 队列周期、不随机选设备、不 Web Direct 兜底）。
    if (task.requireBoundDevice && task.deviceId == null) {
      task.status = PublishStatus.FAILED;
      task.error = 'REQUIRE_BOUND_DEVICE: account has no bound/designated publish device';
      task.failedAt = new Date().toISOString();
      this.stats.totalAttempts++;
      this.stats.totalFailed++;
      this.publishHistory.push({
        taskId: task.id,
        accountId: task.account?.id,
        deviceId: null,
        platform: task.platform,
        status: 'failed',
        source: 'require_bound_device',
        causalPhase: this._causalPhase(task.account?.id),
        publishedAt: task.failedAt,
        error: task.error,
      });
      this.emit('publish:failed', { task, reason: 'no bound device (REQUIRE_BOUND_DEVICE)', requireBoundDevice: true });
      return task;
    }

    // ── P0-7 平台收敛：仅让具备真实发布通道的平台入队 ──────────────
    // 背景：12 个 provider 中实际具备真实发布能力的目前只有 tumblr，其余在执行阶段
    //       必然标记 NO_REAL_PUBLISH_CHANNEL（100% 失败），却持续占用队列、设备与日志。
    //       历史任务分布：tiktok 264 / twitter 77 / instagram 14 / tumblr 仅 6 ——
    //       97% 的发布资源被浪费在无通道平台上。
    // 以 Tumblr 为主的闭环拉练：默认只放行 tumblr，后续接入新通道时用
    // MSCMS_REAL_CHANNELS=tumblr,bluesky 扩展即可，无需改代码。
    const realChannels = (process.env.MSCMS_REAL_CHANNELS || 'tumblr')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!realChannels.includes(String(task.platform || '').toLowerCase())) {
      task.status = PublishStatus.FAILED;
      task.error = `NO_REAL_PUBLISH_CHANNEL: platform=${task.platform} 无真实发布通道，不入队（当前闭环通道: ${realChannels.join('/')}）`;
      task.failedAt = new Date().toISOString();
      this.stats.totalAttempts++;
      this.stats.totalFailed++;
      this.publishHistory.push({
        taskId: task.id,
        accountId: task.account?.id,
        deviceId: task.deviceId,
        platform: task.platform,
        status: 'failed',
        source: 'no_real_channel',
        causalPhase: this._causalPhase(task.account?.id),
        publishedAt: task.failedAt,
        error: task.error,
      });
      this.emit('publish:failed', { task, reason: 'no real channel (未入队)' });
      return task;
    }

    this.publishQueue.push(task);
    this.emit('publish:enqueued', task);

    // 如果是紧急模式，立即处理
    if (opts.priority === 'emergency') {
      this._processQueue();
    }

    return task;
  }

  // 统计在线（ready/online）设备数量
  _onlineDeviceCount() {
    if (!this.deviceManager || !this.deviceManager.devices) return 0;
    let count = 0;
    for (const d of this.deviceManager.devices.values()) {
      if (d.status === 'ready' || d.status === 'online') count++;
    }
    return count;
  }

  // 是否云手机模式：50 台设备已激活但不启 Playwright/模拟器，发布必须走 Web Direct 稳定通道
  _isCloudMode() {
    // 【2026-09-10 修复】必须与 DeviceManager 的判定对齐。
    // DeviceManager 用 `process.env.CLOUD_PHONE_MODE || 'cloud'`（默认 cloud，不建浏览器上下文），
    // 而此处原先只读 CLOUD_PHONE_MODE 且无默认值 —— 服务用 `MODE=cloud` 启动时判定为 false，
    // 导致 _getDevice() 不返回 null，发布器去找逻辑云手机根本不存在的浏览器上下文，
    // 全站 100% 报 "Device N has no active browser context"（今日发布 0 条的直接原因）。
    const m = process.env.CLOUD_PHONE_MODE || process.env.MODE || 'cloud';
    return String(m).toLowerCase() === 'cloud';
  }


  // 处理发布队列
  /**
   * Tumblr 请求串行化：单出口代理(10808)在并发下会 fetch failed / socket hang up，
   * 串行执行可显著提升真实发布成功率（关闭：MSCMS_TUMBLR_SERIAL=0）。
   */
  _tumblrExclusive(fn) {
    if (!this._tumblrSerial) return fn();
    const run = this._tumblrLock.then(fn, fn);
    this._tumblrLock = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 可用发布代理列表（proxy-pool.json 中 enabled、且未被平台级排除的 http/https 代理）。
   *
   * 2026-08-30 实测（重要结论）：
   *  - VPS 链路 10808 / 7890（出口 104.36.71.219）：**可用于 Tumblr**
   *  - BD isp_proxy1 共 12 条 session（出口 185.97.0.157）：能访问 icanhazip，
   *    但 **Tumblr 屏蔽该出口**（api.tumblr.com 全部失败）→ 已标记 tumblr=false
   *  - BD isp_proxy2：两端口均不可用（zone 未激活）
   *  - 历史收集的 GitHub 免费代理（gh-*）：已全部失效
   * 因此当前 Tumblr 发布实际只有 2 条链路（10808 直连 / 7890 经 Clash），
   * 轮换它们已能把发布成功率显著提升（3 次 → 18 次）。
   * 字段约定：p.tumblr === false 表示该出口对 Tumblr 不可用，不参与发布轮换。
   */
  /**
   * 静态候选代理（不做任何存活性判断）
   * 注意：空结果**不缓存** —— 原实现 `if (this._proxyCache) return ...` 会把空数组
   * 当作有效缓存（[] 是 truthy），一旦首次读取失败（如文件正被其它进程写入、
   * JSON 解析到不完整内容），代理池将永久为空，只能靠中继兜底。
   */
  _proxyCandidates() {
    if (this._proxyCache && this._proxyCache.length) return this._proxyCache;
    const file = path.join(__dirname, 'proxy-pool.json');
    let lastErr = null;
    // 【2026-09-10 加固】读盘重试 + 失败原因上报。
    // 背景：exit-guard 每 15 分钟原子重写 proxy-pool.json；若服务恰在重写窗口内读盘，
    // 会拿到不完整内容 → JSON.parse 抛错 → 候选池静默变空 → 发布退化为单一中继 10808
    // （即「唯一出口 IP 只剩 1 个」的老毛病，且日志里只说「0 条全部探测失败」看不出原因）。
    // 现在：立即重试 2 次 + 打印真实错误 + 明确提示 60s 后会自动重试。
    for (let i = 0; i < 3; i++) {
      try {
        const list = JSON.parse(fs.readFileSync(file, 'utf8'));
        const urls = list
          .filter((p) => p && p.enabled !== false && p.tumblr !== false
            && /^https?:\/\//i.test(p.url || ''))
          .map((p) => p.url);
        if (urls.length) { this._proxyCache = urls; return urls; }
        lastErr = new Error(`过滤后无可用 http 出口条目（文件共 ${Array.isArray(list) ? list.length : '非数组'} 项）`);
      } catch (e) { lastErr = e; }
    }
    if (!this._proxyCfgWarned) {
      this._proxyCfgWarned = true;
      console.warn(`[cloud-publisher] ⚠️ 读取出口池失败 ${file}: ${lastErr && lastErr.message}`);
      console.warn('[cloud-publisher]    → 本轮发布暂时退化为全局中继；出口健康表 60s 后会重新读盘并自动恢复');
    }
    this._proxyCache = (process.env.TUMBLR_PROXY ? [process.env.TUMBLR_PROXY] : []);
    return this._proxyCache;
  }

  /**
   * 发布代理池 —— 只返回「已通过 TCP 探测」的代理。
   *
   * 原实现仅做静态过滤（enabled/tumblr 字段 + URL 格式），从不校验代理是否真的存活，
   * 结果还被永久缓存。实测 7890(Clash) 未监听时，重试轮换命中它就 `fetch failed`，
   * 真实发布因此无谓失败（单次发布最多 5 次重试、全部打在死代理上）。
   */
  _publishProxies() {
    // 已有健康探测结果时优先用它；否则退回静态列表（首次调用前由 _refreshProxyHealth 预填）
    if (this._proxyHealth && this._proxyHealth.length) return this._proxyHealth;
    return this._proxyCandidates();
  }

  /** TCP 探活：能连通即视为可用（不鉴权，足够判断代理进程是否在监听） */
  _tcpProbe(url, timeoutMs = 2000) {
    return new Promise((resolve) => {
      let host, port;
      try {
        const u = new URL(url);
        host = u.hostname;
        port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      } catch (_) { return resolve(false); }
      const s = net.connect({ host, port }, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
    });
  }

  /**
   * 刷新代理健康状态（并发 TCP 探测，结果缓存 60s）。
   * 全部不可用时保留静态列表兜底 —— 交给实际请求去失败，好过直接判定无代理。
   */
  async _refreshProxyHealth(force = false) {
    const now = Date.now();
    if (!force && this._proxyHealthAt && (now - this._proxyHealthAt) < 60000 && this._proxyHealth) {
      return this._proxyHealth;
    }
    const candidates = this._proxyCandidates();
    if (!this._proxyDiagLogged) {
      this._proxyDiagLogged = true;
      console.log(`[cloud-publisher] 出口池候选 ${candidates.length} 条（来源 ${path.join(__dirname, 'proxy-pool.json')}）`);
    }
    const healthy = [];
    await Promise.all(candidates.map(async (u) => {
      if (await this._tcpProbe(u)) healthy.push(u);
    }));
    this._proxyHealthAt = now;
    if (healthy.length) {
      this._proxyHealth = healthy;
      if (healthy.length < candidates.length) {
        console.warn(`[cloud-publisher] 代理池 ${candidates.length} 条中仅 ${healthy.length} 条存活，已剔除不可用代理`);
      }
    } else {
      // 全死：回退到本机中继（默认 10808，实测可到达 Tumblr API）。
      // 原实现此处保留死候选 → 发布请求必定 fetch failed。宁可多账号共用出口
      // （有 429 风险，由退避重试兜底），也好过完全发不出去。
      const fb = process.env.TUMBLR_FALLBACK_PROXY || 'http://127.0.0.1:10808';
      this._proxyHealth = [fb];
      console.warn(`[cloud-publisher] ⚠️ 代理池 ${candidates.length} 条全部探测失败，回退中继 ${fb}`);
    }
    return this._proxyHealth;
  }

  /**
   * P0-D：回收单条已发布帖子的真实互动数据，并回写 publish 模块。
   * 此前 publish 记录的 reach/likes/comments/shares 恒为 0（从未回收），
   * 导致内容效能分析无从谈起。零伪造：取不到就跳过，绝不填任何估算值。
   */
  async _recycleOne(task, result, blogName, accountId) {
    try {
      // 优先从 URL 提取 postId：Tumblr 的 post id 超过 Number.MAX_SAFE_INTEGER，
      // 经 JSON.parse 会精度丢失（实测 ...97505 变成 ...914000），导致回收请求 404。
      // URL 中是字符串，可保真。
      const m = String(task.publishUrl || '').match(/(\d{15,25})\/?$/);
      const postId = (m && m[1]) || String(result.postId || '');
      if (!postId) return;

      const stats = await this._tumblrExclusive(
        () => this.tumblrPublisher.getPostStats(blogName, postId, accountId)
      );
      if (!stats || !stats.ok) {
        console.log(`[cloud-publisher] 📊 互动数据回收跳过(${postId}): ${stats && stats.error}`);
        return;
      }
      if (!this.dataStore) return;

      // 【2026-09-10 修复】list() 的返回形态兼容：路由/不同版本可能返回数组或 {items}。
      // 旧写法 `list(...).items || []` 在返回数组时恒得 []，会静默「找到不记录」→
      // 回采结果丢弃（日志里连跳过都不打，问题被完全掩盖）。
      const _res = this.dataStore.list('publish', { limit: 5000 });
      const items = Array.isArray(_res) ? _res : ((_res && _res.items) || []);
      const rec = items.find((p) => p && p.publish_url === task.publishUrl);
      if (rec) {
        this.dataStore.update('publish', rec.id, {
          reach: stats.noteCount,
          likes: stats.likeCount,
          comments: stats.replyCount,
          shares: stats.reblogCount,
          metrics_recycled_at: new Date().toISOString(),
        });
        console.log(`[cloud-publisher] 📊 互动数据回收: ${task.publishUrl} ` +
          `notes=${stats.noteCount} likes=${stats.likeCount} reblogs=${stats.reblogCount} replies=${stats.replyCount}`);
      } else {
        console.log(`[cloud-publisher] 📊 互动数据已取到但未匹配到 publish 记录(${task.publishUrl})：notes=${stats.noteCount}`);
      }
    } catch (e) {
      /* 回收失败不影响发布结果 */
    }
  }

  async _processQueue() {
    // 【修复】使用在线设备数而非注册设备数 — 避免设备离线时误判为有设备
    const onlineCount = this._onlineDeviceCount();
    const totalDevices = this.deviceManager ? this.deviceManager.devices.size : 0;

    // 诊断：队列长期有积压却不执行，多半是 activePublishes 残留占满并发槽
    if (this.publishQueue.length > 0) {
      console.log(`[cloud-publisher] queue=${this.publishQueue.length} active=${this.activePublishes.size}/${this.maxConcurrent} online=${onlineCount} devices=${totalDevices}`);
    }
    
    // 设备全在启动中 → 静默等待，不处理队列（避免提前耗尽重试次数）
    // 云手机模式：50 台 error 状态设备不启浏览器，必须走 Web Direct，不得因此阻塞队列
    if (totalDevices > 0 && onlineCount === 0 && !this._isCloudMode()) {
      return; // 等下个周期（仅非云模式）
    }
    
    const maxPerCycle = onlineCount > 0 ? Math.min(onlineCount, 3) : 10; // 有在线设备时一次处理最多3个

    let processed = 0;
    let scanned = 0;
    const deferred = [];
    while (processed < maxPerCycle && this.activePublishes.size < this.maxConcurrent) {
      const task = this.publishQueue.shift();
      if (!task) break;

      // 检查调度时间
      // 【2026-09-10 修复】原实现遇到未到时间的任务直接 `break` —— 配合本次新增的
      // 「配额/间隔推迟」机制会变成【队头阻塞】：一个被推迟 2 小时的任务卡在队首，
      // 后面所有账号的发布全部停摆 2 小时。改为：跳过该任务、继续扫后面的，
      // 本轮结束后统一放回队尾（避免无限取放循环用 scanned 封顶）。
      if (task.scheduledAt && new Date(task.scheduledAt).getTime() > Date.now()) {
        deferred.push(task);
        scanned++;
        if (scanned > 500) break;   // 安全阀：队列整体未到时间时不空转
        continue;
      }

      await this._executePublish(task);
      processed++;
      scanned++;
      if (scanned > 500) break;
    }
    if (deferred.length) this.publishQueue.push(...deferred);
  }

  // 执行发布
  async _executePublish(task) {
    const platform = task.platform;
    const config = PlatformPublishConfig[platform];

    // 配额冷却：平台已返回每日限额/限流 → 推迟任务到冷却结束，不消耗重试次数。
    // （2026-09-04 事故：无视 8023 daily limit 继续以每 45s 一次的频率请求，
    //   把配额全部浪费在必然失败的调用上，同时污染发布记录表。）
    if (this._quotaPausedUntil && Date.now() < this._quotaPausedUntil) {
      task.status = PublishStatus.PENDING;
      task.scheduledAt = new Date(this._quotaPausedUntil).toISOString();
      this.publishQueue.push(task);
      const waitMin = Math.round((this._quotaPausedUntil - Date.now()) / 60000);
      console.warn(`[cloud-publisher] ⏸ 配额冷却中（${this._quotaPauseReason}），任务 ${task.id} 推迟 ${waitMin} 分钟`);
      return;
    }

    // 账号级退避（2026-09-12 P0）：单账号命中限流只冻这一个账号，其余账号照常发布。
    // 这是「per-blog 限额不应影响全站」的落点 —— 全局冷却只在多账号同时中招时才启用。
    {
      const acctId = (task.account && task.account.id) || task.accountId || null;
      const until = acctId ? (this._accountCooldown.get(String(acctId)) || 0) : 0;
      if (until > Date.now()) {
        task.status = PublishStatus.PENDING;
        task.scheduledAt = new Date(until).toISOString();
        this.publishQueue.push(task);
        console.warn(`[cloud-publisher] ⏸ 账号 ${acctId} 退避中，任务 ${task.id} 推迟 ` +
          `${Math.round((until - Date.now()) / 60000)} 分钟（其余账号不受影响）`);
        return;
      }
    }

    // 发布前刷新代理存活性：剔除未监听的代理，避免重试全部打在死链路上
    await this._refreshProxyHealth();

    // 【修复】totalAttempts 只在这里递增一次（避免两次重复计数）
    this.stats.totalAttempts++;

    if (!config) {
      task.status = PublishStatus.FAILED;
      task.error = `Unsupported platform: ${platform}`;
      this.stats.totalFailed++;
      this.emit('publish:failed', task);
      return;
    }

    const startTime = Date.now();

    try {
      // ── Phase 3: 强制一机一号模式：无指定发布设备则直接 FAILED ──
      // 不随机选设备、不走 Web Direct 兜底，保证绑定设备发布的真实性。
      if (task.requireBoundDevice && task.deviceId == null) {
        task.status = PublishStatus.FAILED;
        task.error = 'REQUIRE_BOUND_DEVICE: account has no bound/designated publish device';
        this.stats.totalFailed++;
        this.emit('publish:failed', { task, reason: 'no bound device (REQUIRE_BOUND_DEVICE)', requireBoundDevice: true });
        return;
      }

      // Stage 1: 发布前安全检查（配额 / 全站预算 / 内容合规 / 发布间隔 / 空正文）
      // 【2026-09-10 修复】原条件为 `onlineCount > 0 && !this._isCloudMode()`：
      //   ① `_isCloudMode()` 修好之后云手机模式下恒为 true → 整段检查被永久跳过，
      //      每日配额/全站预算/内容合规/发布间隔/空正文五道闸门全部失效
      //      （实测单账号一天被发到 9 帖，且无任何配额约束）;
      //   ② 这些检查与设备/BrowserContext 无关，不该跟「设备是否在线」绑定。
      // 现改为无条件执行；真正依赖浏览器上下文的动作在下方各自分支内判定。
      {
        task.status = PublishStatus.PRE_CHECK;
        this.emit('publish:progress', { task, stage: 'pre_check' });

        const safetyCheck = this._performSafetyCheck(task);
        if (!safetyCheck.passed) {
          // 节奏类拒绝（配额已满 / 未到发布间隔 / 全站预算用尽）→ 推迟回队，不计失败、不烧内容
          if (Number(safetyCheck.deferMs) > 0) {
            this._deferTask(task, safetyCheck.deferMs, safetyCheck.reason);
            return;
          }
          task.status = PublishStatus.FAILED;
          task.error = `Safety check failed: ${safetyCheck.reason}`;
          this.emit('publish:failed', { task, reason: safetyCheck.reason });
          this.stats.totalFailed++;
          return;
        }
      }

      // Stage 2: 获取设备
      const device = await this._getDevice(task);
      if (!device) {
        // ── 无可用设备 ──
        const totalDevices = this.deviceManager ? this.deviceManager.devices.size : 0;
        if (totalDevices > 0 && !this._isCloudMode()) {
          // 有设备但暂不可用（非云模式）→ 放回队列稍后重试
          task._bootingRetries = (task._bootingRetries || 0) + 1;
          if (task._bootingRetries <= 30) {  // 最多等 5 分钟（30 × 10s）
            this.publishQueue.push(task);
            return;
          }
          console.warn(`[cloud-publisher] Task ${task.id} waiting too long for device — giving up`);
          task.status = PublishStatus.FAILED;
          task.error = 'No available device';
          this.emit('publish:failed', { task, reason: 'No device' });
          this.stats.totalFailed++;
          return;
        }

        // ── Web Direct 直连发布（零设备模式 OR 云手机模式）──
        // 只有 Tumblr 且已完成 OAuth 授权 + 本地视频存在，才能返回【真实】post_url。
        // 其余情况（未授权 / 非 Tumblr / 文件缺失）一律【诚实标记未发布】，
        // 绝不生成 hlua.cc.cd/content/... 伪造链接污染流量统计（D3 修复）。
        if (platform === 'tumblr' && this.tumblrPublisher) {
          try {
            const authorized = this.tumblrPublisher.getStatus().authorized;
            const vrRec = (this.dataStore && task.content?.id)
              ? this.dataStore.get('video_render', task.content.id) : null;
            const filePath = (vrRec && vrRec.filePath) || (task.content && task.content.video_url_local) || null;
            if (authorized && filePath && fs.existsSync(filePath)) {
              const caption = [task.content.title, Array.isArray(task.content.tags) ? task.content.tags.join(' ') : (task.content.tags || '')]
                .filter(Boolean).join('\n');
              const result = await this.tumblrPublisher.publishVideo({
                filePath,
                caption,
                tags: Array.isArray(task.content.tags) ? task.content.tags.map(t => String(t).replace(/^#/, '')) : [],
                state: 'published'
              });
              task.publishUrl = result.postUrl;
              task.source = 'tumblr_real';
              task.real = true;
              task.publishNote = `Tumblr 真实发布：${result.postUrl}`;
              task.publishedAt = new Date().toISOString();
              task.publishDuration = Date.now() - startTime;
              task.status = PublishStatus.SUCCESS;
              task.simulated = false;
              this.publishHistory.push({
                taskId: task.id, accountId: task.account?.id, deviceId: 'web_direct',
                platform, status: 'success', source: task.source,
                causalPhase: this._causalPhase(task.account?.id), publishedAt: task.publishedAt,
                url: task.publishUrl, duration: task.publishDuration, real: true,
              });
              this.stats.totalSuccess++;
              this._updatePlatformStats(platform, 'success');
              this.emit('publish:success', task);
              console.log(`[cloud-publisher] ✅ Tumblr 真实发布成功: ${task.id} (${result.postUrl})`);
              return;
            }
            // 【降级】无本地视频 → 改用真实【文字】发布，避免链路在 S4 整体断裂。
            // 背景：内容管线当前产出 100% 为 type=post 的文字内容（710/710，0 条带视频），
            //       而本分支原仅实现视频发布单一路径，导致 S4 真实产出恒为 0、全链路断裂。
            //       实测 tumblrPublisher.postText() 可返回真实外网 postUrl，故作为降级通道。
            // blog 名优先用 publisher 从 OAuth token 解析的结果：
            // accounts 记录中并无 blog/blogName 字段（blog 名实为 username），
            // 直接取 task.account.blog 会恒为空 → TUMBLR_BLOG_UNKNOWN。
            const accountId = task.account?.id || 'main';
            // 【2026-09-10 修复】blog 名必须取【该账号自己 token】里的 blogName，禁止兜底。
            // 原实现用 blogNameOf()：账号无 token 时会回退到第一个持 token 的账号，
            // 导致该账号内容被发到【别人的 blog】上（记录却归它）—— 数据错位、
            // 流量归属全错（今日实测 acc_tumblr_BEFBB978 的帖子发到了 mscmsd01oiz8）。
            // 也不再用 username 兜底：accounts 里 username 是登录名，并非 blog 名。
            const blogName = (this.tumblrPublisher.ownBlogNameOf && this.tumblrPublisher.ownBlogNameOf(accountId))
              || null;
            // 【2026-09-10】区分两种「blogName 为空」的真实原因，避免误报：
            //   · 该账号没有自己的 token          → NO_OAUTH_TOKEN（需补授权）
            //   · 有 token 但 token 记录缺 blogName → BLOG_NAME_UNKNOWN（用 tools/tumblr-backfill-blogname.js 回填即可）
            const hasToken = (this.tumblrPublisher.hasOwnToken && this.tumblrPublisher.hasOwnToken(accountId)) || false;
            const textBody = [task.content?.title, task.content?.body, task.content?.text, task.content?.caption]
              .filter(Boolean).join('\n').trim();
            if (authorized && blogName && textBody) {
              // ── 图文发布通道（优先于纯文字）────────────────────────────
              // 背景：此前无论内容是否带图，一律走 postText，真实发布恒为无图纯文本。
              // 媒体（配图）由 content-media-bridge 异步生成（~30s）并写入
              // matrix_content_generated.media_path。发布前短暂等待其就绪：
              //   · 就绪   → postPhoto（真实带图帖）
              //   · 超时/缺失/失败 → 继续走下方文字降级，绝不阻塞链路、绝不伪造
              const media = await this._resolveMediaForPublish(task);
              if (media && media.type === 'image' && fs.existsSync(media.path)) {
                const maxMediaRetries = Number(process.env.TUMBLR_MEDIA_RETRIES || 3);
                const mediaRetryBaseMs = Number(process.env.TUMBLR_TEXT_RETRY_MS || 2500);
                // 用前刷新存活性（缓存 60s）：剔除未监听的代理，避免重试打在死链路上
                const mediaProxies = await this._refreshProxyHealth();
                for (let attempt = 1; attempt <= maxMediaRetries; attempt++) {
                  const mpx = mediaProxies.length ? mediaProxies[(attempt - 1) % mediaProxies.length] : null;
                  if (mpx) this.tumblrPublisher.setProxyResolver(() => mpx);
                  try {
                    const result = await this._tumblrExclusive(() => this.tumblrPublisher.postPhoto(blogName, {
                      caption: textBody,
                      tags: Array.isArray(task.content.tags) ? task.content.tags.map((t) => String(t).replace(/^#/, '')) : [],
                      filePath: media.path,
                      state: 'published',
                    }, accountId));
                    if (result && result.postUrl) {
                      task.publishUrl = result.postUrl;
                      task.source = 'tumblr_real_photo';
                      task.real = true;
                      task.mediaPath = media.path;
                      task.publishNote = `Tumblr 真实发布（图文）：${result.postUrl}`;
                      task.publishedAt = new Date().toISOString();
                      task.publishDuration = Date.now() - startTime;
                      task.status = PublishStatus.SUCCESS;
                      task.simulated = false;
                      this.publishHistory.push({
                        taskId: task.id, accountId: task.account?.id, deviceId: 'web_direct',
                        platform, status: 'success', source: task.source,
                        causalPhase: this._causalPhase(task.account?.id), publishedAt: task.publishedAt,
                        url: task.publishUrl, duration: task.publishDuration, real: true,
                      });
                      this.stats.totalSuccess++;
                      this._updatePlatformStats(platform, 'success');
                      this.emit('publish:success', task);
                      console.log(`[cloud-publisher] ✅ Tumblr 真实发布成功(图文): ${task.id} (${result.postUrl}) ← ${media.path}`);
                      setTimeout(() => {
                        this._recycleOne(task, result, blogName, accountId).catch(() => {});
                      }, Number(process.env.MSCMS_METRICS_DELAY_MS || 45000));
                      return;
                    }
                  } catch (photoErr) {
                    console.warn(`[cloud-publisher] Tumblr 图文发布失败(${attempt}/${maxMediaRetries}): ${photoErr.message.slice(0, 120)}`);
                    if (attempt < maxMediaRetries) await new Promise((r) => setTimeout(r, mediaRetryBaseMs * attempt));
                  }
                }
                console.warn(`[cloud-publisher] 图文通道未成功，降级为文字发布: ${task.id}`);
              }

              // P0-6：串行化 + 退避重试 —— 单出口代理与内容生成/因果链等请求争抢，
              //       偶发 fetch failed，加长退避后重试基本可自愈。
              const maxTextRetries = Number(process.env.TUMBLR_TEXT_RETRIES || 5);
              const textRetryBaseMs = Number(process.env.TUMBLR_TEXT_RETRY_MS || 2500);
              // 每次重试轮换一条代理链路：单链路故障时用同一条链路重试 5 次毫无意义，
              // 轮换后即使某条链路抖动也能自愈（10808 直连 / 7890 经 Clash 转发）。
              const proxies = await this._refreshProxyHealth();
              for (let attempt = 1; attempt <= maxTextRetries; attempt++) {
                const px = proxies.length ? proxies[(attempt - 1) % proxies.length] : null;
                if (px) this.tumblrPublisher.setProxyResolver(() => px);
              try {
                const result = await this._tumblrExclusive(() => this.tumblrPublisher.postText(blogName, {
                  title: task.content.title || '',
                  body: textBody,
                  tags: Array.isArray(task.content.tags) ? task.content.tags.map((t) => String(t).replace(/^#/, '')) : [],
                  state: 'published',
                }, accountId));
                if (result && result.postUrl) {
                  task.publishUrl = result.postUrl;
                  task.source = 'tumblr_real_text';
                  task.real = true;
                  task.publishNote = `Tumblr 真实发布（文字降级）：${result.postUrl}`;
                  task.publishedAt = new Date().toISOString();
                  task.publishDuration = Date.now() - startTime;
                  task.status = PublishStatus.SUCCESS;
                  task.simulated = false;
                  this.publishHistory.push({
                    taskId: task.id, accountId: task.account?.id, deviceId: 'web_direct',
                    platform, status: 'success', source: task.source,
                    causalPhase: this._causalPhase(task.account?.id), publishedAt: task.publishedAt,
                    url: task.publishUrl, duration: task.publishDuration, real: true,
                  });
                  this.stats.totalSuccess++;
                  this._updatePlatformStats(platform, 'success');
                  this.emit('publish:success', task);
                  console.log(`[cloud-publisher] ✅ Tumblr 真实发布成功(文字降级): ${task.id} (${result.postUrl})`);
                  // P0-D：异步回收真实互动数据（延迟等待平台统计生效，不阻塞发布主流程）
                  setTimeout(() => {
                    this._recycleOne(task, result, blogName, accountId).catch(() => {});
                  }, Number(process.env.MSCMS_METRICS_DELAY_MS || 45000));
                  return;
                }
              } catch (textErr) {
                const errMsg = String(textErr.message || '').slice(0, 200);
                console.warn(`[cloud-publisher] Tumblr 文字发布降级失败(${attempt}/${maxTextRetries}): ${textErr.message}`);
                // 【S5 攻坚 2026-09-05】配额/限流错误立即写入 task.error 并抛出，跳出退避循环，
                //   让外层 catch (e) + finally 块的 _maybeSetQuotaCooldown(task.error, task) 生效。
                //   【2026-09-12 P0】该方法已改为分层：只退避该账号，多账号同时中招才全局暂停。
                //   修复前 catch 只 console.warn 并不写 task.error → 第872行 cooldown 永远走 false 分支
                //   → 5 次退避重试持续浪费 Tumblr 配额，链断在 S4。
                if (/8023|daily\s*post\s*limit|rate\s*limit|quota|too\s*many\s*requests|\b429\b/i.test(errMsg)) {
                  console.warn(`[cloud-publisher] ⏸ 配额/限流命中（${errMsg.slice(0, 80)}），立即结束本次退避循环以激活 cooldown`);
                  task.error = errMsg;
                  throw textErr;
                }
                if (attempt < maxTextRetries) await new Promise((r) => setTimeout(r, textRetryBaseMs * attempt));
              }
              }   // 关闭退避重试循环
            }

            // 未授权 / 无可用正文 / 未知 blog → 诚实标记未发布，绝不生成伪造链接
            task.real = false;
            task.publishUrl = null;
            task.status = PublishStatus.FAILED;
            // blogName 为空 = 该账号没有【自己的】OAuth token（ownBlogNameOf 不兜底），
            // 用 NO_OAUTH_TOKEN 精确命名，便于一眼区分「缺授权」与「缺正文」。
            task.error = !authorized ? 'TUMBLR_UNAUTHORIZED'
              : (!blogName ? (hasToken
                ? `BLOG_NAME_UNKNOWN: account=${task.account?.id || 'main'} 已有 OAuth token 但缺 blog 名（可回填恢复）`
                : `NO_OAUTH_TOKEN: account=${task.account?.id || 'main'} 未完成 OAuth 授权`)
                : 'NO_PUBLISHABLE_BODY');
            task.publishNote = !authorized
              ? 'Tumblr 未授权 → 无法生成真实链接，诚实标记为未发布（完成 OAuth 后由因果链重试真实发布）'
              : (!blogName
                ? (hasToken
                  ? '该账号已有 OAuth token 但 token 记录缺 blog 名 → 执行 tools/tumblr-backfill-blogname.js 回填后即可发布'
                  : '该账号未完成 Tumblr OAuth 授权 → 诚实标记未发布（不借用他人 token 发到别人 blog）')
                : '本地视频缺失且无可用正文 → 无法真实发布，诚实标记为未发布');
          } catch (e) {
            console.error(`[cloud-publisher] Tumblr 真实发布失败，诚实标记未发布: ${e.message}`);
            task.real = false;
            task.publishUrl = null;
            task.status = PublishStatus.FAILED;
            task.error = 'TUMBLR_PUBLISH_ERROR: ' + e.message.slice(0, 80);
            task.publishNote = `Tumblr 发布异常，诚实标记未发布：${e.message.slice(0, 80)}`;
          }
        } else {
          // 两类情形分开标记，便于运维一眼定位：
          //  ① Tumblr 但该账号没有自己的 OAuth token → NO_OAUTH_TOKEN（补授权即可恢复）
          //  ② 其它平台未配置真实发布通道 → NO_REAL_PUBLISH_CHANNEL
          // 无论哪种都诚实标记未发布，绝不生成伪造链接、绝不借用他人账号发布。
          const isTumblr = platform === 'tumblr';
          task.real = false;
          task.publishUrl = null;
          task.status = PublishStatus.FAILED;
          task.source = isTumblr ? 'no_oauth_token' : 'no_real_channel';
          task.error = isTumblr
            ? `NO_OAUTH_TOKEN: account=${task.account?.id || 'main'} 未完成 Tumblr OAuth 授权`
            : `NO_REAL_PUBLISH_CHANNEL: platform=${platform} 未配置真实发布通道`;
          task.publishNote = isTumblr
            ? '该账号未完成 Tumblr OAuth 授权，诚实标记未发布（不借用其他账号 token 发到别人 blog）'
            : `平台 ${platform} 未配置真实发布通道，诚实标记为未发布（不污染流量统计）`;
        }

        // ── 非真实发布统一收口：记录为 unpublished，不计入成功、不污染流量统计 ──
        if (task.status !== PublishStatus.SUCCESS) {
          this.publishHistory.push({
            taskId: task.id,
            accountId: task.account?.id,
            deviceId: 'web_direct',
            platform,
            status: 'unpublished',
            source: task.source || 'unpublished',
            causalPhase: this._causalPhase(task.account?.id),
            publishedAt: new Date().toISOString(),
            url: null,
            duration: Date.now() - startTime,
            real: false,
          });
          this.stats.totalFailed++;
          this._updatePlatformStats(platform, 'failed');
          this.emit('publish:unpublished', { task, reason: task.error });
          console.log(`[cloud-publisher] ⚠️ 诚实标记未发布: ${task.id} (platform=${platform}, reason=${task.error})`);
          return;
        }
      }

      this.activePublishes.set(device.id, task);

      // Stage 3: 通过云手机执行发布
      const publishResult = await this._publishViaDevice(device, task, config);

      // 设备发布失败 → 诚实标记未发布（绝不伪造链接污染流量统计，D3 修复）
      if (!publishResult.success) {
        task.real = false;
        task.publishUrl = null;
        task.publishedAt = new Date().toISOString();
        task.publishDuration = Date.now() - startTime;
        task.status = PublishStatus.FAILED;
        task.source = 'device_publish_failed';
        task.error = `DEVICE_PUBLISH_FAILED: ${publishResult.error?.substring(0, 80)}`;
        task.simulated = false;
        task.publishNote = `设备发布不可用，诚实标记未发布：${publishResult.error?.substring(0, 60)}`;

        this.publishHistory.push({
          taskId: task.id,
          accountId: task.account.id,
          deviceId: device.id,
          platform,
          status: 'unpublished',
          source: 'device_publish_failed',
          causalPhase: this._causalPhase(task.account.id),
          publishedAt: task.publishedAt,
          url: null,
          duration: task.publishDuration,
          real: false,
        });

        this.stats.totalFailed++;
        this._updatePlatformStats(platform, 'failed');
        this.emit('publish:unpublished', { task, reason: task.error });
        return;
      }

    } catch (e) {
      task.error = e.message;
      task.retryCount = (task.retryCount || 0) + 1;

      if (task.retryCount <= task.maxRetries) {
        task.status = PublishStatus.RETRYING;
        task.scheduledAt = new Date(Date.now() + config.retryDelay * task.retryCount).toISOString();
        this.publishQueue.push(task);
        this.stats.totalRetries++;
        this.emit('publish:retry', { task, retryCount: task.retryCount, nextAttempt: task.scheduledAt });
      } else {
        task.status = PublishStatus.FAILED;
        this.stats.totalFailed++;
        this._updatePlatformStats(platform, 'failed');
        this.emit('publish:failed', { task, error: e.message });
      }
    } finally {
      // 统一识别平台配额/限流（Tumblr 8023 daily post limit 等）：
      // 命中即全局冷却，避免把配额浪费在必然失败的重试上。
      // 统一识别平台配额/限流（Tumblr 8023 daily post limit 等）：
      // 【2026-09-12 P0】分层处理 —— 单账号 429 只退避该账号，多账号同时中招才全局暂停 15 分钟。
      try { if (task.error) this._maybeSetQuotaCooldown(task.error, task); } catch (_) { /* ignore */ }

      // 清理活跃发布
      if (task.deviceId) {
        this.activePublishes.delete(task.deviceId);
      }

      // 更新平均发布时间
      const duration = Date.now() - startTime;
      this.stats.avgPublishTime = (this.stats.avgPublishTime * (this.stats.totalAttempts - 1) + duration) / this.stats.totalAttempts;
    }
  }

  /** 读分钟级 env（非法值回退默认） */
  _quotaMin(env, defMin) {
    const n = Number(process.env[env]);
    return (Number.isFinite(n) && n > 0 ? n : defMin);
  }

  /**
   * 识别平台配额/限流错误 → 【分层】退避（2026-09-12 P0 重构）。
   *
   * 返回 true 表示「该任务应被视为已被限流处理」。
   * 语义变化：旧实现在这里一律设置全局冷却到次日 00:05，把 per-blog 限额
   * 误当成平台级限流，会冻住全站数小时。现在拆成两层，见构造函数注释。
   *
   * @param {string} msg 错误信息
   * @param {{account?:{id?:string}, accountId?:string, id?:string}|null} [task] 出错的发布任务
   */
  _maybeSetQuotaCooldown(msg, task) {
    const s = String(msg || '');
    // Tumblr: 8023 daily post limit；通用: rate limit / quota / 429 / too many requests
    if (!/8023|daily\s*post\s*limit|rate\s*limit|quota|too\s*many\s*requests|\b429\b/i.test(s)) return false;
    const now = Date.now();

    // ── ① 账号级退避（默认 30 分钟）────────────────────────────────
    const acct = String((task && task.account && task.account.id) || (task && task.accountId) || '') || null;
    if (acct) {
      const backoff = this._quotaMin('MSCMS_QUOTA_ACCOUNT_BACKOFF_MIN', 30) * 60000;
      const until = now + backoff;
      if (until > (this._accountCooldown.get(acct) || 0)) this._accountCooldown.set(acct, until);
      console.warn(`[cloud-publisher] ⏸ 账号 ${acct} 退避 ${Math.round(backoff / 60000)} 分钟` +
        `（其余账号继续发布）— ${s.slice(0, 120)}`);
    }

    // 顺手清理已过期的账号退避项，避免 Map 无限增长
    if (this._accountCooldown.size > 64) {
      for (const [k, v] of this._accountCooldown) if (v <= now) this._accountCooldown.delete(k);
    }

    // ── ② 全局兜底：只有「多个不同账号」在窗口内先后中招才升级 ──────
    const win = this._quotaMin('MSCMS_QUOTA_ESCALATE_WINDOW_MIN', 10) * 60000;
    const need = this._quotaMin('MSCMS_QUOTA_ESCALATE_ACCOUNTS', 3);
    this._recentRateLimits.push({ at: now, acct });
    this._recentRateLimits = this._recentRateLimits.filter((r) => now - r.at < win);
    const uniq = new Set(this._recentRateLimits.map((r) => r.acct).filter(Boolean));

    if (uniq.size >= need) {
      const pause = this._quotaMin('MSCMS_QUOTA_GLOBAL_PAUSE_MIN', 15) * 60000;
      const until = now + pause;
      if (until > this._quotaPausedUntil) {
        this._quotaPausedUntil = until;
        this._quotaPauseReason = `${uniq.size} 个账号在 ${Math.round(win / 60000)} 分钟内先后触发限流：${s.slice(0, 120)}`;
        console.error(`[cloud-publisher] 🛑 多账号限流（疑似出口/平台级），全局暂停发布 ` +
          `${Math.round(pause / 60000)} 分钟至 ${new Date(until).toLocaleString()} — ${this._quotaPauseReason}`);
        try {
          this.emit('publish:quota-paused', {
            until: new Date(until).toISOString(), reason: this._quotaPauseReason,
            scope: 'global', accounts: uniq.size,
          });
        } catch (_) {}
      }
      return true;
    }

    // 未达升级阈值 → 停留账号级，不设全局冷却
    return !!acct;
  }

  /** 限流退避快照（供 /api/v14/publisher/quota 诊断） */
  quotaBackoffSnapshot() {
    const now = Date.now();
    const accounts = [];
    for (const [id, until] of this._accountCooldown) {
      if (until > now) accounts.push({ accountId: id, untilISO: new Date(until).toISOString(), remainingMin: Math.round((until - now) / 60000) });
    }
    return {
      global: { active: this._quotaPausedUntil > now, until: this._quotaPausedUntil || 0, reason: this._quotaPauseReason || null },
      accounts,
      recentRateLimits: this._recentRateLimits.filter((r) => now - r.at < 10 * 60000).length,
      thresholds: {
        accountBackoffMin: this._quotaMin('MSCMS_QUOTA_ACCOUNT_BACKOFF_MIN', 30),
        globalPauseMin: this._quotaMin('MSCMS_QUOTA_GLOBAL_PAUSE_MIN', 15),
        escalateAccounts: this._quotaMin('MSCMS_QUOTA_ESCALATE_ACCOUNTS', 3),
        escalateWindowMin: this._quotaMin('MSCMS_QUOTA_ESCALATE_WINDOW_MIN', 10),
      },
    };
  }

  // 发布前安全检查
  _performSafetyCheck(task) {
    // 1. 检查养号阶段是否允许发帖 + 该账号今日配额
    if (this.nurturingRules) {
      // 修复：原先不传账号年龄 -> 走全局单例的 accountAge=0（注册期），post 配额恒为 0，
      // 导致「超过每日配额 (0/0)」把全站发布全部冻结。这里改为按账号真实年龄 + 该账号今日已发数判定。
      const ageDays = this._accountAgeDays(task.account);
      const usedPosts = this._getDailyPostCount(task.account.id);
      const canPost = this.nurturingRules.canPerform('post', 1, { accountAge: ageDays, currentCount: usedPosts });
      if (!canPost.allowed) {
        // 配额已满 → 推迟到次日 00:05 再发（旧实现直接判失败，会把内容计 3 次失败后永久丢弃）
        return {
          passed: false,
          deferMs: this._nextQuotaReset() - Date.now(),
          reason: `${canPost.reason}（账号 ${task.account.id} 年龄 ${ageDays} 天，今日已发 ${usedPosts} 帖）`,
        };
      }
    }

    // 1'. 全局每日发布预算（与出口 IP 容量模型绑定，见 _dailyPostBudget）
    const budget = this._dailyPostBudget();
    if (budget > 0) {
      const globalUsed = this._getGlobalDailyPostCount();
      if (globalUsed >= budget) {
        return {
          passed: false,
          deferMs: this._nextQuotaReset() - Date.now(),
          reason: `全站当日发布预算已用尽 (${globalUsed}/${budget}，= 出口IP数 × 单IP每日安全帖量)，顺延到次日`,
        };
      }
    }

    // 2. 检查内容合规性
    if (this.contentRules && task.content) {
      const checker = this.contentRules;
      const checkResult = checker.checkContent(task.content, {
        accountAge: task.account.age || 30,
        dailyPostCount: this._getDailyPostCount(task.account.id),
      });
      if (!checkResult.passed) {
        return { passed: false, reason: `Content compliance failed: ${checkResult.warnings.join('; ')}` };
      }
    }

    // 3. 检查发布间隔
    // 这是【节奏控制】而非违规：未到间隔就排到后面去，不消耗失败次数、不烧内容。
    const lastPublish = this._getLastPublishTime(task.account.id);
    if (lastPublish && (Date.now() - lastPublish) < this.minIntervalMs) {
      const elapsedMin = Math.round((Date.now() - lastPublish) / 60000);
      const base = this.minIntervalMs - (Date.now() - lastPublish);
      // 加 0~60% 抖动：同一账号若一次入队多帖，避免它们被推迟到同一时刻形成「集中连发」
      // （集中连发是最容易被平台判为 bot 的行为特征）。
      return {
        passed: false,
        deferMs: Math.round(base * (1 + Math.random() * 0.6)),
        reason: `Too soon since last publish（距上次 ${elapsedMin} 分钟 < 要求 ${Math.round(this.minIntervalMs / 60000)} 分钟）`,
      };
    }

    // 4. 检查内容是否为空
    const text = task.content?.body || task.content?.text || task.content?.caption || '';
    if (!text || text.trim().length === 0) {
      return { passed: false, reason: 'Content is empty' };
    }

    return { passed: true };
  }

  /**
   * 发布前解析内容的媒体（配图/视频）。
   *
   * 两级来源：
   *  1. 内容对象自带真实媒体路径（人工编辑 / 外部导入场景）—— 注意过滤 preview_url 中
   *     历史遗留的内容存档 JSON 路径（saveContentToFile 写入，磁盘上并不存在）。
   *  2. mediaResolver（由 content-media-bridge 注入）—— 等待异步生成结果，
   *     默认最长 60s，超时返回 null。
   *
   * 任何异常都不抛出：无媒体即返回 null，调用方据此降级为纯文本发布。
   */
  async _resolveMediaForPublish(task) {
    try {
      const direct = task.content?.media_path || task.content?.preview_url || null;
      if (typeof direct === 'string' && direct && !/\.json$/i.test(direct)) {
        const p = direct.replace(/\\/g, '/');
        if (fs.existsSync(p)) return { path: p, type: /\.mp4$/i.test(p) ? 'video' : 'image' };
      }

      // 等待策略（吞吐权衡）：
      // 配图生成约 42s/张，而内容生成约 17 条/分钟 —— 绝大多数内容来不及配图。
      // 若每条发布都无差别等待，Tumblr 串行发布吞吐会被直接压垮。
      // 因此：仅在桥接「正在生成」(media_status='pending') 时才轮询等待；
      //       其余情况只查一次（timeout=0），有则用、无则立即降级为纯文本。
      const st = task.content?.media_status;
      if (st && st !== 'pending' && st !== 'ready') return null;

      const cid = task.content?.matrix_id || task.content?.content_id || task.content?.id || null;
      if (cid && typeof this.mediaResolver === 'function') {
        const waitMs = (st === 'pending') ? this.mediaWaitMs : 0;
        if (waitMs > 0 || st === undefined) {
          const m = await this.mediaResolver(cid, waitMs);
          if (m && m.path && fs.existsSync(m.path)) return m;
        }
      }
    } catch (e) {
      // 媒体解析失败一律降级为纯文本，不阻塞发布
      if (this.stats.totalAttempts < 5) console.warn(`[cloud-publisher] 媒体解析失败，降级文字: ${e.message}`);
    }
    return null;
  }

  // 获取设备
  async _getDevice(task) {
    // 云手机模式：设备不启浏览器，强制返回 null → 走 Web Direct 稳定通道
    if (this._isCloudMode()) return null;

    // ── Phase 3: 强制一机一号模式：仅允许「指定设备」，禁止随机兜底 ──
    // 无就绪的指定设备时返回 null（非云模式会在 _executePublish 中重新入队等待该设备就绪）。
    if (task.requireBoundDevice) {
      if (task.deviceId && this.deviceManager) {
        const device = this.deviceManager.devices.get(task.deviceId);
        if (device && (device.status === 'ready' || device.status === 'online')) return device;
      }
      return null;
    }

    // 优先使用绑定的设备
    if (task.deviceId && this.deviceManager) {
      const device = this.deviceManager.devices.get(task.deviceId);
      if (device && (device.status === 'ready' || device.status === 'online')) {
        return device;
      }
    }

    // 查找可用设备
    if (this.deviceManager) {
      const readyDevices = Array.from(this.deviceManager.devices.values())
        .filter(d => (d.status === 'ready' || d.status === 'online') && !this.activePublishes.has(d.id));
      if (readyDevices.length > 0) {
        return readyDevices[0];
      }
    }

    return null;
  }

  // 通过云手机设备执行发布 — 仅真实设备发布，无模拟回退
  async _publishViaDevice(device, task, config) {
    if (!this.deviceManager) {
      this.emit('publish:failed', { task, reason: 'No DeviceManager connected' });
      return { success: false, error: 'No DeviceManager — real device required for publishing' };
    }

    task.status = PublishStatus.NAVIGATING;
    this.emit('publish:progress', { task, stage: 'navigating', deviceId: device.id });

    // 获取设备的浏览器上下文
    const ctx = this.deviceManager.browserContexts?.get(device.id);
    if (!ctx || !ctx.page) {
      this.emit('publish:failed', { task, reason: `Device ${device.id} has no active browser context` });
      return { success: false, error: `Device ${device.id}: no browser context — real cloud phone required` };
    }

    const page = ctx.page;

    try {
      // 1. 导航到发布页面
      if (config.publishUrl) {
        await page.goto(config.publishUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._humanDelay(config.prePublishDelay.min, config.prePublishDelay.max);
      }

      // 2. 填写内容
      task.status = PublishStatus.TYPING;
      this.emit('publish:progress', { task, stage: 'typing', deviceId: device.id });

      const content = task.content;
      const text = content.body || content.text || content.caption || '';

      // 查找输入框并输入
      if (config.selectors.titleInput && content.title) {
        await this._humanType(page, config.selectors.titleInput, content.title, config.typingDelay);
      }

      if (config.selectors.bodyInput || config.selectors.tweetInput || config.selectors.postInput || config.selectors.captionInput || config.selectors.messageInput) {
        const inputSelector = config.selectors.bodyInput || config.selectors.tweetInput || config.selectors.postInput || config.selectors.captionInput || config.selectors.messageInput;
        await this._humanType(page, inputSelector, text, config.typingDelay);
      }

      // 3. 提交发布
      task.status = PublishStatus.SUBMITTING;
      this.emit('publish:progress', { task, stage: 'submitting', deviceId: device.id });

      const submitSelector = config.selectors.submitButton || config.selectors.postButton || config.selectors.shareButton || config.selectors.sendButton;
      if (submitSelector) {
        await this._humanClick(page, submitSelector);
      }

      // 4. 等待发布完成
      await this._humanDelay(config.postSubmitDelay.min, config.postSubmitDelay.max);

      // 5. 获取发布URL
      const currentUrl = page.url();
      // 【零伪造】未能取得真实帖子 URL 时返回 null 并标记失败
      // （旧实现会伪造 https://<platform>.com/post/<random> 污染流量统计）
      const publishUrl = (currentUrl && currentUrl !== config.publishUrl) ? currentUrl : null;
      return { success: !!publishUrl, url: publishUrl, error: publishUrl ? null : 'NO_REAL_POST_URL' };

    } catch (e) {
      this.emit('publish:device_error', { task, deviceId: device.id, error: e.message });
      // 设备发布失败 — 返回错误，由 _executePublish 处理重试，不使用模拟回退
      return { success: false, error: `Publish via device ${device.id} failed: ${e.message}` };
    }
  }

  // 模拟真人输入
  async _humanType(page, selector, text, delayConfig) {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      await this._humanDelay(500, 1500); // 点击后暂停

      // 逐字输入模拟
      const chars = text.split('');
      for (let i = 0; i < chars.length; i++) {
        await page.keyboard.type(chars[i]);
        const delay = delayConfig.perChar + (Math.random() - 0.5) * 2 * delayConfig.jitter;
        await new Promise(r => setTimeout(r, Math.max(30, delay)));

        // 偶尔暂停（模拟思考）
        if (Math.random() < 0.05 && i > 0 && i < chars.length - 1) {
          await this._humanDelay(1000, 3000);
        }
      }
    } catch (e) {
      // 选择器可能不存在，直接输入
      await page.keyboard.type(text);
    }
  }

  // 模拟真人点击
  async _humanClick(page, selector) {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await this._humanDelay(500, 2000); // 点击前暂停
      await page.click(selector);
    } catch (e) {
      // 尝试通过文本查找按钮
      try {
        const elements = await page.$$('button');
        for (const el of elements) {
          const text = await el.textContent();
          if (text && (text.includes('Post') || text.includes('Submit') || text.includes('Share') || text.includes('Send'))) {
            await el.click();
            break;
          }
        }
      } catch (e2) {
        // 最后尝试按回车
        await page.keyboard.press('Enter');
      }
    }
  }

  // 人类化延迟
  async _humanDelay(min, max) {
    const delay = min + Math.random() * (max - min);
    await new Promise(r => setTimeout(r, delay));
  }

  // 验证发布
  async _verifyPublish(device, task, config) {
    if (!this.deviceManager) return false;

    const ctx = this.deviceManager.browserContexts?.get(device.id);
    if (!ctx || !ctx.page) return false; // 无浏览器上下文，无法验证

    try {
      const page = ctx.page;
      // 检查是否有发布成功的元素
      if (config.verifySelector) {
        await page.waitForSelector(config.verifySelector, { timeout: 15000 }).catch(() => {});
        const element = await page.$(config.verifySelector);
        return !!element;
      }
    } catch (e) {
      // 验证失败但可能是误判
    }

    return true; // 默认返回成功
  }

  // 【已废弃】模拟发布 — 不再使用。真实发布要求云手机设备在线。
  // 保留函数体作为参考，但所有调用路径已替换为真实失败处理。
  /** @deprecated */
  _simulatePublish(task, config) {
    // 【零伪造】即使是废弃的模拟路径也不生成假链接，避免任何伪造 URL 外泄
    this.emit('publish:simulated', { task, url: null });
    return { success: false, url: null, simulated: true, error: 'SIMULATION DISABLED — real device required' };
  }

  // 批量发布
  async publishBatch(contents, accounts, opts = {}) {
    const tasks = [];
    for (let i = 0; i < contents.length && i < accounts.length; i++) {
      const task = this.enqueuePublish(contents[i], accounts[i], opts);
      tasks.push(task);
      // 间隔入队
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));
    }

    // 等待所有完成
    const results = [];
    for (const task of tasks) {
      while (task.status !== PublishStatus.SUCCESS && task.status !== PublishStatus.FAILED) {
        await new Promise(r => setTimeout(r, 5000));
      }
      results.push({
        taskId: task.id,
        status: task.status,
        url: task.publishUrl,
        error: task.error,
      });
    }

    return results;
  }

  // 辅助方法
  _getLastPublishTime(accountId) {
    // 【2026-09-10 修复】原来只查内存 publishHistory → 重启后恒为 null，
    // 发布间隔闸门等于失效（重启即可连发）。现同时合并磁盘发布记录取最大值。
    let last = null;
    for (const h of this.publishHistory) {
      if (String(h.accountId) !== String(accountId)) continue;
      const t = new Date(h.publishedAt).getTime();
      if (!isNaN(t) && (last === null || t > last)) last = t;
    }
    try {
      if (this.dataStore && this.dataStore.list) {
        const res = this.dataStore.list('publish', { limit: 20000 });
        const items = Array.isArray(res) ? res : (res && res.items) || [];
        for (const p of items) {
          const aid = p.account_id || p.accountId;
          if (String(aid) !== String(accountId)) continue;
          const url = p.publish_url || p.publishUrl || '';
          if (!/^https?:\/\//i.test(String(url))) continue;
          const t = new Date(p.published_at || p.publishedAt).getTime();
          if (!isNaN(t) && (last === null || t > last)) last = t;
        }
      }
    } catch (_) {}
    return last;
  }

  // 账号年龄（天）：优先 createdAt / reg_time / created_at，缺失按 30 天（稳定期）处理
  _accountAgeDays(account) {
    const a = account || {};
    const t = a.createdAt || a.reg_time || a.created_at || a.created;
    if (!t) return 30;
    const ts = typeof t === 'number' ? t : Date.parse(t);
    if (Number.isNaN(ts)) return 30;
    const days = Math.floor((Date.now() - ts) / 86400000);
    return days >= 0 ? days : 30;
  }

  _getDailyPostCount(accountId) {
    const today = new Date().toDateString();
    const seen = new Set();
    let n = 0;
    const sameDay = (v) => { const d = new Date(v); return !isNaN(d) && d.toDateString() === today; };

    // ① 本次进程内已成功真实发布的记录
    for (const h of this.publishHistory) {
      if (String(h.accountId) !== String(accountId)) continue;
      if (h.status !== 'success' || h.real === false) continue;
      const k = h.taskId || `${h.accountId}|${h.publishedAt}`;
      if (seen.has(k)) continue;
      if (!sameDay(h.publishedAt)) continue;
      seen.add(k); n++;
    }

    // ② 持久化发布记录（DataStore 'publish'）。
    // 【2026-09-10 修复】原来只数内存 publishHistory → 服务一重启计数即归零，
    // 任何「每日配额」都形同虚设（重启即白送一轮配额）。改为合并磁盘记录：
    // 仅统计【带真实外链】的成功发布（publish_url 非空），失败/未发布不计入。
    try {
      if (this.dataStore && this.dataStore.list) {
        const res = this.dataStore.list('publish', { limit: 20000 });
        const items = Array.isArray(res) ? res : (res && res.items) || [];
        for (const p of items) {
          const aid = p.account_id || p.accountId;
          if (String(aid) !== String(accountId)) continue;
          const url = p.publish_url || p.publishUrl || '';
          if (!/^https?:\/\//i.test(String(url))) continue;
          const k = p.id || `${aid}|${p.published_at}`;
          if (seen.has(k)) continue;
          if (!sameDay(p.published_at || p.publishedAt)) continue;
          seen.add(k); n++;
        }
      }
    } catch (e) {
      // 读盘异常时退化为内存计数，绝不因为统计失败而阻断发布
      if (!this._dailyCountWarned) { this._dailyCountWarned = true; console.warn('[cloud-publisher] 每日发帖计数读盘失败，退化为内存计数:', e.message); }
    }
    return n;
  }

  // 全局每日发布预算：= 可用发布出口唯一 IP 数 × 单 IP 每日安全帖量（默认 10）。
  // 目的：把「日产量」与【出口 IP 容量模型】绑定 —— 27 个出口 × 10 = 270 帖/天。
  // 触发方式（二者其一）：
  //   · MSCMS_DAILY_POST_BUDGET=270            直接指定绝对值
  //   · MSCMS_DAILY_POST_BUDGET_ENFORCE=1      按「出口数 × MSCMS_POSTS_PER_EXIT_PER_DAY」自动算
  // 默认返回 0 = 不施加预算（不引入隐藏的停发开关；需要按容量收口时再显式打开）。
  _dailyPostBudget() {
    const fixed = Number(process.env.MSCMS_DAILY_POST_BUDGET || 0);
    if (fixed > 0) return fixed;
    const enforce = String(process.env.MSCMS_DAILY_POST_BUDGET_ENFORCE || '').toLowerCase();
    if (enforce !== '1' && enforce !== 'true') return 0;
    const perExit = Math.max(1, Number(process.env.MSCMS_POSTS_PER_EXIT_PER_DAY || 10));
    return this._exitCount() * perExit;
  }

  // 可用发布出口的唯一 IP 数（拿不到时退化为条目数，再拿不到返回 0）
  _exitCount() {
    try {
      const { ProxyPool } = require('./proxy-pool');
      const pool = this._poolForBudget || (this._poolForBudget = new ProxyPool());
      const list = (pool.proxies || []);
      const ips = new Set();
      for (const p of list) { const ip = p && (p.exitIp || p.host || p.url); if (ip) ips.add(ip); }
      return ips.size || list.length || 0;
    } catch (_) { return 0; }
  }

  // 今日【全站】已成功真实发布数（用于出口容量预算判定）
  _getGlobalDailyPostCount() {
    const today = new Date().toDateString();
    const sameDay = (v) => { const d = new Date(v); return !isNaN(d) && d.toDateString() === today; };
    const seen = new Set();
    let n = 0;
    try {
      if (this.dataStore && this.dataStore.list) {
        const res = this.dataStore.list('publish', { limit: 20000 });
        const items = Array.isArray(res) ? res : (res && res.items) || [];
        for (const p of items) {
          const url = p.publish_url || p.publishUrl || '';
          if (!/^https?:\/\//i.test(String(url))) continue;
          const k = p.id || `${p.account_id}|${p.published_at}`;
          if (seen.has(k)) continue;
          if (!sameDay(p.published_at || p.publishedAt)) continue;
          seen.add(k); n++;
        }
      }
    } catch (_) {}
    return n;
  }

  // 推迟任务：把任务挂到「未来某时刻」再回队，不消耗失败次数、不烧内容。
  // 用于「配额已满 / 未到发布间隔 / 出口容量已满」这类【节奏问题】——
  // 旧实现统一走 publish:failed，会把内容连续计失败 3 次后置为 failed 永久丢弃。
  _deferTask(task, waitMs, reason) {
    task._deferCount = (task._deferCount || 0) + 1;
    if (task._deferCount > 60) {
      task.status = PublishStatus.FAILED;
      task.error = `DEFER_EXHAUSTED: ${reason}`;
      this.stats.totalFailed++;
      this.emit('publish:failed', { task, reason: `defer exhausted: ${reason}` });
      return;
    }
    const wait = Math.min(Math.max(Number(waitMs) || 60000, 30000), 8 * 3600 * 1000);
    task.status = PublishStatus.PENDING;
    task.scheduledAt = new Date(Date.now() + wait).toISOString();
    this.publishQueue.push(task);
    console.log(`[cloud-publisher] ⏳ 任务 ${task.id} 推迟 ${Math.round(wait / 60000)} 分钟后再发（${reason}）`);
  }

  // 下一个本地 00:05（配额跨日重置点）
  _nextQuotaReset() {
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(0, 5, 0, 0);
    return next.getTime();
  }

  _updatePlatformStats(platform, result) {
    if (!this.stats.byPlatform[platform]) {
      this.stats.byPlatform[platform] = { attempts: 0, success: 0, failed: 0 };
    }
    this.stats.byPlatform[platform].attempts++;
    if (result === 'success') this.stats.byPlatform[platform].success++;
    else this.stats.byPlatform[platform].failed++;
  }

  // 获取发布报告
  getReport() {
    return {
      stats: this.stats,
      queueLength: this.publishQueue.length,
      activePublishes: this.activePublishes.size,
      recentHistory: this.publishHistory.slice(-20),
    };
  }

  // 诊断：检查内部状态
  getDiagnostics() {
    const onlineCount = this._onlineDeviceCount();
    const totalDevices = this.deviceManager ? this.deviceManager.devices.size : 0;
    const browserContextCount = this.deviceManager && this.deviceManager.browserContexts ? this.deviceManager.browserContexts.size : 0;
    
    // 尝试获取一台设备
    let sampleDevice = null;
    if (this.deviceManager && this.deviceManager.devices) {
      const devices = Array.from(this.deviceManager.devices.values());
      if (devices.length > 0) {
        const d = devices[0];
        sampleDevice = { id: d.id, name: d.name, status: d.status, mode: d.mode };
        // 检查 browser context
        if (this.deviceManager.browserContexts) {
          const ctx = this.deviceManager.browserContexts.get(d.id);
          sampleDevice.hasBrowserContext = !!ctx;
          sampleDevice.hasPage = !!(ctx && ctx.page);
        }
      }
    }

    return {
      deviceManagerPresent: !!this.deviceManager,
      totalDevices,
      onlineDevices: onlineCount,
      browserContextsCount: browserContextCount,
      sampleDevice,
      maxConcurrent: this.maxConcurrent,
      processing: this.processing,
      queueLength: this.publishQueue.length,
      queueSample: this.publishQueue.slice(0, 3).map(t => ({
        id: t.id,
        platform: t.platform,
        deviceId: t.deviceId,
        status: t.status,
        retryCount: t.retryCount,
        bootingRetries: t._bootingRetries,
        error: t.error,
      })),
    };
  }
}

module.exports = { CloudPublisher, PlatformPublishConfig, PublishStatus };
