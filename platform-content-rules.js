/**
 * platform-content-rules.js — MSCMS v14 社媒平台内容管理规则引擎
 *
 * 在内容生成前学习和理解各社媒平台的内容管理规则，确保不会触发平台风控：
 *   1. 各平台内容政策与社区准则
 *   2. 禁止内容类型清单
 *   3. 风控触发条件与阈值
 *   4. 内容审核检查器
 *   5. Hashtag 安全性检查
 *   6. 链接安全性检查
 *   7. 敏感词过滤
 *   8. 内容合规评分
 */

const { EventEmitter } = require('events');

// ── 平台内容管理规则 ─────────────────────────────────
const PlatformContentRules = {
  reddit: {
    name: 'Reddit',
    contentPolicy: {
      // Reddit Content Policy 核心规则
      prohibited: [
        '禁止发布非法内容（儿童剥削、恐怖主义、暴力威胁）',
        '禁止人肉搜索或泄露他人隐私信息',
        '禁止骚扰、霸凌或煽动暴力',
        '禁止发布非自愿的亲密影像',
        '禁止 spam（重复发布相同内容、跨版刷屏）',
        '禁止投票操纵（多账号互相点赞）',
        '禁止推广非法产品或服务',
        '禁止 impersonation（冒充他人）',
      ],
      subredditSpecific: true,        // 各subreddit有独立规则
      karmaRequirements: {
        minCommentKarma: 10,          // 发帖最低comment karma
        minLinkKarma: 5,              // 发链接最低link karma
        accountAgeDays: 7,            // 发帖最低账号年龄
      },
      rateLimits: {
        newAccount: { postsPerHour: 1, commentsPerHour: 5 },
        normal: { postsPerHour: 3, commentsPerHour: 20 },
      },
    },
    moderationTriggers: {
      crossPostSpam: { threshold: 3, action: 'shadowban_risk', score: 35 },
      lowEffortContent: { threshold: 'short_comments', action: 'rate_limit', score: 15 },
      repeatedDomain: { threshold: 5, action: 'spam_filter', score: 25 },
      reportRatio: { threshold: 0.1, action: 'auto_removal', score: 30 },
      newAccountActivity: { threshold: 'high_velocity', action: 'captcha', score: 20 },
    },
    safeHashtags: ['discussion', 'question', 'advice', 'technology', 'science'],
    bannedHashtags: [],
    linkPolicy: {
      newAccount: 'blocked',         // 新账号不能发链接
      minAge: 7,                     // 7天后可以发链接
      allowedDomains: ['imgur.com', 'reddit.com', 'youtube.com'],
      suspiciousDomains: ['bit.ly', 'tinyurl.com', 'short.link'],
    },
    contentTips: [
      '帖子标题要真实有趣，不要标题党',
      '正文要有实质内容，避免一句话帖子',
      '在合适的subreddit发帖，阅读sidebar规则',
      '回复评论要真诚，不要模板化',
      '不要删除低分帖子重新发（会被检测）',
      '使用原文链接而非短链接',
      '在r/newreddits或r/blog推广自己的社区',
    ],
  },

  x: {
    name: 'X (Twitter)',
    contentPolicy: {
      prohibited: [
        '禁止发布威胁暴力或伤害他人的内容',
        '禁止仇恨言论（种族、宗教、性别、性取向等）',
        '禁止骚扰和霸凌',
        '禁止发布他人隐私信息',
        '禁止儿童性剥削内容',
        '禁止 spam 和平台操纵',
        '禁止冒充他人',
        '禁止发布非法或有害内容',
      ],
      rateLimits: {
        tweets: { perDay: 2400, perHour: 100 },
        replies: { perDay: 500, perHour: 25 },
        follows: { perDay: 400, perHour: 50 },
        dms: { perDay: 500, perHour: 25 },
      },
      automationPolicy: {
        allowedAutomation: 'API-based posting with rate limits',
        prohibitedAutomation: 'mass-following, mass-liking, duplicate tweets',
        apiTierLimits: { free: 50, basic: 5000, pro: 10000 },
      },
    },
    moderationTriggers: {
      rapidFollow: { threshold: 50, action: 'account_lock', score: 25 },
      duplicateTweet: { threshold: 1, action: 'visibility_reduction', score: 30 },
      aggressiveHashtag: { threshold: 5, action: 'spam_flag', score: 15 },
      botBehavior: { threshold: 'pattern_match', action: 'shadowban', score: 35 },
      massMention: { threshold: 10, action: 'rate_limit', score: 20 },
    },
    safeHashtags: ['tech', 'ai', 'innovation', 'design', 'productivity'],
    bannedHashtags: ['#follow4follow', '#like4like', '#spam'],
    linkPolicy: {
      newAccount: 'allowed',
      minAge: 0,
      allowedDomains: [],
      suspiciousDomains: ['bit.ly', 'tinyurl.com'],
      tcoWrapper: true,               // X自动使用t.co包装链接
    },
    contentTips: [
      '推文要有个性，不要像机器人',
      '避免在短时间内发大量相同主题推文',
      '使用1-2个相关hashtag即可',
      '回复要比转发更有价值',
      '不要买粉或买赞',
      '保持推文长度多样化',
      '使用线程(Thread)讲述复杂故事',
    ],
  },

  instagram: {
    name: 'Instagram',
    contentPolicy: {
      prohibited: [
        '禁止发布裸露或性暗示内容',
        '禁止仇恨言论和歧视性内容',
        '禁止威胁和暴力内容',
        '禁止骚扰和霸凌',
        '禁止发布他人隐私信息',
        '禁止鼓励自残或饮食障碍',
        '禁止销售非法商品',
        '禁止 spam 和虚假互动',
      ],
      rateLimits: {
        likes: { perHour: 60, perDay: 500 },
        comments: { perHour: 30, perDay: 200 },
        follows: { perHour: 20, perDay: 150 },
        posts: { perDay: 5 },
        stories: { perDay: 100 },
      },
      automationPolicy: {
        allowedAutomation: 'none (all automation prohibited)',
        prohibitedAutomation: 'auto-like, auto-follow, auto-comment, bot posting',
        apiAccess: 'Instagram Graph API (business accounts only)',
      },
    },
    moderationTriggers: {
      rapidFollow: { threshold: 20, action: 'action_block', score: 25 },
      massLike: { threshold: 60, action: 'temporary_block', score: 20 },
      dmSpam: { threshold: 10, action: 'dm_block', score: 40 },
      botComment: { threshold: 'pattern', action: 'comment_filter', score: 30 },
      bannedHashtag: { threshold: 1, action: 'shadowban', score: 35 },
      thirdPartyApp: { threshold: 1, action: 'password_reset', score: 25 },
    },
    safeHashtags: ['photography', 'art', 'travel', 'food', 'fitness', 'nature', 'instagood'],
    bannedHashtags: ['#like4like', '#follow4follow', '#comment4comment', '#spam', '# giveaway'],
    linkPolicy: {
      newAccount: 'bio_only',         // 新账号只能在简介放链接
      minAge: 14,                     // 14天后可考虑在帖子放链接
      allowedDomains: [],
      suspiciousDomains: ['bit.ly', 'short.link'],
      inCaption: 'not_recommended',   // 不建议在标题放链接
    },
    contentTips: [
      '使用高质量图片或视频',
      '标题要有吸引力但不要标题党',
      '使用5-10个相关hashtag',
      '避免使用banned hashtags',
      'Stories比帖子互动率更高',
      'Reels获得更多自然曝光',
      '不要使用第三方自动发帖工具',
      '保持视觉风格一致性',
    ],
  },

  tiktok: {
    name: 'TikTok',
    contentPolicy: {
      prohibited: [
        '禁止发布未成年人危险内容',
        '禁止仇恨言论和歧视',
        '禁止暴力和血腥内容',
        '禁止成人内容和性暗示',
        '禁止骚扰和霸凌',
        '禁止自残或危险挑战',
        '禁止 spam 和虚假互动',
        '禁止发布非法活动内容',
      ],
      rateLimits: {
        likes: { perHour: 100, perDay: 500 },
        comments: { perHour: 30, perDay: 200 },
        follows: { perHour: 25, perDay: 200 },
        posts: { perDay: 3 },
        shares: { perHour: 50 },
      },
      automationPolicy: {
        allowedAutomation: 'none',
        prohibitedAutomation: 'auto-upload, bot views, fake engagement',
        apiAccess: 'TikTok Research API (approved researchers only)',
      },
    },
    moderationTriggers: {
      rapidFollow: { threshold: 25, action: 'follow_block', score: 20 },
      massLike: { threshold: 100, action: 'like_block', score: 15 },
      rapidScroll: { threshold: 'pattern', action: 'view_invalid', score: 25 },
      botUpload: { threshold: 'api_access', action: 'video_removal', score: 35 },
      duplicateContent: { threshold: 'hash_match', action: 'visibility_reduction', score: 30 },
      copyrightedMusic: { threshold: 1, action: 'audio_mute', score: 20 },
    },
    safeHashtags: ['fyp', 'foryou', 'viral', 'trending', 'dance', 'comedy', 'tutorial'],
    bannedHashtags: [],
    linkPolicy: {
      newAccount: 'bio_only',
      minAge: 7,
      allowedDomains: [],
      suspiciousDomains: [],
      inCaption: 'not_recommended',
    },
    contentTips: [
      '使用TikTok原生音乐增加曝光',
      '前3秒要hook住观众',
      '视频时长15-30秒效果最好',
      '使用3-5个相关hashtag',
      '参与trending challenge要自然',
      '不要批量上传相同视频',
      '视频质量要清晰（720p+）',
      '使用TikTok内置编辑工具',
    ],
  },

  facebook: {
    name: 'Facebook',
    contentPolicy: {
      prohibited: [
        '禁止仇恨言论和歧视',
        '禁止暴力和威胁',
        '禁止成人内容和裸露',
        '禁止骚扰和霸凌',
        '禁止发布他人隐私信息',
        '禁止 spam 和虚假信息',
        '禁止销售非法商品',
        '禁止协调伤害',
      ],
      rateLimits: {
        posts: { perDay: 10 },
        comments: { perHour: 60 },
        likes: { perHour: 100 },
        addFriend: { perDay: 20, perHour: 5 },
        joinGroup: { perDay: 10 },
      },
      automationPolicy: {
        allowedAutomation: 'Graph API for business pages',
        prohibitedAutomation: 'personal account automation',
        apiAccess: 'Facebook Graph API',
      },
    },
    moderationTriggers: {
      rapidFriendAdd: { threshold: 20, action: 'friend_block', score: 30 },
      massGroupJoin: { threshold: 10, action: 'group_block', score: 25 },
      spammyPost: { threshold: 'pattern', action: 'post_removal', score: 25 },
      fakeNews: { threshold: 'fact_check', action: 'visibility_reduction', score: 35 },
      newAccountHighActivity: { threshold: 'velocity', action: 'checkpoint', score: 25 },
    },
    safeHashtags: [],
    bannedHashtags: [],
    linkPolicy: {
      newAccount: 'allowed',
      minAge: 0,
      allowedDomains: [],
      suspiciousDomains: ['bit.ly'],
    },
    contentTips: [
      '使用真实姓名和照片',
      '帖子要有故事性',
      '在群组中积极参与讨论',
      '不要在多个群组发相同内容',
      '使用Facebook Stories增加曝光',
      '公共主页和个人主页分开',
      '不要频繁修改个人信息',
    ],
  },

  youtube: {
    name: 'YouTube',
    contentPolicy: {
      prohibited: [
        '禁止发布非法内容',
        '禁止仇恨言论',
        '禁止骚扰和霸凌',
        '禁止成人内容',
        '禁止暴力内容',
        '禁止 spam 和误导性内容',
        '禁止版权侵权',
        '禁止鼓励危险行为',
      ],
      rateLimits: {
        comments: { perHour: 30, perDay: 200 },
        uploads: { perDay: 5 },
        likes: { perHour: 100 },
        subscriptions: { perHour: 25 },
      },
      automationPolicy: {
        allowedAutomation: 'YouTube Data API v3',
        prohibitedAutomation: 'view bots, sub4sub, artificial engagement',
      },
    },
    moderationTriggers: {
      rapidSub: { threshold: 25, action: 'sub_block', score: 15 },
      noWatchSub: { threshold: 'pattern', action: 'sub_invalid', score: 25 },
      commentSpam: { threshold: 'pattern', action: 'comment_hold', score: 20 },
      botView: { threshold: 'pattern', action: 'view_invalid', score: 35 },
      copyrightStrike: { threshold: 1, action: 'strike', score: 50 },
    },
    safeHashtags: ['#youtube', '#tutorial', '#review', '#vlog'],
    bannedHashtags: ['#sub4sub', '#subscribers'],
    linkPolicy: {
      newAccount: 'allowed',
      minAge: 0,
      allowedDomains: [],
      suspiciousDomains: [],
    },
    contentTips: [
      '视频标题要SEO友好',
      '缩略图要吸引人但不误导',
      '描述中使用关键词',
      '完整观看视频再点赞',
      '评论要有实质内容',
      '使用播放列表组织内容',
      'Shorts获得更多自然曝光',
    ],
  },

  discord: {
    name: 'Discord',
    contentPolicy: {
      prohibited: [
        '禁止发布非法内容',
        '禁止 harassment 和霸凌',
        '禁止 spam 和 flooding',
        '禁止恶意链接',
        '禁止冒充他人',
        '禁止违反服务器规则',
      ],
      rateLimits: {
        messages: { perChannel: 5, per10Sec: 5 },
        joins: { perHour: 10 },
      },
      automationPolicy: {
        allowedAutomation: 'Discord Bot API (with proper verification)',
        prohibitedAutomation: 'self-bots, user account automation',
      },
    },
    moderationTriggers: {
      massJoin: { threshold: 10, action: 'join_cooldown', score: 25 },
      duplicateMessage: { threshold: 3, action: 'auto_delete', score: 30 },
      selfBot: { threshold: 1, action: 'account_termination', score: 50 },
      spamPing: { threshold: 5, action: 'mute', score: 35 },
    },
    safeHashtags: [],
    bannedHashtags: [],
    linkPolicy: {
      newAccount: 'server_dependent',
      minAge: 0,
      allowedDomains: [],
      suspiciousDomains: ['bit.ly', 'discord.gg/free'],
    },
    contentTips: [
      '先阅读服务器规则再发言',
      '使用对话式语言',
      '积极参与语音频道互动',
      '不要在多个服务器发相同消息',
      '尊重服务器角色和权限',
    ],
  },
};

