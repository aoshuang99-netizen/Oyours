/**
 * account-nurturing.js — MSCMS v14 智能养号自动化引擎
 *
 * 涵盖：
 *   1. 7状态账号生命周期（S0创建 → S1预热 → S2养成 → S3成熟 → S4巅峰 → S5衰退 → S6冻结）
 *   2. 5平台精细化养号策略（TikTok/Instagram/Facebook/Twitter/YouTube）
 *   3. 高斯分布行为模拟（延迟、鼠标轨迹、会话时长）
 *   4. T0-T6账号分层管理
 *   5. Ban-Risk动态评分引擎
 *   6. 每日操作配额自动生成
 *   7. 行为策略自适应调整
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 状态枚举 ─────────────────────────────────────
const AccountState = {
  : '',       // 刚创建
  : '',       // 预热期
  S2_NURTURING: 'S2_NURTURING',   // 养成期
  S3_MATURE: 'S3_MATURE',         // 成熟期
  S4_PEAK: 'S4_PEAK',             // 巅峰期
  S5_DECLINING: 'S5_DECLINING',   // 衰退期
  S6_FROZEN: 'S6_FROZEN',         // 冻结期
};

// ── 账号层级 ─────────────────────────────────────
const AccountTier = {
  T0_NEW: { name: 'T0-新生', minScore: 0, maxScore: 30, dailyActionsMax: 5, followLimit: 2, contentLimit: 0 },
  T1_BEGINNER: { name: 'T1-入门', minScore: 30, maxScore: 50, dailyActionsMax: 15, followLimit: 8, contentLimit: 0 },
  T2_GROWING: { name: 'T2-成长', minScore: 50, maxScore: 65, dailyActionsMax: 30, followLimit: 20, contentLimit: 2 },
  T3_ACTIVE: { name: 'T3-活跃', minScore: 65, maxScore: 75, dailyActionsMax: 50, followLimit: 35, contentLimit: 5 },
  T4_POWER: { name: 'T4-主力', minScore: 75, maxScore: 85, dailyActionsMax: 80, followLimit: 50, contentLimit: 10 },
  T5_ELITE: { name: 'T5-精英', minScore: 85, maxScore: 95, dailyActionsMax: 120, followLimit: 80, contentLimit: 20 },
  T6_LEGEND: { name: 'T6-传奇', minScore: 95, maxScore: 100, dailyActionsMax: 200, followLimit: 120, contentLimit: 40 },
};

// ── 模拟账号判定（2026-09-12）─────────────────────
// 与 server.js / v14-account-loop.js 的真实口径保持一致：临时邮箱 / preinstall 标记
// 的账号属于「模拟资产」，不得计入养号容量，更不得替它发射 account.healthy 因果事件
// （每个进程启动都会让它们从 S0→S3，即每轮白送数十条假健康事件）。
const SIM_TEMP_EMAIL_RE = /guerrillamail|guerrillamailblock|mailinator|10minutemail|10minute-mail|tempmail|throwaway|dispostable|trashmail|temp-mail|sharklasers|getnada|yopmail|@mscms\.mail/i;
 isSimulatedSeed(data) {
  if (!data) return true;
  if (data._simulated === true || data.simulated === true) return true;
  if (Array.isArray(data.tags) && data.tags.includes('preinstall')) return true;
  if (String(data.source || '') === 'preinstall') return true;
  if (SIM_TEMP_EMAIL_RE.test(String(data.email || ''))) return true;
  return false;
}

// ── 成熟判定阈值（2026-09-12：从「计时器 +1」改为「真实行为反算」）─────
// 唯一数据源 = 3005 养号服务落库的 tumblr_nurture（真实动作记录）：
//   day / totalActions / daily{ '': {like,follow,reblog,post,comment} } / noToken
// 设计原则：**没有真实动作证据就不升级、不发事件**。任何账号都不会因为"等够时间"而成熟。
// 旧实现 ` += 1` / 10s → 任何账号（含假号、含无 token 号）约 7.5 分钟自动
// S3_MATURE 并 emit('account.healthy')，117 个账号集体假成熟 → 每个进程启动就往因果链
// 灌 117 条"健康"事件，每一条又触发一次内容生成（真实生成速率 11.7 条/分钟，是配置值
// 0.67/分钟的 17 倍）。现改为证据驱动 + 仅"新达成"才发 + 每周期上限。
 maturityThresholds() {
  const num = (key, dflt) => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    minDays: num('MSCMS_MATURE_MIN_DAYS', 7),          // 有真实动作的天数
    minPosts: num('MSCMS_MATURE_MIN_POSTS', 3),        // 累计真实发帖
    minLikes: num('MSCMS_MATURE_MIN_LIKES', 30),       // 累计真实点赞
    minActions: num('MSCMS_MATURE_MIN_ACTIONS', 30),   // 累计真实动作
    nurtureDays: num('MSCMS_NURTURE_MIN_DAYS', 2),     // 进入养成期的最低活跃天数
    maxHealthyPerCycle: num('MSCMS_NURTURE_HEALTHY_MAX_PER_CYCLE', 2), // 每周期最多发几条 account.healthy
  };
}

// ── 平台养号策略 ─────────────────────────────────
const PlatformStrategies = {
  tiktok: {
    name: 'TikTok',
    warmingDurationDays: 7,
    phases: [
      { day: '1-2', actions: ['browse_fyp', 'like_3', 'follow_1'], maxActions: 5, maxSessionMin: 10, sessionsPerDay: 2 },
      { day: '3-4', actions: ['browse_fyp', 'like_5', 'follow_2', 'comment_1', 'search_1'], maxActions: 12, maxSessionMin: 15, sessionsPerDay: 3 },
      { day: '5-6', actions: ['browse_fyp', 'like_10', 'follow_5', 'comment_2', 'search_2', 'share_1', 'watch_full_3'], maxActions: 25, maxSessionMin: 25, sessionsPerDay: 4 },
      { day: '7', actions: ['browse_fyp', 'like_15', 'follow_8', 'comment_3', 'search_3', 'share_2', 'watch_full_5', 'post_1'], maxActions: 40, maxSessionMin: 35, sessionsPerDay: 5 },
    ],
    antiPatterns: ['no_rapid_scroll', 'no_batch_follow', 'vary_watch_duration', 'human_typing_speed'],
    riskFactors: { rapidFollow: 15, massLike: 12, newDeviceLogin: 8, proxySwitch: 20 },
  },
  instagram: {
    name: 'Instagram',
    warmingDurationDays: 10,
    phases: [
      { day: '1-3', actions: ['browse_feed', 'like_2', 'scroll_stories'], maxActions: 5, maxSessionMin: 10, sessionsPerDay: 2 },
      { day: '4-5', actions: ['browse_feed', 'like_4', 'follow_1', 'scroll_stories'], maxActions: 10, maxSessionMin: 15, sessionsPerDay: 3 },
      { day: '6-7', actions: ['browse_feed', 'like_6', 'follow_2', 'comment_1', 'scroll_reels', 'save_1'], maxActions: 18, maxSessionMin: 20, sessionsPerDay: 4 },
      { day: '8-10', actions: ['browse_feed', 'like_10', 'follow_4', 'comment_2', 'scroll_reels', 'save_2', 'story_view_5', 'post_1'], maxActions: 30, maxSessionMin: 30, sessionsPerDay: 5 },
    ],
    antiPatterns: ['no_auto_dm', 'no_mass_story_view', 'diverse_hashtag_browse', 'random_engagement'],
    riskFactors: { rapidFollow: 18, massLike: 15, newDeviceLogin: 10, proxySwitch: 25, dmSpam: 40 },
  },
  facebook: {
    name: 'Facebook',
    warmingDurationDays: 14,
    phases: [
      { day: '1-4', actions: ['browse_feed', 'like_1', 'add_friend_1'], maxActions: 3, maxSessionMin: 8, sessionsPerDay: 2 },
      { day: '5-7', actions: ['browse_feed', 'like_3', 'add_friend_2', 'join_group_1'], maxActions: 8, maxSessionMin: 12, sessionsPerDay: 3 },
      { day: '8-10', actions: ['browse_feed', 'like_5', 'add_friend_3', 'join_group_1', 'comment_1'], maxActions: 15, maxSessionMin: 18, sessionsPerDay: 4 },
      { day: '11-14', actions: ['browse_feed', 'like_8', 'add_friend_5', 'join_group_2', 'comment_2', 'share_1', 'post_1'], maxActions: 25, maxSessionMin: 25, sessionsPerDay: 5 },
    ],
    antiPatterns: ['no_rapid_friend_add', 'real_name_profile', 'photo_upload_gradual', 'group_engagement_diverse'],
    riskFactors: { rapidFriendAdd: 25, massGroupJoin: 20, incompleteProfile: 15, proxySwitch: 22 },
  },
  twitter: {
    name: 'Twitter/X',
    warmingDurationDays: 5,
    phases: [
      { day: '1', actions: ['browse_timeline', 'like_2', 'follow_1'], maxActions: 5, maxSessionMin: 8, sessionsPerDay: 2 },
      { day: '2-3', actions: ['browse_timeline', 'like_5', 'follow_3', 'retweet_1'], maxActions: 15, maxSessionMin: 15, sessionsPerDay: 3 },
      { day: '4-5', actions: ['browse_timeline', 'like_10', 'follow_5', 'retweet_2', 'reply_1', 'post_1'], maxActions: 25, maxSessionMin: 20, sessionsPerDay: 4 },
    ],
    antiPatterns: ['no_batch_retweet', 'diverse_topic_engage', 'vary_reply_length'],
    riskFactors: { rapidFollow: 10, massRetweet: 12, newDeviceLogin: 6, proxySwitch: 18 },
  },
  youtube: {
    name: 'YouTube',
    warmingDurationDays: 8,
    phases: [
      { day: '1-2', actions: ['browse_home', 'watch_2min', 'like_1'], maxActions: 4, maxSessionMin: 10, sessionsPerDay: 2 },
      { day: '3-4', actions: ['browse_home', 'watch_5min', 'like_2', 'search_1', 'subscribe_1'], maxActions: 8, maxSessionMin: 15, sessionsPerDay: 3 },
      { day: '5-6', actions: ['browse_home', 'watch_10min', 'like_4', 'search_2', 'subscribe_2', 'comment_1'], maxActions: 15, maxSessionMin: 25, sessionsPerDay: 4 },
      { day: '7-8', actions: ['browse_home', 'watch_15min', 'like_6', 'search_3', 'subscribe_3', 'comment_2', 'share_1'], maxActions: 22, maxSessionMin: 35, sessionsPerDay: 5 },
    ],
    antiPatterns: ['no_skip_watch', 'vary_watch_percent', 'diverse_content_type'],
    riskFactors: { rapidSub: 10, noWatchSub: 20, commentSpam: 15, proxySwitch: 15 },
  },
  reddit: {
    name: 'Reddit',
    warmingDurationDays: 14,
    phases: [
      { day: '1-3', actions: ['browse_feed', 'upvote_1', 'read_comments'], maxActions: 4, maxSessionMin: 10, sessionsPerDay: 2 },
      { day: '4-7', actions: ['browse_feed', 'upvote_2', 'comment_1', 'join_sub_1'], maxActions: 10, maxSessionMin: 15, sessionsPerDay: 3 },
      { day: '8-10', actions: ['browse_feed', 'upvote_3', 'comment_2', 'join_sub_2', 'save_1'], maxActions: 18, maxSessionMin: 25, sessionsPerDay: 4 },
      { day: '11-14', actions: ['browse_feed', 'upvote_5', 'comment_3', 'join_sub_2', 'post_1', 'award_1'], maxActions: 28, maxSessionMin: 35, sessionsPerDay: 5 },
    ],
    antiPatterns: ['no_karma_farming', 'no_self_promo', 'diverse_subreddits', 'human_comment_length'],
    riskFactors: { karmaFarming: 30, selfPromotion: 40, rapidComment: 15, proxySwitch: 20 },
  },
  discord: {
    name: 'Discord',
    warmingDurationDays: 7,
    phases: [
      { day: '1-2', actions: ['browse_channels', 'react_1', 'read_pins'], maxActions: 5, maxSessionMin: 8, sessionsPerDay: 2 },
      { day: '3-4', actions: ['browse_channels', 'react_2', 'reply_1', 'join_server_1'], maxActions: 12, maxSessionMin: 15, sessionsPerDay: 3 },
      { day: '5-6', actions: ['browse_channels', 'react_3', 'reply_2', 'join_server_1', 'share_media_1'], maxActions: 22, maxSessionMin: 25, sessionsPerDay: 4 },
      { day: '7', actions: ['browse_channels', 'react_4', 'reply_3', 'join_server_2', 'share_media_1', 'start_thread_1'], maxActions: 32, maxSessionMin: 35, sessionsPerDay: 5 },
    ],
    antiPatterns: ['no_mass_mention', 'no_invite_spam', 'organic_engagement', 'slow_mode_respect'],
    riskFactors: { massMention: 35, inviteSpam: 40, rapidReply: 15, proxySwitch: 18 },
  },
  tumblr: {
    name: 'Tumblr',
    warmingDurationDays: 10,
    phases: [
      { day: '1-3', actions: ['browse_dashboard', 'like_2', 'reblog_1'], maxActions: 6, maxSessionMin: 10, sessionsPerDay: 2 },
      { day: '4-6', actions: ['browse_dashboard', 'like_4', 'reblog_2', 'comment_1', 'follow_1'], maxActions: 14, maxSessionMin: 18, sessionsPerDay: 3 },
      { day: '7-8', actions: ['browse_dashboard', 'like_6', 'reblog_3', 'comment_2', 'follow_2', 'tag_browse_1'], maxActions: 22, maxSessionMin: 25, sessionsPerDay: 4 },
      { day: '9-10', actions: ['browse_dashboard', 'like_8', 'reblog_4', 'comment_3', 'follow_3', 'tag_browse_2', 'post_1'], maxActions: 32, maxSessionMin: 35, sessionsPerDay: 5 },
    ],
    antiPatterns: ['no_mass_reblog', 'diverse_tags', 'organic_follow', 'original_content_mix'],
    riskFactors: { massReblog: 20, tagSpam: 18, rapidFollow: 15, proxySwitch: 18 },
  },
};

// ── 高斯分布延迟生成器 ───────────────────────────
 gaussianDelay(meanMs, stdDevMs) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.max(100, Math.round(meanMs + z * stdDevMs));
}

// ── 行为模拟器 ───────────────────────────────────
class BehaviorSimulator {
  // 阅读/浏览延迟
  static browseDelay() { return gaussianDelay(3000, 1500); }
  // 点赞延迟
  static likeDelay() { return gaussianDelay(1500, 800); }
  // 关注延迟
  static followDelay() { return gaussianDelay(4000, 2000); }
  // 评论延迟（打字模拟）
  static commentDelay(textLength) { return gaussianDelay(textLength * 200 + 2000, 1000); }
  // 滚动间隔
  static scrollDelay() { return gaussianDelay(5000, 3000); }
  // 会话时长
  static sessionDuration(minMinutes, maxMinutes) {
    return gaussianDelay((minMinutes + maxMinutes) / 2 * 60000, (maxMinutes - minMinutes) / 3 * 60000);
  }
  // 每日首次打开延迟（模拟起床时间）
  static dayStartDelay() { return gaussianDelay(9 * 3600000, 2 * 3600000); } // 9AM ± 2h
}

// ── Ban-Risk评分引擎 ─────────────────────────────
class BanRiskEngine {
  constructor() {
    this.riskHistory = new Map();
  }

  assess(account, event) {
    const  = PlatformStrategies[account.];
    if (!) return { score: 0, level: 'LOW', factors: [] };

    let score = 0;
    const factors = [];

    if (.riskFactors) {
      for (const [factor, weight] of Object.entries(.riskFactors)) {
        if (event?.type === factor) {
          score += weight;
          factors.push({ factor, weight, event: event.detail });
        }
      }
    }

    // 累积风险评估
    const history = this.riskHistory.get(account.id) || [];
    const recentRisks = history.filter(h => Date.now() - h.time < 86400000); // 24h
    const cumulativeScore = recentRisks.reduce((s, h) => s + h.score, 0);
    score = Math.min(100, score + cumulativeScore * 0.05);

    // 记录
    history.push({ time: Date.now(), score, factors });
    if (history.length > 100) history.shift();
    this.riskHistory.set(account.id, history);

    // 风险等级
    let level = 'LOW';
    if (score >= 80) level = 'CRITICAL';
    else if (score >= 60) level = 'HIGH';
    else if (score >= 35) level = 'MEDIUM';

    return { score, level, cumulative: cumulativeScore, factors, recommendations: this.getRecommendations(level, factors) };
  }

  getRecommendations(level, factors) {
    const recs = [];
    if (level === 'CRITICAL') {
      recs.push('IMMEDIATE_PAUSE: 暂停所有自动化操作24小时');
      recs.push('MANUAL_REVIEW: 人工检查账号状态');
    } else if (level === 'HIGH') {
      recs.push('REDUCE_ACTIONS: 降低50%操作频率');
      recs.push('INCREASE_DELAYS: 增加操作间隔');
    } else if (level === 'MEDIUM') {
      recs.push('MONITOR_CLOSE: 密切关注操作频率');
    }
    return recs;
  }

  getAccountRisk(accountId) {
    const history = this.riskHistory.get(accountId) || [];
    const recent = history.filter(h => Date.now() - h.time < 86400000);
    if (recent.length === 0) return { score: 0, level: 'LOW' };
    const avg = recent.reduce((s, h) => s + h.score, 0) / recent.length;
    const level = avg >= 80 ? 'CRITICAL' : avg >= 60 ? 'HIGH' : avg >= 35 ? 'MEDIUM' : 'LOW';
    return { score: Math.round(avg), level, events24h: recent.length };
  }
}

// ── 养号策略引擎 ─────────────────────────────────
class NurturingEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.db = opts.db || null;
    // 真实养号进度来源（tumblr_nurture，属主 3005）。没有它就无法判定成熟 ——
    // 宁可停在 S0/S1，也不用计时器编造成熟。
    this.dataStore = opts.dataStore || null;
    this.riskEngine = new BanRiskEngine();
    this.behaviorSim = BehaviorSimulator;
    this. = new Map();
    // 本进程启动后「已首次评估」的账号：用于区分
    //   ① 启动时就已成熟（只回填标记，绝不补发 account.healthy）
    //   ② 本次运行期间新达成成熟（发一次事件，推进因果链）
    this._bootEvaluated = new Set();
    this._lastCycleEvidence = { realRecords: 0, mature: 0, emitted: 0, noEvidence: 0, simulatedSkipped: 0 };
  }

  // 创建账号
  createAccount(, , deviceId, proxyId) {
    const  = PlatformStrategies[];
    if (!) throw new Error(`Unknown : `);

    const account = {
      id: `acct_${Date.now()}_${crypto.randomBytes(4'hex')}`,
      ,
      ,
      deviceId,
      proxyId,
      tier: 'T0_NEW',
      state: AccountState.,
      : 0,
      : 0,
      : 0,
      totalActions: 0,
      dailyActions: {},
      createdAt: new Date().toISOString(),
      warmingStart: null,
      graduatedAt: null,
      lastActiveAt: null,
      metadata: {},
      stats: {
        followers: 0,
        following: 0,
        posts: 0,
        likes: 0,
        comments: 0,
      },
    };

    this..set(account.id, account);
    this.emit('account:created', account);
    return account;
  }

  // 从注册事件/外部系统添加已有账号
  addAccount(data) {
    const  = data. || 'tiktok';
    // 兼容 value=x（AIGC 使用 x）映射到 twitter
    const mappedPlatform =  === 'x' ? 'twitter' : ;
    const  = data. || data.email || data.bot_id || `user_${Date.now()}`;

    // 如果提供了 id 且已存在则更新
    const existingId = data.id || data.account_id || data.bot_id;
    if (existingId && this..has(existingId)) {
      const existing = this..get(existingId);
      Object.assign(existing, {
        : data. || data.device_id || existing.,
        email: data.email || existing.email,
        phone: data.phone || existing.phone,
        proxyId: data. || data.proxyId || existing.proxyId,
        metadata: { ...existing.metadata, ...data },
      });
      this.emit('account:updated', existing);
      return existing;
    }

    const account = {
      id: existingId || `acct_${Date.now()}_${crypto.randomBytes(4'hex')}`,
      bot_id: data.bot_id || data.account_id || existingId,
      : mappedPlatform,
      ,
      email: data.email || null,
      phone: data.phone || null,
      // 模拟账号标记：缓存层拦截，不参与养号计数、不发射因果事件
      _simulated: isSimulatedSeed(data),
      deviceId: data. || data.device_id || data.deviceId || null,
      proxyId: data. || data.proxyId || null,
      tier: 'T0_NEW',
      state: AccountState.,
      : data. || data.score || 0,
      : data. || 0,
      : 0,
      totalActions: 0,
      dailyActions: {},
      createdAt: data. || new Date().toISOString(),
      warmingStart: null,
      graduatedAt: null,
      lastActiveAt: null,
      metadata: { ...data },
      stats: {
        followers: data.follower_count || 0,
        following: data.following_count || 0,
        posts: data.post_count || 0,
        likes: 0,
        comments: 0,
      },
    };

    this..set(account.id, account);
    this.emit('account:added', account);
    return account;
  }

  // 开始预热
  startWarming(accountId) {
    const account = this..get(accountId);
    if (!account) throw new Error('Account not found');

    account.state = AccountState.;
    account.warmingStart = new Date().toISOString();
    account. = 0;
    this.emit('account:warming_started', account);
    return account;
  }

  // 获取今日任务计划
  getDailyPlan(account) {
    const  = PlatformStrategies[account.];
    if (!) return null;

    // 计算预热天数
    if (account.state === AccountState.) {
      const daysSinceStart = Math.floor((Date.now() - new Date(account.warmingStart).getTime()) / 86400000) + 1;
      account. = daysSinceStart;

      // 匹配当前阶段的策略
      let currentPhase = null;
      for (const phase of .phases) {
        const [start, end] = phase.day.split('-').map(Number);
        if (daysSinceStart >= start && daysSinceStart <= end) {
          currentPhase = phase;
          break;
        }
      }
      // 超过预热期
      if (!currentPhase && daysSinceStart > parseInt(.phases[.phases.length - 1].day.split('-')[1])) {
        account.state = AccountState.S2_NURTURING;
        account.graduatedAt = new Date().toISOString();
        this.emit('account:warming_complete', account);
        return this.getDailyPlan(account);
      }

      if (!currentPhase) currentPhase = .phases[0];

      // 检查今日是否已超过配额
      const today = new Date().toISOString().slice(0, 10);
      const todayActions = (account.dailyActions[today] || 0);
      if (todayActions >= currentPhase.maxActions) {
        return { status: 'quota_exceeded', todayActions, maxActions: currentPhase.maxActions, account };
      }

      return {
        status: 'warming',
        : daysSinceStart,
        phase: currentPhase,
        maxActions: currentPhase.maxActions,
        remainingActions: currentPhase.maxActions - todayActions,
        todayActions,
        sessionMinutes: currentPhase.maxSessionMin,
        sessionsPerDay: currentPhase.sessionsPerDay,
        suggestedActions: this._shuffleActions(currentPhase.actions),
        account,
      };
    }

    // 养成期之后：基于层级的配额
    const tier = AccountTier[account.tier];
    const today = new Date().toISOString().slice(0, 10);
    const todayActions = (account.dailyActions[today] || 0);

    if (todayActions >= tier.dailyActionsMax) {
      return { status: 'quota_exceeded', todayActions, maxActions: tier.dailyActionsMax, account };
    }

    return {
      status: 'active',
      tier: account.tier,
      tierName: tier.name,
      maxActions: tier.dailyActionsMax,
      remainingActions: tier.dailyActionsMax - todayActions,
      followLimit: tier.followLimit,
      contentLimit: tier.contentLimit,
      account,
    };
  }

  // 执行一个行为
  async performAction(accountId, actionType) {
    const account = this..get(accountId);
    if (!account) throw new Error('Account not found');

    const today = new Date().toISOString().slice(0, 10);
    const plan = this.getDailyPlan(account);

    if (!plan || plan.status === 'quota_exceeded') {
      this.emit('action:blocked', { account, reason: 'quota_exceeded' });
      return { allowed: false, reason: 'quota_exceeded' };
    }

    // 风险检查
    const risk = this.riskEngine.assess(account, { type: actionType, detail: 'action_performed' });
    if (risk.level === 'CRITICAL') {
      this.emit('action:blocked', { account, reason: 'risk_critical', risk });
      return { allowed: false, reason: 'risk_critical', risk };
    }

    // 计算延迟
    const delay = this._getActionDelay(actionType);

    // 更新计数
    account.dailyActions[today] = (account.dailyActions[today] || 0) + 1;
    account.totalActions++;
    account.lastActiveAt = new Date().toISOString();

    // 健康分数增量
    account. = Math.min(100, account. + 0.1);

    // 自动层级升级检查
    this._checkTierUpgrade(account);

    this.emit('action:performed', { account, actionType, delay, : account. });
    return { allowed: true, delay, actionType, : account. };
  }

  // 检查并升级账号层级
  _checkTierUpgrade(account) {
    const tiers = ['T0_NEW', 'T1_BEGINNER', 'T2_GROWING', 'T3_ACTIVE', 'T4_POWER', 'T5_ELITE', 'T6_LEGEND'];
    const currentIdx = tiers.indexOf(account.tier);

    if (currentIdx < tiers.length - 1) {
      const nextTier = AccountTier[tiers[currentIdx + 1]];
      if (account. >= nextTier.minScore) {
        const oldTier = account.tier;
        account.tier = tiers[currentIdx + 1];
        this.emit('account:tier_upgraded', { account, from: oldTier, to: account.tier });
      }
    }
  }

  // 暂停账号
  pauseAccount(accountId) {
    const account = this..get(accountId);
    if (!account) throw new Error('Account not found');
    account.state = AccountState.S6_FROZEN;
    this.emit('account:paused', account);
    return account;
  }

  // 恢复账号
  resumeAccount(accountId) {
    const account = this..get(accountId);
    if (!account) throw new Error('Account not found');
    account.state = AccountState.;
    account.warmingStart = new Date().toISOString();
    account. = 0;
    this.emit('account:resumed', account);
    return account;
  }

  // 批量开始预热所有  账号
  // 【2026-09-12】不再伪造健康分（旧实现把  抬到 30），真实状态与分数
  //   一律由 _doCycle() 从 3005 落库的 tumblr_nurture 反算；没有真实动作记录的账号
  //   会在下一个周期被退回 S0。这里只做"进入观察名单"的标记。
  startAllWarming() {
    let count = 0;
    for (const account of this..values()) {
      if (account._simulated) continue;   // 模拟账号不养（不计入容量、不发事件）
      if (account.state === AccountState.) {
        if (!account.warmingStart) account.warmingStart = new Date().toISOString();
        count++;
      }
    }
    if (count > 0) {
      console.log(`[nurturing] ${count} 个账号进入观察名单（真实等级由 tumblr_nurture 证据反算）`);
      this.emit('batch:warming_started', { count });
    }
    return count;
  }

  // 启动养号自动循环（每10秒执行一次 — 快速模式）
  startCycle(eventBus) {
    if (this._cycleTimer) return;
    this._eventBus = eventBus || null;
    this._cycleCount = 0;
    
    // 立即执行一次
    this._doCycle();
    
    // 每 10 秒重算一次「真实等级」。
    // 【2026-09-12】注意：周期**不再等于**成熟速度 —— 等级完全由 3005 的真实动作证据决定，
    //   10s 只是刷新频率（旧实现是 +1/10s，导致任何账号 7.5 分钟假成熟）。
    this._cycleTimer = setInterval(() => this._doCycle(), 10000);
    console.log('[nurturing] Auto-cycle started (每 10s 依据真实证据重算等级，非计时成熟)');
  }

  // 停止循环
  stopCycle() {
    if (this._cycleTimer) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = null;
      console.log('[nurturing] Auto-cycle stopped');
    }
  }

  // 单次循环逻辑
  _doCycle() {
    try {
    this._cycleCount++;
    const th = maturityThresholds();
    const realMap = this._loadRealProgress();     // 3005 落库的真实养号进度（唯一证据源）
    const marks = this._loadMaturityMarks();      // 已发过 account.healthy 的账号标记
    const existedMarkIds = new Set(marks.keys());
    const dirtyMarkIds = new Set();
    let maturedNow = 0, emitted = 0, noEvidence = 0, simulatedSkipped = 0, realCount = 0;

    for (const account of this..values()) {
      // 跳过冻结账号
      if (account.state === AccountState.S6_FROZEN) continue;
      // 跳过模拟账号（2026-09-12）：不给它们"长大"，也不替它们发射 account.healthy
      if (account._simulated) { simulatedSkipped++; continue; }

      const rec = realMap.get(String(account.id)) || realMap.get(String(account.bot_id)) || null;
      // 首次评估 = 本进程第一次看到这个账号。若首次评估时它就已成熟，那属于「启动回填」，
      // 只落标记不发事件；只有"被观察期间状态发生变化"才是真正的成熟达成。
      const isFirstEval = !this._bootEvaluated.has(account.id);
      this._bootEvaluated.add(account.id);

      // 没有任何真实养号记录 → 停在 S0：不升级、不发事件。
      // （旧实现在这里用 +=1 把账号"养大"，假号也能 7.5 分钟到 S3）
      if (!rec) {
        noEvidence++;
        account.state = AccountState.;
        account. = 0;
        account. = 0;
        continue;
      }
      realCount++;

      const { state, score, evidence } = this._deriveFromReal(rec);
      account.state = state;
      account. = score;
      account. = evidence.day;
      account.totalActions = evidence.totalActions;
      account.nurturePhase = rec.phase || null;
      account.realEvidence = evidence;
      account.lastActiveAt = rec.lastActionAt || account.lastActiveAt;
      if (state === AccountState.S3_MATURE) {
        maturedNow++;
        if (!account.graduatedAt) account.graduatedAt = rec.startedAt || new Date().toISOString();
      }
      this._checkTierUpgrade(account);

      // ── 成熟事件：只发「被观察期间新达成」的，且每账号只发一次、每周期有上限 ──
      //   ① 首次评估时就已成熟 → 只回填标记，绝不补发
      //      （否则每次重启都会给全部成熟账号补一轮假事件 → 每轮白生成上百条内容）
      //   ② 观察期间新达成 → 发一次 account.healthy 推进因果链，并落标记防重复
      if (state === AccountState.S3_MATURE) {
        const key = String(account.id);
        const mark = marks.get(key);
        if (isFirstEval) {
          if (!mark || !mark.matureSince) {
            marks.set(key, { matureSince: new Date().toISOString(), emitted: true, bootBackfill: true, evidence });
            dirtyMarkIds.add(key);
          }
        } else if (!mark || mark.emitted !== true) {
          if (emitted < th.maxHealthyPerCycle) {
            if (this._emitHealthy(account, evidence)) {
              emitted++;
              marks.set(key, {
                matureSince: (mark && mark.matureSince) || new Date().toISOString(),
                emitted: true,
                emittedAt: new Date().toISOString(),
                evidence,
              });
              dirtyMarkIds.add(key);
            }
          }
        }
      }
    }

    if (dirtyMarkIds.size) {
      this._persistMaturityMarks(marks, existedMarkIds, dirtyMarkIds);
    }

    // 每周期打印状态（即使无变更也打印前几次）—— 只统计真实账号（模拟号不计入）
    //   "有证据" = 本周期在 tumblr_nurture 里找到真实动作记录并据此定级的账号数
    //   "无证据" = 账号库里有、但养号服务还没有任何动作记录的账号（停在 S0）
    this._lastCycleEvidence = { realRecords: realCount, mature: maturedNow, emitted, noEvidence, simulatedSkipped };
    const realArr = Array.from(this..values()).filter(a => !a._simulated);
    const s0 = realArr.filter(a => a.state === '';
    const s1 = realArr.filter(a => a.state === '';
    const s2 = realArr.filter(a => a.state === 'S2_NURTURING';
    const s3 = realArr.filter(a => a.state === 'S3_MATURE';
    const avgScore = realArr.reduce((s, a) => s + (a. || 0), 0) / Math.max(1, realArr.length);

    if (emitted > 0 || this._cycleCount <= 5 || this._cycleCount % 5 === 0) {
      console.log(`[nurturing] Cycle #${this._cycleCount}: 真实=${realArr.length} S0=${s0} S1=${s1} S2=${s2} S3=${s3} avgScore=${avgScore.toFixed(1)} 有证据=${realCount} 无证据=${noEvidence} 新发健康事件=${emitted} 模拟跳过=${simulatedSkipped}`);
    }
    // 每 30 个周期（5分钟）输出心跳，证明循环仍在运行
    if (this._cycleCount % 30 === 0) {
      console.log(`[nurturing] ❤️ Heartbeat #${this._cycleCount}: ${this..size}  alive, timer OK`);
    }
    } catch (cycleErr) {
      console.error(`[nurturing] _doCycle crash (cycle will retry): ${cycleErr.message}`);
      if (cycleErr.stack) console.error(`[nurturing] Stack: ${cycleErr.stack.split('\n').slice(0,3).join(' | ')}`);
    }
  }

  // ── 真实证据读取 / 折算（2026-09-12 成熟判定治本）──────────────
  /**
   * 读取 3005 养号服务落库的真实进度。读不到就返回空 Map —— 宁可不升级，也不编造。
   */
  _loadRealProgress() {
    const map = new Map();
    if (!this.dataStore || typeof this.dataStore.list !== '') return map;
    try {
      const res = this.dataStore.list('tumblr_nurture', { limit: 5000 });
      const items = Array.isArray(res) ? res : (res && res.items) || [];
      for (const it of items) {
        if (it && it.id !== undefined && it.id !== null) map.set(String(it.id), it);
      }
    } catch (e) {
      console.warn(`[nurturing] 读取 tumblr_nurture 失败（本轮不做成熟判定）: ${e.message}`);
    }
    return map;
  }

  /**
   * 把一条真实养号记录折算成「账号状态 + 健康分 + 证据」。
   * 证据 = daily 逐日动作聚合（3005 每做一次真实 API 动作就 +1）+ totalActions + 是否持有 token。
   */
  _deriveFromReal(rec) {
    const th = maturityThresholds();
    const daily = (rec && rec.daily) || {};
    let posts = 0, likes = 0, follows = 0, reblogs = 0;
    for (const day of Object.keys(daily)) {
      const d = daily[day] || {};
      posts += Number(d.post || 0);
      likes += Number(d.like || 0);
      follows += Number(d.follow || 0);
      reblogs += Number(d.reblog || 0);
    }
    const activeDays = Object.keys(daily;
    const totalActions = Math.max(Number(rec.totalActions || 0), posts + likes + follows + reblogs);
    const day = Number(rec.day || 0);
    const hasToken = !rec.noToken;   // 无 token = 发不出任何东西，不具备成熟资格

    const qualifying = hasToken
      && activeDays >= th.minDays
      && posts >= th.minPosts
      && likes >= th.minLikes
      && totalActions >= th.minActions;

    // 健康分由真实证据反算（0~100）。旧实现是 `+1/10s`，与真实行为零关联。
    const score = Math.max(0, Math.min(100, Math.round(
      Math.min(1, activeDays / 14) * 35 +
      Math.min(1, posts / 12) * 25 +
      Math.min(1, likes / 120) * 25 +
      Math.min(1, totalActions / 300) * 15
    )));

    let state = AccountState.;
    if (qualifying) state = AccountState.S3_MATURE;
    else if (activeDays >= th.nurtureDays && totalActions > 0) state = AccountState.S2_NURTURING;
    else if (activeDays >= 1 || totalActions > 0) state = AccountState.;

    return {
      state,
      score,
      evidence: { activeDays, posts, likes, follows, reblogs, totalActions, day, hasToken, qualifying },
    };
  }

  /** 发一次 account.healthy（推进因果链）。返回是否真的发出。 */
  _emitHealthy(account, evidence) {
    if (!this._eventBus) return false;
    try {
      const  = account. === 'twitter' ? 'x' : account.;
      this._eventBus.emit('account.healthy', {
        account_id: account.bot_id || account.id,
        bot_id: account.bot_id,
        ,
        : account.,
        score: Math.round(account.),
        account_age: account. || 7,
        : account. || 7,
        evidence,
      }, 'nurturing-cycle');
      this.emit('account:matured', account);
      console.log(`[nurturing] 🩺 account.healthy 首次发射: ${account.id} (score=${Math.round(account.)}, 活跃${evidence.activeDays}天/发帖${evidence.posts}/点赞${evidence.likes})`);
      return true;
    } catch (e) {
      console.warn(`[nurturing] account.healthy 发射失败: ${e.message}`);
      return false;
    }
  }

  /** 读取「已发过成熟事件」的账号标记（account_maturity 模块，属主 = 3002） */
  _loadMaturityMarks() {
    const m = new Map();
    if (!this.dataStore || typeof this.dataStore.list !== '') return m;
    try {
      const res = this.dataStore.list('account_maturity', { limit: 5000 });
      const items = Array.isArray(res) ? res : (res && res.items) || [];
      for (const it of items) {
        if (it && it.id !== undefined && it.id !== null) m.set(String(it.id), it);
      }
    } catch (_) { /* 模块首次运行尚不存在，属正常 */ }
    return m;
  }

  /** 落盘成熟标记（仅写本周期变化的账号） */
  _persistMaturityMarks(marks, existedIds, dirtyIds) {
    if (!this.dataStore || typeof this.dataStore.create !== '') return;
    for (const id of dirtyIds) {
      const mark = marks.get(id);
      if (!mark) continue;
      try {
        if (existedIds.has(id)) this.dataStore.update('account_maturity', id, mark);
        else this.dataStore.create('account_maturity', Object.assign({ id }, mark));
      } catch (e) {
        console.warn(`[nurturing] 成熟标记写入失败 ${id}: ${e.message}`);
      }
    }
  }

  // 获取所有账号状态
  // 【2026-09-12】total 只计真实账号 —— 控制台「🌱 养号账号」曾把 147 个 MySQL 测试
  //   残留（临时邮箱、无 token）算进去，虚高到 197。模拟账号数量单独放在 simulated 字段。
  getStats() {
    const all = Array.from(this..values());
    const  = all.filter(a => !a._simulated);
    const simulated = all.length - .length;
    const byState = {};
    const byPlatform = {};
    const byTier = {};

    for (const a of ) {
      byState[a.state] = (byState[a.state] || 0) + 1;
      byPlatform[a.] = (byPlatform[a.] || 0) + 1;
      byTier[a.tier] = (byTier[a.tier] || 0) + 1;
    }

    return {
      total: .length,
      simulated,
      byState,
      byPlatform,
      byTier,
      avgHealthScore: .reduce((s, a) => s + a., 0) / Math.max(1, .length),
      riskyAccounts: .filter(a => this.riskEngine.getAccountRisk(a.id).level === 'HIGH' || this.riskEngine.getAccountRisk(a.id).level === 'CRITICAL',
      // 证据口径（2026-09-12）：健康分/成熟度来自 3005 tumblr_nurture 的真实动作记录，
      // 而非计时器。无证据账号停在 S0，不占成熟容量、不发健康事件。
      evidence: this._lastCycleEvidence || null,
    };
  }

  // ── 内部 ─────────────────────────────────────
  _getActionDelay(actionType) {
    const delays = {
      browse: gaussianDelay(5000, 3000),
      like: gaussianDelay(2000, 1000),
      follow: gaussianDelay(5000, 2500),
      comment: gaussianDelay(8000, 4000),
      share: gaussianDelay(3000, 1500),
      search: gaussianDelay(4000, 2000),
      scroll: gaussianDelay(3000, 2000),
      post: gaussianDelay(15000, 5000),
      watch: gaussianDelay(30000, 15000),
      subscribe: gaussianDelay(4000, 2000),
      retweet: gaussianDelay(3000, 1500),
      reply: gaussianDelay(8000, 4000),
    };
    return delays[actionType] || gaussianDelay(3000, 1500);
  }

  _shuffleActions(actions) {
    const arr = [...actions];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: Bezier 触控轨迹生成器
// ══════════════════════════════════════════════════════
class BezierTouchGenerator {
  /**
   * 生成三次贝塞尔曲线触控轨迹
   * @param {Object} from - {x, y} 起点
   * @param {Object} to - {x, y} 终点
   * @param {number} durationMs - 总时长
   * @param {number} steps - 采样点数
   */
  static generateSwipe(from, to, durationMs = 500, steps = 50) {
    // 自动计算控制点（引入曲率）
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const cp1 = {
      x: from.x + dx * 0.25 + (Math.random() - 0.5) * 30,
      y: from.y + dy * 0.1 + (Math.random() - 0.5) * 20,
    };
    const cp2 = {
      x: from.x + dx * 0.75 + (Math.random() - 0.5) * 30,
      y: from.y + dy * 0.9 + (Math.random() - 0.5) * 20,
    };

    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u*u*u * from.x + 3*u*u*t * cp1.x + 3*u*t*t * cp2.x + t*t*t * to.x;
      const y = u*u*u * from.y + 3*u*u*t * cp1.y + 3*u*t*t * cp2.y + t*t*t * to.y;
      // 添加微小的自然抖动
      const jitterX = (Math.random() - 0.5) * 2;
      const jitterY = (Math.random() - 0.5) * 2;
      points.push({
        x: Math.round(x + jitterX),
        y: Math.round(y + jitterY),
        t: i * (durationMs / steps),
        pressure: 0.6 + Math.random() * 0.4,
      });
    }
    return points;
  }

  /**
   * 生成点击轨迹（按压→停留→释放）
   */
  static generateTap(x, y, durationMs = 200) {
    const points = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const jitter = t < 0.2 ? 0.5 : (t > 0.8 ? 0.5 : 0.1);
      points.push({
        x: Math.round(x + (Math.random() - 0.5) * jitter),
        y: Math.round(y + (Math.random() - 0.5) * jitter),
        t: i * (durationMs / 10),
        pressure: t < 0.1 ? 0.2 + t * 8 : (t > 0.8 ? 0.8 - (t - 0.8) * 4 : 0.8),
      });
    }
    return points;
  }

  /**
   * 生成滚动轨迹（线性+减速曲线）
   */
  static generateScroll(fromY, toY, viewportWidth = 360, viewportHeight = 800, durationMs = 800) {
    const from = { x: viewportWidth / 2 + (Math.random() - 0.5) * 40, y: fromY };
    const to = { x: viewportWidth / 2 + (Math.random() - 0.5) * 60, y: toY };

    const steps = Math.round(durationMs / 16); // ~60fps
    const points = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // 带减速的缓动函数
      const easeOut = 1 - Math.pow(1 - t, 2.5);
      const y = from.y + (to.y - from.y) * easeOut;
      const xDrift = Math.sin(t * Math.PI * 0.5) * (Math.random() - 0.5) * 8;
      points.push({
        x: Math.round(from.x + xDrift),
        y: Math.round(y),
        t: i * (durationMs / steps),
        pressure: 0.5 + Math.random() * 0.3,
      });
    }
    return points;
  }

  /**
   * 打字模拟：每个字符随机间隔
   */
  static typeSequence(text, avgDelayMs = 150) {
    const keys = [];
    let totalTime = 0;
    for (const char of text) {
      // 高斯延迟
      const delay = gaussianDelay(avgDelayMs, avgDelayMs * 0.3);
      totalTime += delay;
      keys.push({ char, delay, time: totalTime });
    }
    return keys;
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: 误触模拟器 (2% 概率)
// ══════════════════════════════════════════════════════
class MistouchSimulator {
  constructor(mistouchRate = 0.02) {
    this.mistouchRate = mistouchRate;
    this.mistouchTypes = ['accidental_tap', 'wrong_swipe', 'double_tap', 'long_press', 'edge_touch'];
    this.stats = { totalActions: 0, mistouches: 0 };
  }

  /**
   * 判断是否应产生误触
   */
  shouldMistouch() {
    this.stats.totalActions++;
    return Math.random() < this.mistouchRate;
  }

  /**
   * 生成随机误触事件
   */
  generateMistouch(screenWidth = 360, screenHeight = 800) {
    this.stats.mistouches++;
    const type = this.mistouchTypes[Math.floor(Math.random() * this.mistouchTypes.length)];

    switch (type) {
      case 'accidental_tap': {
        // 随机位置误点
        const x = Math.random() * screenWidth;
        const y = Math.random() * screenHeight;
        return BezierTouchGenerator.generateTap(x, y, 50 + Math.random() * 100);
      }
      case 'wrong_swipe': {
        // 错误方向的滑动
        const fromX = screenWidth * 0.3 + Math.random() * screenWidth * 0.4;
        const fromY = screenHeight * 0.4 + Math.random() * screenHeight * 0.2;
        const toX = fromX + (Math.random() - 0.5) * screenWidth * 0.3;
        const toY = fromY + (Math.random() - 0.5) * screenHeight * 0.3;
        return BezierTouchGenerator.generateSwipe(
          { x: fromX, y: fromY }, { x: toX, y: toY }, 200 + Math.random() * 400
        );
      }
      case 'double_tap': {
        const x = Math.random() * screenWidth;
        const y = Math.random() * screenHeight;
        return [
          ...BezierTouchGenerator.generateTap(x, y, 100),
          ...BezierTouchGenerator.generateTap(x + (Math.random()-0.5)*5, y + (Math.random()-0.5)*5, 100),
        ];
      }
      case 'long_press': {
        const x = screenWidth * 0.1 + Math.random() * screenWidth * 0.3;
        const y = screenHeight * 0.1 + Math.random() * screenHeight * 0.3;
        return BezierTouchGenerator.generateTap(x, y, 800 + Math.random() * 1200);
      }
      case 'edge_touch': {
        // 屏幕边缘误触
        const edge = Math.random() < 0.5 ? 'left' : 'right';
        const x = edge === 'left' ? Math.random() * 10 : screenWidth - Math.random() * 10;
        const y = Math.random() * screenHeight;
        return BezierTouchGenerator.generateTap(x, y, 80 + Math.random() * 150);
      }
      default:
        return [];
    }
  }

  getStats() {
    return {
      ...this.stats,
      rate: this.stats.totalActions > 0
        ? (this.stats.mistouches / this.stats.totalActions * 100).toFixed(2) + '%'
        : '0%',
    };
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: 疲劳休息管理器 (15分钟累计后强制休息)
// ══════════════════════════════════════════════════════
class FatigueManager {
  constructor(opts = {}) {
    this.activeTimeMs = opts.activeTimeMs || 900000;   // 15分钟累计操作
    this.restTimeMs = opts.restTimeMs || [300000, 900000]; // 5-15分钟随机休息
    this.sessions = new Map(); // deviceId → { cumulativeMs, lastAction, resting, restUntil }
  }

  /**
   * 记录一次操作，返回是否需要休息
   */
  recordAction(deviceId, actionDurationMs = 0) {
    if (!this.sessions.has(deviceId)) {
      this.sessions.set(deviceId, {
        cumulativeMs: 0,
        lastAction: Date.now(),
        resting: false,
        restUntil: null,
        totalActions: 0,
        restCount: 0,
      });
    }

    const session = this.sessions.get(deviceId);
    session.cumulativeMs += actionDurationMs;
    session.lastAction = Date.now();
    session.totalActions++;

    // 检查是否需要休息
    if (session.cumulativeMs >= this.activeTimeMs && !session.resting) {
      return this._triggerRest(deviceId, session);
    }

    return { shouldRest: false };
  }

  _triggerRest(deviceId, session) {
    session.resting = true;
    session.restCount++;
    const restDuration = this.restTimeMs[0] + Math.random() * (this.restTimeMs[1] - this.restTimeMs[0]);
    session.restUntil = Date.now() + restDuration;
    session.cumulativeMs = 0; // 重置累计时间

    return {
      shouldRest: true,
      deviceId,
      restDurationMs: Math.round(restDuration),
      restUntil: new Date(session.restUntil).toISOString(),
      previousCumulativeMs: session.cumulativeMs,
      restCount: session.restCount,
    };
  }

  /**
   * 检查设备是否在休息中
   */
  isResting(deviceId) {
    const session = this.sessions.get(deviceId);
    if (!session || !session.resting) return false;

    // 检查休息时间是否结束
    if (Date.now() >= session.restUntil) {
      session.resting = false;
      session.restUntil = null;
      session.cumulativeMs = 0;
      return false;
    }
    return true;
  }

  /**
   * 获取剩余休息时间（毫秒），0表示不需要休息
   */
  getRemainingRestMs(deviceId) {
    const session = this.sessions.get(deviceId);
    if (!session || !session.resting) return 0;
    const remaining = session.restUntil - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * 强制结束休息
   */
  forceEndRest(deviceId) {
    const session = this.sessions.get(deviceId);
    if (session) {
      session.resting = false;
      session.restUntil = null;
      session.cumulativeMs = 0;
    }
  }

  getStats() {
    const stats = { sessions: 0, resting: 0, totalRestCount: 0 };
    for (const [, session] of this.sessions.values()) {
      stats.sessions++;
      if (this.isResting(session)) stats.resting++;
      stats.totalRestCount += session.restCount;
    }
    return stats;
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: 8类行为池扩展
// ══════════════════════════════════════════════════════
const BEHAVIOR_POOL = {
  browse:       { category: 'browse', actions: ['scroll_feed', 'watch_video', 'view_profile', 'browse_hashtag', 'search_explore'], weight: 0.4 },
  engage:       { category: 'engage', actions: ['like_post', 'like_comment', 'save_content', 'share_content', 'react_story'], weight: 0.25 },
  follow:       { category: 'follow', actions: ['follow_user', 'unfollow_user', 'follow_back', 'subscribe_channel'], weight: 0.1 },
  comment:      { category: 'comment', actions: ['write_comment', 'reply_comment', 'tag_comment', 'emoji_comment'], weight: 0.08 },
  message:      { category: 'message', actions: ['read_dm', 'send_dm', 'react_message'], weight: 0.05 },
  create:       { category: 'create', actions: ['draft_post', 'edit_caption', 'add_hashtags', 'upload_media'], weight: 0.05 },
  setting:      { category: 'setting', actions: ['change_bio', 'update_profile_pic', 'privacy_check'], weight: 0.04 },
  idle:         { category: 'idle', actions: ['passive_scroll', 'watch_ad', 'loading_wait', 'notifications_check'], weight: 0.03 },
};

 sampleBehavior() {
  const total = Object.values(BEHAVIOR_POOL).reduce((s, b) => s + b.weight, 0);
  let rand = Math.random() * total;
  for (const [key, pool] of Object.entries(BEHAVIOR_POOL)) {
    rand -= pool.weight;
    if (rand <= 0) {
      const action = pool.actions[Math.floor(Math.random() * pool.actions.length)];
      return { category: key, action };
    }
  }
  return { category: 'browse', action: 'scroll_feed' };
}

// ── 导出 ─────────────────────────────────────────
module.exports = {
  NurturingEngine,
  BanRiskEngine,
  BehaviorSimulator,
  BezierTouchGenerator,
  MistouchSimulator,
  FatigueManager,
  BEHAVIOR_POOL,
  sampleBehavior,
  AccountState,
  AccountTier,
  PlatformStrategies,
  gaussianDelay,
  maturityThresholds,
  isSimulatedSeed,
};
