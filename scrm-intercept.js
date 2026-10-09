/**
 * scrm-intercept.js — MSCMS v14 SCRM 智能截流引擎
 *
 * 核心能力：
 *   1. 多权重评分模型（关键词×0.3 + 发布时间×0.2 + 互动量×0.25 + 情感×0.15 + 用户质量×0.1）
 *   2. 情感极性识别（正面/负面/中性 + 情绪强度）
 *   3. AI 智能回复生成（上下文感知 + 模板库）
 *   4. 评论/用户去重校验
 *   5. 手动确认模式（WebUI审核队列）
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 权重评分模型 ─────────────────────────────────
const SCORING_WEIGHTS = {
  keyword:      0.30,  // 关键词匹配度
  publishTime:  0.20,  // 发布时间新鲜度
  engagement:   0.25,  // 互动量（点赞+评论+分享）
  sentiment:    0.15,  // 情感匹配度
  userQuality:  0.10,  // 用户质量（粉丝数/认证状态）
};

// ── 情感极性 ─────────────────────────────────────
const SentimentPolarity = {
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  NEUTRAL: 'neutral',
  QUESTION: 'question',   // 疑问/求助
  COMPLAINT: 'complaint', // 投诉
  PRAISE: 'praise',       // 赞美
};

// ── 情感词典 ─────────────────────────────────────
const SENTIMENT_DICT = {
  positive: ['好', '棒', '赞', '厉害', '优秀', '喜欢', '支持', '期待', '完美', 'nice', 'great', 'amazing', 'love'],
  negative: ['差', '烂', '垃圾', '失望', '不好', '骗', '投诉', '举报', 'terrible', 'bad', 'hate', 'awful'],
  question: ['怎么', '如何', '什么', '为什么', '能不能', '可以吗', '哪里有', 'how', 'what', 'why', 'where', 'when'],
  complaint: ['投诉', '退款', '举报', '坑', '骗人', '虚假', 'refund', 'scam', 'fake', 'report'],
  praise:  ['太棒了', '最好的', '膜拜', '大佬', '天花板', 'goat', 'best', 'legend', 'masterpiece'],
};

// ── 回复模板库 ───────────────────────────────────
const REPLY_TEMPLATES = {
  positive: [
    '感谢支持！我们会继续努力的 💪',
    '谢谢你的认可，超级开心！',
    '你的支持是我们最大的动力！',
    '太暖了，谢谢！',
  ],
  negative: [
    '抱歉给你带来不好的体验，可以私信我们详细说说吗？',
    '感谢反馈，我们已经记录并会尽快改进！',
    '理解你的感受，我们会认真处理的。',
  ],
  question: [
    '好问题！让我来解答一下...',
    '这个问题很多人都问过，详细说明在这里 👇',
    '简单来说是这样的...有其他问题随时问！',
  ],
  complaint: [
    '非常抱歉！我们立刻为你处理，请查看私信。',
    '已收到你的反馈，客服团队会24小时内联系你。',
    '感谢指出问题，我们已记录并会尽快修复！',
  ],
  praise: [
    '受宠若惊！感谢大佬认可 🙏',
    '太感动了，我们会继续保持！',
    '谢谢你的夸奖，我们还有很多要学习的！',
  ],
  neutral: [
    '感谢关注，你对此有什么看法？',
    '说得很有道理，期待更多交流！',
    '谢谢分享你的观点 👍',
  ],
};

// ── 评论基类 ─────────────────────────────────────
class Comment {
  constructor(opts = {}) {
    this.id = opts.id || `cmt_${Date.now()}_${crypto.randomBytes(3'hex')}`;
    this. = opts. || 'tiktok';
    this.postId = opts.postId || '';
    this.author = {
      : opts.author?. || '',
      userId: opts.author?.userId || '',
      followers: opts.author?.followers || 0,
      verified: opts.author?.verified || false,
      bio: opts.author?.bio || '',
    };
    this.content = opts.content || '';
    this.createdAt = opts.createdAt || new Date().toISOString();
    this.metrics = {
      likes: opts.metrics?.likes || 0,
      replies: opts.metrics?.replies || 0,
      shares: opts.metrics?.shares || 0,
    };
    this.tags = opts.tags || [];
  }
}

// ── 去重引擎 ─────────────────────────────────────
class DedupEngine {
  constructor(maxSize = 10000) {
    this.seenIds = new Set();
    this.seenContents = new Map(); // contentHash → count
    this.authorHistory = new Map();  // authorId → [commentIds]
    this.maxSize = maxSize;
  }

  /**
   * 检查评论是否应被去重
   */
  isDuplicate(comment) {
    // 1. ID 去重
    if (this.seenIds.has(comment.id)) {
      return { duplicate: true, reason: 'id_duplicate' };
    }

    // 2. 内容哈希去重
    const contentHash = this._contentFingerprint(comment.content);
    if (this.seenContents.has(contentHash)) {
      const count = this.seenContents.get(contentHash) + 1;
      this.seenContents.set(contentHash, count);
      if (count >= 3) {
        return { duplicate: true, reason: 'spam_content', count };
      }
    }

    // 3. 同一作者短时间重复评论
    const authorId = comment.author.userId;
    if (this.authorHistory.has(authorId)) {
      const history = this.authorHistory.get(authorId);
      const lastComment = history[history.length - 1];
      const timeDiff = Date.now() - new Date(lastComment.createdAt).getTime();
      if (timeDiff < 60000) { // 1分钟内
        return { duplicate: true, reason: 'rapid_comment', timeDiff };
      }
    }

    return { duplicate: false };
  }

  /**
   * 注册评论
   */
  (comment) {
    this.seenIds.add(comment.id);

    const contentHash = this._contentFingerprint(comment.content);
    this.seenContents.set(contentHash, (this.seenContents.get(contentHash) || 0) + 1);

    const authorId = comment.author.userId;
    if (!this.authorHistory.has(authorId)) {
      this.authorHistory.set(authorId, []);
    }
    this.authorHistory.get(authorId).push({
      commentId: comment.id,
      contentHash,
      createdAt: comment.createdAt,
    });

    // 限制缓存大小
    if (this.seenIds.size > this.maxSize) this.seenIds.clear();
    if (this.authorHistory.size > this.maxSize) this.authorHistory.clear();
  }

  _contentFingerprint(text) {
    // 规范化文本后取hash
    const normalized = text.toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s\u4e00-\u9fff]/g, '')
      .trim();
    return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 16);
  }
}

