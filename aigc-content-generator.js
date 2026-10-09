/**
 * aigc-content-generator.js — MSCMS v14 AI 内容生成引擎
 *
 * 核心能力：
 *   1. LLM API 集成（支持 OpenAI/Claude/本地 Ollama）
 *   2. 多平台内容生成（Reddit/X/Discord/Instagram/TikTok/Facebook）
 *   3. 内容日历与排期管理
 *   4. A/B 测试变体生成
 *   5. 热点话题驱动内容生产
 *   6. 图片/视频脚本描述生成
 *   7. 内容质量评分与去重
 *   8. 批量生成队列
 *
 * 用法：
 *   const { AIGCContentGenerator } = require('./aigc-content-generator.js');
 *   const gen = new AIGCContentGenerator({ llmEndpoint: 'http://localhost:11434/api/generate' });
 *   const content = await gen.generate('reddit', { topic: 'AI tools', style: 'casual' });
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// ── WorkBuddy 内容池 ──────────────────────────────
const { ContentPool, normalizeTagList } = require('./content-pool.js');

// ── 平台内容规格 ──────────────────────────────────
const PLATFORM_SPECS = {
  reddit: {
    name: 'Reddit',
    maxLength: 40000,
    titleMaxLength: 300,
    style: 'detailed_discussion',
    hasTitle: true,
    hasBody: true,
    tone: 'thoughtful, community-oriented, slightly nerdy',
    structure: 'hook → context → main point → question for discussion',
    emojiLevel: 'low',
  },
  x: {
    name: 'X (Twitter)',
    maxLength: 280,
    titleMaxLength: 0,
    style: 'punchy_viral',
    hasTitle: false,
    hasBody: true,
    tone: 'bold, concise, shareable',
    structure: 'hook → value → CTA',
    emojiLevel: 'medium',
  },
  twitter: {
    name: 'X (Twitter)',
    maxLength: 280,
    titleMaxLength: 0,
    style: 'punchy_viral',
    hasTitle: false,
    hasBody: true,
    tone: 'bold, concise, shareable',
    structure: 'hook → value → CTA',
    emojiLevel: 'medium',
  },
  discord: {
    name: 'Discord',
    maxLength: 2000,
    titleMaxLength: 0,
    style: 'casual_friendly',
    hasTitle: false,
    hasBody: true,
    tone: 'casual, helpful, community member',
    structure: 'greeting → value → invitation',
    emojiLevel: 'high',
  },
  instagram: {
    name: 'Instagram',
    maxLength: 2200,
    titleMaxLength: 0,
    style: 'visual_lifestyle',
    hasTitle: false,
    hasBody: true,
    tone: 'inspiring, aesthetic, aspirational',
    structure: 'hook → story → value → hashtags',
    emojiLevel: 'high',
  },
  tiktok: {
    name: 'TikTok',
    maxLength: 2200,
    titleMaxLength: 0,
    style: 'trendy_hook',
    hasTitle: false,
    hasBody: true,
    tone: 'energetic, trendy, relatable',
    structure: 'hook → setup → payoff → CTA',
    emojiLevel: 'high',
  },
  facebook: {
    name: 'Facebook',
    maxLength: 63206,
    titleMaxLength: 0,
    style: 'storytelling',
    hasTitle: false,
    hasBody: true,
    tone: 'warm, community-focused, informative',
    structure: 'story hook → value → question → CTA',
    emojiLevel: 'medium',
  },
  tumblr: {
    name: 'Tumblr',
    maxLength: 4096,
    titleMaxLength: 0,
    style: 'blog_',
    hasTitle: false,
    hasBody: true,
    tone: ', personal, artistic, blog-like',
    structure: 'hook → narrative → insight → callout',
    emojiLevel: 'low',
    contentTypes: ['text', 'photo', 'quote', 'chat', 'link', 'audio'],
  },
  // [NEWPLAT-2026-09-21]
  nostr: {
    name: 'Nostr',
    maxLength: 2000,
    titleMaxLength: 0,
    style: 'decentralized_microblog',
    hasTitle: false,
    hasBody: true,
    tone: 'authentic, first-person, low-hype, no marketing speak',
    structure: 'observation → concrete detail → insight → open question',
    emojiLevel: 'low',
    contentTypes: ['text', 'quote', 'link'],
  },
  bluesky: {
    name: 'Bluesky',
    maxLength: 300,
    titleMaxLength: 0,
    style: 'short_conversational',
    hasTitle: false,
    hasBody: true,
    tone: 'casual, witty, conversational',
    structure: 'hook → one concrete detail → light question',
    emojiLevel: 'low',
  },
  : {
    name: 'Mastodon',
    maxLength: 500,
    titleMaxLength: 0,
    style: 'community_thoughtful',
    hasTitle: false,
    hasBody: true,
    tone: 'thoughtful, community-minded, non-commercial',
    structure: 'context → main point → invitation to discuss',
    emojiLevel: 'low',
  },
  : {
    name: 'Telegram',
    maxLength: 1000,
    titleMaxLength: 0,
    style: 'channel_broadcast',
    hasTitle: false,
    hasBody: true,
    tone: 'direct, informative, channel-owner voice',
    structure: 'headline → key points → where to read more',
    emojiLevel: 'medium',
  },
  devto: {
    name: 'DEV Community',
    maxLength: 5000,
    titleMaxLength: 128,
    style: 'technical_article',
    hasTitle: true,
    hasBody: true,
    tone: 'practical, technical, mentor-like',
    structure: 'problem → approach → what I learned → takeaway',
    emojiLevel: 'low',
  },
  : {
    name: 'Hashnode',
    maxLength: 5000,
    titleMaxLength: 128,
    style: 'developer_blog',
    hasTitle: true,
    hasBody: true,
    tone: 'technical but narrative, personal developer blog',
    structure: 'intro → context → walkthrough → conclusion',
    emojiLevel: 'low',
  },
  github: {
    name: 'GitHub',
    maxLength: 2000,
    titleMaxLength: 120,
    style: 'precise_release_note',
    hasTitle: true,
    hasBody: true,
    tone: 'precise, factual, maintainer voice',
    structure: 'what changed → why it matters → how to verify',
    emojiLevel: 'none',
  },
};

// ── 内容模板提示词 ────────────────────────────────
const PROMPT_TEMPLATES = {
  reddit: `You are a Reddit power user. Write a post for r/{subreddit} about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Title must be under {titleMaxLength} chars, catchy, genuinely curious
- Body should be {maxLength} chars max
- Sound like a real person, not a marketer
- Include a natural question to spark discussion
- No promotional language
{customInstructions}

Output JSON: {{"title":"...","body":"..."}}`,

  x: `You are a viral X/Twitter creator. Write a tweet about "{topic}".
Tone: {tone}
Rules:
- Maximum {maxLength} characters
- Start with a scroll-stopping hook
- Include 1-2 relevant hashtags
- End with an implicit CTA (question or bold statement)
- {emojiLevel} emoji usage
{customInstructions}

Output JSON: {{"text":"..."}}`,

  discord: `You are a helpful Discord community member. Write a message about "{topic}".
Tone: {tone}
Rules:
- Maximum {maxLength} characters
- Be conversational and friendly
- Include a natural mention of a resource: {link}
- Invite engagement
- {emojiLevel} emoji usage
{customInstructions}

Output JSON: {{"text":"..."}}`,

  instagram: `You are an Instagram content creator. Write a caption about "{topic}".
Tone: {tone}
Rules:
- Maximum {maxLength} characters
- Start with a compelling hook
- Tell a brief story
- End with 5-10 relevant hashtags
- {emojiLevel} emoji usage
{customInstructions}

Output JSON: {{"caption":"...","hashtags":["..."]}}`,

  tiktok: `You are a TikTok creator. Write a video description about "{topic}".
Tone: {tone}
Rules:
- Maximum {maxLength} characters
- Start with a trending hook phrase
- Include 3-5 trending hashtags
- {emojiLevel} emoji usage
{customInstructions}

Output JSON: {{"description":"...","hashtags":["..."],"videoScript":"..."}}`,

  facebook: `You are a Facebook page manager. Write a post about "{topic}".
Tone: {tone}
Rules:
- Maximum {maxLength} characters
- Tell a relatable story
- Include a question to drive comments
- Natural mention of: {link}
- {emojiLevel} emoji usage
{customInstructions}

Output JSON: {{"text":"..."}}`,

  tumblr: `You are a Tumblr blogger with a , personal voice. Write a Tumblr post about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 400-700 characters (Tumblr posts are short; do NOT exceed 700)
- Write in first person or with a strong personal voice
- Make it feel like a journal entry, not a marketing post
- Include specific details, names, numbers (felt real)
- End with a question to invite reblogs and comments
- {emojiLevel} emoji usage
- Tumblr content types: text (blog post), photo (image+caption), quote, chat (Q&A format), link, audio
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}`,

  // [NEWPLAT-2026-09-21]
  nostr: `You are a Nostr user writing a kind:1 note about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 200-600 characters. Nostr notes are short-form; do NOT exceed 600.
- Write like a real person posting to a decentralized network, not a brand
- No marketing hooks, no "thread 1/5", no growth-bait
- Include one concrete, specific detail (a number, a name, a place)
- End with a genuine open question
- {emojiLevel} emoji usage
- Do NOT include hashtag spam; at most 2 topical tags
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}`,

  bluesky: `You are a Bluesky user writing a short post about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- HARD LIMIT 300 characters total. Count carefully; shorter is better.
- Conversational, like replying to a friend
- One idea only, sharp and specific
- No hashtags beyond 1
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}`,

  : `You are a Mastodon user writing a post about "{topic}" for your instance's local timeline.
Tone: {tone}
Structure: {structure}
Rules:
- Length: 200-450 characters, hard cap 500
- The fediverse dislikes promotion: write to share, not to sell
- Add a content warning only if the topic is genuinely sensitive
- Use at most 3 hashtags, they matter for discoverability here
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}`,

  : `You are the owner of a Telegram channel posting about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 200-600 characters
- Lead with the most useful fact; channel readers skim
- Short lines, generous line breaks, easy to read on mobile
- One clear next step at the end
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}`,

  devto: `You are a developer writing a DEV Community article about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 800-2500 characters. Hard cap 5000.
- Open with the concrete problem, not a generic introduction
- Be specific and technical; show the actual approach, no hand-waving
- Include one section heading using markdown (##)
- End with a practical takeaway the reader can apply today
- No emoji in headings; {emojiLevel} emoji usage elsewhere
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}`,

  : `You are a developer writing a Hashnode blog post about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 800-2500 characters. Hard cap 5000.
- Narrative but technical: explain your reasoning, not just the outcome
- Use markdown headings (##) for at least two sections
- Include one honest limitation or trade-off you hit
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}`,

  github: `You are a maintainer writing a GitHub issue or release note about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 200-800 characters. Hard cap 2000.
- Be precise and factual; no marketing language at all
- State what changed, why it matters, and how to verify it
- Reference concrete identifiers (version, file, flag) where possible
- No emoji
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}`,

  // [NEWPLAT-2026-09-21] 修复孤儿 spec：twitter 存在于 PLATFORM_SPECS 却无模板
  // → _buildPrompt 对 undefined.replace() 抛 TypeError（实测）
  twitter: `You are a viral Twitter/X creator. Write a tweet about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- HARD LIMIT 280 characters. Count carefully.
- Hook in the first 5 words
- One sharp idea; no thread, no "1/5"
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"text":"..."}`,
};

// ── 内容类型常量 ──────────────────────────────────
const CONTENT_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  TEXT_IMAGE: 'text_image',  // 图文混合
  TEXT_VIDEO: 'text_video',  // 视频+文案
};

// ── 平台默认内容类型 ──────────────────────────────
const PLATFORM_DEFAULT_TYPES = {
  reddit: CONTENT_TYPES.TEXT,
  x: CONTENT_TYPES.TEXT,
  twitter: CONTENT_TYPES.TEXT,
  discord: CONTENT_TYPES.TEXT,
  instagram: CONTENT_TYPES.TEXT_IMAGE,
  tiktok: CONTENT_TYPES.TEXT_VIDEO,
  facebook: CONTENT_TYPES.TEXT_IMAGE,
  tumblr: CONTENT_TYPES.TEXT,
  // [NEWPLAT-2026-09-21]
  nostr: CONTENT_TYPES.TEXT,
  bluesky: CONTENT_TYPES.TEXT,
  : CONTENT_TYPES.TEXT,
  : CONTENT_TYPES.TEXT,
  devto: CONTENT_TYPES.TEXT,
  : CONTENT_TYPES.TEXT,
  github: CONTENT_TYPES.TEXT,
};

// ── 生成任务 ──────────────────────────────────────
class GenerationTask {
  constructor(, config) {
    this.id = `gen_${Date.now()}_${crypto.randomBytes(4'hex')}`;
    this. = ;
    this.config = config;
    this.contentType = config.contentType || PLATFORM_DEFAULT_TYPES[] || CONTENT_TYPES.TEXT;
    this.status = 'queued';
    this.result = null;
    this.error = null;
    this.createdAt = new Date().toISOString();
    this.completedAt = null;
    this.qualityScore = null;
    this.uniquenessScore = null;
    // 文件存储路径
    this.filePath = null;     // D:\MSCMS-Content\... 实际文件路径
    this.previewUrl = null;   // /content/... 预览 URL
  }
}

// ── AI 内容生成引擎 ──────────────────────────────
class AIGCContentGenerator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.llmEndpoint = opts.llmEndpoint || process.env.LLM_ENDPOINT || 'http://localhost:11434/api/generate';
    this.llmModel = opts.llmModel || process.env.LLM_MODEL || 'llama3.2';
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || '';
    this.provider = opts.provider || 'ollama'; // ollama | openai | claude

    this.queue = [];
    this.history = [];
    this.maxHistory = 500;
    this.contentCalendar = []; // 排期内容
    this.generatedHashes = new Set(); // 去重

    this.stats = {
      totalGenerated: 0,
      successCount: 0,
      failCount: 0,
      avgQualityScore: 0,
      avgUniquenessScore: 0,
      byPlatform: {},
    };

    this.running = false;
    this.processorInterval = null;
    this._ollamaDegraded = false;
    this._lastOllamaError = null;
    // [P2-B6] LLM 主路径状态：来源标记 + 池复用计数（防小池无限循环）
    this._lastLLMSource = null;
    this._poolUseCount = {};
    this._poolCapWarned = {};

    // WorkBuddy 内容池 — 由 AI 预生成的高质量内容
    this.contentPool = new ContentPool(opts.contentPoolDir || 'D:/MSCMS-Content/pool');
    console.log(`[aigc] 内容池已加载: ${JSON.stringify(this.contentPool.getStats())}`);
  }

  // ── 启动 ──────────────────────────────────────
  start() {
    if (this.running) return;
    this.running = true;
    this.processorInterval = setInterval(() => this._processQueue(), 3000);
    this.emit('started');
  }

  stop() {
    this.running = false;
    if (this.processorInterval) clearInterval(this.processorInterval);
    this.emit('stopped');
  }

  // ── 生成 ──────────────────────────────────
  enqueueGeneration(, count = 1, config = {}) {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const task = new GenerationTask(, config);
      this.queue.push(task);
      tasks.push(task);
    }
    this.emit('enqueued', { , count, tasks });
    return tasks;
  }

  // ── 直接生成 ──────────────────────────────────
  async generate(, config = {}) {
    const task = new GenerationTask(, config);
    await this._executeGeneration(task);
    return task;
  }

  // ── 队列处理 ──────────────────────────────────
  async _processQueue() {
    if (this.queue.length === 0) return;
    const task = this.queue.shift();
    if (!task) return;

    try {
      await this._executeGeneration(task);
    } catch (e) {
      // Error already set in _executeGeneration
    }
  }

  // ── 执行生成 ──────────────────────────────────
  async _executeGeneration(task) {
    task.status = 'running';
    this.emit('task:start', task);

    try {
      const spec = PLATFORM_SPECS[task.];
      if (!spec) throw new Error(`Unknown : ${task.}`);

      // 构建 prompt
      const prompt = this._buildPrompt(task., task.config);

      // 调用 LLM
      const llmResponse = await this._callLLM(prompt, task.);

      // 解析结果
      const content = this._parseContent(llmResponse, task.);
      // [P2-B6b] 归一化字段：占位标题兜底 + topic 补齐 + 正文别名
      this._normalizeContentFields(content, task);
      // [P2-B6] 标记真实来源（llm:<model> / workbuddy-pool / template）
      // 用于验收「真 LLM 生效」；池兜底自带 source 则不覆盖
      if (content && !content.fallback && !content.source) {
        content.source = this._lastLLMSource === 'llm'
          ? `llm:${this.llmModel}` : (this._lastLLMSource || 'unknown');
      }

      // 质量评分
      task.qualityScore = this._scoreQuality(content, spec);

      // 去重检查
      const contentHash = this._hashContent(content);
      task.uniquenessScore = this.generatedHashes.has(contentHash) ? 0 : 1;
      this.generatedHashes.add(contentHash);

      // 注入内容类型元数据
      content.content_type = task.contentType;
      content.content_type_label = this._getTypeLabel(task.contentType);
      task.result = content;
      task.status = 'success';
      task.completedAt = new Date().toISOString();
      this.stats.successCount++;
      this._updateStats(task);
      this.emit('task:success', task);
    } catch (e) {
      task.status = 'failed';
      task.error = e.message;
      task.completedAt = new Date().toISOString();
      this.stats.failCount++;
      this.emit('task:fail', task);
    }

    this.stats.totalGenerated++;
    this.history.unshift({
      id: task.id,
      : task.,
      contentType: task.contentType,
      status: task.status,
      qualityScore: task.qualityScore,
      uniquenessScore: task.uniquenessScore,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      error: task.error,
      result: task.result,
      filePath: task.filePath,
      previewUrl: task.previewUrl,
    });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }
  }

  // ── 构建 prompt ───────────────────────────────
  _buildPrompt(, config) {
    const spec = PLATFORM_SPECS[];
    const template = PROMPT_TEMPLATES[];

    return template
      .replace('{topic}', config.topic || 'general interest topic')
      .replace('{subreddit}', config.subreddit || 'general')
      .replace('{tone}', spec.tone)
      .replace('{structure}', spec.structure)
      .replace('{maxLength}', spec.maxLength)
      .replace('{titleMaxLength}', spec.titleMaxLength || 0)
      .replace('{emojiLevel}', spec.emojiLevel)
      .replace('{link}', config.link || 'https://example.com')
      .replace('{customInstructions}', config.customInstructions || '');
  }

  // ── 调用 LLM ─────────────────────────────────
  // [P2-B6 2026-09-16] 语义纠正：LLM 为**主路径**，内容池仅作降级兜底。
  // 原实现第一步就查内容池、命中即 return → LLM 永不触发；池靠 content-pool
  // 的 usedIndices.clear() 从头循环(tumblr 15 条) → 全站「同稿」。
  // 叠加 _callOllama timeout(15000ms) < 实测单条 qwen2.5:3b 32.6s → 双重阻断。
  async _callLLM(prompt, Hint) {
    // [P2-B6b] 平台由调用方显式传入：prompt 反推会把 tumblr/discord/facebook
    // 误判为 x（单字母子串命中），导致跨平台取用错误池内容。
    const  = Hint || this._extractPlatformFromPrompt(prompt);

    // ① 主路径：真实 LLM
    if (this.provider === 'ollama') {
      try {
        const out = await this._callOllama(prompt);
        if (out && String(out).trim()) {
          this._ollamaDegraded = false;
          this._lastLLMSource = 'llm';
          return out;
        }
        throw new Error('empty LLM response');
      } catch (e) {
        if (!this._ollamaDegraded) {
          this._ollamaDegraded = true;
          this._lastOllamaError = e.message;
          console.warn(`[aigc] LLM 不可用，降级内容池: ${e.message}`);
          this.emit('degraded', { reason: e.message, fallback: 'content_pool' });
        }
      }
    } else if (this.provider === 'openai') {
      try {
        const out = await this._callOpenAI(prompt);
        if (out && String(out).trim()) {
          this._lastLLMSource = 'llm';
          return out;
        }
      } catch (e) {
        // 落到池兜底
      }
    }

    // ② 降级：内容池（带复用上限，避免小池无限循环）
    const pooled = this._poolFallback();
    if (pooled) { this._lastLLMSource = 'pool'; return pooled; }

    // ③ 最后兜底：本地模板
    this._lastLLMSource = 'template';
    return this._localGenerate(prompt, );
  }

  // ── 内容池兜底（带复用上限） ────────────────────
  // content-pool.getContent() 在池耗尽时会 clear() usedIndices 从 0 重来；
  // 若不加闸门，tumblr(15 条)会被无限循环复用 → 同稿。
  // 闸门：每条池内容最多复用 MSCMS_POOL_REUSE_MULT 次（默认 3），用尽即放弃池。
  _poolFallback() {
    if (! || !this.contentPool) return null;
    const size = Array.isArray(this.contentPool.pools && this.contentPool.pools[])
      ? this.contentPool.pools[].length : 0;
    const mult = Number(process.env.MSCMS_POOL_REUSE_MULT || 3);
    const cap = size > 0 ? size * mult : 0;
    if (!this._poolUseCount) this._poolUseCount = {};
    if (!this._poolCapWarned) this._poolCapWarned = {};
    const used = this._poolUseCount[] || 0;
    if (cap > 0 && used >= cap) {
      if (!this._poolCapWarned[]) {
        this._poolCapWarned[] = true;
        console.warn(`[aigc] 内容池复用已达上限(${cap} = ${size}x${mult})， 停止复用池内容`);
      }
      return null;
    }
    const pooled = this.contentPool.getContent();
    if (!pooled) return null;
    this._poolUseCount[] = used + 1;
    return JSON.stringify(pooled);
  }

  // ── Ollama API ───────────────────────────────
  async _callOllama(prompt) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.llmEndpoint);
      const body = JSON.stringify({
        model: this.llmModel,
        prompt,
        stream: false,
        // 模型常驻 30m：避免 180s 周期之间卸载/重载带来的耗时抖动
        keep_alive: process.env.MSCMS_OLLAMA_KEEP_ALIVE || '30m',
        options: {
          temperature: 0.8,
          top_p: 0.9,
          // [P2-B6] 限制最长输出：实测 qwen2.5:3b 约 4.2 tok/s，300 tok 约 72s < timeout
          // 420 tok 约 100s（实测 4.2 tok/s），低于 timeout；
          // 300 实测会在长文上截断 JSON（第 3 条 1302 字符处断）。
          num_predict: Number(process.env.MSCMS_LLM_NUM_PREDICT || 420),
        },
      });

      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { '': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        // [P2-B6] 原 15000ms < 实测单条 32.6s → 即便解除池短路也必然全量超时。
        // 默认 120000ms（约 3.7x 余量），可用 MSCMS_LLM_TIMEOUT_MS 覆盖。
        timeout: Number(process.env.MSCMS_LLM_TIMEOUT_MS || 150000),
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`Ollama HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(new Error(`Ollama error: ${json.error}`));
            resolve(json.response || json.output || data);
          } catch {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── OpenAI API ───────────────────────────────
  async _callOpenAI(prompt) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
      });

      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          '': 'application/json',
          '': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.choices[0].message.content);
          } catch {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── 本地回退生成 — 从 WorkBuddy 内容池读取 ──────
  _localGenerate(prompt, Hint) {
    const  = Hint || this._extractPlatformFromPrompt(prompt);
    // [P2-B6] 统一走带复用上限的池兜底，避免 15 条小池无限循环复用
    const pooled = this._poolFallback();
    if (pooled) return pooled;
    // 兜底：返回通用内容
    return JSON.stringify({
      title: null,
      body: 'Content generation in progress. Please check back later.',
      text: 'Content generation in progress.',
      source: 'workbuddy-fallback',
      :  || 'unknown',
    });
  }

  // ── 从 prompt 中提取平台信息 ──────────────────
  // [P2-B6b 2026-09-16 修复] 原实现用 `lower.includes(p)` 做子串匹配，
  // 且平台数组把单字母 'x' 排在第 4 位（早于 discord/facebook/tumblr）→
  // prompt 里只要出现任意一个字母 x（实测 tumblr/discord/facebook 模板均含）
  // 就会被判成 'x'。实测：tumblr→x、discord→x、facebook→x（reddit/instagram/tiktok 正常）
  // ⇒ **跨平台内容污染**：tumblr 帖子实际取用 x 池内容。
  // 现改为：① 长名优先 + 词边界匹配；② 'x' 仅在与 twitter 明确共现时命中。
  _extractPlatformFromPrompt(prompt) {
    if (!prompt) return null;
    const lower = String(prompt).toLowerCase();
    // 长名/多字母名优先，且必须整词命中（避免 'x' 之类的子串误伤）
    const ordered = ['instagram', 'facebook', 'discord', 'twitter', 'tumblr', 'reddit', 'tiktok'];
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      if (new RegExp('\\b' + p + '\\b').test(lower)) return p === 'twitter' ? 'x' : p;
    }
    // 单字母 x：仅在与 twitter 共现、或明确写作 "on X" / "X post" 时才认定
    if (/\bx\s*\(\s*twitter\s*\)|twitter\s*\(\s*x\s*\)/.test(lower)) return 'x';
    if (/(^|[\s"'])x\s+(post|thread|tweet)/.test(lower)) return 'x';
    return null;
  }

  // ── [P2-B6b] 归一化小模型输出字段 ────────────────
  // 实测 qwen2.5:3b 的三类退化：
  //   ① title 输出占位省略号 "..." / "title" / 纯符号（实测 2/3 条命中）；
  //   ② 完全不回传 topic（池内容自带 topic，真 LLM 不带）→ topic 空串落库，
  //      连带 deriveTags 缺失选题相关性、server 侧 contentTopic 回填失败；
  //   ③ 只回传 body 的别名（text/caption）。
  _normalizeContentFields(content, task) {
    if (!content || typeof content !== 'object') return content;

    // 正文别名归一
    const body = String(content.body || content.text || content.caption || content.description || '').trim();
    if (!content.body && body) content.body = body;

    // 标题：占位/无意义 → 用正文首行兜底（下游 `title || body.slice(0,60)` 亦依赖此项）
    const PLACEHOLDER_TITLE_RE = /^(\.{2,}|…+|-+|_+|title|untitled|标题|here|n\/a|null|undefined|none)$/i;
    let t = String(content.title == null ? '' : content.title).trim();
    const alnumCount = t.replace(/[^\p{L}\p{N}]/gu, '';
    if (!t || PLACEHOLDER_TITLE_RE.test(t) || alnumCount < 3) {
      const firstLine = body.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
      t = firstLine.slice(0, 60).trim();
    }
    content.title = t || null;

    // topic：模型不回传 → 用任务配置（真实热点选题）补齐
    const cfg = (task && task.config) ? task.config.topic : null;
    const pick = (v) => {
      if (!v) return '';
      if (typeof v === 'string') return v.trim();
      if (typeof v === 'object') return String(v.title || v.topic || v.name || '').trim();
      return String(v).trim();
    };
    content.topic = pick(content.topic) || pick(cfg) || 'general';

    // 标签归一化：小模型常回传 CamelCase（实测 "MenendezBrothers"），
    // 违反标签规范（小写 / 去 # / 2..32 字符 / 上限 8），平台侧命中率也低。
    // [P2-B6d] 另需剔除纯符号标签（实测模型会输出 "..." / "#"），它们不是有效话题。
    const saneTags = (arr) => normalizeTagList(arr)
      .filter((t) => t.length >= 2 && /[\p{L}\p{N}]/u.test(t));
    if (Array.isArray(content.tags)) {
      content.tags = saneTags(content.tags);
      if (!content.tags.length) delete content.tags;   // 交下游 deriveTags 兜底
    }
    if (Array.isArray(content.hashtags)) {
      content.hashtags = saneTags(content.hashtags);
    }

    return content;
  }

  // ── [P2-B6b] 截断 JSON 字段抢救 ──────────────────
  // num_predict 触顶时模型 JSON 不闭合（实测第 3 条：body 1302 字符后戛然而止），
  // JSON.parse 与括号平衡抽取均失败 → 整条退化为「原始 JSON 文本正文」。
  // 这里用字段级正则把已生成的 title/body/tags 捞回来。
  _salvageFields(s) {
    if (!s) return null;
    const unesc = (x) => String(x)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim();
    const grab = (key) => {
      // "key": "..." —— 末引号允许缺失（截断场景）
      const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"?', 'i');
      const m = s.match(re);
      return m ? unesc(m[1]) : '';
    };
    const out = {};
    const t = grab('title');
    const b = grab('body') || grab('text') || grab('caption') || grab('description');
    if (t) out.title = t;
    if (b) out.body = b;
    const mt = s.match(/"tags"\s*:\s*\[([^\]]*)/i);
    if (mt) {
      out.tags = mt[1].split(',')
        .map((x) => x.replace(/["'\s]/g, ''))
        .filter(Boolean)
        .slice(0, 8);
    }
    return (out.body || out.title) ? out : null;
  }

  // ── 获取内容类型标签（中文） ──────────────────
  _getTypeLabel(contentType) {
    const labels = {
      [CONTENT_TYPES.TEXT]: '纯文本',
      [CONTENT_TYPES.IMAGE]: '图片',
      [CONTENT_TYPES.VIDEO]: '视频',
      [CONTENT_TYPES.TEXT_IMAGE]: '图文',
      [CONTENT_TYPES.TEXT_VIDEO]: '视频文案',
    };
    return labels[contentType] || contentType;
  }

  // ── 保存内容到文件（D盘存储） ──────────────────
  saveContentToFile(task, baseDir = 'D:/MSCMS-Content') {
    try {
      const fs = require('fs');
      const path = require('path');
      const now = new Date();
      const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const typeDir = task.contentType || CONTENT_TYPES.TEXT;
      const fullDir = path.join(baseDir, dateDir, typeDir);

      if (!fs.existsSync(fullDir)) {
        fs.mkdirSync(fullDir, { recursive: true });
      }

      const fileName = `${task.id}.json`;
      const filePath = path.join(fullDir, fileName);

      const contentPayload = {
        id: task.id,
        : task.,
        content_type: task.contentType,
        generated_at: task.completedAt || new Date().toISOString(),
        quality_score: task.qualityScore,
        content: task.result,
      };

      fs.writeFileSync(filePath, JSON.stringify(contentPayload, null, 2), 'utf-8');

      task.filePath = filePath;
      // 生成预览 URL（Express 静态文件路径）
      task.previewUrl = `/content/${dateDir}/${typeDir}/${fileName}`;

      return { filePath, previewUrl: task.previewUrl };
    } catch (e) {
      console.error(`[aigc] Failed to save content: ${e.message}`);
      return null;
    }
  }

  // ── 解析内容 ──────────────────────────────────
  // [P2-B6] 容错增强：真 LLM 产物不再是「保证纯 JSON 的池内容」，
  // qwen2.5 系常输出 ```json 围栏或「Here is the post: {...}」夹带说明。
  // 原实现 JSON.parse 失败即退化为纯文本 → 丢失 title/tags。
  // 这里补：围栏剥离 + 首个平衡 JSON 对象抽取（字符串/转义感知）。
  _parseContent(raw, ) {
    const text = String(raw == null ? '' : raw).trim();

    // ① 直接 JSON
    const direct = this._tryParseJson(text);
    if (direct) return { , ...direct, raw: text };

    // ② 代码围栏剥离
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const cand = fenced ? String(fenced[1]).trim() : text;

    // ③ 抽取首个平衡 JSON 对象
    const salvaged = this._tryParseJson(cand)
      || this._tryParseJson(this._extractFirstJsonObject(cand));
    if (salvaged) return { , ...salvaged, raw: text };

    // ④ 截断 JSON 抢救：num_predict 触顶时 JSON 不闭合（实测 1302 字符处戛然而止），
    //    JSON.parse 与括号平衡抽取均失败 → 用字段级正则捞回已生成内容，
    //    避免整条退化成「原始 JSON 文本」这种既非文章也非结构的产物。
    const rescued = this._salvageFields(cand) || this._salvageFields(text);
    if (rescued) return { , ...rescued, raw: text, salvaged: true };

    // ⑤ 纯文本 → 统一格式（显式补 body，下游按 body || text 消费）
    return { , text, body: text, raw: text };
  }

  // 严格 JSON 解析（仅对象/数组，其余返回 null）
  _tryParseJson(s) {
    if (!s || typeof s !== 'string') return null;
    const t = s.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
    try {
      const v = JSON.parse(t);
      return (v && typeof v === 'object') ? v : null;
    } catch (e) {
      return null;
    }
  }

  // 从混杂文本中抽取首个「括号平衡」的 JSON 对象（忽略字符串内的花括号）
  _extractFirstJsonObject(s) {
    if (!s) return null;
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  // ── 质量评分 ──────────────────────────────────
  _scoreQuality(content, spec) {
    let score = 50;
    const text = content.body || content.text || content.caption || content.description || '';

    // 长度合适
    if (text.length > 50 && text.length <= spec.maxLength) score += 15;

    // 有结构（标题+正文）
    if (content.title && content.body) score += 10;

    // 有 hashtag
    if (content.hashtags && content.hashtags.length > 0) score += 10;

    // 有 CTA（问号）
    if (text.includes('?')) score += 10;

    // 非空
    if (text.trim( > 0) score += 5;

    return Math.min(score, 100);
  }

  // ── 内容哈希去重 ──────────────────────────────
  _hashContent(content) {
    const text = JSON.stringify(content).toLowerCase().replace(/\s+/g, ' ').trim();
    return crypto.createHash('md5').update(text).digest('hex');
  }

  // ── 更新统计 ──────────────────────────────────
  _updateStats(task) {
    if (!this.stats.byPlatform[task.]) {
      this.stats.byPlatform[task.] = { count: 0, totalQuality: 0, avgQuality: 0 };
    }
    const p = this.stats.byPlatform[task.];
    p.count++;
    p.totalQuality += task.qualityScore || 0;
    p.avgQuality = p.totalQuality / p.count;

    // 全局平均
    const allScores = this.history.filter(h => h.qualityScore !== null).map(h => h.qualityScore);
    if (allScores.length > 0) {
      this.stats.avgQualityScore = (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1);
    }
    const allUnique = this.history.filter(h => h.uniquenessScore !== null).map(h => h.uniquenessScore);
    if (allUnique.length > 0) {
      this.stats.avgUniquenessScore = (allUnique.reduce((a, b) => a + b, 0) / allUnique.length * 100).toFixed(1) + '%';
    }
  }

  // ── 内容日历 ──────────────────────────────────
  addToCalendar(, scheduledAt, config) {
    this.contentCalendar.push({
      id: `cal_${Date.now()}_${crypto.randomBytes(2'hex')}`,
      ,
      scheduledAt,
      config,
      status: 'scheduled',
    });
    this.contentCalendar.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    this.emit('calendar:added');
  }

  getCalendar(startDate, endDate) {
    return this.contentCalendar.filter(c => {
      const d = new Date(c.scheduledAt);
      return (!startDate || d >= new Date(startDate)) && (!endDate || d <= new Date(endDate));
    });
  }

  // ── 批量生成 A/B 变体 ─────────────────────────
  async generateVariants(, config, count = 3) {
    const variants = [];
    for (let i = 0; i < count; i++) {
      const variantConfig = { ...config, customInstructions: `Variant ${i + 1}: Make it ${['more casual', 'more professional', 'more provocative'][i % 3]}.` };
      const task = await this.generate(, variantConfig);
      variants.push({ variant: String.fromCharCode(65 + i), task });
    }
    return variants;
  }

  // ── 获取状态 ──────────────────────────────────
  getStats() {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      calendarCount: this.contentCalendar.length,
      uniqueContents: this.generatedHashes.size,
      running: this.running,
      provider: this.provider,
      model: this.llmModel,
      ollamaDegraded: this._ollamaDegraded,
      lastOllamaError: this._lastOllamaError,
    };
  }

  getHistory(limit = 50) {
    return this.history.slice(0, limit);
  }

  getQueue() {
    return this.queue.map(t => ({
      id: t.id,
      : t.,
      contentType: t.contentType,
      status: t.status,
      createdAt: t.createdAt,
    }));
  }
}

module.exports = { AIGCContentGenerator, GenerationTask, PLATFORM_SPECS, PROMPT_TEMPLATES, CONTENT_TYPES, PLATFORM_DEFAULT_TYPES };
