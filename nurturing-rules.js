/**
 * nurturing-rules.js — MSCMS v14 海外社媒养号基本规则引擎
 *
 * 基于海外社媒养号全解析指南，定义养号的基本规则和策略：
 *   1. 账号生命周期管理（注册→预热→养成→成熟→巅峰→衰退→冻结）
 *   2. 各平台精细化养号时间表（Reddit/X/Instagram/TikTok/Facebook/YouTube/Discord）
 *   3. 每日操作配额与频率限制
 *   4. 行为模拟规则（模拟正常用户行为）
 *   5. 防封号策略（IP隔离、设备隔离、防关联）
 *   6. 内容发布节奏控制
 *   7. 互动策略与增长规则
 *   8. Ban-Risk 动态评分
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 养号阶段定义 ─────────────────────────────────────
const NurturingPhase = {
  PHASE_0_REGISTER: {
    name: '注册期',
    dayRange: 'day 0',
    rules: {
      completeProfile: true,        // 完善个人资料
      uploadAvatar: true,            // 上传高质量真人头像
      addBusinessPhotos: true,       // 添加业务相关照片
      noExternalLinks: true,         // 禁止添加外部链接
      noLocationInfo: true,          // 禁止添加位置信息
      noAutomation: true,            // 禁止使用自动化工具
      maxActionsPerDay: 0,           // 当日最大操作数
      browseTimeMin: 0,             // 浏览时间
    },
    description: '注册当天仅完善资料，不做任何互动操作',
  },
  PHASE_1_OBSERVE: {
    name: '观察期',
    dayRange: 'day 1-2',
    rules: {
      noComments: true,              // 禁止评论
      noPosts: true,                 // 禁止发帖
      noFollows: true,               // 禁止关注（第1天）
      browseFeed: true,              // 浏览信息流
      browseTimeMin: 120,            // 每天2-3小时
      maxLikes: 3,                   // 每天最多点赞3次
      maxFollows: 0,                 // 第1天不关注
      sessionsPerDay: 2,             // 每天2次会话
      maxSessionMin: 10,             // 每次最多10分钟
      simulateHuman: true,           // 模拟人类行为
      noBatchActions: true,          // 禁止批量操作
    },
    description: '仅浏览和少量点赞，保持低调，像真实新用户一样探索平台',
  },
  PHASE_2_WARMING: {
    name: '预热期',
    dayRange: 'day 3-5',
    rules: {
      noComments: false,             // 可以评论
      maxComments: 1,                // 每天最多1条评论
      noPosts: true,                 // 仍禁止发帖
      browseFeed: true,
      browseTimeMin: 150,            // 每天2.5小时
      maxLikes: 10,                  // 每天最多10次点赞
      maxFollows: 5,                 // 3小时内关注≤5个
      likePerSession: 10,            // 每次会话点赞10+
      sessionsPerDay: 3,             // 每天3次会话
      maxSessionMin: 15,             // 每次最多15分钟
      replyToComments: true,         // 可以回复评论和私信
      noExternalLinks: true,         // 仍禁止外部链接
      noDM: true,                    // 禁止私信营销
      varyBehavior: true,            // 变化行为模式
    },
    description: '逐步增加互动，开始关注和点赞，但保持自然频率',
  },
  PHASE_3_GROWING: {
    name: '成长期',
    dayRange: 'day 5-7',
    rules: {
      canPost: true,                 // 可以发帖
      maxPosts: 6,                   // 阶段上限；真实上限由平台 dailyQuota.post.max 收口
      postType: 'lifestyle',         // 分享日常生活
      browseFeed: true,
      browseTimeMin: 180,            // 每天3小时
      maxLikes: 20,
      maxFollows: 10,
      maxComments: 3,
      sessionsPerDay: 4,
      maxSessionMin: 25,
      useStories: true,              // 可使用Stories/Reels
      replyToComments: true,
      noExternalLinks: false,        // 可适当添加链接
      noPromotionalContent: true,    // 禁止推广内容
      useHashtags: false,            // 暂不使用热门标签
    },
    description: '开始发布日常内容，使用平台功能，逐步建立活跃度',
  },
  PHASE_4_ACTIVE: {
    name: '活跃期',
    dayRange: 'day 7-10',
    rules: {
      canPost: true,
      maxPosts: 8,                   // 阶段上限；真实上限由平台 dailyQuota.post.max 收口
      postType: 'mixed',             // 混合内容类型
      browseFeed: true,
      browseTimeMin: 180,
      maxLikes: 30,
      maxFollows: 15,
      maxComments: 5,
      sessionsPerDay: 5,
      maxSessionMin: 30,
      useStories: true,
      useReels: true,
      useTrendingTags: true,         // 可使用热门标签
      replyToComments: true,
      engageWithTrending: true,      // 参与热门话题
      noSpam: true,
      noMassDM: true,
    },
    description: '内容发布与互动进入正轨，开始使用热门标签增加曝光',
  },
  PHASE_5_STABLE: {
    name: '稳定期',
    dayRange: 'day 10+',
    rules: {
      canPost: true,
      maxPosts: 12,                  // 阶段上限；真实上限由平台 dailyQuota.post.max 收口
      postType: 'strategic',         // 战略性内容
      browseFeed: true,
      browseTimeMin: 120,            // 维持每天浏览
      maxLikes: 50,
      maxFollows: 20,
      maxComments: 10,
      sessionsPerDay: 4,
      maxSessionMin: 35,
      useStories: true,
      useReels: true,
      useTrendingTags: true,
      replyToComments: true,
      engageWithTrending: true,
      crossPromote: true,            // 可跨平台推广
      useContentCalendar: true,      // 使用内容日历
      maintainConsistency: true,     // 保持内容一致性
    },
    description: '账号进入稳定运营期，可持续进行营销活动',
  },
};

// ── 平台特定规则 ─────────────────────────────────────
const PlatformNurturingRules = {
  reddit: {
    name: 'Reddit',
    warmingDays: 7,
    karmaTarget: { comment: 50, link: 10 },
    subredditEngageLimit: 3,         // 每天最多在3个不同subreddit活动
    rules: [
      '新账号前7天不发布链接帖子',
      '先在小型subreddit积累comment karma',
      '避免在多个subreddit发相同内容（跨版spam检测）',
      '评论要有实质内容，不少于20字',
      '遵守各subreddit的规则和wiki',
      '不要频繁删除和重新发布帖子',
      '新账号前14天不使用Reddit API进行自动化',
      '每日操作不超过1440次（上限阈值）',
      '避免使用新注册邮箱域名（推荐gmail/hotmail）',
    ],
    riskFactors: {
      crossPostSpam: 35,             // 跨版发相同内容
      lowEffortComment: 15,          // 低质量评论
      rapidKarmaFarm: 25,            // 快速刷karma
      newAccountLink: 20,            // 新号发链接
      suspiciousUpvote: 40,          // 可疑点赞模式
    },
    dailyQuota: {
      browse: { min: 90, max: 180 },     // 分钟
      comment: { min: 2, max: 5 },
      post: { min: 0, max: 1 },
      upvote: { min: 5, max: 15 },
      downvote: { min: 0, max: 2 },
      search: { min: 3, max: 8 },
    },
  },
  x: {
    name: 'X (Twitter)',
    warmingDays: 5,
    rules: [
      '新账号前3天不发推',
      '先浏览timeline，点赞和转发',
      '避免批量关注/取关（会被判定为bot）',
      '回复要有个性，不要模板化',
      '不要频繁修改用户名和简介',
      '避免短时间内大量发推',
      '使用话题标签但不过度（1-2个/推）',
      '保持推文长度多样化，不要都是280字极限',
      '不要在凌晨3-5点突然大量活动',
    ],
    riskFactors: {
      rapidFollow: 20,
      massRetweet: 25,
      botBehavior: 35,
      duplicateTweet: 30,
      aggressiveHashtag: 15,
    },
    dailyQuota: {
      browse: { min: 60, max: 120 },
      tweet: { min: 0, max: 3 },
      retweet: { min: 1, max: 5 },
      reply: { min: 1, max: 5 },
      like: { min: 5, max: 15 },
      follow: { min: 0, max: 8 },
    },
  },
  instagram: {
    name: 'Instagram',
    warmingDays: 10,
    rules: [
      '新账号前3天仅浏览和点赞',
      '前7天不发布帖子',
      '避免使用第三方自动发帖工具',
      '不要一次性上传大量照片',
      'Stories互动比帖子更安全',
      '避免在评论区放链接',
      '使用Reels增加自然曝光',
      '不要批量关注/取关',
      '避免使用 banned hashtags',
      '个人简介前14天不放外部链接',
    ],
    riskFactors: {
      rapidFollow: 25,
      massLike: 20,
      dmSpam: 40,
      botComment: 30,
      suspiciousLogin: 20,
    },
    dailyQuota: {
      browse: { min: 90, max: 180 },
      post: { min: 0, max: 1 },
      story: { min: 0, max: 3 },
      like: { min: 5, max: 20 },
      follow: { min: 0, max: 10 },
      comment: { min: 0, max: 3 },
      save: { min: 0, max: 5 },
    },
  },
  tiktok: {
    name: 'TikTok',
    warmingDays: 7,
    rules: [
      '新账号前5天仅刷For You Page',
      '完整观看视频（不要快速滑动）',
      '前7天不发布视频',
      '使用TikTok原生音乐而非外部导入',
      '不要批量关注',
      '参与trending challenge要自然',
      '视频时长保持多样化',
      '避免在视频描述中放链接',
      '使用3-5个相关hashtags',
    ],
    riskFactors: {
      rapidFollow: 20,
      massLike: 15,
      rapidScroll: 25,
      botUpload: 35,
      duplicateContent: 30,
    },
    dailyQuota: {
      browse: { min: 120, max: 180 },
      post: { min: 0, max: 1 },
      like: { min: 5, max: 20 },
      follow: { min: 0, max: 8 },
      comment: { min: 0, max: 3 },
      share: { min: 0, max: 2 },
      watchFull: { min: 3, max: 8 },
    },
  },
  facebook: {
    name: 'Facebook',
    warmingDays: 14,
    rules: [
      '新账号前4天仅浏览和少量点赞',
      '使用真实姓名和照片',
      '逐步添加好友（不要一次性大量添加）',
      '前7天不加入过多群组',
      '不要在多个群组发相同内容',
      '避免频繁修改个人信息',
      '使用Facebook原生功能（Stories/Reels）',
      '不要在帖子中频繁标记陌生人',
      '个人主页和公共主页分开运营',
    ],
    riskFactors: {
      rapidFriendAdd: 30,
      massGroupJoin: 25,
      incompleteProfile: 20,
      suspiciousLogin: 25,
      spammyPost: 25,
    },
    dailyQuota: {
      browse: { min: 60, max: 120 },
      post: { min: 0, max: 1 },
      like: { min: 3, max: 10 },
      comment: { min: 0, max: 3 },
      addFriend: { min: 0, max: 5 },
      joinGroup: { min: 0, max: 1 },
      share: { min: 0, max: 2 },
    },
  },
  youtube: {
    name: 'YouTube',
    warmingDays: 8,
    rules: [
      '新账号前2天仅观看视频',
      '完整观看视频（不要跳过）',
      '观看时长要自然分布',
      '前5天不发布评论',
      '订阅频道要有选择性',
      '不要批量订阅/取消订阅',
      '使用YouTube Shorts增加曝光',
      '评论要有实质内容',
    ],
    riskFactors: {
      rapidSub: 15,
      noWatchSub: 25,
      commentSpam: 20,
      botView: 35,
    },
    dailyQuota: {
      browse: { min: 90, max: 180 },
      watch: { min: 10, max: 30 },      // 分钟
      like: { min: 2, max: 8 },
      subscribe: { min: 0, max: 3 },
      comment: { min: 0, max: 2 },
      share: { min: 0, max: 1 },
    },
  },
  discord: {
    name: 'Discord',
    warmingDays: 5,
    rules: [
      '新账号先在小型服务器活跃',
      '避免在多个服务器发相同消息',
      '不要频繁加入/退出服务器',
      '使用对话式语言，不要广播式发言',
      '遵守各服务器的规则和角色权限',
      '不要使用self-bot或自动化客户端',
      '积极参与语音频道互动增加可信度',
    ],
    riskFactors: {
      massJoin: 25,
      duplicateMessage: 30,
      selfBot: 50,
      spamPing: 35,
    },
    dailyQuota: {
      browse: { min: 30, max: 90 },
      message: { min: 2, max: 10 },
      react: { min: 3, max: 15 },
      joinServer: { min: 0, max: 1 },
    },
  },
  // ── Tumblr（当前唯一真实发布通道）────────────────────────────
  // 【2026-09-10 新增】此前本表没有 tumblr 条目 → NurturingRulesEngine 落到 reddit 兜底，
  // 而 reddit 的 dailyQuota.post.max = 1，与阶段 maxPosts 取 min() 后，
  // 所有 Tumblr 账号的每日发帖上限被硬钉在 1 帖（全站 50 帖/天封顶）。
  // 现单独定义 Tumblr 配额，上限由环境变量 MSCMS_TUMBLR_POST_MAX_PER_DAY 控制（默认 12）。
  // 注意：Tumblr 官方 API 单账号上限约 250 帖/天，但真实风控远低于该值，
  //      放量请改环境变量，不要直接改这里。
  // 【2026-09-12 解发布瓶颈】6 → 12：ready 池积压 6800+ 条，而 117 个账号 × 6 帖/天
  //   = 700 帖/天是当时的硬天花板（队列任务普遍因「超过每日配额 (6/6)」被推迟 428 分钟）。
  //   同时把阶段上限（P3=6 / P4=8 / P5=12）抬到不再低于平台上限，否则 min() 后 env 无效。
  //   回滚方式：MSCMS_TUMBLR_POST_MAX_PER_DAY=6（env 优先，无需改代码）。
  tumblr: {
    name: 'Tumblr',
    warmingDays: 7,
    rules: [
      '新账号前3天仅浏览与点赞，不发帖',
      '前7天不发布外链',
      '单账号每日发帖量保守控制，避免整站被判为 spam 博客',
      '同一内容不要跨 blog 重复发布（跨号重复命中 spam 检测）',
      '标签 3-5 个且与内容强相关，避免堆砌无关热词',
      '帖子之间保持 1-2 小时间隔，不要短时间高频连发',
      '正文避免堆砌营销词与短链',
      '不要频繁修改博客主题与简介',
    ],
    riskFactors: {
      crossBlogDuplicate: 35,
      highFrequencyPost: 30,
      tagStuffing: 20,
      linkSpam: 30,
      incompleteBlog: 15,
    },
    dailyQuota: {
      browse: { min: 60, max: 180 },
      // 每日发帖上限（真实闸门，云手机模式下同样生效）。2026-09-12：6 → 12。
      post: { min: 1, max: Math.max(1, Number(process.env.MSCMS_TUMBLR_POST_MAX_PER_DAY || 12)) },
      like: { min: 5, max: 30 },
      reblog: { min: 0, max: 5 },
      follow: { min: 0, max: 10 },
      comment: { min: 0, max: 5 },
    },
  },
};

// ── 防关联规则 ───────────────────────────────────────
const AntiCorrelationRules = {
  deviceIsolation: {
    rule: '每个账号绑定独立设备',
    enforcement: 'device_manager.assignUniqueDevice(accountId)',
    checkInterval: 'daily',
  },
  ipIsolation: {
    rule: '每个账号使用独立IP/代理',
    enforcement: 'proxy_manager.assignUniqueProxy(accountId)',
    checkInterval: 'daily',
  },
  fingerprintDiversity: {
    rule: '不同账号使用不同浏览器指纹',
    enforcement: 'fingerprint_injector.generateUnique()',
    fields: ['canvas', 'webgl', 'audio', 'font', 'navigator', 'screen'],
    checkInterval: 'on_create',
  },
  profileDiversity: {
    rule: '不同账号避免相似信息',
    fields: ['avatar', 'nickname', 'bio', 'cover_photo', 'email_pattern'],
    checkInterval: 'on_create',
  },
  noCrossLogin: {
    rule: '禁止在同一设备上切换账号',
    enforcement: 'device_manager.lockDevice(accountId)',
    checkInterval: 'realtime',
  },
  stableNetwork: {
    rule: '保持固定IP和设备，避免频繁切换',
    enforcement: 'proxy_manager.lockIP(accountId)',
    checkInterval: 'realtime',
  },
};

// ── 内容发布节奏 ─────────────────────────────────────
const ContentPublishRhythm = {
  week1: {
    phase: 'PHASE_1_OBSERVE',
    postFrequency: 0,
    storyFrequency: 0,
    allowedContent: [],
    description: '第1周：仅浏览和互动，不发布任何内容',
  },
  week2: {
    phase: 'PHASE_3_GROWING',
    postFrequency: '1-2/天',
    storyFrequency: '0-1/天',
    allowedContent: ['lifestyle', 'daily_life', 'thoughts'],
    description: '第2周：开始发布日常生活内容，1-2篇/天',
  },
  week3: {
    phase: 'PHASE_4_ACTIVE',
    postFrequency: '2-3/天',
    storyFrequency: '1-2/天',
    allowedContent: ['lifestyle', 'industry_insights', 'questions', 'trend_participation'],
    description: '第3周：增加发布频率，参与热门话题',
  },
  week4Plus: {
    phase: 'PHASE_5_STABLE',
    postFrequency: '3-5/周',
    storyFrequency: '3-5/周',
    allowedContent: ['strategic', 'promotional_subtle', 'user_generated', 'trend_participation', 'value_content'],
    description: '第4周+：稳定运营，战略性发布，可适度推广',
  },
};

// ── 互动策略 ─────────────────────────────────────────
const EngagementStrategy = {
  day1: {
    follow: 0,
    like: 3,
    comment: 0,
    browse: '2-3h',
    note: '第一天保持低调，仅浏览和少量点赞',
  },
  day2to3: {
    follow: '5/3h',
    like: '10+',
    comment: 1,
    browse: '2-3h',
    replyToComments: true,
    note: '第二天起配合发帖与点赞，逐步增加关注',
  },
  day4to6: {
    follow: '8-10/天',
    like: '15-20/天',
    comment: '2-3/天',
    browse: '2-3h',
    replyToComments: true,
    engageTrending: true,
    note: '逐步扩大互动范围，参与热门内容',
  },
  day7plus: {
    follow: '15-20/天',
    like: '30+/天',
    comment: '5-8/天',
    browse: '2h+',
    replyToComments: true,
    engageTrending: true,
    crossEngage: true,
    note: '稳定期，全面互动，建立社区关系',
  },
};

// ── 全局操作限制 ─────────────────────────────────────
const GlobalLimits = {
  maxActionsPerDay: 1440,            // 每日操作上限阈值
  maxSessionDuration: 45,            // 单次会话最大时长（分钟）
  minSessionInterval: 30,            // 会话间最小间隔（分钟）
  maxConcurrentSessions: 1,          // 最大并发会话
  maxFollowsPerHour: 20,             // 每小时最大关注数
  maxLikesPerHour: 50,               // 每小时最大点赞数
  maxCommentsPerHour: 15,            // 每小时最大评论数
  maxPostsPerDay: 5,                 // 每日最大发帖数
  minPostInterval: 7200000,          // 帖子最小间隔（2小时）
  noActionTimeWindow: {              // 禁止操作时段（模拟睡眠）
    start: 0,                         // 凌晨0点
    end: 6,                           // 早上6点
  },
  peakActivityWindows: [             // 高峰活动时段
    { start: 8, end: 10 },           // 早晨
    { start: 12, end: 14 },          // 午间
    { start: 18, end: 22 },          // 晚间
  ],
};

// ── 养号规则引擎 ─────────────────────────────────────
class NurturingRulesEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.platform = opts.platform || 'reddit';
    this.accountAge = opts.accountAge || 0;  // 天
    this.rules = PlatformNurturingRules[this.platform] || PlatformNurturingRules.reddit;
    this.currentPhase = this._determinePhase();
    this.dailyActionCount = { browse: 0, like: 0, follow: 0, comment: 0, post: 0, share: 0, search: 0 };
    this.lastActionTime = null;
    this.sessionStartTime = null;
    this.sessionCount = 0;
  }

  // 根据账号年龄确定当前养号阶段
  // 支持传入具体账号年龄（天）—— 全局单例拿不到每账号年龄时由调用方传入
  _determinePhase(age) {
    const a = (typeof age === 'number' && age >= 0) ? age : this.accountAge;
    if (a === 0) return NurturingPhase.PHASE_0_REGISTER;
    if (a <= 2) return NurturingPhase.PHASE_1_OBSERVE;
    if (a <= 5) return NurturingPhase.PHASE_2_WARMING;
    if (a <= 7) return NurturingPhase.PHASE_3_GROWING;
    if (a <= 10) return NurturingPhase.PHASE_4_ACTIVE;
    return NurturingPhase.PHASE_5_STABLE;
  }

  // 获取当前阶段的每日配额
  getDailyQuota(age) {
    const phase = (typeof age === 'number' && age >= 0) ? this._determinePhase(age) : this.currentPhase;
    const platformQuota = this.rules.dailyQuota || {};
    return {
      browse: Math.min(phase.rules.browseTimeMin || 120, platformQuota.browse?.max || 180),
      like: Math.min(phase.rules.maxLikes || 10, platformQuota.like?.max || 15),
      follow: Math.min(phase.rules.maxFollows || 5, platformQuota.follow?.max || 8),
      comment: Math.min(phase.rules.maxComments || 1, platformQuota.comment?.max || 3),
      // 修复：早期阶段 maxPosts 未定义时 `|| 0` 会让所有账号 post 配额恒为 0（全站发布被冻结）
      post: (phase.rules.noPosts === true || phase.rules.canPost === false || phase.rules.maxActionsPerDay === 0)
        ? 0
        : Math.min(phase.rules.maxPosts || 1, platformQuota.post?.max || 1),
      sessions: phase.rules.sessionsPerDay || 3,
      maxSessionMin: phase.rules.maxSessionMin || 15,
    };
  }

  // 检查操作是否允许
  /**
   * opts:
   *   accountAge  — 按指定账号年龄判定阶段（不传则用实例自身的 accountAge，默认 0 = 注册期）
   *   currentCount— 用调用方的真实计数（如「该账号今日已发 N 帖」）替代实例内全局计数
   * 传了 accountAge 即进入「按账号维度」模式，跳过依赖全局计数的小时/总量上限（那些计数不是该账号的）。
   */
  canPerform(action, count = 1, opts = {}) {
    const scoped = typeof opts.accountAge === 'number' && opts.accountAge >= 0;
    const quota = scoped ? this.getDailyQuota(opts.accountAge) : this.getDailyQuota();
    const phase = scoped ? this._determinePhase(opts.accountAge) : this.currentPhase;
    const now = new Date();
    const hour = now.getHours();

    // 检查禁止操作时段
    if (hour >= GlobalLimits.noActionTimeWindow.start && hour < GlobalLimits.noActionTimeWindow.end) {
      return { allowed: false, reason: '禁止操作时段（模拟睡眠）', retryAt: GlobalLimits.noActionTimeWindow.end };
    }

    // 检查阶段规则
    if (phase.rules.noComments && action === 'comment') {
      return { allowed: false, reason: `当前阶段(${phase.name})禁止评论` };
    }
    if (phase.rules.noPosts && action === 'post') {
      return { allowed: false, reason: `当前阶段(${phase.name})禁止发帖` };
    }
    if (phase.rules.noFollows && action === 'follow') {
      return { allowed: false, reason: `当前阶段(${phase.name})禁止关注` };
    }
    if (phase.rules.noDM && action === 'dm') {
      return { allowed: false, reason: `当前阶段(${phase.name})禁止私信` };
    }

    // 检查每日配额
    const currentCount = (typeof opts.currentCount === 'number') ? opts.currentCount : (this.dailyActionCount[action] || 0);
    const maxAllowed = quota[action] !== undefined ? quota[action] : GlobalLimits[`max${action.charAt(0).toUpperCase() + action.slice(1)}sPerDay`] || 50;

    if (currentCount + count > maxAllowed) {
      return { allowed: false, reason: `超过每日配额 (${currentCount}/${maxAllowed})`, action, quota: maxAllowed };
    }

    if (!scoped) {
      // 检查每小时限制
      const hourKey = `max${action.charAt(0).toUpperCase() + action.slice(1)}sPerHour`;
      const hourlyLimit = GlobalLimits[hourKey];
      if (hourlyLimit && this._getHourlyCount(action) + count > hourlyLimit) {
        return { allowed: false, reason: `超过每小时限制 (${hourlyLimit})`, action };
      }

      // 检查全局每日上限
      const totalActions = Object.values(this.dailyActionCount).reduce((a, b) => a + b, 0);
      if (totalActions + count > GlobalLimits.maxActionsPerDay) {
        return { allowed: false, reason: '达到每日全局操作上限' };
      }
    }

    return { allowed: true, quota: maxAllowed, remaining: maxAllowed - currentCount };
  }

  // 记录操作
  recordAction(action, details = {}) {
    this.dailyActionCount[action] = (this.dailyActionCount[action] || 0) + 1;
    this.lastActionTime = Date.now();

    // 检查是否需要升级阶段
    const newPhase = this._determinePhase();
    if (newPhase.name !== this.currentPhase.name) {
      this.emit('phase:changed', { from: this.currentPhase.name, to: newPhase.name, accountAge: this.accountAge });
      this.currentPhase = newPhase;
    }

    // Ban-Risk 评估
    const risk = this._assessRisk(action, details);
    if (risk.level === 'HIGH' || risk.level === 'CRITICAL') {
      this.emit('risk:alert', risk);
    }

    return { recorded: true, risk };
  }

  // Ban-Risk 评估
  _assessRisk(action, details) {
    let score = 0;
    const factors = [];
    const riskFactors = this.rules.riskFactors || {};

    // 检查行为模式
    if (action === 'follow' && this._getHourlyCount('follow') > GlobalLimits.maxFollowsPerHour * 0.8) {
      score += riskFactors.rapidFollow || 15;
      factors.push('rapid_follow');
    }
    if (action === 'like' && this._getHourlyCount('like') > GlobalLimits.maxLikesPerHour * 0.8) {
      score += riskFactors.massLike || 12;
      factors.push('mass_like');
    }
    if (action === 'comment' && details.length < 20) {
      score += riskFactors.lowEffortComment || 10;
      factors.push('low_effort_comment');
    }
    if (action === 'post' && details.duplicate) {
      score += 30;
      factors.push('duplicate_content');
    }

    // 累积风险
    const totalActions = Object.values(this.dailyActionCount).reduce((a, b) => a + b, 0);
    if (totalActions > GlobalLimits.maxActionsPerDay * 0.8) {
      score += 15;
      factors.push('high_daily_volume');
    }

    let level = 'LOW';
    if (score >= 80) level = 'CRITICAL';
    else if (score >= 60) level = 'HIGH';
    else if (score >= 35) level = 'MEDIUM';

    return { score, level, factors, recommendations: this._getRiskRecommendations(level, factors) };
  }

  _getRiskRecommendations(level, factors) {
    const recs = [];
    if (level === 'CRITICAL') {
      recs.push('IMMEDIATE_PAUSE: 暂停所有自动化操作24小时');
      recs.push('MANUAL_REVIEW: 人工检查账号状态');
      recs.push('CHANGE_IP: 考虑更换IP地址');
    } else if (level === 'HIGH') {
      recs.push('REDUCE_ACTIONS: 降低50%操作频率');
      recs.push('INCREASE_DELAY: 增加操作间隔至正常值的2倍');
    } else if (level === 'MEDIUM') {
      recs.push('SLOW_DOWN: 适当降低操作频率');
      recs.push('MONITOR: 密切关注账号状态');
    }
    return recs;
  }

  _getHourlyCount(action) {
    // 简化实现：返回当前小时的估计计数
    return Math.floor((this.dailyActionCount[action] || 0) / 8); // 假设8小时活跃
  }

  // 获取建议行为
  getSuggestedActions() {
    const phase = this.currentPhase;
    const quota = this.getDailyQuota();
    const suggestions = [];

    // 浏览建议
    if (this.dailyActionCount.browse < quota.browse) {
      suggestions.push({ action: 'browse', priority: 'high', remaining: quota.browse - this.dailyActionCount.browse });
    }

    // 点赞建议
    if (this.dailyActionCount.like < quota.like && !phase.rules.noComments) {
      suggestions.push({ action: 'like', priority: 'medium', remaining: quota.like - this.dailyActionCount.like });
    }

    // 关注建议
    if (this.dailyActionCount.follow < quota.follow && !phase.rules.noFollows) {
      suggestions.push({ action: 'follow', priority: 'low', remaining: quota.follow - this.dailyActionCount.follow });
    }

    // 发帖建议
    if (this.dailyActionCount.post < quota.post && phase.rules.canPost) {
      const rhythm = this._getContentRhythm();
      if (rhythm.allowedContent.length > 0) {
        suggestions.push({ action: 'post', priority: 'medium', remaining: quota.post - this.dailyActionCount.post, contentType: rhythm.allowedContent });
      }
    }

    return suggestions;
  }

  _getContentRhythm() {
    if (this.accountAge < 7) return ContentPublishRhythm.week1;
    if (this.accountAge < 14) return ContentPublishRhythm.week2;
    if (this.accountAge < 21) return ContentPublishRhythm.week3;
    return ContentPublishRhythm.week4Plus;
  }

  // 获取互动策略
  getEngagementStrategy() {
    if (this.accountAge <= 1) return EngagementStrategy.day1;
    if (this.accountAge <= 3) return EngagementStrategy.day2to3;
    if (this.accountAge <= 6) return EngagementStrategy.day4to6;
    return EngagementStrategy.day7plus;
  }

  // 重置每日计数（午夜调用）
  resetDailyCounters() {
    this.dailyActionCount = { browse: 0, like: 0, follow: 0, comment: 0, post: 0, share: 0, search: 0 };
    this.sessionCount = 0;
    this.emit('daily:reset', { date: new Date().toISOString() });
  }

  // 获取养号报告
  getReport() {
    const quota = this.getDailyQuota();
    const totalActions = Object.values(this.dailyActionCount).reduce((a, b) => a + b, 0);
    return {
      platform: this.platform,
      accountAge: this.accountAge,
      currentPhase: this.currentPhase.name,
      phaseDescription: this.currentPhase.description,
      dailyQuota: quota,
      dailyActions: this.dailyActionCount,
      totalActions,
      quotaUsage: totalActions / GlobalLimits.maxActionsPerDay,
      suggestions: this.getSuggestedActions(),
      engagementStrategy: this.getEngagementStrategy(),
      contentRhythm: this._getContentRhythm(),
    };
  }
}

module.exports = {
  NurturingPhase,
  PlatformNurturingRules,
  AntiCorrelationRules,
  ContentPublishRhythm,
  EngagementStrategy,
  GlobalLimits,
  NurturingRulesEngine,
};