// ── 情感分析器 ───────────────────────────────────
class SentimentAnalyzer {
  analyze(text) {
    const lower = text.toLowerCase();
    const scores = {
      positive: 0, negative: 0, question: 0, complaint: 0, praise: 0,
    };

    for (const [type, words] of Object.entries(SENTIMENT_DICT)) {
      for (const word of words) {
        if (lower.includes(word)) {
          scores[type] += 1;
        }
      }
    }

    // 确定主要情感
    const entries = Object.entries(scores);
    entries.sort((a, b) => b[1] - a[1]);
    const [topType, topScore] = entries[0];

    if (topScore === 0) {
      return { polarity: SentimentPolarity.NEUTRAL, intensity: 0, scores };
    }

    // 总情感强度 (0-1)
    const intensity = Math.min(1, topScore / 3);
    const polarityMap = {
      positive: SentimentPolarity.POSITIVE,
      negative: SentimentPolarity.NEGATIVE,
      praise: SentimentPolarity.PRAISE,
      complaint: SentimentPolarity.COMPLAINT,
      question: SentimentPolarity.QUESTION,
    };

    return {
      polarity: polarityMap[topType] || SentimentPolarity.NEUTRAL,
      intensity,
      scores,
    };
  }
}

// ── 评分引擎 ─────────────────────────────────────
class ScoringEngine {
  constructor(targetKeywords = [], opts = {}) {
    this.keywords = targetKeywords;
    this.opts = opts;
  }

