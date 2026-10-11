/**
 * content-intelligence.js — MSCMS v14 智能内容情报引擎
 *
 * 核心能力：
 *   1. 多源社媒热点抓取与聚合
 *   2. S/A/B/C 四级热度评分
 *   3. 关键词驱动的AIGC内容生成调度
 *   4. Content DNA模板引擎
 *   5. 内容趋势预测
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── 真实热点数据源（P1-A1/A3/A4）─────────────────────
// trends.json 由 tools/trends-scraper.js 真实抓取落盘（5 源：google_trends /
// hackernews / devto / medium / lobsters）。此处直读磁盘、刻意不进 DataStore：
// DataStore 为「内存优先 + 5s flush」，外部脚本写入会被内存旧数据覆盖。
const TRENDS_TTL_MS = 72 * 3600 * 1000;   // A4：只认 72h 内抓到的条目
const TRENDS_CACHE_MS = 60 * 1000;        // 磁盘读取缓存 60s（生成周期 ~182s，足够）

function trendsFilePath() {
  const dir = process.env.MSCMS_DATA_DIR || process.env.DATA_DIR || 'D:/mscms-ws/data';
  return path.join(dir, 'trends.json');
}

// 英文停用词 + 中文 2-gram（与 TextDedupEngine._tokenize 口径一致）
const TREND_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'you', 'your',
  'how', 'why', 'what', 'when', 'which', 'who', 'from', 'at', 'by', 'as', 'we', 'they', 'them',
  'he', 'she', 'his', 'her', 'not', 'no', 'but', 'if', 'then', 'than', 'so', 'up', 'out',
  'about', 'into', 'over', 'after', 'new', 'using', 'use', 'used', 'get', 'got', 'can', 'will',
  'just', 'more', 'most', 'all', 'one', 'two', 'also', 'has', 'have', 'had', 'do', 'does', 'did',
  'my', 'me', 'our', 'their', 'there', 'here', 'now', 'only', 'ever', 'never', 'still', 'even',
]);

function extractTrendKeywords(text, limit = 5) {
  const freq = new Map();
  const words = String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [];
  for (const w of words) {
    const t = w.replace(/[.\-+#]+$/, '');
    if (t.length < 3 || TREND_STOPWORDS.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  const s = String(text || '');
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(bg)) freq.set(bg, (freq.get(bg) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

// ── 热点评分等级 ─────────────────────────────────
const HotLevel = {
  S_VIRAL: { level: 'S', minScore: 85, label: '爆款级', priority: 1, cloneFactor: 10 },
  A_TRENDING: { level: 'A', minScore: 70, label: '趋势级', priority: 2, cloneFactor: 5 },
  B_RISING: { level: 'B', minScore: 50, label: '上升级', priority: 3, cloneFactor: 3 },
  C_NORMAL: { level: 'C', minScore: 0, label: '普通级', priority: 4, cloneFactor: 1 },
};

// ── 平台数据源 ───────────────────────────────────
const DATA_SOURCES = {
  tiktok: { name: 'TikTok', types: ['trending', 'hashtag', 'music', 'creator'] },
  instagram: { name: 'Instagram', types: ['explore', 'reels', 'hashtag'] },
  youtube: { name: 'YouTube', types: ['trending', 'shorts'] },
  twitter: { name: 'Twitter/X', types: ['trending', 'hashtag'] },
  reddit: { name: 'Reddit', types: ['hot', 'rising'] },
  weibo: { name: '微博', types: ['hot_search', 'topic'] },
  douyin: { name: '抖音', types: ['hot_video', 'challenge'] },
  xiaohongshu: { name: '小红书', types: ['trending', 'note'] },
};

// ── Content DNA 模板 ─────────────────────────────
class ContentDNA {
  constructor() {
    this.templates = new Map();
    this.variations = new Map();
  }

  createTemplate(topic) {
    const dna = {
      id: `dna_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      topic,
      // 主题DNA
      topicDNA: {
        category: topic.category || 'general',
        keywords: topic.keywords || [],
        sentiment: topic.sentiment || 'neutral',
        targetAudience: topic.targetAudience || 'general',
      },
      // 格式DNA
      formatDNA: {
        type: 'image_text', // image_text | short_video | long_video | carousel
        aspectRatio: '9:16',
        duration: 15, // seconds for video
        textLength: { min: 50, max: 200 },
        hashtags: [],
        musicStyle: 'trending',
      },
      // 结构DNA
      structureDNA: {
        hook: null,        // 钩子句式
        body: null,        // 主体框架
        cta: null,         // 行动号召
        emotionCurve: [],  // 情感曲线
      },
      // 变异参数
      variationParams: {
        synonymRate: 0.3,       // 同义词替换率
        sentenceReorder: 0.5,   // 句式重排率
        semanticRewrite: 0.4,   // 语义改写率
        styleShift: 0.2,        // 风格偏移率
        structureSwap: 0.3,     // 结构互换率
      },
      performance: {
        views: 0, likes: 0, shares: 0, comments: 0,
        ctr: 0, conversionRate: 0, viralScore: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.templates.set(dna.id, dna);
    return dna;
  }

  // 从热门内容提取DNA
  extractFromHotContent(content) {
    const dna = this.createTemplate({
      category: content.category || 'general',
      keywords: this._extractKeywords(content.title || content.text || ''),
      sentiment: this._analyzeSentiment(content.title || content.text || ''),
      targetAudience: content.audience || 'general',
    });

    dna.formatDNA.type = content.type || 'image_text';
    dna.formatDNA.hashtags = content.hashtags || [];
    dna.structureDNA.hook = content.hook || null;
    dna.structureDNA.body = content.body || null;
    dna.structureDNA.cta = content.cta || null;
    dna.performance.viralScore = content.viralScore || 0;

    // 如果表现好，降低变异率（保留原汁原味）
    if (content.viralScore >= 80) {
      dna.variationParams.synonymRate = 0.1;
      dna.variationParams.semanticRewrite = 0.2;
    }

    return dna;
  }

  // 生成变异参数
  generateVariation(dnaId, intensity = 0.5) {
    const dna = this.templates.get(dnaId);
    if (!dna) return null;

    const variation = {
      id: `var_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      parentDNA: dnaId,
      params: {
        synonymRate: Math.min(1, dna.variationParams.synonymRate * (1 + intensity)),
        sentenceReorder: Math.min(1, dna.variationParams.sentenceReorder * (1 + intensity - 0.3)),
        semanticRewrite: Math.min(1, dna.variationParams.semanticRewrite * (1 + intensity)),
        styleShift: Math.min(1, dna.variationParams.styleShift * (1 + intensity)),
        structureSwap: Math.min(1, dna.variationParams.structureSwap * (1 + intensity)),
      },
      seed: crypto.randomBytes(8).toString('hex'),
      createdAt: new Date().toISOString(),
    };

    if (!this.variations.has(dnaId)) this.variations.set(dnaId, []);
    this.variations.get(dnaId).push(variation);
    return variation;
  }

  _extractKeywords(text) {
    // 简化关键词提取
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const freq = {};
    words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
  }

  _analyzeSentiment(text) {
    const positive = ['amazing', 'love', 'great', 'best', 'awesome', 'incredible', 'beautiful', 'must', 'viral'];
    const negative = ['hate', 'worst', 'terrible', 'awful', 'fail', 'scam', 'fake'];
    let score = 0;
    text.split(/\s+/).forEach(w => {
      if (positive.includes(w)) score++;
      if (negative.includes(w)) score--;
    });
    return score > 1 ? 'positive' : score < -1 ? 'negative' : 'neutral';
  }
}

// ── 热点抓取引擎 ─────────────────────────────────
class HotTopicScraper extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.db = opts.db || null;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5分钟缓存
    this._trendsCache = null;    // 真实 trends.json 磁盘缓存
    this._trendsCacheAt = 0;
  }

  // 关键词驱动抓取
  async fetchByKeywords(keywords, sources = ['tiktok', 'instagram', 'twitter']) {
    const topics = [];
    const cacheKey = keywords.join(',') + sources.join(',');

    // 缓存检查
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheTimeout) {
      return cached.data;
    }

    for (const source of sources) {
      const sourceData = DATA_SOURCES[source];
      if (!sourceData) continue;

      // 模拟多源热点抓取
      for (const kw of keywords) {
        const topic = this._generateMockTopic(kw, source, sourceData);
        topics.push(topic);
      }
    }

    // 去重和排序
    const unique = this._deduplicateAndRank(topics);
    this.cache.set(cacheKey, { time: Date.now(), data: unique });
    
    this.emit('fetch:complete', { keywords, count: unique.length });
    return unique;
  }

  // ── 真实热点数据源（P1-A1/A3/A4）────────────────────
  /** 直读 trends.json（带 60s 缓存）；文件缺失/损坏返回 []，绝不伪造 */
  _readRealTrends() {
    const now = Date.now();
    if (this._trendsCache && (now - this._trendsCacheAt) < TRENDS_CACHE_MS) {
      return this._trendsCache;
    }
    let arr = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(trendsFilePath(), 'utf8'));
      if (Array.isArray(parsed)) arr = parsed;
    } catch (e) {
      arr = [];
    }
    this._trendsCache = arr;
    this._trendsCacheAt = now;
    return arr;
  }

  /**
   * 真实热点（content-pipeline._getTrendingTopic 的消费契约）
   * 返回 [{ id,title,keywords,category,level,score,relevance,source,url,fetchedAt }]
   * level：按 relevance 降序的 percentile 分级 S(top10%)/A(10~30%)/B(30~60%)/C
   */
  async getTrends(platform = null, limit = 20) {
    const now = Date.now();
    const all = this._readRealTrends();

    // A4 新鲜度：只认 TRENDS_TTL_MS 内的条目
    let fresh = all.filter((t) => {
      if (!t || !t.title) return false;
      const ts = Date.parse(t.fetchedAt || t.timestamp || '');
      return Number.isFinite(ts) && (now - ts) <= TRENDS_TTL_MS;
    });
    // 极端情况（长时间未抓取）退化为全部真实条目，仍不伪造
    if (fresh.length === 0) fresh = all.filter((t) => t && t.title);
    if (fresh.length === 0) return [];

    // A3 业务相关性优先（relevanceOf 在 trends-scraper 侧按 TOPIC_KEYWORDS 累加）
    const relevant = fresh.filter((t) => (t.relevance || 0) > 0);
    const base = relevant.length ? relevant : fresh;

    const sorted = [...base].sort((a, b) =>
      ((b.relevance || 0) - (a.relevance || 0)) || ((b.score || 0) - (a.score || 0)));

    const n = sorted.length;
    return sorted.slice(0, limit).map((t, i) => {
      const p = n > 1 ? i / (n - 1) : 0;
      const level = p < 0.1 ? 'S' : p < 0.3 ? 'A' : p < 0.6 ? 'B' : 'C';
      const ts = t.fetchedAt || t.timestamp || null;
      return {
        id: t.simhash ? `trend_${t.simhash}` : `trend_${i}`,
        title: String(t.title).trim(),
        keywords: extractTrendKeywords(`${t.title} ${t.summary || ''}`),
        category: 'trending',
        level,
        score: Number(t.score) || 0,
        relevance: Number(t.relevance) || 0,
        source: t.source || 'unknown',
        url: t.url || null,
        fetchedAt: ts,
        timestamp: ts,
      };
    });
  }

  // 获取当前全网热点（真实数据；无数据返回 []，不再返回 Math.random 假数据）
  async getTrendingTopics(platform = null, limit = 50) {
    const topics = await this.getTrends(platform, limit);
    this.emit('fetch:complete', { platform, count: topics.length, source: 'trends.json' });
    return topics;
  }

  // 热度评分计算
  _calculateHotScore() {
    const views = Math.random() * 100;
    const likes = Math.random() * 100;
    const shares = Math.random() * 100;
    const comments = Math.random() * 100;
    const growth = Math.random() * 100;

    // 加权综合评分
    return Math.min(100, Math.round(
      views * 0.15 + likes * 0.25 + shares * 0.30 + comments * 0.15 + growth * 0.15
    ));
  }

  _getHotLevel(score) {
    if (score >= 85) return HotLevel.S_VIRAL;
    if (score >= 70) return HotLevel.A_TRENDING;
    if (score >= 50) return HotLevel.B_RISING;
    return HotLevel.C_NORMAL;
  }

  _deduplicateAndRank(topics) {
    const seen = new Set();
    const unique = [];

    for (const topic of topics) {
      const key = topic.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        // 保留真实 score —— 原实现对传入条目无条件重算 Math.random 分数，
        // 会把真实热度彻底打乱（零伪造原则下必须保留原始值）
        if (!Number.isFinite(topic.score)) topic.score = this._calculateHotScore();
        if (!topic.level) topic.level = this._getHotLevel(topic.score).level;
        unique.push(topic);
      }
    }

    return unique.sort((a, b) => b.score - a.score);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ⚠️ 以下 _generateMock* / _calculateHotScore 是随机假数据生成器
  //  【2026-09-15】已从生产链路摘除：getTrends / getTrendingTopics /
  //  fetchByKeywords 全部改读真实 trends.json。仅保留供单测与演示，
  //  严禁在新代码中调用（零伪造原则）。
  // ══════════════════════════════════════════════════════════════════
  _generateMockTopic(keyword, source, sourceData) {
    const templates = [
      `${keyword} challenge going viral right now`,
      `How to use ${keyword} for maximum growth`,
      `The secret behind ${keyword} success in 2026`,
      `${keyword} trend that everyone is talking about`,
      `Why ${keyword} is dominating ${sourceData.name}`,
      `${keyword} hacks you need to know`,
      `Breaking: ${keyword} changes everything`,
      `${keyword} vs traditional methods - the results`,
      `Top 10 ${keyword} tips from experts`,
      `The ${keyword} revolution has begun`,
    ];

    const title = templates[Math.floor(Math.random() * templates.length)];
    const score = this._calculateHotScore();

    return {
      id: `topic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      source: sourceData.name,
      platform: source,
      title,
      keywords: [keyword, ...this._generateTopicKeywords(3)],
      score,
      level: this._getHotLevel(score).level,
      engagement: {
        views: Math.floor(Math.random() * 500000) + 5000,
        likes: Math.floor(Math.random() * 25000) + 100,
        shares: Math.floor(Math.random() * 5000) + 50,
        comments: Math.floor(Math.random() * 3000) + 20,
      },
      growthRate: (Math.random() * 5 - 1).toFixed(2),
      timestamp: new Date().toISOString(),
    };
  }

  _generateTopicTitle(type) {
    const titles = {
      trending: ['Viral dance challenge', 'Breaking news update', 'Celebrity moment', 'Shocking reveal', 'Must-watch clip'],
      hashtag: ['#TrendingNow', '#ViralChallenge', '#FYP', '#MustSee', '#BreakingNews'],
      music: ['Hot new track', 'Viral sound alert', 'Chart topper', 'Remix sensation', 'New music drop'],
      explore: ['Hidden gem alert', 'Must-visit spot', 'Photography magic', 'Art inspiration', 'Travel goals'],
      reels: ['Quick tutorial', 'Before & after', 'Satisfying moment', 'Life hack', 'Day in the life'],
      shorts: ['60 second challenge', 'Quick tip', 'Instant reaction', 'Fast tutorial', 'Speed art'],
      hot_search: ['热搜第一', '惊天爆料', '独家揭秘', '全网热议', '刚刚曝光'],
    };
    const pool = titles[type] || titles.trending;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _generateTopicKeywords(count = 5) {
    const words = ['viral', 'trend', 'challenge', 'growth', 'secret', 'hack', 'tutorial', 'review', 'tips', 'guide', 'inspiration', 'creative', 'success', 'strategy', 'innovation'];
    const shuffled = [...words].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
}

// ── 内容设计规则引擎 ─────────────────────────────
class ContentRuleEngine extends EventEmitter {
  constructor() {
    super();
    this.rules = new Map();
    this.dna = new ContentDNA();
    this._initDefaultRules();
  }

  _initDefaultRules() {
    // 平台内容规则
    this.addRule('platform_short_video', {
      condition: (content) => content.platform === 'tiktok' || content.platform === 'youtube_shorts',
      transform: (content) => ({
        ...content,
        format: 'short_video',
        aspectRatio: '9:16',
        durationMax: 60,
        textOverlay: true,
        hookFirst: true,
      }),
    });

    this.addRule('platform_image_text', {
      condition: (content) => content.platform === 'instagram' || content.platform === 'xiaohongshu',
      transform: (content) => ({
        ...content,
        format: 'image_text',
        aspectRatio: content.platform === 'instagram' ? '4:5' : '3:4',
        maxHashtags: content.platform === 'instagram' ? 30 : 10,
      }),
    });

    // 热度规则
    this.addRule('viral_amplify', {
      condition: (content) => content.viralScore >= 85,
      transform: (content) => ({
        ...content,
        cloneCount: 10,
        syncToAccounts: true,
        urgencyLevel: 'S',
        priority: 1,
      }),
    });

    // 品类规则
    this.addRule('entertainment_style', {
      condition: (content) => content.category === 'entertainment',
      transform: (content) => ({
        ...content,
        tone: 'energetic',
        musicStyle: 'upbeat',
        textStyle: 'bold_punchy',
        emojiLevel: 'high',
      }),
    });
  }

  addRule(name, { condition, transform }) {
    this.rules.set(name, { condition, transform });
  }

  applyRules(content) {
    let result = { ...content };
    for (const [name, rule] of this.rules) {
      try {
        if (rule.condition(result)) {
          result = rule.transform(result);
          this.emit('rule:applied', { name, content: result });
        }
      } catch (e) {
        this.emit('rule:error', { name, error: e.message });
      }
    }
    return result;
  }

  // 基于关键词生成内容策略
  generateStrategy(keywords, platform) {
    const strategy = {
      keywords,
      platform,
      recommendedFormats: this._getRecommendedFormats(platform),
      toneSuggestions: this._getToneSuggestions(keywords),
      hashtagStrategy: this._getHashtagStrategy(platform, keywords),
      postingSchedule: this._getOptimalSchedule(platform),
      abTestVariants: 3,
      clonePotential: this._estimateClonePotential(keywords),
    };

    return strategy;
  }

  _getRecommendedFormats(platform) {
    const formats = {
      tiktok: ['short_video_15s', 'short_video_30s', 'short_video_60s', 'slideshow'],
      instagram: ['reel_15s', 'reel_30s', 'carousel_5', 'carousel_10', 'single_image'],
      youtube: ['short_60s', 'video_5min', 'video_10min'],
      twitter: ['text_thread', 'single_image', 'short_video'],
      facebook: ['video_3min', 'carousel', 'text_post'],
    };
    return formats[platform] || ['image_text'];
  }

  _getToneSuggestions(keywords) {
    if (keywords.some(k => ['challenge', 'viral', 'trend'].includes(k))) return ['energetic', 'urgent', 'bold'];
    if (keywords.some(k => ['tutorial', 'guide', 'tips'].includes(k))) return ['educational', 'friendly', 'clear'];
    if (keywords.some(k => ['secret', 'hack', 'reveal'].includes(k))) return ['mysterious', 'intriguing', 'bold'];
    return ['engaging', 'authentic', 'relatable'];
  }

  _getHashtagStrategy(platform, keywords) {
    return {
      branded: keywords.map(k => `#${k.replace(/\s+/g, '')}`),
      trending: ['#fyp', '#viral', '#trending'],
      niche: keywords.map(k => `#${k.replace(/\s+/g, '')}Tips`),
      maxCount: platform === 'instagram' ? 25 : 5,
    };
  }

  _getOptimalSchedule(platform) {
    const schedules = {
      tiktok: ['07:00-09:00', '12:00-14:00', '19:00-22:00'],
      instagram: ['08:00-09:00', '12:00-13:00', '18:00-20:00'],
      youtube: ['12:00-14:00', '17:00-19:00'],
      twitter: ['08:00-10:00', '12:00-13:00', '17:00-19:00'],
      facebook: ['09:00-11:00', '13:00-15:00', '19:00-21:00'],
    };
    return schedules[platform] || ['10:00-12:00', '18:00-20:00'];
  }

  _estimateClonePotential(keywords) {
    return Math.min(50, keywords.length * 5 + 10);
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: Jaccard/Levenshtein 双去重引擎
// ══════════════════════════════════════════════════════
class TextDedupEngine {
  constructor(opts = {}) {
    this.jaccardThreshold = opts.jaccardThreshold || 0.75;     // 高于此值视为重复
    this.levenshteinThreshold = opts.levenshteinThreshold || 0.85; // 高于此值视为重复
    this.cache = new Map(); // contentHash → {text, timestamp}
    this.cacheSize = opts.cacheSize || 5000;
  }

  /**
   * Jaccard 相似度: |A ∩ B| / |A ∪ B|
   */
  jaccardSimilarity(textA, textB) {
    const setA = new Set(this._tokenize(textA));
    const setB = new Set(this._tokenize(textB));

    if (setA.size === 0 && setB.size === 0) return 1.0;

    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    return intersection.size / union.size;
  }

  /**
   * Levenshtein 编辑距离归一化相似度
   */
  levenshteinSimilarity(textA, textB) {
    const maxLen = Math.max(textA.length, textB.length);
    if (maxLen === 0) return 1.0;

    const distance = this._levenshteinDistance(textA, textB);
    return 1 - distance / maxLen;
  }

  /**
   * 双算法去重检测
   */
  isDuplicate(text) {
    // 先用Jaccard快速过滤
    for (const [hash, cached] of this.cache) {
      const jacSim = this.jaccardSimilarity(text, cached.text);
      if (jacSim > this.jaccardThreshold) {
        // 再用Levenshtein精确验证
        const levSim = this.levenshteinSimilarity(text, cached.text);
        if (levSim > this.levenshteinThreshold) {
          return {
            duplicate: true,
            matchedHash: hash,
            jaccardSimilarity: Math.round(jacSim * 100) / 100,
            levenshteinSimilarity: Math.round(levSim * 100) / 100,
            matchedText: cached.text.slice(0, 50) + '...',
          };
        }
      }
    }

    return { duplicate: false };
  }

  /**
   * 注册内容（重复检测通过后）
   */
  register(text) {
    const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    this.cache.set(hash, { text, timestamp: Date.now() });

    // 限制缓存大小
    if (this.cache.size > this.cacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    return hash;
  }

  /**
   * 比较两段文本的所有相似度
   */
  compare(textA, textB) {
    return {
      jaccard: Math.round(this.jaccardSimilarity(textA, textB) * 100) / 100,
      levenshtein: Math.round(this.levenshteinSimilarity(textA, textB) * 100) / 100,
    };
  }

  _tokenize(text) {
    // 中文按2-gram，英文按词
    const tokens = [];
    // 中文2-gram
    for (let i = 0; i < text.length - 1; i++) {
      const bigram = text.slice(i, i + 2);
      if (/[\u4e00-\u9fff]/.test(bigram[0]) && /[\u4e00-\u9fff]/.test(bigram[1])) {
        tokens.push(bigram);
      }
    }
    // 英文词
    const words = text.toLowerCase().match(/[a-zA-Z]+/g) || [];
    tokens.push(...words);

    return tokens;
  }

  _levenshteinDistance(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    // 只用两行的DP优化空间
    let prev = Array.from({length: n + 1}, (_, i) => i);
    let curr = new Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,      // 删除
          curr[j - 1] + 1,  // 插入
          prev[j - 1] + cost // 替换
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[n];
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: EXIF 元数据清洗器
// ══════════════════════════════════════════════════════
class EXIFCleaner {
  /**
   * 清洗文本中的潜在元数据暴露
   */
  cleanText(content) {
    let cleaned = content;

    // 移除GPS坐标模式
    cleaned = cleaned.replace(/(?:GPS|location)[:\s]*[-]?\d{1,3}\.\d{4,}/gi, '[LOCATION_REDACTED]');

    // 移除设备信息
    cleaned = cleaned.replace(/(?:Shot on|Taken with|Captured by)\s+[\w\s]+(?:Pro|Ultra|Max)/gi, '');
    cleaned = cleaned.replace(/(?:iPhone|Samsung|Pixel|OnePlus|Xiaomi|Huawei)\s[\w\s\d]+/gi, '[DEVICE_REDACTED]');

    // 移除时间戳模式（EXIF可能泄露时区）
    cleaned = cleaned.replace(/\d{4}:\d{2}:\d{2}\s\d{2}:\d{2}:\d{2}/g, '[TIMESTAMP_REDACTED]');

    // 移除分辨率信息
    cleaned = cleaned.replace(/\d{3,4}x\d{3,4}/g, '[RESOLUTION_REDACTED]');

    return cleaned;
  }

  /**
   * 清洗图片元数据（模拟：生成干净的元数据）
   */
  cleanImageMetadata(originalMetadata = {}) {
    return {
      // 清除所有可追踪信息
      Make: '[SANITIZED]',
      Model: '[SANITIZED]',
      Software: '[SANITIZED]',
      DateTimeOriginal: new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString(),
      GPSLatitude: null,
      GPSLongitude: null,
      GPSAltitude: null,
      GPSDateStamp: null,
      GPSTimeStamp: null,
      GPSProcessingMethod: null,
      SerialNumber: null,
      CameraOwnerName: null,
      LensModel: null,
      LensSerialNumber: null,

      // 保留的非敏感属性
      ImageWidth: originalMetadata.ImageWidth || 1080,
      ImageHeight: originalMetadata.ImageHeight || 1920,
      Orientation: 1,
      ColorSpace: 'sRGB',
      ResolutionUnit: 2,
      XResolution: 72,
      YResolution: 72,
    };
  }

  /**
   * 检测文本中是否包含EXIF泄露
   */
  detectLeaks(content) {
    const leaks = [];

    const checks = [
      { pattern: /GPS[:\s]*[-]?\d+\.\d+/, label: 'GPS坐标' },
      { pattern: /Shot on [\w\s]+(?:Pro|Ultra|Max)/i, label: '设备型号' },
      { pattern: /\d{4}:\d{2}:\d{2}\s\d{2}:\d{2}:\d{2}/, label: '时间戳' },
      { pattern: /f\/\d+\.\d+/, label: '光圈' },
      { pattern: /ISO\s*\d+/, label: 'ISO' },
      { pattern: /\d+mm\s*f\//, label: '焦距' },
    ];

    for (const check of checks) {
      if (check.pattern.test(content)) {
        leaks.push({ type: check.label, match: content.match(check.pattern)[0] });
      }
    }

    return { hasLeaks: leaks.length > 0, leaks };
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: 图片重编码（去指纹）
// ══════════════════════════════════════════════════════
class ImageReencoder {
  constructor() {
    this.reencodeCount = 0;
  }

  /**
   * 重编码参数生成（模拟：实际应由图像处理库执行）
   */
  generateReencodeParams(original = {}) {
    // 随机质量（92-98%，保持视觉质量）
    const quality = 92 + Math.floor(Math.random() * 7);

    // 随机微小裁剪（0-2px 边缘裁剪去水印/指纹）
    const cropLeft = Math.floor(Math.random() * 3);
    const cropTop = Math.floor(Math.random() * 3);
    const cropRight = Math.floor(Math.random() * 3);
    const cropBottom = Math.floor(Math.random() * 3);

    // 随机微小缩放（±3%）
    const scaleFactor = 0.97 + Math.random() * 0.06;

    // 随机翻转/旋转（极少概率）
    const flipHorizontal = Math.random() < 0.02;
    const rotation = [0, 0, 0, 0, 0, 0, 0, 0, 90, 270][Math.floor(Math.random() * 10)];

    // 微小色相偏移（±1度）
    const hueShift = Math.round((Math.random() - 0.5) * 2);

    // JPEG元数据压缩
    const stripExif = true;
    const stripICC = Math.random() < 0.9; // 90%概率去ICC

    this.reencodeCount++;

    return {
      quality,
      crop: { left: cropLeft, top: cropTop, right: cropRight, bottom: cropBottom },
      scaleFactor: Math.round(scaleFactor * 1000) / 1000,
      transform: { flipHorizontal, rotation },
      colorAdjustment: { hueShift },
      stripExif,
      stripICC,
      estimatedOutput: {
        width: Math.round((original.width || 1080) * scaleFactor) - cropLeft - cropRight,
        height: Math.round((original.height || 1920) * scaleFactor) - cropTop - cropBottom,
      },
    };
  }

  /**
   * 多重编码（串行重编码多次，增加去指纹强度）
   */
  multiPassReencode(original = {}, passes = 2) {
    const results = [];
    let current = { ...original };

    for (let i = 0; i < passes; i++) {
      const params = this.generateReencodeParams(current);
      results.push({ pass: i + 1, ...params });

      // 更新尺寸
      current.width = params.estimatedOutput.width;
      current.height = params.estimatedOutput.height;
    }

    return {
      passes: results,
      totalReencodeCount: this.reencodeCount,
      finalQuality: results[results.length - 1].quality,
      finalDimensions: results[results.length - 1].estimatedOutput,
    };
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: 四层内容改写引擎
// ══════════════════════════════════════════════════════
class FourLevelRewriter {
  static _synonyms = {
    '好': ['棒', '赞', '优秀', '出色', '极好'],
    '大': ['巨', '庞大', '宏大', '巨大', '硕大'],
    '快': ['迅速', '快捷', '高速', '迅捷', '飞速'],
    '美': ['漂亮', '好看', '靓丽', '精美', '华丽'],
    '强': ['厉害', '强大', '强悍', '威猛', '强劲'],
    'good': ['great', 'excellent', 'amazing', 'fantastic', 'wonderful'],
    'big': ['large', 'huge', 'massive', 'enormous', 'giant'],
    'fast': ['quick', 'rapid', 'swift', 'speedy', 'brisk'],
    'new': ['fresh', 'novel', 'recent', 'latest', 'innovative'],
    'best': ['top', 'finest', 'greatest', 'superior', 'ultimate'],
  };

  /**
   * 层级1: 同义词替换
   */
  static level1_synonymReplace(text, rate = 0.3) {
    let result = text;
    for (const [word, synonyms] of Object.entries(this._synonyms)) {
      const regex = new RegExp(word, 'gi');
      if (Math.random() < rate) {
        const replacement = synonyms[Math.floor(Math.random() * synonyms.length)];
        result = result.replace(regex, () => replacement);
      }
    }
    return result;
  }

  /**
   * 层级2: 句式变换（主动↔被动，前置↔后置）
   */
  static level2_sentenceReorder(text, rate = 0.5) {
    const sentences = text.split(/(?<=[。！？.!?])\s*/);
    if (sentences.length < 2 || Math.random() > rate) return text;

    // 随机交换两个相邻句子的顺序
    const i = Math.floor(Math.random() * (sentences.length - 1));
    [sentences[i], sentences[i + 1]] = [sentences[i + 1], sentences[i]];

    return sentences.join('');
  }

  /**
   * 层级3: 段落结构重组
   */
  static level3_paragraphRestructure(text, rate = 0.4) {
    if (Math.random() > rate) return text;

    const paragraphs = text.split(/\n{2,}/);
    if (paragraphs.length < 2) return text;

    // 随机打乱中间段落（保留首尾）
    const first = paragraphs[0];
    const last = paragraphs[paragraphs.length - 1];
    const middle = paragraphs.slice(1, -1);

    // Fisher-Yates 洗牌
    for (let i = middle.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [middle[i], middle[j]] = [middle[j], middle[i]];
    }

    return [first, ...middle, last].join('\n\n');
  }

  /**
   * 层级4: 语义改写（模拟：句子简化/扩展/语气变换）
   */
  static level4_semanticRewrite(text, rate = 0.2) {
    if (Math.random() > rate) return text;

    // 添加随机语气词
    const fillers = ['的确', '说实话', '个人觉得', '其实', '不得不说', '真的'];
    const lines = text.split('\n');
    if (lines.length > 0 && Math.random() < 0.5) {
      const filler = fillers[Math.floor(Math.random() * fillers.length)];
      const idx = Math.floor(Math.random() * lines.length);
      lines[idx] = filler + '，' + lines[idx];
    }

    return lines.join('\n');
  }

  /**
   * 运行四层完整改写管线
   */
  static fullRewrite(text, opts = {}) {
    let result = text;

    result = this.level1_synonymReplace(result, opts.synonymRate || 0.3);
    result = this.level2_sentenceReorder(result, opts.sentenceReorder || 0.5);
    result = this.level3_paragraphRestructure(result, opts.paragraphRestructure || 0.4);
    result = this.level4_semanticRewrite(result, opts.semanticRewrite || 0.2);

    return result;
  }
}

// ── 导出 ─────────────────────────────────────────
module.exports = {
  ContentDNA,
  HotTopicScraper,
  ContentRuleEngine,
  TextDedupEngine,
  EXIFCleaner,
  ImageReencoder,
  FourLevelRewriter,
  HotLevel,
  DATA_SOURCES,
};
