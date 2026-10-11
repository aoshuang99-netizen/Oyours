/**
 * content-pipeline.js — MSCMS v14 增强内容生成管线
 *
 * 将内容生成与数据追踪结合，集成以下模块：
 *   1. 平台内容规则检查（platform-content-rules.js）
 *   2. AI内容生成（aigc-content-generator.js）
 *   3. 去AI味处理（content-deai.js）
 *   4. 数据追踪与反馈循环
 *   5. 内容质量评分
 *   6. A/B测试变体生成
 *   7. 热点话题驱动
 *   8. 内容日历管理
 *
 * 参考最新自动化内容生产技术：
 *   - Chain-of-Thought 提示工程
 *   - 多轮迭代优化
 *   - 数据驱动的风格学习
 *   - 内容DNA变异生成
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { ContentRuleChecker } = require('./platform-content-rules.js');
const { DeAIProcessor } = require('./content-deai.js');
const { ContentPool } = require('./content-pool.js');

// ── 内容生成管线 ─────────────────────────────────────
class ContentPipeline extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.contentGenerator = opts.contentGenerator || null;  // AIGCContentGenerator
    this.contentIntelligence = opts.contentIntelligence || null;  // ContentIntelligence
    this.deaiProcessor = opts.deaiProcessor || new DeAIProcessor({
      llmEndpoint: opts.llmEndpoint || 'http://localhost:11434/api/generate',
      llmModel: opts.llmModel || 'qwen2.5:7b',
    });
    this.db = opts.db || null;

    // WorkBuddy 内容池
    this.contentPool = new ContentPool(opts.contentPoolDir || 'D:/MSCMS-Content/pool');

    // 数据驱动策略决定器（延迟注入）
    this.strategyDecider = opts.strategyDecider || null;

    // 数据追踪
    this.contentPerformance = new Map();   // contentId -> performance metrics
    this.styleLearning = new Map();        // platform -> learned style preferences
    this.topicTrends = new Map();          // topic -> trend score
    this.abTestResults = new Map();        // variantId -> performance

    // 管线配置
    this.config = {
      enableRuleCheck: true,               // 启用平台规则检查
      enableDeAI: true,                    // 启用去AI味
      enableDataTracking: true,            // 启用数据追踪
      enableABTest: true,                  // 启用A/B测试
      deAIIntensity: 'medium',             // 去AI味强度
      qualityThreshold: 60,                // 质量分数阈值
      maxRetries: 3,                       // 最大重试次数
    };

    // 统计
    this.stats = {
      totalGenerated: 0,
      totalPublished: 0,
      avgQualityScore: 0,
      avgAIScore: 0,
      topPerformingTopics: [],
      platformStats: {},
    };
  }

  // 完整内容生成管线
  async generateContent(platform, opts = {}) {
    const pipelineId = `pipe_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.emit('pipeline:started', { id: pipelineId, platform, opts });

    const stages = [];

    try {
      // Stage 1: 获取热点话题（如果可用）
      let topic = opts.topic;
      if (!topic && this.contentIntelligence) {
        topic = await this._getTrendingTopic(platform);
        stages.push({ stage: 'trend_analysis', result: { topic } });
      }
      topic = topic || { title: 'general interest', keywords: [], category: 'general' };

      // Stage 2: 平台规则预检查
      let ruleCheckResult = null;
      if (this.config.enableRuleCheck) {
        const checker = new ContentRuleChecker(platform);
        const eligibility = checker.checkAccountEligibility({
          age: opts.accountAge || 30,
          karma: opts.karma || { comment: 100, link: 50 },
        });
        ruleCheckResult = { eligibility, checker };
        stages.push({ stage: 'rule_precheck', result: eligibility });
      }

      // Stage 3: AI内容生成
      let content;
      if (this.contentGenerator) {
        const genResult = await this.contentGenerator.generate(platform, {
          topic: topic.title || topic,
          subreddit: opts.subreddit,
          tone: opts.tone,
          customInstructions: this._buildCustomInstructions(platform, opts),
          ...opts,
        });
        content = genResult.result;
      } else {
        content = this._fallbackGenerate(platform, topic, opts);
      }
      // 如果 AI 生成返回 null（Ollama 崩溃等）或返回的是错误响应/占位文本，使用本地 fallback
      // （fallback 带 fallback:true 标记 → 调用方跳过入库，错误响应绝不会进入内容库）
      if (!this._isUsableContent(content)) {
        content = this._fallbackGenerate(platform, topic, opts);
      }
      stages.push({ stage: 'ai_generation', result: { contentId: content?.id, qualityScore: content?.qualityScore } });

      // Stage 4: 平台内容规则检查
      if (this.config.enableRuleCheck && ruleCheckResult?.checker) {
        const checkResult = ruleCheckResult.checker.checkContent(content, {
          accountAge: opts.accountAge || 30,
          recentContent: this._getRecentContent(platform, 10),
          dailyPostCount: this._getDailyPostCount(platform),
          dailyActionCount: this._getDailyActionCount(platform),
        });
        stages.push({ stage: 'rule_check', result: { score: checkResult.score, passed: checkResult.passed } });

        if (!checkResult.passed) {
          // 重新生成或修改
          content = await this._fixContentIssues(content, checkResult, platform, opts);
        }
      }

      // Stage 5: 去AI味处理
      let deaiResult = null;
      if (this.config.enableDeAI) {
        deaiResult = await this.deaiProcessor.process(content, {
          platform,
          intensity: this.config.deAIIntensity,
          iterations: 2,
        });
        content = deaiResult.processed;
        stages.push({
          stage: 'deai',
          result: {
            originalScore: deaiResult.originalAIScore,
            finalScore: deaiResult.finalAIScore,
            improvement: deaiResult.improvementPercent,
          },
        });
      }

      // Stage 6: 质量评分
      const qualityScore = this._calculateQualityScore(content, platform, deaiResult);
      stages.push({ stage: 'quality_score', result: { score: qualityScore } });

      // Stage 7: A/B测试变体生成
      let variants = [];
      if (this.config.enableABTest && opts.generateVariants !== false) {
        variants = await this._generateVariants(content, platform, 2);
        stages.push({ stage: 'ab_test', result: { variantCount: variants.length } });
      }

      // Stage 8: 数据追踪标记
      const trackingId = this._createTrackingId();
      content.trackingId = trackingId;
      content.pipelineId = pipelineId;
      content.qualityScore = qualityScore;
      content.aiScore = deaiResult?.finalAIScore || 0;
      content.generatedAt = new Date().toISOString();
      content.platform = platform;
      content.topic = topic;

      // 记录到数据追踪
      if (this.config.enableDataTracking) {
        this._trackContent(content, { variants, stages });
      }

      // 更新统计
      this._updateStats(content, platform);

      const result = {
        pipelineId,
        content,
        variants,
        qualityScore,
        aiScore: deaiResult?.finalAIScore || 0,
        stages,
        recommendations: this._getRecommendations(content, platform),
      };

      this.emit('pipeline:completed', result);
      return result;

    } catch (e) {
      this.emit('pipeline:error', { id: pipelineId, error: e.message });
      throw e;
    }
  }

  // 批量生成内容
  async batchGenerate(platform, count, opts = {}) {
    const results = [];
    for (let i = 0; i < count; i++) {
      try {
        const result = await this.generateContent(platform, opts);
        results.push(result);
        // 间隔以避免速率限制
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      } catch (e) {
        results.push({ error: e.message, platform, index: i });
      }
    }
    return results;
  }

  // 获取热点话题
  async _getTrendingTopic(platform) {
    if (!this.contentIntelligence) return null;

    try {
      const trends = await this.contentIntelligence.getTrends(platform, 30);
      if (trends && trends.length > 0) {
        // S/A 级优先，且在其中「随机取一条」——
        // 原实现 `find(...) || trends[0]` 恒取排序第一条，导致所有账号
        // 的 topic 完全相同（topic 无分布）。真实数据下改为集合内随机。
        const preferred = trends.filter(t => t.level === 'S' || t.level === 'A');
        const pickFrom = preferred.length ? preferred : trends;
        const topTrend = pickFrom[Math.floor(Math.random() * pickFrom.length)];
        return {
          title: topTrend.title || topTrend.topic,
          keywords: topTrend.keywords || [],
          category: topTrend.category || 'trending',
          level: topTrend.level,
        };
      }
    } catch (e) {
      this.emit('trend:fallback', { error: e.message });
    }
    return null;
  }

  // 构建自定义指令
  _buildCustomInstructions(platform, opts) {
    const instructions = [];

    // 根据账号养号阶段调整内容
    if (opts.accountAge !== undefined) {
      if (opts.accountAge < 7) {
        instructions.push('Keep content casual and personal, like sharing daily life thoughts');
      } else if (opts.accountAge < 14) {
        instructions.push('Include some industry insights but keep it relatable');
      } else {
        instructions.push('Can include subtle promotional elements but prioritize value');
      }
    }

    // 根据数据反馈调整
    const stylePrefs = this.styleLearning.get(platform);
    if (stylePrefs) {
      if (stylePrefs.preferredLength) {
        instructions.push(`Aim for ${stylePrefs.preferredLength} characters based on past performance`);
      }
      if (stylePrefs.topKeywords && stylePrefs.topKeywords.length > 0) {
        instructions.push(`Consider incorporating themes: ${stylePrefs.topKeywords.slice(0, 3).join(', ')}`);
      }
    }

    return instructions.join('. ');
  }

  // 修复内容问题
  async _fixContentIssues(content, checkResult, platform, opts) {
    let fixed = { ...content };

    for (const issue of checkResult.issues) {
      this.emit('content:fixing', { issue });
    }

    for (const warning of checkResult.warnings) {
      // 移除banned hashtags
      if (warning.includes('banned hashtags')) {
        const text = fixed.body || fixed.text || fixed.caption || '';
        fixed.body = text.replace(/#\w+/g, match => {
          const banned = checkResult._bannedHashtags || [];
          return banned.some(b => match.toLowerCase().includes(b.toLowerCase())) ? '' : match;
        });
      }

      // 移除链接（新账号）
      if (warning.includes('新账号') && warning.includes('链接')) {
        const text = fixed.body || fixed.text || fixed.caption || '';
        fixed.body = text.replace(/https?:\/\/[^\s]+/g, '');
      }

      // 缩短内容
      if (warning.includes('过长')) {
        const text = fixed.body || fixed.text || fixed.caption || '';
        const specs = this._getPlatformSpecs(platform);
        if (specs.maxLength && text.length > specs.maxLength) {
          fixed.body = text.slice(0, specs.maxLength - 3) + '...';
        }
      }
    }

    // 移除推广内容（如果新账号）
    if (checkResult.recommendations.some(r => r.includes('推广'))) {
      const text = fixed.body || fixed.text || fixed.caption || '';
      const promoWords = ['buy', 'shop', 'discount', 'sale', 'order now', 'click here'];
      let cleaned = text;
      for (const word of promoWords) {
        cleaned = cleaned.replace(new RegExp(word, 'gi'), '');
      }
      fixed.body = cleaned;
    }

    return fixed;
  }

  _getPlatformSpecs(platform) {
    const specs = {
      reddit: { maxLength: 40000 },
      x: { maxLength: 280 },
      discord: { maxLength: 2000 },
      instagram: { maxLength: 2200 },
      tiktok: { maxLength: 2200 },
      facebook: { maxLength: 63206 },
      youtube: { maxLength: 5000 },
      tumblr: { maxLength: 4096 },
      // [NEWPLAT-2026-09-21]
      nostr: { maxLength: 2000 },
      bluesky: { maxLength: 300 },
      mastodon: { maxLength: 500 },
      telegram: { maxLength: 1000 },
      devto: { maxLength: 5000 },
      hashnode: { maxLength: 5000 },
      github: { maxLength: 2000 },
    };
    return specs[platform] || specs.reddit;
  }

  // 生成A/B测试变体
  async _generateVariants(content, platform, count = 2) {
    const variants = [];
    const originalText = content.body || content.text || content.caption || '';

    for (let i = 0; i < count; i++) {
      const variant = { ...content };
      variant.id = `${content.id || 'content'}_v${i + 1}`;
      variant.variantOf = content.id;

      // 变异策略
      const strategies = ['rewrite', 'restructure', 'retone'];
      const strategy = strategies[i % strategies.length];

      if (strategy === 'rewrite' && this.deaiProcessor) {
        const result = await this.deaiProcessor.process(content, {
          platform,
          intensity: 'strong',
          iterations: 1,
        });
        variant.body = result.processed.body || result.processed.text || originalText;
      } else if (strategy === 'restructure') {
        // 重组段落顺序
        const paragraphs = originalText.split(/\n\n+/);
        if (paragraphs.length > 1) {
          variant.body = [...paragraphs].reverse().join('\n\n');
        }
      } else if (strategy === 'retone') {
        // 调整语气
        variant.body = originalText
          .replace(/\./g, '!')
          .replace(/very/g, 'super')
          .replace(/good/g, 'awesome');
      }

      variant.variantStrategy = strategy;
      variants.push(variant);
    }

    return variants;
  }

  // 计算质量分数
  _calculateQualityScore(content, platform, deaiResult) {
    let score = 70; // 基础分

    const text = content.body || content.text || content.caption || '';
    const title = content.title || '';

    // 内容长度适当
    const specs = this._getPlatformSpecs(platform);
    if (text.length > specs.maxLength * 0.3 && text.length < specs.maxLength * 0.8) {
      score += 10;
    }

    // 有吸引力的标题
    if (title && title.length > 10 && title.length < 100) {
      score += 5;
    }

    // 包含问题（促进互动）
    if (text.includes('?')) {
      score += 5;
    }

    // 去AI味分数
    if (deaiResult) {
      if (deaiResult.finalAIScore < 15) score += 10;
      else if (deaiResult.finalAIScore < 30) score += 5;
      else score -= 5;
    }

    // 个性化表达
    const personalPronouns = (text.match(/\b(I|me|my|we|our)\b/gi) || []).length;
    if (personalPronouns > 2) score += 5;

    // 句长多样化
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    if (sentences.length > 2) {
      const lengths = sentences.map(s => s.trim().split(/\s+/).length);
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const variance = lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length;
      if (Math.sqrt(variance) / avg > 0.3) score += 5; // 句长变化大
    }

    return Math.min(100, Math.max(0, score));
  }

  // 数据追踪
  _trackContent(content, metadata) {
    const trackingData = {
      contentId: content.trackingId,
      platform: content.platform,
      topic: content.topic,
      qualityScore: content.qualityScore,
      aiScore: content.aiScore,
      generatedAt: content.generatedAt,
      variants: metadata.variants?.length || 0,
      stages: metadata.stages,
      performance: {
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        clicks: 0,
        conversionRate: 0,
      },
      published: false,
      publishedAt: null,
    };

    this.contentPerformance.set(content.trackingId, trackingData);
  }

  // 更新内容性能数据
  updateContentPerformance(contentId, metrics) {
    const data = this.contentPerformance.get(contentId);
    if (!data) return;

    data.performance = { ...data.performance, ...metrics };
    data.lastUpdated = new Date().toISOString();

    // 学习风格偏好
    this._learnStylePreferences(data);

    this.emit('performance:updated', data);
  }

  // 风格学习
  _learnStylePreferences(contentData) {
    const platform = contentData.platform;
    const perf = contentData.performance;

    // 只从高表现内容中学习
    if (perf.likes + perf.comments + perf.shares < 10) return;

    const prefs = this.styleLearning.get(platform) || {
      preferredLength: null,
      topKeywords: [],
      bestPostingTime: null,
      avgEngagement: 0,
    };

    // 更新偏好
    const text = contentData.content?.body || '';
    if (text.length > 0) {
      prefs.preferredLength = Math.round((prefs.preferredLength || text.length) * 0.7 + text.length * 0.3);
    }

    prefs.avgEngagement = (prefs.avgEngagement || 0) * 0.8 + (perf.likes + perf.comments) * 0.2;

    this.styleLearning.set(platform, prefs);
    this.emit('style:learned', { platform, prefs });
  }

  // 获取建议
  _getRecommendations(content, platform) {
    const recs = [];

    if (content.qualityScore < 70) {
      recs.push('内容质量分数较低，建议重新生成或修改');
    }
    if (content.aiScore > 30) {
      recs.push('AI痕迹较明显，建议加强去AI味处理');
    }

    const stylePrefs = this.styleLearning.get(platform);
    if (stylePrefs) {
      if (stylePrefs.avgEngagement > 50) {
        recs.push(`该平台历史表现良好，可以适当增加发布频率`);
      }
    }

    return recs;
  }

  /**
   * P0 止血：AI 产物可用性校验
   * ---------------------------------------------------------------
   * 背景：外部 AI 服务异常时返回 "400 Bad Request" / "Auto-generated content" 等错误文本，
   * 因其非 null，原先 `if (!content)` 不会触发兜底，错误响应被当成正常内容一路入库并发布。
   * 这里把「判空」升级为「判有效性」：不可用时走 _fallbackGenerate（带 fallback:true 标记，
   * 调用方据此跳过入库，绝不把错误响应写进内容库）。
   */
  _isUsableContent(content) {
    if (!content) return false;
    const body = String(content.body || content.text || '').trim();
    const title = String(content.title || '').trim();
    if (body.length < 30) return false;                       // 正文过短 = 非真实内容
    const GARBLED_RE = /^(400|401|403|404|405|408|429|500|502|503|504)\b|bad request|auto-generated|internal server error|service unavailable|unauthorized|forbidden|not found|gateway|error occurred|timed? ?out|undefined|null/i;
    if (GARBLED_RE.test((title + ' ' + body).trim())) return false;
    const PLACEHOLDER_RE = /^post for\s+[\w-]+$/i;
    if (PLACEHOLDER_RE.test(title || body)) return false;
    return true;
  }

  // 备选生成 — 从 WorkBuddy 内容池读取真实内容
  _fallbackGenerate(platform, topic, opts) {
    // 从内容池获取预生成的真实内容
    const pooled = this.contentPool.getContent(platform);
    if (pooled) {
      return {
        id: `content_pool_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        platform,
        title: pooled.title,
        body: pooled.body,
        text: pooled.text || pooled.body,
        topic: pooled.topic || (typeof topic === 'string' ? topic : 'general'),
        tone: pooled.tone || 'neutral',
        hashtags: pooled.hashtags || [],
        quality_score: 75,
        content_type: opts.contentType || 'text',
        source: 'workbuddy-pool',
        pool_index: pooled.pool_index,
      };
    }

    // 兜底：返回标记为不可用的结果
    return {
      id: `content_unavailable_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      platform,
      fallback: true,
      error: `Content pool exhausted for platform=${platform}`,
      title: null, body: null, text: null,
      quality_score: 0,
      content_type: 'unavailable',
    };
  }

  _createTrackingId() {
    return `track_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  _getRecentContent(platform, count) {
    const recent = [];
    for (const [, data] of this.contentPerformance) {
      if (data.platform === platform) {
        recent.push({ id: data.contentId, body: data.content?.body || '' });
      }
    }
    return recent.slice(-count);
  }

  _getDailyPostCount(platform) {
    const today = new Date().toDateString();
    let count = 0;
    for (const [, data] of this.contentPerformance) {
      if (data.platform === platform && new Date(data.generatedAt).toDateString() === today) {
        count++;
      }
    }
    return count;
  }

  _getDailyActionCount(platform) {
    return this._getDailyPostCount(platform) * 10; // 估算
  }

  _updateStats(content, platform) {
    this.stats.totalGenerated++;

    if (!this.stats.platformStats[platform]) {
      this.stats.platformStats[platform] = { count: 0, avgQuality: 0, avgAIScore: 0 };
    }
    const ps = this.stats.platformStats[platform];
    ps.count++;
    ps.avgQuality = (ps.avgQuality * (ps.count - 1) + content.qualityScore) / ps.count;
    ps.avgAIScore = (ps.avgAIScore * (ps.count - 1) + (content.aiScore || 0)) / ps.count;

    this.stats.avgQualityScore = (this.stats.avgQualityScore * (this.stats.totalGenerated - 1) + content.qualityScore) / this.stats.totalGenerated;
    this.stats.avgAIScore = (this.stats.avgAIScore * (this.stats.totalGenerated - 1) + (content.aiScore || 0)) / this.stats.totalGenerated;
  }

  // 获取管线报告
  getReport() {
    return {
      stats: this.stats,
      contentCount: this.contentPerformance.size,
      styleLearning: Object.fromEntries(this.styleLearning),
      topPerforming: Array.from(this.contentPerformance.values())
        .filter(c => c.performance.likes + c.performance.comments > 0)
        .sort((a, b) => (b.performance.likes + b.performance.comments) - (a.performance.likes + a.performance.comments))
        .slice(0, 5)
        .map(c => ({ contentId: c.contentId, platform: c.platform, engagement: c.performance.likes + c.performance.comments })),
    };
  }
}

module.exports = { ContentPipeline };