  /**
   * 对评论进行综合评分 (0-100)
   */
  score(comment, sentiment) {
    const scores = {};

    // 1. 关键词匹配 (0-100)
    scores.keyword = this._keywordScore(comment.content);

    // 2. 发布时间新鲜度 (0-100)
    scores.publishTime = this._timeScore(comment.createdAt);

    // 3. 互动量 (0-100)
    scores.engagement = this._engagementScore(comment.metrics);

    // 4. 情感匹配 (0-100)
    scores.sentiment = this._sentimentWeight(sentiment);

    // 5. 用户质量 (0-100)
    scores.userQuality = this._userQualityScore(comment.author);

    // 加权总分
    const total = (
      scores.keyword * SCORING_WEIGHTS.keyword +
      scores.publishTime * SCORING_WEIGHTS.publishTime +
      scores.engagement * SCORING_WEIGHTS.engagement +
      scores.sentiment * SCORING_WEIGHTS.sentiment +
      scores.userQuality * SCORING_WEIGHTS.userQuality
    );

    return {
      total: Math.round(total),
      breakdown: scores,
      tier: total >= 70 ? 'S' : total >= 50 ? 'A' : total >= 30 ? 'B' : 'C',
    };
  }

  _keywordScore(content) {
    if (this.keywords.length === 0) return 50;
    const lower = content.toLowerCase();
    let matches = 0;
    for (const kw of this.keywords) {
      if (lower.includes(kw.toLowerCase())) matches++;
    }
    return Math.min(100, (matches / this.keywords.length) * 100);
  }

  _timeScore(createdAt) {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageMin = ageMs / 60000;
    // 指数衰减：5分钟内100分，1小时后~30分，24小时后~5分
    return Math.max(5, 100 * Math.exp(-ageMin / 180));
  }

  _engagementScore(metrics) {
    const total = (metrics.likes || 0) + (metrics.replies || 0) * 2 + (metrics.shares || 0) * 3;
    // 对数缩放
    return Math.min(100, Math.round(Math.log2(total + 1) * 10));
  }

  _sentimentWeight(sentiment) {
    // 负面情绪是高价值截流机会
    const weights = {
      complaint: 100,
      question: 85,
      negative: 80,
      neutral: 50,
      positive: 30,
      praise: 20,
    };
    return weights[sentiment.polarity] || 50;
  }

  _userQualityScore(author) {
    let score = 30;
    if (author.verified) score += 30;
    if (author.followers > 10000) score += 20;
    else if (author.followers > 1000) score += 15;
    else if (author.followers > 100) score += 10;
    return Math.min(100, score);
  }
}

// ── AI 回复生成器 ────────────────────────────────
class ReplyGenerator {
  generate(comment, sentiment, score) {
    const polarity = sentiment.polarity;
    const templates = REPLY_TEMPLATES[polarity] || REPLY_TEMPLATES.neutral;

    // 根据评分选择回复类型
    let selectedTemplates = templates;
    if (score.total >= 70) {
      // 高价值：增加个性化
      const mention = comment.author. ? `@${comment.author.} ` : '';
      const base = templates[Math.floor(Math.random() * templates.length)];
      return {
        text: mention + base,
        type: 'personalized',
        confidence: 0.9,
      };
    }

    // 普通：随机模板
    const template = templates[Math.floor(Math.random() * templates.length)];
    return {
      text: template,
      type: 'template',
      confidence: 0.7,
    };
  }

  /**
   * 批量生成回复
   */
  batchGenerate(comments) {
    return comments.map(c => ({
      commentId: c.comment.id,
      reply: this.generate(c.comment, c.sentiment, c.score),
    }));
  }
}

// ── 审核队列 ─────────────────────────────────────
class ReviewQueue {
  constructor() {
    this.pending = [];       // 待审核
    this.approved = [];      // 已通过
    this.rejected = [];      // 已拒绝
  }

  enqueue(comment, score, reply) {
    const item = {
      id: `rev_${Date.now()}_${crypto.randomBytes(3'hex')}`,
      comment,
      score,
      reply,
      status: 'pending',
      enqueuedAt: new Date().toISOString(),
    };
    this.pending.push(item);
    return item;
  }

  approve(reviewId) {
    const idx = this.pending.findIndex(r => r.id === reviewId);
    if (idx === -1) throw new Error(`审核项不存在: ${reviewId}`);
    const item = this.pending.splice(idx, 1)[0];
    item.status = 'approved';
    item.reviewedAt = new Date().toISOString();
    this.approved.push(item);
    return item;
  }

