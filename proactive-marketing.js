/**
 * proactive-marketing.js — MSCMS v14 主动营销引擎
 *
 * 核心能力：
 *   1. 自动关注目标用户（按关键词/竞品粉丝/KOL粉丝定向）
 *   2. 私信触达（个性化话术 + A/B 测试 + 转化追踪）
 *   3. 话题参与（热点话题自动评论 + 带链接发帖）
 *   4. KOL 互动（大V评论区前排截流 + 互动曝光）
 *   5. 评论区截流（竞品帖子下评论引流）
 *   6. 跨号协同（矩阵账号互相点赞/评论/转发）
 *   7. 营销日历 + 时间窗口调度
 *   8. 效果追踪（关注→回关→私信→点击→转化漏斗）
 *
 * 用法：
 *   const { ProactiveMarketing } = require('./proactive-marketing.js');
 *   const mkt = new ProactiveMarketing({ socialBridge, contentGenerator, trafficRouter });
 *   mkt.startCampaign({ type: 'follow_target', platform: 'reddit', keywords: ['gaming'] });
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 营销活动类型 ──────────────────────────────────
const CAMPAIGN_TYPES = {
  FOLLOW_TARGET: 'follow_target',       // 关注目标用户
  DM_OUTREACH: 'dm_outreach',           // 私信触达
  TOPIC_PARTICIPATE: 'topic_participate', // 话题参与
  KOL_INTERCEPT: 'kol_intercept',       // KOL评论区截流
  COMPETITOR_INTERCEPT: 'competitor_intercept', // 竞品帖子截流
  CROSS_ACCOUNT: 'cross_account',       // 跨号协同
};

// ── 活动状态 ──────────────────────────────────────
const CAMPAIGN_STATUS = {
  DRAFT: 'draft',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

// ── 营销话术模板 ──────────────────────────────────
const MESSAGE_TEMPLATES = {
  reddit: [
    "Hey! Saw your post about {topic} — really insightful. We just published a deep-dive on this at {link}, would love your feedback!",
    "Nice contribution to r/{subreddit}! This reminded me of something we wrote: {link}. Curious what you think?",
    "Great question! We actually covered something similar recently: {link}. Might help answer some of your points.",
  ],
  x: [
    "Love your take on {topic}! We're working on something related — check it out: {link}",
    "This is gold. Shared it with our community. Also wrote about this: {link}",
    "Spot on! Here's our perspective on {topic}: {link}",
  ],
  discord: [
    "Hey! Great discussion here. We put together a guide on {topic}: {link} — feel free to check it out!",
    "This is super helpful! For anyone wanting more depth, we have a resource: {link}",
    "Awesome community! We created something related to {topic}: {link}",
  ],
  instagram: [
    "Love your content on {topic}! Check out our latest post: {link}",
    "This is amazing! More on {topic} here: {link}",
    "Great vibes! We're all about {topic} too: {link}",
  ],
  tiktok: [
    "This is fire! We made something about {topic} too: {link}",
    "Love this! More {topic} content: {link}",
    "POV: you found the best {topic} resource: {link}",
  ],
  facebook: [
    "Great post about {topic}! We have a detailed guide: {link}",
    "This is really helpful! More resources on {topic}: {link}",
    "Wonderful insights! Check out our page for more on {topic}: {link}",
  ],
};

// ── 营销活动 ──────────────────────────────────────
class MarketingCampaign {
  constructor(config) {
    this.id = `camp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.type = config.type;
    this.platform = config.platform;
    this.name = config.name || `${config.type}_${config.platform}`;
    this.config = config;
    this.status = CAMPAIGN_STATUS.DRAFT;
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.completedAt = null;

    // 目标
    this.targets = config.targets || []; // 用户列表/关键词/话题
    this.deviceIds = config.deviceIds || []; // 使用的设备

    // 进度
    this.progress = {
      total: this.targets.length,
      completed: 0,
      success: 0,
      failed: 0,
      pending: this.targets.length,
    };

    // 漏斗
    this.funnel = {
      reached: 0,        // 触达
      engaged: 0,        // 互动（回关/回复）
      clicked: 0,        // 点击链接
      converted: 0,      // 转化
    };

    // A/B 测试
    this.abTestVariants = config.variants || ['A', 'B'];
    this.abTestResults = {};

    this.error = null;
  }
}

// ── 主动营销引擎 ──────────────────────────────────
class ProactiveMarketing extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.socialBridge = opts.socialBridge || null;
    this.contentGenerator = opts.contentGenerator || null;
    this.trafficRouter = opts.trafficRouter || null;
    this.deviceManager = opts.deviceManager || null;
    this.nurturing = opts.nurturing || null;  // 【新增】账号养号引擎引用

    this.campaigns = new Map();
    this.activeCampaigns = new Set();
    this.maxConcurrent = opts.maxConcurrent || 3;

    // 营销时间窗口（避免深夜发送）
    this.activeHours = opts.activeHours || { start: 8, end: 23 };

    // 统计
    this.stats = {
      totalCampaigns: 0,
      activeCampaigns: 0,
      totalReached: 0,
      totalEngaged: 0,
      totalClicked: 0,
      totalConverted: 0,
      conversionRate: 0,
      byType: {},
      byPlatform: {},
    };

    this.processorInterval = null;
    this.running = false;
  }

  // ── 启动引擎 ──────────────────────────────────
  start() {
    if (this.running) return;
    this.running = true;
    this.processorInterval = setInterval(() => this._processCampaigns(), 5000);
    this.emit('started');
  }

  stop() {
    this.running = false;
    if (this.processorInterval) clearInterval(this.processorInterval);
    this.emit('stopped');
  }

  // ── 创建营销活动 ──────────────────────────────
  createCampaign(config) {
    const campaign = new MarketingCampaign(config);
    this.campaigns.set(campaign.id, campaign);
    this.stats.totalCampaigns++;
    this.emit('campaign:created', campaign);
    return campaign;
  }

  startCampaign(campaignId) {
    const camp = this.campaigns.get(campaignId);
    if (!camp) throw new Error('Campaign not found');
    if (this.activeCampaigns.size >= this.maxConcurrent) {
      throw new Error('Max concurrent campaigns reached');
    }
    camp.status = CAMPAIGN_STATUS.RUNNING;
    camp.startedAt = new Date().toISOString();
    this.activeCampaigns.add(campaignId);
    this.stats.activeCampaigns = this.activeCampaigns.size;
    this.emit('campaign:started', camp);
    return camp;
  }

  pauseCampaign(campaignId) {
    const camp = this.campaigns.get(campaignId);
    if (!camp) return;
    camp.status = CAMPAIGN_STATUS.PAUSED;
    this.activeCampaigns.delete(campaignId);
    this.stats.activeCampaigns = this.activeCampaigns.size;
    this.emit('campaign:paused', camp);
  }

  completeCampaign(campaignId) {
    const camp = this.campaigns.get(campaignId);
    if (!camp) return;
    camp.status = CAMPAIGN_STATUS.COMPLETED;
    camp.completedAt = new Date().toISOString();
    this.activeCampaigns.delete(campaignId);
    this.stats.activeCampaigns = this.activeCampaigns.size;
    this._updateStats(camp);
    this.emit('campaign:completed', camp);
  }

  // ── 处理营销活动 ──────────────────────────────
  async _processCampaigns() {
    if (!this._isWithinActiveHours()) return;

    for (const campaignId of this.activeCampaigns) {
      const camp = this.campaigns.get(campaignId);
      if (!camp || camp.status !== CAMPAIGN_STATUS.RUNNING) continue;
      if (camp.progress.pending === 0) {
        this.completeCampaign(campaignId);
        continue;
      }

      // 取下一个目标
      const targetIndex = camp.progress.completed;
      const target = camp.targets[targetIndex];
      if (!target) {
        this.completeCampaign(campaignId);
        continue;
      }

      // 分配设备
      const deviceId = camp.deviceIds[targetIndex % camp.deviceIds.length];

      try {
        await this._executeCampaignAction(camp, target, deviceId);
        camp.progress.success++;
        camp.funnel.reached++;
      } catch (e) {
        camp.progress.failed++;
        this.emit('campaign:error', { campaign: camp, error: e.message });
      }

      camp.progress.completed++;
      camp.progress.pending--;
    }
  }

  // ── 执行营销动作 ──────────────────────────────
  async _executeCampaignAction(campaign, target, deviceId) {
    // 【修复】验证账号/设备是否已登录到目标社媒平台
    const plat = campaign.platform;
    let accountLoggedIn = false;

    // 检查 DeviceManager 中设备状态
    if (this.deviceManager) {
      try {
        const device = this.deviceManager.getDevice ? this.deviceManager.getDevice(deviceId) : null;
        if (!device || device.status !== 'ONLINE' && device.status !== 'READY' && device.status !== 'BUSY') {
          console.warn(`[ProactiveMarketing] 设备 ${deviceId} 离线，跳过平台 ${plat} 营销动作`);
          throw new Error(`Device ${deviceId} offline (status: ${device?.status || 'unknown'})`);
        }
      } catch(e) {
        throw new Error(`Device ${deviceId} not available: ${e.message}`);
      }
    }

    // 检查 Nurturing 中账号状态
    if (this.nurturing) {
      try {
        const accounts = Array.from(this.nurturing.accounts?.values() || []);
        const matchedAccount = accounts.find(a =>
          a.deviceId === deviceId && a.platform === plat &&
          ['S2_NURTURING', 'S3_MATURE', 'S4_PEAK'].includes(a.state)
        );
        if (!matchedAccount) {
          console.warn(`[ProactiveMarketing] 平台 ${plat} 设备 ${deviceId} 无已登录活跃账号，跳过营销动作`);
          throw new Error(`No active logged-in account for ${plat} on device ${deviceId}`);
        }
        accountLoggedIn = true;
        console.log(`[ProactiveMarketing] ✅ 账号 ${matchedAccount.username} (${matchedAccount.state}) 已登录 ${plat}`);
      } catch(e) {
        if (e.message.includes('No active')) throw e;
        // nurturing 查询失败不影响，继续执行
      }
    }

    // 生成引流链接
    let trackingLink = null;
    if (this.trafficRouter && campaign.config.landingUrl) {
      trackingLink = await this.trafficRouter.createLink({
        url: campaign.config.landingUrl,
        source: campaign.platform,
        campaign: campaign.id,
        medium: 'proactive_marketing',
        content: target.user || target.keyword || 'default',
        platform: campaign.platform,
        accountId: campaign.accountId || null,
      });
    }

    // 生成话术
    const message = this._generateMessage(campaign.platform, {
      topic: target.topic || campaign.config.topic || 'this topic',
      subreddit: target.subreddit || campaign.config.subreddit || '',
      link: trackingLink || campaign.config.landingUrl || '',
    }, campaign.abTestVariants[targetIndex % campaign.abTestVariants.length]);

    switch (campaign.type) {
      case CAMPAIGN_TYPES.FOLLOW_TARGET:
        if (this.socialBridge) {
          this.socialBridge.followUser(deviceId, campaign.platform, target.user);
        }
        break;

      case CAMPAIGN_TYPES.DM_OUTREACH:
        if (this.socialBridge) {
          this.socialBridge.sendDM(deviceId, campaign.platform, target.user, message);
        }
        camp.funnel.reached++;
        break;

      case CAMPAIGN_TYPES.TOPIC_PARTICIPATE:
        if (this.socialBridge) {
          this.socialBridge.comment(deviceId, campaign.platform, target.postUrl, message);
        }
        break;

      case CAMPAIGN_TYPES.KOL_INTERCEPT:
        if (this.socialBridge) {
          // 先关注KOL
          this.socialBridge.followUser(deviceId, campaign.platform, target.kol);
          // 然后在KOL最新帖子下评论
          this.socialBridge.comment(deviceId, campaign.platform, target.postUrl, message);
        }
        break;

      case CAMPAIGN_TYPES.COMPETITOR_INTERCEPT:
        if (this.socialBridge) {
          this.socialBridge.comment(deviceId, campaign.platform, target.competitorPost, message);
        }
        break;

      case CAMPAIGN_TYPES.CROSS_ACCOUNT:
        // 矩阵号互赞互评
        if (this.socialBridge && target.postUrl) {
          this.socialBridge.likePost(deviceId, campaign.platform, target.postUrl);
          this.socialBridge.comment(deviceId, campaign.platform, target.postUrl, message);
        }
        break;
    }
  }

  // ── 生成话术 ──────────────────────────────────
  _generateMessage(platform, vars, variant = 'A') {
    const templates = MESSAGE_TEMPLATES[platform] || MESSAGE_TEMPLATES.reddit;
    let template = templates[Math.floor(Math.random() * templates.length)];
    // 替换变量
    for (const [key, value] of Object.entries(vars)) {
      template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    // A/B 测试变体
    if (variant === 'B') {
      const bTemplates = [
        `Quick question — are you into ${vars.topic}? We just launched something cool: ${vars.link}`,
        `Been following your work on ${vars.topic}. Thought you might like this: ${vars.link}`,
        `Hey! We built something for ${vars.topic} enthusiasts: ${vars.link}`,
      ];
      template = bTemplates[Math.floor(Math.random() * bTemplates.length)];
    }
    return template;
  }

  // ── 活跃时间检查 ──────────────────────────────
  _isWithinActiveHours() {
    const hour = new Date().getHours();
    return hour >= this.activeHours.start && hour < this.activeHours.end;
  }

  // ── 更新统计 ──────────────────────────────────
  _updateStats(campaign) {
    this.stats.totalReached += campaign.funnel.reached;
    this.stats.totalEngaged += campaign.funnel.engaged;
    this.stats.totalClicked += campaign.funnel.clicked;
    this.stats.totalConverted += campaign.funnel.converted;
    this.stats.conversionRate = this.stats.totalReached > 0
      ? (this.stats.totalConverted / this.stats.totalReached * 100).toFixed(2) + '%'
      : '0%';

    const typeKey = campaign.type;
    if (!this.stats.byType[typeKey]) this.stats.byType[typeKey] = { count: 0, reached: 0 };
    this.stats.byType[typeKey].count++;
    this.stats.byType[typeKey].reached += campaign.funnel.reached;

    const platKey = campaign.platform;
    if (!this.stats.byPlatform[platKey]) this.stats.byPlatform[platKey] = { count: 0, reached: 0 };
    this.stats.byPlatform[platKey].count++;
    this.stats.byPlatform[platKey].reached += campaign.funnel.reached;
  }

  // ── 快速创建活动 ──────────────────────────────
  quickFollowCampaign(platform, keywords, deviceIds, landingUrl) {
    return this.createCampaign({
      type: CAMPAIGN_TYPES.FOLLOW_TARGET,
      platform,
      name: `Follow campaign - ${platform} - ${keywords.join(',')}`,
      targets: keywords.map(kw => ({ keyword: kw, topic: kw })),
      deviceIds,
      landingUrl,
    });
  }

  quickDMCampaign(platform, users, deviceIds, landingUrl, topic) {
    return this.createCampaign({
      type: CAMPAIGN_TYPES.DM_OUTREACH,
      platform,
      name: `DM campaign - ${platform} - ${users.length} users`,
      targets: users.map(u => ({ user: u, topic })),
      deviceIds,
      landingUrl,
      topic,
    });
  }

  quickInterceptCampaign(platform, kolPosts, deviceIds, landingUrl) {
    return this.createCampaign({
      type: CAMPAIGN_TYPES.KOL_INTERCEPT,
      platform,
      name: `KOL intercept - ${platform} - ${kolPosts.length} posts`,
      targets: kolPosts.map(p => ({ kol: p.kol, postUrl: p.url, topic: p.topic || 'trending' })),
      deviceIds,
      landingUrl,
    });
  }

  // ── 帖子发布后自动营销触发 ────────────────────
  onPostPublished(data) {
    const { post_id, account_id, platform, content_id, publish_url } = data;
    console.log(`[ProactiveMarketing] 📢 帖子发布触发自动营销: ${post_id} platform=${platform}`);

    // 1. 自动创建关注营销 — 在同平台搜索关键词关注目标用户
    try {
      const keywords = (data.content_title || data.title || '').split(/\s+/).filter(Boolean).slice(0, 3);
      if (keywords.length === 0) keywords.push(platform, 'trending');
      const deviceIds = data.device_id ? [data.device_id] : (this.deviceManager && typeof this.deviceManager.getOnlineDeviceIds === 'function' ? this.deviceManager.getOnlineDeviceIds() || [] : []);
      // 【零伪造】无真实发布 URL 时传空串，绝不拼接 platform.com/post/id 假链接
      const realUrl = (publish_url && /^https?:\/\//i.test(String(publish_url))) ? String(publish_url) : '';
      const campaign = this.quickFollowCampaign(platform, keywords,
        deviceIds.length > 0 ? deviceIds : ['auto'],
        realUrl);
      console.log(`[ProactiveMarketing] 自动创建 Follow 活动: ${campaign.id} (${keywords.join(',')})`);
      if (deviceIds.length > 0 && this.activeCampaigns.size < this.maxConcurrent) {
        this.startCampaign(campaign.id);
        console.log(`[ProactiveMarketing] Follow 活动已自动启动: ${campaign.id}`);
      }
    } catch (e) {
      console.warn('[ProactiveMarketing] 自动 Follow 活动创建失败:', e.message);
    }

    // 2. 自动创建 KOL 截流营销 — 截流同平台热门KOL评论区
    try {
      const kolPosts = [{ kol: `top_${platform}_influencer`, url: `https://${platform}.com/trending`, topic: 'trending' }];
      const deviceIds = data.device_id ? [data.device_id] : [];
      const campaign = this.quickInterceptCampaign(platform, kolPosts,
        deviceIds.length > 0 ? deviceIds : ['auto'],
        publish_url || null);
      console.log(`[ProactiveMarketing] 自动创建 KOL截流 活动: ${campaign.id}`);
    } catch (e) {
      console.warn('[ProactiveMarketing] 自动 KOL截流 活动创建失败:', e.message);
    }

    return { triggered: true, post_id };
  }

  // ── 获取状态 ──────────────────────────────────
  getStats() {
    return {
      ...this.stats,
      campaignsTotal: this.campaigns.size,
      campaignsActive: this.activeCampaigns.size,
      running: this.running,
    };
  }

  listCampaigns(status = null) {
    let campaigns = Array.from(this.campaigns.values());
    if (status) campaigns = campaigns.filter(c => c.status === status);
    return campaigns.map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      platform: c.platform,
      status: c.status,
      progress: c.progress,
      funnel: c.funnel,
      createdAt: c.createdAt,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
    }));
  }

  getCampaign(campaignId) {
    const c = this.campaigns.get(campaignId);
    if (!c) return null;
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      platform: c.platform,
      status: c.status,
      config: c.config,
      progress: c.progress,
      funnel: c.funnel,
      abTestResults: c.abTestResults,
      createdAt: c.createdAt,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      error: c.error,
    };
  }
}

module.exports = { ProactiveMarketing, MarketingCampaign, CAMPAIGN_TYPES, CAMPAIGN_STATUS, MESSAGE_TEMPLATES };
