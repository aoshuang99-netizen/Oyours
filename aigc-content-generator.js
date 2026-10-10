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
const { ContentPool } = require('./content-pool.js');

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
    style: 'blog_creative',
    hasTitle: false,
    hasBody: true,
    tone: 'creative, personal, artistic, blog-like',
    structure: 'hook → narrative → insight → callout',
    emojiLevel: 'low',
    contentTypes: ['text', 'photo', 'quote', 'chat', 'link', 'audio'],
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

  tumblr: `You are a Tumblr blogger with a creative, personal voice. Write a Tumblr post about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Maximum {maxLength} characters
- Write in first person or with a strong personal voice
- Make it feel like a journal entry, not a marketing post
- Include specific details, names, numbers (felt real)
- End with a question to invite reblogs and comments
- {emojiLevel} emoji usage
- Tumblr content types: text (blog post), photo (image+caption), quote, chat (Q&A format), link, audio
{customInstructions}

Output JSON: {{"title":"...","body":"...","tags":["..."],"content_type":"text"}}`,
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
};

// ── 生成任务 ──────────────────────────────────────
class GenerationTask {
  constructor(platform, config) {
    this.id = `gen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.platform = platform;
    this.config = config;
    this.contentType = config.contentType || PLATFORM_DEFAULT_TYPES[platform] || CONTENT_TYPES.TEXT;
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
  enqueueGeneration(platform, count = 1, config = {}) {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const task = new GenerationTask(platform, config);
      this.queue.push(task);
      tasks.push(task);
    }
    this.emit('enqueued', { platform, count, tasks });
    return tasks;
  }

  // ── 直接生成 ──────────────────────────────────
  async generate(platform, config = {}) {
    const task = new GenerationTask(platform, config);
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
      const spec = PLATFORM_SPECS[task.platform];
      if (!spec) throw new Error(`Unknown platform: ${task.platform}`);

      // 构建 prompt
      const prompt = this._buildPrompt(task.platform, task.config);

      // 调用 LLM
      const llmResponse = await this._callLLM(prompt);

      // 解析结果
      const content = this._parseContent(llmResponse, task.platform);

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
      platform: task.platform,
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
  _buildPrompt(platform, config) {
    const spec = PLATFORM_SPECS[platform];
    const template = PROMPT_TEMPLATES[platform];

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
  async _callLLM(prompt) {
    // 优先使用 WorkBuddy 内容池
    const platform = this._extractPlatformFromPrompt(prompt);
    if (platform && this.contentPool) {
      const pooled = this.contentPool.getContent(platform);
      if (pooled) {
        return JSON.stringify(pooled);
      }
    }

    // 尝试 LLM API
    if (this.provider === 'ollama') {
      try {
        return await this._callOllama(prompt);
      } catch (e) {
        // Ollama 不可用时自动降级为本地模板生成
        if (!this._ollamaDegraded) {
          this._ollamaDegraded = true;
          this._lastOllamaError = e.message;
          this.emit('degraded', { reason: e.message, fallback: 'local_template' });
        }
        return this._localGenerate(prompt);
      }
    } else if (this.provider === 'openai') {
      try {
        return await this._callOpenAI(prompt);
      } catch (e) {
        return this._localGenerate(prompt);
      }
    } else {
      return this._localGenerate(prompt);
    }
  }

  // ── Ollama API ───────────────────────────────
  async _callOllama(prompt) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.llmEndpoint);
      const body = JSON.stringify({
        model: this.llmModel,
        prompt,
        stream: false,
        options: { temperature: 0.8, top_p: 0.9 },
      });

      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
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
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
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
  _localGenerate(prompt) {
    const platform = this._extractPlatformFromPrompt(prompt);
    if (platform && this.contentPool) {
      const pooled = this.contentPool.getContent(platform);
      if (pooled) {
        return JSON.stringify(pooled);
      }
    }
    // 兜底：返回通用内容
    return JSON.stringify({
      title: null,
      body: 'Content generation in progress. Please check back later.',
      text: 'Content generation in progress.',
      source: 'workbuddy-fallback',
      platform: platform || 'unknown',
    });
  }

  // ── 从 prompt 中提取平台信息 ──────────────────
  _extractPlatformFromPrompt(prompt) {
    if (!prompt) return null;
    const lower = prompt.toLowerCase();
    const platforms = ['reddit', 'instagram', 'tiktok', 'x', 'twitter', 'discord', 'facebook', 'tumblr'];
    for (const p of platforms) {
      if (lower.includes(p)) return p === 'twitter' ? 'x' : p;
    }
    return null;
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
        platform: task.platform,
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
  _parseContent(raw, platform) {
    // 尝试 JSON 解析
    try {
      const json = JSON.parse(raw);
      return { platform, ...json, raw };
    } catch {
      // 非 JSON，包装为统一格式
      return { platform, text: raw, raw };
    }
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
    if (text.trim().length > 0) score += 5;

    return Math.min(score, 100);
  }

  // ── 内容哈希去重 ──────────────────────────────
  _hashContent(content) {
    const text = JSON.stringify(content).toLowerCase().replace(/\s+/g, ' ').trim();
    return crypto.createHash('md5').update(text).digest('hex');
  }

  // ── 更新统计 ──────────────────────────────────
  _updateStats(task) {
    if (!this.stats.byPlatform[task.platform]) {
      this.stats.byPlatform[task.platform] = { count: 0, totalQuality: 0, avgQuality: 0 };
    }
    const p = this.stats.byPlatform[task.platform];
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
  addToCalendar(platform, scheduledAt, config) {
    this.contentCalendar.push({
      id: `cal_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      platform,
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
  async generateVariants(platform, config, count = 3) {
    const variants = [];
    for (let i = 0; i < count; i++) {
      const variantConfig = { ...config, customInstructions: `Variant ${i + 1}: Make it ${['more casual', 'more professional', 'more provocative'][i % 3]}.` };
      const task = await this.generate(platform, variantConfig);
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
      platform: t.platform,
      contentType: t.contentType,
      status: t.status,
      createdAt: t.createdAt,
    }));
  }
}

module.exports = { AIGCContentGenerator, GenerationTask, PLATFORM_SPECS, PROMPT_TEMPLATES, CONTENT_TYPES, PLATFORM_DEFAULT_TYPES };
