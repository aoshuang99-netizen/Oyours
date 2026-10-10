/**
 * social-bridge.js — MSCMS v14 云手机社媒操作桥接层
 *
 * 核心能力：
 *   1. 对接 mobile-emulator.js 的 Playwright browser contexts
 *   2. 在云手机实例上执行真实社媒操作（发帖/关注/私信/评论/点赞）
 *   3. 支持多平台（Reddit/X/Discord/Instagram/TikTok/Facebook）
 *   4. 操作队列管理 + 失败重试 + 操作日志
 *   5. 反检测策略（随机延迟、人类行为模拟）
 *   6. 与 session-manager.js 集成，自动恢复登录态
 *
 * 用法：
 *   const { SocialBridge } = require('./social-bridge.js');
 *   const bridge = new SocialBridge({ deviceManager, sessionMgr });
 *   await bridge.postContent('device_01', 'reddit', { title: 'Hello', body: 'World' });
 *   await bridge.followUser('device_02', 'x', 'target_user');
 *   await bridge.sendDM('device_03', 'discord', 'user123', 'Hi there');
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 平台配置 ──────────────────────────────────────
const PLATFORM_CONFIG = {
  reddit: {
    name: 'Reddit',
    baseUrl: 'https://www.reddit.com',
    loginUrl: 'https://www.reddit.com/login',
    selectors: {
      createPost: 'a[href="/submit"]',
      titleField: 'textarea[name="title"]',
      bodyField: 'div[contenteditable="true"] div',
      submitBtn: 'button[type="submit"]',
      subredditInput: 'input[name="sr"]',
    },
    rateLimits: { post: 600000, comment: 180000, follow: 60000 }, // ms
  },
  x: {
    name: 'X (Twitter)',
    baseUrl: 'https://x.com',
    loginUrl: 'https://x.com/login',
    selectors: {
      createPost: 'a[data-testid="SideNav_NewTweet_Button"]',
      textField: 'div[data-testid="tweetTextarea_0"]',
      submitBtn: 'button[data-testid="tweetButton"]',
      followBtn: 'button[data-testid$="-follow"]',
      dmButton: 'a[data-testid="DMButton"]',
      dmInput: 'div[data-testid="dmComposerTextInput"]',
      dmSend: 'button[data-testid="dmComposerSendButton"]',
    },
    rateLimits: { post: 300000, comment: 120000, follow: 30000 },
  },
  discord: {
    name: 'Discord',
    baseUrl: 'https://discord.com',
    loginUrl: 'https://discord.com/login',
    selectors: {
      channelItem: 'li[data-list-item-id]',
      messageInput: 'div[role="textbox"][data-editor-type=""]',
      sendBtn: 'button[type="submit"]',
    },
    rateLimits: { post: 5000, comment: 3000, follow: 10000 },
  },
  instagram: {
    name: 'Instagram',
    baseUrl: 'https://www.instagram.com',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    selectors: {
      createPost: 'button[aria-label="New post"]',
      captionField: 'div[contenteditable="true"]',
      shareBtn: 'button:has-text("Share")',
      followBtn: 'button:has-text("Follow")',
      dmIcon: 'a[href="/direct/inbox/"]',
    },
    rateLimits: { post: 3600000, comment: 300000, follow: 60000 },
  },
  tiktok: {
    name: 'TikTok',
    baseUrl: 'https://www.tiktok.com',
    loginUrl: 'https://www.tiktok.com/login',
    selectors: {
      uploadBtn: 'a[href="/upload"]',
      captionField: 'div[contenteditable="true"]',
      postBtn: 'button:has-text("Post")',
      followBtn: 'button[data-e2e="follow"]',
    },
    rateLimits: { post: 7200000, comment: 600000, follow: 120000 },
  },
  facebook: {
    name: 'Facebook',
    baseUrl: 'https://www.facebook.com',
    loginUrl: 'https://www.facebook.com/login',
    selectors: {
      createPost: 'div[role="textbox"]',
      postBtn: 'div[aria-label="Post"]',
      followBtn: 'button[aria-label*="Follow"]',
      messenger: 'a[href="/messages/"]',
    },
    rateLimits: { post: 900000, comment: 240000, follow: 60000 },
  },
};

// ── 操作类型 ──────────────────────────────────────
const ACTION_TYPES = {
  POST: 'post',
  COMMENT: 'comment',
  FOLLOW: 'follow',
  UNFOLLOW: 'unfollow',
  DM: 'dm',
  LIKE: 'like',
  SHARE: 'share',
  REPOST: 'repost',
};

// ── 人类行为模拟 ──────────────────────────────────
function humanDelay(min = 800, max = 3000) {
  return min + Math.random() * (max - min);
}

function humanTypingDelay() {
  return 50 + Math.random() * 150;
}

function randomScroll() {
  return 200 + Math.random() * 600;
}

// ── 操作任务 ──────────────────────────────────────
class SocialAction {
  constructor(type, platform, deviceId, payload) {
    this.id = `act_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.type = type;
    this.platform = platform;
    this.deviceId = deviceId;
    this.payload = payload;
    this.status = 'queued'; // queued → running → success / failed
    this.attempts = 0;
    this.maxAttempts = 3;
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.completedAt = null;
    this.error = null;
    this.result = null;
  }

  start() {
    this.status = 'running';
    this.startedAt = new Date().toISOString();
    this.attempts++;
  }

  succeed(result) {
    this.status = 'success';
    this.completedAt = new Date().toISOString();
    this.result = result;
  }

  fail(error) {
    this.status = 'failed';
    this.completedAt = new Date().toISOString();
    this.error = error;
  }
}

// ── SocialBridge 主类 ────────────────────────────
class SocialBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.deviceManager = opts.deviceManager || null;
    this.sessionMgr = opts.sessionMgr || null;
    this.queue = [];
    this.active = new Map(); // deviceId → current action
    this.history = [];
    this.maxHistory = 500;
    this.lastActionTime = new Map(); // `${deviceId}:${platform}:${type}` → timestamp
    this.stats = {
      totalActions: 0,
      successCount: 0,
      failCount: 0,
      byType: {},
      byPlatform: {},
    };
    this.running = false;
    this.processorInterval = null;
  }

  // ── 启动队列处理器 ────────────────────────────
  start() {
    if (this.running) return;
    this.running = true;
    this.processorInterval = setInterval(() => this._processQueue(), 2000);
    this.emit('started');
  }

  stop() {
    this.running = false;
    if (this.processorInterval) clearInterval(this.processorInterval);
    this.emit('stopped');
  }

  // ── 入队操作 ──────────────────────────────────
  enqueue(type, platform, deviceId, payload) {
    if (!PLATFORM_CONFIG[platform]) throw new Error(`Unknown platform: ${platform}`);
    if (!ACTION_TYPES[type.toUpperCase()]) throw new Error(`Unknown action type: ${type}`);
    const action = new SocialAction(type, platform, deviceId, payload);
    this.queue.push(action);
    this.emit('enqueued', action);
    return action;
  }

  // ── 便捷方法 ──────────────────────────────────
  postContent(deviceId, platform, content) {
    return this.enqueue('post', platform, deviceId, content);
  }

  comment(deviceId, platform, targetPost, text) {
    return this.enqueue('comment', platform, deviceId, { targetPost, text });
  }

  followUser(deviceId, platform, targetUser) {
    return this.enqueue('follow', platform, deviceId, { targetUser });
  }

  unfollowUser(deviceId, platform, targetUser) {
    return this.enqueue('unfollow', platform, deviceId, { targetUser });
  }

  sendDM(deviceId, platform, targetUser, message) {
    return this.enqueue('dm', platform, deviceId, { targetUser, message });
  }

  likePost(deviceId, platform, targetPost) {
    return this.enqueue('like', platform, deviceId, { targetPost });
  }

  sharePost(deviceId, platform, targetPost) {
    return this.enqueue('share', platform, deviceId, { targetPost });
  }

  // ── 队列处理 ──────────────────────────────────
  async _processQueue() {
    if (this.queue.length === 0) return;

    // 取出就绪任务
    const action = this.queue.shift();
    if (!action) return;

    // 检查设备是否在线
    if (this.deviceManager) {
      const device = this.deviceManager.getDevice(action.deviceId);
      if (!device || device.status !== 'ready') {
        action.fail('Device not ready');
        this._recordAction(action);
        return;
      }
    }

    // 速率限制检查
    const rateKey = `${action.deviceId}:${action.platform}:${action.type}`;
    const lastTime = this.lastActionTime.get(rateKey) || 0;
    const platformCfg = PLATFORM_CONFIG[action.platform];
    const rateLimit = platformCfg.rateLimits[action.type] || 60000;
    if (Date.now() - lastTime < rateLimit) {
      // 重新入队，稍后重试
      this.queue.unshift(action);
      return;
    }

    // 执行操作
    action.start();
    this.active.set(action.deviceId, action);
    this.emit('action:start', action);

    try {
      const result = await this._executeAction(action);
      action.succeed(result);
      this.lastActionTime.set(rateKey, Date.now());
      this.stats.successCount++;
      this.emit('action:success', action);
    } catch (e) {
      action.fail(e.message);
      if (action.attempts < action.maxAttempts) {
        // 重试
        action.status = 'queued';
        this.queue.push(action);
      } else {
        this.stats.failCount++;
        this.emit('action:fail', action);
      }
    } finally {
      this.active.delete(action.deviceId);
      this._recordAction(action);
    }
  }

  // ── 执行操作 ──────────────────────────────────
  async _executeAction(action) {
    const platformCfg = PLATFORM_CONFIG[action.platform];

    // 获取设备 browser context
    if (!this.deviceManager) throw new Error('No device manager');
    const device = this.deviceManager.getDevice(action.deviceId);
    if (!device || !device.context) {
      throw new Error(`Device ${action.deviceId} has no browser context`);
    }

    const page = await device.context.newPage();
    try {
      switch (action.type) {
        case 'post':
          return await this._doPost(page, action.platform, action.payload);
        case 'comment':
          return await this._doComment(page, action.platform, action.payload);
        case 'follow':
          return await this._doFollow(page, action.platform, action.payload);
        case 'unfollow':
          return await this._doUnfollow(page, action.platform, action.payload);
        case 'dm':
          return await this._doDM(page, action.platform, action.payload);
        case 'like':
          return await this._doLike(page, action.platform, action.payload);
        case 'share':
          return await this._doShare(page, action.platform, action.payload);
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ── 发帖 ──────────────────────────────────────
  async _doPost(page, platform, payload) {
    const cfg = PLATFORM_CONFIG[platform];
    await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(humanDelay(1500, 3000));

    // 点击创建帖子
    const createBtn = page.locator(cfg.selectors.createPost).first();
    await createBtn.waitFor({ state: 'visible', timeout: 10000 });
    await createBtn.click();
    await page.waitForTimeout(humanDelay(800, 2000));

    // 填写标题
    if (payload.title) {
      const titleField = page.locator(cfg.selectors.titleField).first();
      await titleField.fill('');
      for (const ch of payload.title) {
        await titleField.press(ch);
        await page.waitForTimeout(humanTypingDelay());
      }
    }

    // 填写内容
    if (payload.body) {
      const bodyField = page.locator(cfg.selectors.bodyField).first();
      await bodyField.click();
      await page.waitForTimeout(humanDelay(300, 800));
      for (const ch of payload.body) {
        await page.keyboard.type(ch, { delay: humanTypingDelay() });
      }
    }

    // 模拟人类阅读检查
    await page.mouse.wheel(0, randomScroll());
    await page.waitForTimeout(humanDelay(1000, 2500));

    // 提交
    const submitBtn = page.locator(cfg.selectors.submitBtn).first();
    await submitBtn.click();
    await page.waitForTimeout(humanDelay(2000, 4000));

    return { posted: true, platform, url: page.url(), timestamp: new Date().toISOString() };
  }

  // ── 评论 ──────────────────────────────────────
  async _doComment(page, platform, payload) {
    const cfg = PLATFORM_CONFIG[platform];
    const postUrl = payload.targetPost || cfg.baseUrl;
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(humanDelay(1500, 3000));

    // 模拟阅读帖子
    await page.mouse.wheel(0, randomScroll());
    await page.waitForTimeout(humanDelay(2000, 5000));

    // 找到评论框并输入
    const commentField = page.locator(cfg.selectors.bodyField || cfg.selectors.textField).first();
    await commentField.click();
    await page.waitForTimeout(humanDelay(500, 1000));
    for (const ch of payload.text) {
      await page.keyboard.type(ch, { delay: humanTypingDelay() });
    }

    // 提交评论
    await page.waitForTimeout(humanDelay(800, 1500));
    const submitBtn = page.locator(cfg.selectors.submitBtn).first();
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(humanDelay(1500, 3000));

    return { commented: true, platform, targetPost: postUrl, timestamp: new Date().toISOString() };
  }

  // ── 关注 ──────────────────────────────────────
  async _doFollow(page, platform, payload) {
    const cfg = PLATFORM_CONFIG[platform];
    const profileUrl = payload.targetUser.startsWith('http')
      ? payload.targetUser
      : `${cfg.baseUrl}/${payload.targetUser}`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(humanDelay(1500, 3000));

    // 浏览一下页面
    await page.mouse.wheel(0, randomScroll());
    await page.waitForTimeout(humanDelay(2000, 4000));

    // 点击关注按钮
    const followBtn = page.locator(cfg.selectors.followBtn).first();
    await followBtn.waitFor({ state: 'visible', timeout: 8000 });
    const btnText = await followBtn.textContent().catch(() => '');
    if (btnText.toLowerCase().includes('following') || btnText.toLowerCase().includes('已关注')) {
      return { followed: false, reason: 'already following', platform, target: payload.targetUser };
    }
    await followBtn.click();
    await page.waitForTimeout(humanDelay(1000, 2500));

    return { followed: true, platform, target: payload.targetUser, timestamp: new Date().toISOString() };
  }

  // ── 取关 ──────────────────────────────────────
  async _doUnfollow(page, platform, payload) {
    const cfg = PLATFORM_CONFIG[platform];
    const profileUrl = payload.targetUser.startsWith('http')
      ? payload.targetUser
      : `${cfg.baseUrl}/${payload.targetUser}`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(humanDelay(1500, 3000));

    const followBtn = page.locator(cfg.selectors.followBtn).first();
    await followBtn.waitFor({ state: 'visible', timeout: 8000 });
    await followBtn.click();
    await page.waitForTimeout(humanDelay(800, 1500));

    // 确认取关弹窗
    const confirmBtn = page.locator('button:has-text("Unfollow")').first();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
    }
    await page.waitForTimeout(humanDelay(1000, 2000));

    return { unfollowed: true, platform, target: payload.targetUser, timestamp: new Date().toISOString() };
  }

  // ── 私信 ──────────────────────────────────────
  async _doDM(page, platform, payload) {
    const cfg = PLATFORM_CONFIG[platform];
    const profileUrl = payload.targetUser.startsWith('http')
      ? payload.targetUser
      : `${cfg.baseUrl}/${payload.targetUser}`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(humanDelay(1500, 3000));

    // 点击私信按钮
    if (cfg.selectors.dmButton) {
      const dmBtn = page.locator(cfg.selectors.dmButton).first();
      await dmBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      if (await dmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await dmBtn.click();
        await page.waitForTimeout(humanDelay(1500, 3000));
      }
    }

    // 输入消息
    const dmInput = page.locator(cfg.selectors.dmInput || cfg.selectors.messageInput).first();
    await dmInput.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await dmInput.click();
    await page.waitForTimeout(humanDelay(500, 1000));
    for (const ch of payload.message) {
      await page.keyboard.type(ch, { delay: humanTypingDelay() });
    }

    // 发送
    await page.waitForTimeout(humanDelay(800, 1500));
    if (cfg.selectors.dmSend) {
      const sendBtn = page.locator(cfg.selectors.dmSend).first();
      if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sendBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(humanDelay(1500, 3000));

    return { sent: true, platform, target: payload.targetUser, timestamp: new Date().toISOString() };
  }

  // ── 点赞 ──────────────────────────────────────
  async _doLike(page, platform, payload) {
    const cfg = PLATFORM_CONFIG[platform];
    const postUrl = payload.targetPost || cfg.baseUrl;
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(humanDelay(1500, 3000));

    // 找到点赞按钮
    const likeSelectors = {
      reddit: 'button[aria-label*="upvote"]',
      x: 'button[data-testid="like"]',
      discord: 'button[aria-label*="reaction"]',
      instagram: 'button[aria-label*="Like"] svg',
      tiktok: 'button[data-e2e="like-icon"]',
      facebook: 'div[aria-label="Like"]',
    };
    const likeSelector = likeSelectors[platform];
    if (likeSelector) {
      const likeBtn = page.locator(likeSelector).first();
      await likeBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await likeBtn.click();
      await page.waitForTimeout(humanDelay(800, 2000));
    }

    return { liked: true, platform, target: postUrl, timestamp: new Date().toISOString() };
  }

  // ── 分享 ──────────────────────────────────────
  async _doShare(page, platform, payload) {
    const cfg = PLATFORM_CONFIG[platform];
    const postUrl = payload.targetPost || cfg.baseUrl;
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(humanDelay(1500, 3000));

    const shareSelectors = {
      reddit: 'button[aria-label*="share"]',
      x: 'button[data-testid="retweet"]',
      discord: 'button[aria-label*="forward"]',
      instagram: 'button[aria-label*="share"]',
      tiktok: 'button[data-e2e="share-icon"]',
      facebook: 'div[aria-label="Send"]',
    };
    const shareSelector = shareSelectors[platform];
    if (shareSelector) {
      const shareBtn = page.locator(shareSelector).first();
      await shareBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await shareBtn.click();
      await page.waitForTimeout(humanDelay(1000, 2500));
    }

    return { shared: true, platform, target: postUrl, timestamp: new Date().toISOString() };
  }

  // ── 记录操作 ──────────────────────────────────
  _recordAction(action) {
    this.stats.totalActions++;
    const typeKey = action.type;
    this.stats.byType[typeKey] = (this.stats.byType[typeKey] || 0) + 1;
    const platKey = action.platform;
    this.stats.byPlatform[platKey] = (this.stats.byPlatform[platKey] || 0) + 1;

    this.history.unshift({
      id: action.id,
      type: action.type,
      platform: action.platform,
      deviceId: action.deviceId,
      status: action.status,
      attempts: action.attempts,
      createdAt: action.createdAt,
      completedAt: action.completedAt,
      error: action.error,
      result: action.result,
    });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }
  }

  // ── 获取状态 ──────────────────────────────────
  getStats() {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      activeCount: this.active.size,
      running: this.running,
      successRate: this.stats.totalActions > 0
        ? (this.stats.successCount / this.stats.totalActions * 100).toFixed(1) + '%'
        : '0%',
    };
  }

  getQueue() {
    return this.queue.map(a => ({
      id: a.id,
      type: a.type,
      platform: a.platform,
      deviceId: a.deviceId,
      status: a.status,
      attempts: a.attempts,
    }));
  }

  getHistory(limit = 50) {
    return this.history.slice(0, limit);
  }

  getActive() {
    return Array.from(this.active.values()).map(a => ({
      id: a.id,
      type: a.type,
      platform: a.platform,
      deviceId: a.deviceId,
      attempts: a.attempts,
      startedAt: a.startedAt,
    }));
  }

  // ── 批量操作 ──────────────────────────────────
  async batchPost(deviceIds, platform, contents) {
    const actions = [];
    for (let i = 0; i < deviceIds.length && i < contents.length; i++) {
      actions.push(this.postContent(deviceIds[i], platform, contents[i]));
    }
    return actions;
  }

  async batchFollow(deviceIds, platform, targetUsers) {
    const actions = [];
    for (let i = 0; i < deviceIds.length && i < targetUsers.length; i++) {
      actions.push(this.followUser(deviceIds[i], platform, targetUsers[i]));
    }
    return actions;
  }
}

module.exports = { SocialBridge, PLATFORM_CONFIG, ACTION_TYPES, SocialAction };