// ── 敏感词库 ─────────────────────────────────────────
const SensitiveWords = {
  violence: ['kill', 'murder', 'attack', 'bomb', 'weapon', 'gun', 'shoot', '暴力', '杀', '攻击'],
  hate: ['racist_terms', 'slur', 'discrimination', '歧视', '侮辱'],
  adult: ['porn', 'nsfw', 'explicit', 'nude', '成人', '色情'],
  spam: ['free_followers', 'click_here', 'limited_offer', 'act_now', 'buy_now', '免费', '点击领取'],
  personal: ['ssn', 'credit_card', 'password', 'address', 'phone_number', '身份证', '银行卡'],
  illegal: ['drugs', 'illegal_sale', 'fraud', 'scam', '毒品', '诈骗'],
};

// ── 内容审核检查器 ───────────────────────────────────
class ContentRuleChecker extends EventEmitter {
  constructor(platform = 'reddit') {
    super();
    this.platform = platform;
    this.rules = PlatformContentRules[platform] || PlatformContentRules.reddit;
  }

  // 全面检查内容
  checkContent(content, opts = {}) {
    const results = {
      passed: true,
      score: 100,
      issues: [],
      warnings: [],
      recommendations: [],
    };

    // 1. 禁止内容检查
    const prohibitedCheck = this._checkProhibited(content);
    if (!prohibitedCheck.passed) {
      results.passed = false;
      results.score -= 50;
      results.issues.push(...prohibitedCheck.issues);
    }

    // 2. 敏感词检查
    const sensitiveCheck = this._checkSensitiveWords(content);
    if (sensitiveCheck.found.length > 0) {
      results.score -= sensitiveCheck.found.length * 10;
      results.warnings.push(`检测到敏感词: ${sensitiveCheck.found.join(', ')}`);
      results.recommendations.push('建议替换或删除敏感词');
    }

    // 3. Hashtag 检查
    const hashtagCheck = this._checkHashtags(content);
    if (hashtagCheck.banned.length > 0) {
      results.score -= 20;
      results.warnings.push(`使用 banned hashtags: ${hashtagCheck.banned.join(', ')}`);
      results.recommendations.push('移除 banned hashtags');
    }
    if (hashtagCheck.count > 10) {
      results.score -= 10;
      results.warnings.push('Hashtag 数量过多（超过10个）');
    }

    // 4. 链接检查
    const linkCheck = this._checkLinks(content, opts.accountAge || 0);
    if (!linkCheck.passed) {
      results.score -= 15;
      results.warnings.push(...linkCheck.warnings);
    }

    // 5. 长度检查
    const lengthCheck = this._checkLength(content);
    if (!lengthCheck.passed) {
      results.score -= 10;
      results.warnings.push(lengthCheck.warning);
    }

    // 6. 重复内容检查
    if (opts.duplicateCheck) {
      const dupCheck = this._checkDuplicate(content, opts.recentContent || []);
      if (dupCheck.isDuplicate) {
        results.score -= 30;
        results.warnings.push('内容与近期发布过于相似');
      }
    }

    // 7. 促销内容检查
    const promoCheck = this._checkPromotional(content);
    if (promoCheck.isPromotional && (opts.accountAge || 0) < 14) {
      results.score -= 20;
      results.warnings.push('新账号不宜发布推广内容');
      results.recommendations.push('账号年龄不足14天，建议先发布非推广内容');
    }

    // 8. 风控触发检查
    const riskCheck = this._checkRiskTriggers(content, opts);
    if (riskCheck.triggers.length > 0) {
      results.score -= riskCheck.triggers.reduce((s, t) => s + t.score, 0);
      results.warnings.push(...riskCheck.triggers.map(t => t.warning));
    }

    results.score = Math.max(0, results.score);
    if (results.score < 60) {
      results.passed = false;
      results.recommendations.push('内容合规分数过低，建议修改后再发布');
    }

    this.emit('check:completed', results);
    return results;
  }

