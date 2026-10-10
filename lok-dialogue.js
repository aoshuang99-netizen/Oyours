/**
 * lok-dialogue.js — MSCMS v14 LOK 对话模型集成引擎
 *
 * 调用 LOK 的对话模型进行自主化营销的回复：
 *   1. 多平台社媒对话生成（评论回复、私信回复、@提及回复）
 *   2. 上下文感知的对话引擎（记住对话历史）
 *   3. 平台风格适配（Reddit/X/Instagram/TikTok/Facebook/Discord）
 *   4. 语气与人格设定（不同账号不同人设）
 *   5. 情感分析与共情回复
 *   6. 安全回复检查（不触发风控）
 *   7. 多轮对话管理
 *   8. 批量回复队列
 *
 * LOK 对话模型支持:
 *   - 本地 Ollama (qwen2.5:7b 推荐)
 *   - 远程 API (通过 hala.lokfeel.com 隧道)
 *   - OpenAI 兼容 API
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ── 账号人设模板 ─────────────────────────────────────
const PersonaTemplates = {
  tech_enthusiast: {
    name: '科技爱好者',
    traits: ['curious', 'analytical', 'helpful', 'slightly_nerdy'],
    tone: 'enthusiastic but measured',
    interests: ['AI', 'programming', 'gadgets', 'startups'],
    writingStyle: 'uses technical terms naturally, asks thoughtful questions',
    responseStyle: 'shares personal experience, provides specific examples',
  },
  casual_user: {
    name: '普通用户',
    traits: ['friendly', 'relatable', 'casual', 'opinionated'],
    tone: 'casual and warm',
    interests: ['lifestyle', 'entertainment', 'food', 'travel'],
    writingStyle: 'simple language, uses slang, emoji occasionally',
    responseStyle: 'shares personal stories, agrees or disagrees naturally',
  },
  professional: {
    name: '专业人士',
    traits: ['knowledgeable', 'respectful', 'structured', 'insightful'],
    tone: 'professional yet approachable',
    interests: ['business', 'finance', 'marketing', 'leadership'],
    writingStyle: 'clear and concise, uses industry terms appropriately',
    responseStyle: 'provides value, offers different perspectives',
  },
  creative: {
    name: '创意人士',
    traits: ['imaginative', 'expressive', 'open_minded', 'quirky'],
    tone: 'playful and inspiring',
    interests: ['art', 'design', 'music', 'photography'],
    writingStyle: 'vivid descriptions, metaphorical, emotional',
    responseStyle: 'encourages creativity, shares unique perspectives',
  },
  community_builder: {
    name: '社区建设者',
    traits: ['welcoming', 'supportive', 'inclusive', 'engaging'],
    tone: 'warm and encouraging',
    interests: ['community', 'social_impact', 'education', 'networking'],
    writingStyle: 'inclusive language, asks questions, acknowledges others',
    responseStyle: 'builds on others\' ideas, creates connections',
  },
};

// ── 平台对话风格 ─────────────────────────────────────
const PlatformDialogueStyle = {
  reddit: {
    avgReplyLength: { min: 30, max: 200 },
    tone: 'thoughtful, community-oriented',
    rules: [
      '回复要有实质内容，不要只说"同意"',
      '可以温和地表达不同意见',
      '使用Reddit格式（引用、列表）',
      '避免推广语言',
      '可以适当使用Reddit梗和文化',
    ],
    forbiddenPatterns: ['推广链接', '模板化回复', '过短回复(<10字)'],
  },
  x: {
    avgReplyLength: { min: 10, max: 280 },
    tone: 'punchy, witty',
    rules: [
      '回复要简洁有力',
      '可以使用幽默和讽刺',
      '1-2个emoji即可',
      '可以引用推文回复',
      '不要长篇大论',
    ],
    forbiddenPatterns: ['长篇大论(>280字)', '过多emoji', '无聊的附和'],
  },
  instagram: {
    avgReplyLength: { min: 5, max: 150 },
    tone: 'warm, supportive, visual',
    rules: [
      '使用emoji表达情感',
      '回复要温馨友好',
      '可以赞美但不要过度',
      '使用Instagram文化语言',
      '鼓励互动',
    ],
    forbiddenPatterns: ['冷漠回复', '推广内容', '过长回复'],
  },
  tiktok: {
    avgReplyLength: { min: 5, max: 100 },
    tone: 'trendy, energetic',
    rules: [
      '使用流行语和梗',
      '回复要有趣',
      '可以使用emoji',
      '参与trend',
      '简短有力',
    ],
    forbiddenPatterns: ['无聊回复', '过长回复', '不使用平台文化'],
  },
  facebook: {
    avgReplyLength: { min: 15, max: 200 },
    tone: 'warm, community-focused',
    rules: [
      '回复要真诚',
      '可以分享个人经历',
      '使用友好的语气',
      '鼓励进一步讨论',
      '避免争议性话题',
    ],
    forbiddenPatterns: ['争议性言论', '推广内容', '冷漠回复'],
  },
  discord: {
    avgReplyLength: { min: 10, max: 500 },
    tone: 'casual, friendly',
    rules: [
      '使用对话式语言',
      '可以引用消息回复',
      '适当使用emoji和反应',
      '积极参与讨论',
      '尊重其他成员',
    ],
    forbiddenPatterns: ['广播式发言', 'spam', '不相关内容'],
  },
};

// ── 对话上下文管理 ───────────────────────────────────
class DialogueContext {
  constructor(accountId, platform) {
    this.accountId = accountId;
    this.platform = platform;
    this.history = [];
    this.persona = null;
    this.maxHistoryLength = 20;
    this.personalityTraits = {};
    this.emotionalState = 'neutral';
  }

  setPersona(personaKey) {
    this.persona = PersonaTemplates[personaKey] || PersonaTemplates.casual_user;
    this.personalityTraits = { ...this.persona.traits };
  }

  addMessage(role, content, metadata = {}) {
    this.history.push({
      role,          // 'user' | 'assistant' | 'system'
      content,
      timestamp: Date.now(),
      metadata,      // { postId, commentId, userId, userName, ... }
    });

    if (this.history.length > this.maxHistoryLength) {
      this.history.shift();
    }
  }

  getRecentHistory(count = 5) {
    return this.history.slice(-count);
  }

  getFormattedHistory(count = 10) {
    return this.getRecentHistory(count)
      .map(m => `${m.role === 'user' ? 'Them' : 'You'}: ${m.content}`)
      .join('\n');
  }
}

// ── LOK 对话引擎 ─────────────────────────────────────
class LokDialogueEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    // LOK 对话模型端点
    this.endpoints = {
      ollama: opts.ollamaEndpoint || 'http://localhost:11434/api/generate',
      ollamaChat: opts.ollamaChatEndpoint || 'http://localhost:11434/api/chat',
      remote: opts.remoteEndpoint || 'https://hala.lokfeel.com/api/lok/chat',
      openai: opts.openaiEndpoint || null,
    };
    this.model = opts.model || 'qwen2.5:7b';
    this.fallbackModel = opts.fallbackModel || 'qwen2.5:3b';
    this.temperature = opts.temperature || 0.8;
    this.maxTokens = opts.maxTokens || 500;
    this.contexts = new Map();  // accountId -> DialogueContext
    this.replyQueue = [];
    this.processing = false;
  }

  // 生成回复
  async generateReply(accountId, platform, incomingMessage, opts = {}) {
    const context = this._getOrCreateContext(accountId, platform);

    // 设置人设（如果尚未设置）
    if (!context.persona) {
      context.setPersona(opts.persona || this._selectPersona(platform));
    }

    // 添加收到的消息到上下文
    context.addMessage('user', incomingMessage.text, {
      postId: incomingMessage.postId,
      commentId: incomingMessage.commentId,
      userId: incomingMessage.userId,
      userName: incomingMessage.userName,
    });

    // 构建提示词
    const prompt = this._buildPrompt(context, incomingMessage, opts);

    // 调用LOK对话模型
    let reply;
    try {
      reply = await this._callLokModel(prompt, opts);
    } catch (e) {
      this.emit('dialogue:fallback', { error: e.message, accountId });
      // 使用备选模型
      try {
        reply = await this._callLokModel(prompt, { ...opts, model: this.fallbackModel });
      } catch (e2) {
        // 使用规则基础回复
        reply = this._generateRuleBasedReply(context, incomingMessage, opts);
      }
    }

    // 后处理
    reply = this._postProcessReply(reply, platform, opts);

    // 添加回复到上下文
    context.addMessage('assistant', reply.text, { generated: true });

    // 情感分析
    const sentiment = this._analyzeSentiment(incomingMessage.text);
    if (sentiment.negative) {
      context.emotionalState = 'cautious';
    }

    const result = {
      accountId,
      platform,
      reply: reply.text,
      confidence: reply.confidence || 0.8,
      sentiment,
      persona: context.persona?.name,
      contextLength: context.history.length,
      metadata: reply.metadata || {},
    };

    this.emit('dialogue:generated', result);
    return result;
  }

  // 批量生成回复
  async batchGenerateReply(messages, opts = {}) {
    const results = [];
    for (const msg of messages) {
      try {
        const result = await this.generateReply(msg.accountId, msg.platform, msg.incomingMessage, opts);
        results.push(result);
      } catch (e) {
        results.push({ error: e.message, ...msg });
      }
    }
    return results;
  }

  // 构建提示词
  _buildPrompt(context, incomingMessage, opts) {
    const style = PlatformDialogueStyle[context.platform] || PlatformDialogueStyle.reddit;
    const persona = context.persona || PersonaTemplates.casual_user;
    const recentHistory = context.getFormattedHistory(5);

    const systemPrompt = `You are a ${persona.name} on ${context.platform}.
Your personality: ${persona.traits.join(', ')}.
Your tone: ${persona.tone}.
Your interests: ${persona.interests.join(', ')}.
Your writing style: ${persona.writingStyle}.
Your response style: ${persona.responseStyle}.

Platform rules:
${style.rules.map(r => `- ${r}`).join('\n')}

Reply length: ${style.avgReplyLength.min}-${style.avgReplyLength.max} characters.
Tone: ${style.tone}

Important:
- Sound like a real person, NOT an AI
- Be natural and conversational
- Don't use generic phrases like "I completely agree" or "That's a great point"
- Add personality and opinions
- Use platform-appropriate language and culture
- Don't be overly positive or balanced
- It's okay to disagree politely
- Don't include any AI disclaimers`;

    const userPrompt = `Recent conversation:
${recentHistory || '(No previous conversation)'}

New message from ${incomingMessage.userName || 'user'}:
"${incomingMessage.text}"

${opts.additionalContext ? `Context: ${opts.additionalContext}\n` : ''}Your reply:`;

    return { system: systemPrompt, user: userPrompt };
  }

  // 调用LOK对话模型
  async _callLokModel(prompt, opts = {}) {
    const model = opts.model || this.model;

    // 优先使用Ollama Chat API（支持system prompt）
    const data = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      stream: false,
      options: {
        temperature: opts.temperature || this.temperature,
        top_p: 0.9,
        max_tokens: opts.maxTokens || this.maxTokens,
      },
    });

    const response = await this._httpRequest(this.endpoints.ollamaChat, 'POST', data);
    const replyText = response.message?.content || response.response || '';

    return {
      text: replyText.trim(),
      confidence: 0.85,
      metadata: {
        model,
        tokensUsed: response.eval_count || 0,
        duration: response.total_duration ? response.total_duration / 1e9 : 0,
      },
    };
  }

  // HTTP 请求封装
  _httpRequest(url, method, data) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      if (data) {
        options.headers['Content-Length'] = Buffer.byteLength(data);
      }

      const req = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ response: body });
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('LOK model timeout')); });
      if (data) req.write(data);
      req.end();
    });
  }

  // 规则基础回复（LLM不可用时的备选方案）
  _generateRuleBasedReply(context, incomingMessage, opts) {
    const style = PlatformDialogueStyle[context.platform] || PlatformDialogueStyle.reddit;
    const persona = context.persona || PersonaTemplates.casual_user;
    const text = incomingMessage.text.toLowerCase();

    // 模板库
    const templates = {
      agreement: [
        'Yeah, totally get what you mean.',
        'This. So much this.',
        'Honestly, same here.',
        'You\'re spot on with this one.',
        'Couldn\'t agree more, actually been thinking the same thing.',
      ],
      question: [
        'That\'s a really good question. From what I\'ve seen...',
        'Hmm, honestly not sure but here\'s my take:',
        'Interesting question! I think it depends on the situation.',
        'Good question. Let me think about this...',
      ],
      disagreement: [
        'I see where you\'re coming from, but I gotta disagree on this one.',
        'Hmm, I\'m not so sure about that tbh.',
        'Respectfully, I think it\'s a bit more nuanced than that.',
        'I get the logic but my experience has been different.',
      ],
      empathy: [
        'Man, that sounds rough. Hang in there.',
        'Ugh, been there. It gets better though.',
        'That really sucks, sorry you\'re dealing with that.',
        'Oh no, that\'s frustrating. Hope it works out.',
      ],
      humor: [
        'Lol this is too relatable',
        'Not me reading this at 2am thinking the exact same thing',
        'The way I immediately thought of my own situation lol',
        'This comment aged like fine wine',
      ],
      informational: [
        'Actually, from what I\'ve read, it\'s a bit different.',
        'I looked into this recently. Here\'s what I found:',
        'Not an expert but I think the answer depends on a few factors.',
        'From my experience, it\'s not that straightforward.',
      ],
    };

    // 检测消息类型
    let category = 'agreement';
    if (text.includes('?') || text.includes('how') || text.includes('what') || text.includes('why')) {
      category = 'question';
    } else if (text.includes('sad') || text.includes('bad') || text.includes('hard') || text.includes('struggle')) {
      category = 'empathy';
    } else if (text.includes('funny') || text.includes('lol') || text.includes('haha')) {
      category = 'humor';
    }

    const replies = templates[category] || templates.agreement;
    const reply = replies[Math.floor(Math.random() * replies.length)];

    return { text: reply, confidence: 0.5, metadata: { method: 'rule_based' } };
  }

  // 后处理回复
  _postProcessReply(reply, platform, opts) {
    let text = '';
    if (typeof reply === 'string') {
      text = reply;
    } else if (reply && typeof reply.text === 'string') {
      text = reply.text;
    } else if (reply && typeof reply === 'object') {
      text = String(reply.text || reply.response || reply.message || '');
    }

    // 移除AI常见后缀
    text = text.replace(/(?:As an AI|I hope this helps|Let me know if|Feel free to|Is there anything else).*$/gi, '');
    text = text.replace(/^(?:Sure|Of course|Absolutely),?\s*/i, '');

    // 平台特定长度限制
    const style = PlatformDialogueStyle[platform] || PlatformDialogueStyle.reddit;
    if (text.length > style.avgReplyLength.max) {
      // 截断到最后一个完整句子
      const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
      let truncated = '';
      for (const s of sentences) {
        if ((truncated + s).length <= style.avgReplyLength.max) {
          truncated += s;
        } else break;
      }
      text = truncated || text.slice(0, style.avgReplyLength.max);
    }

    // 检查禁止模式
    const forbidden = style.forbiddenPatterns || [];
    for (const pattern of forbidden) {
      if (pattern.includes('过短') && text.length < 10) {
        text = text + ' Really appreciate you sharing this.';
      }
    }

    return { text: text.trim(), confidence: (typeof reply === 'object' ? reply.confidence : null) || 0.8, metadata: (typeof reply === 'object' ? reply.metadata : null) || {} };
  }

  // 情感分析
  _analyzeSentiment(text) {
    const positive = ['good', 'great', 'love', 'amazing', 'awesome', 'happy', 'excellent', 'wonderful'];
    const negative = ['bad', 'hate', 'terrible', 'awful', 'sad', 'angry', 'frustrated', 'disappointing']
    const lower = text.toLowerCase();

    const positiveCount = positive.filter(w => lower.includes(w)).length;
    const negativeCount = negative.filter(w => lower.includes(w)).length;

    return {
      positive: positiveCount > negativeCount,
      negative: negativeCount > positiveCount,
      neutral: positiveCount === negativeCount,
      score: positiveCount - negativeCount,
    };
  }

  // 选择人设
  _selectPersona(platform) {
    const platformPersonaMap = {
      reddit: 'tech_enthusiast',
      x: 'casual_user',
      instagram: 'creative',
      tiktok: 'casual_user',
      facebook: 'community_builder',
      youtube: 'tech_enthusiast',
      discord: 'community_builder',
    };
    return platformPersonaMap[platform] || 'casual_user';
  }

  // 获取或创建对话上下文
  _getOrCreateContext(accountId, platform) {
    const key = `${accountId}_${platform}`;
    if (!this.contexts.has(key)) {
      this.contexts.set(key, new DialogueContext(accountId, platform));
    }
    return this.contexts.get(key);
  }

  // 设置账号人设
  setPersona(accountId, platform, personaKey) {
    const context = this._getOrCreateContext(accountId, platform);
    context.setPersona(personaKey);
    this.emit('persona:set', { accountId, platform, persona: personaKey });
  }

  // 获取对话历史
  getHistory(accountId, platform) {
    const key = `${accountId}_${platform}`;
    return this.contexts.get(key)?.history || [];
  }

  // 清除对话历史
  clearHistory(accountId, platform) {
    const key = `${accountId}_${platform}`;
    this.contexts.delete(key);
    this.emit('history:cleared', { accountId, platform });
  }

  // 获取可用模型列表
  async listModels() {
    try {
      const response = await this._httpRequest('http://localhost:11434/api/tags', 'GET');
      return (response.models || []).map(m => ({
        name: m.name,
        size: m.size,
        parameters: m.details?.parameter_size,
        family: m.details?.family,
      }));
    } catch (e) {
      return [];
    }
  }
}

module.exports = { LokDialogueEngine, DialogueContext, PersonaTemplates, PlatformDialogueStyle };