  reject(reviewId, reason = '') {
    const idx = this.pending.findIndex(r => r.id === reviewId);
    if (idx === -1) throw new Error(`审核项不存在: ${reviewId}`);
    const item = this.pending.splice(idx, 1)[0];
    item.status = 'rejected';
    item.reviewReason = reason;
    item.reviewedAt = new Date().toISOString();
    this.rejected.push(item);
    return item;
  }

  getStats() {
    return {
      pending: this.pending.length,
      approved: this.approved.length,
      rejected: this.rejected.length,
      autoApproved: this.approved.filter(a => a.autoApproved,
    };
  }
}

// ── SCRM 截流主引擎 ──────────────────────────────
class SCRMInterceptEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.keywords = opts.keywords || [];
    this.scoringEngine = new ScoringEngine(this.keywords, opts);
    this.sentimentAnalyzer = new SentimentAnalyzer();
    this.dedupEngine = new DedupEngine();
    this.replyGenerator = new ReplyGenerator();
    this.reviewQueue = new ReviewQueue();
    this.enableAutoReply = opts.enableAutoReply !== false;
    this.interceptHistory = [];
  }

  /**
   * 处理单条评论（完整截流流水线）
   */
  intercept(commentData) {
    const comment = commentData instanceof Comment ? commentData : new Comment(commentData);

    // 1. 去重检查
    const dupResult = this.dedupEngine.isDuplicate(comment);
    if (dupResult.duplicate) {
      this.emit('duplicate', { comment, reason: dupResult.reason });
      return { action: 'skip', reason: dupResult.reason, comment };
    }

    // 2. 情感分析
    const sentiment = this.sentimentAnalyzer.analyze(comment.content);

    // 3. 评分
    const score = this.scoringEngine.score(comment, sentiment);

    // 4. 生成回复
    const reply = this.replyGenerator.generate(comment, sentiment, score);

    // 5. 注册去重
    this.dedupEngine.(comment);

    // 6. 根据评分决定动作
    let action;
    if (score.tier === 'S' || score.tier === 'A') {
      // 高价值：入审核队列
      const reviewItem = this.reviewQueue.enqueue(comment, score, reply);
      action = 'review';
      this.emit('needsReview', reviewItem);
    } else if (this.enableAutoReply && score.tier === 'B') {
      // 中等：自动回复
      action = 'auto_reply';
    } else {
      // 低价值：跳过
      action = 'skip';
    }

    const result = { action, comment, sentiment, score, reply };
    this.interceptHistory.push(result);

    this.emit('intercepted', result);
    return result;
  }

  /**
   * 批量处理
   */
  batchIntercept(comments) {
    const results = [];
    for (const c of comments) {
      results.push(this.intercept(c));
    }
    this.emit('batchIntercepted', { total: comments.length, results });
    return results;
  }

  /**
   * 获取统计数据
   */
  getStats() {
    const actions = { review: 0, auto_reply: 0, skip: 0, duplicate: 0 };
    for (const h of this.interceptHistory) {
      if (h.action === 'skip' && h.reason) actions.duplicate++;
      else actions[h.action] = (actions[h.action] || 0) + 1;
    }

    return {
      totalIntercepted: this.interceptHistory.length,
      actions,
      reviewQueue: this.reviewQueue.getStats(),
      keywords: this.keywords,
      enableAutoReply: this.enableAutoReply,
    };
  }

  /**
   * 更新关键词
   */
  updateKeywords(keywords) {
    this.keywords = keywords;
    this.scoringEngine = new ScoringEngine(keywords);
    this.emit('keywordsUpdated', { keywords });
  }

  /**
   * 获取审核队列
   */
  getReviewQueue() {
    return {
      pending: this.reviewQueue.pending,
      approved: this.reviewQueue.approved,
      rejected: this.reviewQueue.rejected,
    };
  }

  /**
   * 批准回复
   */
  approveReply(reviewId) {
    return this.reviewQueue.approve(reviewId);
  }

  /**
   * 拒绝回复
   */
  rejectReply(reviewId, reason = '') {
    return this.reviewQueue.reject(reviewId, reason);
  }
}

module.exports = {
  SCRMInterceptEngine,
  Comment,
  SentimentAnalyzer,
  ScoringEngine,
  DedupEngine,
  ReplyGenerator,
  ReviewQueue,
  SentimentPolarity,
  SCORING_WEIGHTS,
};