  _checkProhibited(content) {
    const issues = [];
    const text = (content.body || content.text || content.caption || '').toLowerCase();

    for (const rule of this.rules.contentPolicy.prohibited) {
      // 简化检查：检测关键词
      const keywords = rule.match(/[\w\u4e00-\u9fff]+/g) || [];
      const matches = keywords.filter(k => k.length > 3 && text.includes(k.toLowerCase()));
      if (matches.length >= 2) {
        issues.push({ type: 'prohibited', rule, matches });
      }
    }

    return { passed: issues.length === 0, issues };
  }

  _checkSensitiveWords(content) {
    const text = (content.body || content.text || content.caption || '').toLowerCase();
    const found = [];

    for (const [category, words] of Object.entries(SensitiveWords)) {
      for (const word of words) {
        if (text.includes(word.toLowerCase())) {
          found.push(`${category}:${word}`);
        }
      }
    }

    return { found, count: found.length };
  }

  _checkHashtags(content) {
    const text = content.body || content.text || content.caption || '';
    const hashtags = text.match(/#[\w\u4e00-\u9fff]+/g) || [];
    const banned = this.rules.bannedHashtags || [];
    const foundBanned = hashtags.filter(h => banned.some(b => h.toLowerCase().includes(b.toLowerCase())));

    return {
      count: hashtags.length,
      banned: foundBanned,
      all: hashtags,
    };
  }

  _checkLinks(content, accountAge) {
    const text = content.body || content.text || content.caption || '';
    const urlPattern = /https?:\/\/[^\s]+/g;
    const links = text.match(urlPattern) || [];
    const warnings = [];
    let passed = true;

    const linkPolicy = this.rules.linkPolicy;

    // 新账号链接检查
    if (linkPolicy.newAccount === 'blocked' && accountAge < (linkPolicy.minAge || 0) && links.length > 0) {
      passed = false;
      warnings.push(`新账号（${accountAge}天）不能发布链接，需满${linkPolicy.minAge}天`);
    }

    if (linkPolicy.newAccount === 'bio_only' && accountAge < (linkPolicy.minAge || 0) && links.length > 0) {
      warnings.push(`新账号链接只能在个人简介中，建议移除帖子中的链接`);
    }

    // 可疑域名检查
    const suspicious = linkPolicy.suspiciousDomains || [];
    for (const link of links) {
      for (const domain of suspicious) {
        if (link.includes(domain)) {
          warnings.push(`可疑短链接域名: ${domain}，建议使用完整链接`);
        }
      }
    }

    return { passed, warnings, linkCount: links.length, links };
  }

  _checkLength(content) {
    const specs = this._getPlatformSpecs();
    const text = content.body || content.text || content.caption || '';
    const title = content.title || '';

    if (title.length > specs.titleMaxLength && specs.titleMaxLength > 0) {
      return { passed: false, warning: `标题过长 (${title.length}/${specs.titleMaxLength})` };
    }
    if (text.length > specs.maxLength) {
      return { passed: false, warning: `内容过长 (${text.length}/${specs.maxLength})` };
    }
    if (text.length < 10) {
      return { passed: false, warning: '内容过短（少于10字）' };
    }

    return { passed: true };
  }

  _getPlatformSpecs() {
    const specs = {
      reddit: { maxLength: 40000, titleMaxLength: 300 },
      x: { maxLength: 280, titleMaxLength: 0 },
      discord: { maxLength: 2000, titleMaxLength: 0 },
      instagram: { maxLength: 2200, titleMaxLength: 0 },
      tiktok: { maxLength: 2200, titleMaxLength: 0 },
      facebook: { maxLength: 63206, titleMaxLength: 0 },
      youtube: { maxLength: 5000, titleMaxLength: 100 },
    };
    return specs[this.platform] || specs.reddit;
  }

  _checkDuplicate(content, recentContent) {
    const text = (content.body || content.text || content.caption || '').toLowerCase();
    for (const recent of recentContent) {
      const recentText = (recent.body || recent.text || recent.caption || '').toLowerCase();
      const similarity = this._calculateSimilarity(text, recentText);
      if (similarity > 0.7) {
        return { isDuplicate: true, similarity, similarTo: recent.id };
      }
    }
    return { isDuplicate: false };
  }

  _calculateSimilarity(text1, text2) {
    const words1 = text1.split(/\s+/);
    const words2 = text2.split(/\s+/);
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = new Set([...set1].filter(w => set2.has(w)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
  }

  _checkPromotional(content) {
    const text = (content.body || content.text || content.caption || '').toLowerCase();
    const promoIndicators = ['buy', 'shop', 'discount', 'sale', 'offer', 'deal', 'limited', 'order now', 'click here', '购买', '优惠', '折扣', '限时', '下单'];
    const matches = promoIndicators.filter(p => text.includes(p));
    return { isPromotional: matches.length >= 2, indicators: matches };
  }

  _checkRiskTriggers(content, opts) {
    const triggers = [];
    const moderationTriggers = this.rules.moderationTriggers || {};

    // 检查批量操作风险
    if (opts.dailyPostCount && opts.dailyPostCount >= 3) {
      if (moderationTriggers.repeatedDomain) {
        triggers.push({ type: 'mass_posting', score: 15, warning: '当日发帖数过多，可能触发spam检测' });
      }
    }

    // 检查新账号高频活动
    if (opts.accountAge !== undefined && opts.accountAge < 7 && opts.dailyActionCount > 30) {
      triggers.push({ type: 'new_account_velocity', score: 20, warning: '新账号活动频率过高' });
    }

    return { triggers };
  }

  // 获取平台安全发布建议
  getSafePublishTips() {
    return this.rules.contentTips || [];
  }

  // 检查账号是否满足发帖条件
  checkAccountEligibility(accountInfo) {
    const policy = this.rules.contentPolicy;
    const issues = [];

    // 检查账号年龄
    if (policy.karmaRequirements && accountInfo.karma) {
      if (accountInfo.karma.comment < policy.karmaRequirements.minCommentKarma) {
        issues.push(`Comment karma不足 (${accountInfo.karma.comment}/${policy.karmaRequirements.minCommentKarma})`);
      }
      if (accountInfo.karma.link < policy.karmaRequirements.minLinkKarma) {
        issues.push(`Link karma不足 (${accountInfo.karma.link}/${policy.karmaRequirements.minLinkKarma})`);
      }
    }

    if (accountInfo.age < (policy.karmaRequirements?.accountAgeDays || 0)) {
      issues.push(`账号年龄不足 (${accountInfo.age}/${policy.karmaRequirements?.accountAgeDays}天)`);
    }

    return { eligible: issues.length === 0, issues };
  }
}

module.exports = {
  PlatformContentRules,
  SensitiveWords,
  ContentRuleChecker,
};
