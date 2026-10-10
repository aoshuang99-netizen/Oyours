/**
 * content-deai.js — MSCMS v14 内容去AI味处理引擎
 *
 * 将AI生成的内容进行去AI味处理，使其更自然、更像真人撰写：
 *   1. AI痕迹检测与评分
 *   2. 句式多样化处理
 *   3. 口语化表达转换
 *   4. 标点符号人性化
 *   5. 情感色彩注入
 *   6. 拼写/语法"合理错误"注入
 *   7. 个性化风格迁移
 *   8. 多轮润色与迭代
 *
 * 可调用 WorkBuddy 的相关技能（如 scrapling-web-fetch 获取参考文风、
 * summarize 提取风格特征等）增强去AI味效果。
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ── AI痕迹特征库 ─────────────────────────────────────
const AIPatterns = {
  // AI常用过渡词（需替换或删除）
  transitionWords: [
    'Furthermore', 'Moreover', 'Additionally', 'Consequently', 'Nevertheless',
    'It is worth noting', 'It should be mentioned', 'In conclusion',
    'As previously mentioned', 'In today\'s world', 'In the digital age',
    'It\'s important to note', 'Needless to say', 'At the end of the day',
    'When it comes to', 'The bottom line is',
  ],
  // AI常用句式模式
  sentencePatterns: [
    /In today's (digital|modern|fast-paced) world,? /gi,
    /It'?s (important|crucial|essential|vital) to (note|remember|understand|consider) that/gi,
    /When it comes to .+?,? (it'?s|one must|we should)/gi,
    /(?:The )?(?:key|main|primary) (?:to|aspect of|factor in) .+? is/gi,
    /(?:Not only|Whether) .+?,? but also/gi,
    /(?:In conclusion|To summarize|In summary|To wrap up)/gi,
    /(?:As|Since|Because) .+?,? (?:it'?s|we|this|that)/gi,
    /(?:There'?s no denying|There'?s no doubt) that/gi,
    /(?:Let'?s|Let us) (?:dive|explore|delve|look) into/gi,
    /(?:Imagine|Picture|Think about) (?:this|a|the)/gi,
  ],
  // AI常用空洞表达
  hollowExpressions: [
    'game-changer', 'revolutionary', 'cutting-edge', 'state-of-the-art',
    'in the realm of', 'navigating the landscape of', 'harnessing the power of',
    'a testament to', 'in the ever-evolving', 'paradigm shift',
    'holy grail', 'silver bullet', 'perfect storm',
  ],
  // AI偏好结构（过于工整的三段式/列表式）
  structuralPatterns: [
    'three_key_points',    // 总是列三个要点
    'intro_body_conclusion', // 标准三段式
    'question_hook',       // 开头总是提问
    'bold_statement_end',  // 结尾总是大胆声明
  ],
  // AI常见情感表达（过于均匀）
  emotionPatterns: {
    tooBalanced: '观点过于平衡（总是both sides）',
    tooPositive: '情感过于正面',
    noVulnerability: '缺乏真实的不确定性和脆弱感',
    noPersonalAnecdote: '缺乏个人轶事',
  },
};

// ── 去AI味处理规则 ───────────────────────────────────
const DeAIRules = {
  // 句式多样化策略
  sentenceDiversification: {
    minSentenceLength: 5,
    maxSentenceLength: 40,
    targetAvgLength: 18,            // 真人平均句长约18词
    lengthVariation: 0.4,           // 句长变化系数
    fragmentProbability: 0.1,       // 使用句子片段的概率
    runOnProbability: 0.05,         // 使用流水句的概率
  },
  // 口语化转换
  colloquialTransforms: [
    { pattern: /I would like to/gi, replacement: 'I wanna' },
    { pattern: /I am going to/gi, replacement: 'I\'m gonna' },
    { pattern: /do not/gi, replacement: 'don\'t' },
    { pattern: /cannot/gi, replacement: 'can\'t' },
    { pattern: /It is/gi, replacement: 'It\'s' },
    { pattern: /That is/gi, replacement: 'That\'s' },
    { pattern: /They are/gi, replacement: 'They\'re' },
    { pattern: /We are/gi, replacement: 'We\'re' },
    { pattern: /I will/gi, replacement: 'I\'ll' },
    { pattern: /would not/gi, replacement: 'wouldn\'t' },
    { pattern: /could not/gi, replacement: 'couldn\'t' },
    { pattern: /should not/gi, replacement: 'shouldn\'t' },
    { pattern: /utilize/gi, replacement: 'use' },
    { pattern: /commence/gi, replacement: 'start' },
    { pattern: /terminate/gi, replacement: 'end' },
    { pattern: /demonstrate/gi, replacement: 'show' },
    { pattern: /facilitate/gi, replacement: 'help' },
    { pattern: /individuals/gi, replacement: 'people' },
    { pattern: /approximately/gi, replacement: 'about' },
    { pattern: /sufficient/gi, replacement: 'enough' },
    { pattern: /numerous/gi, replacement: 'many' },
    { pattern: /subsequently/gi, replacement: 'then' },
    { pattern: /nevertheless/gi, replacement: 'still' },
    { pattern: /furthermore/gi, replacement: 'also' },
    { pattern: /moreover/gi, replacement: 'plus' },
    { pattern: /additionally/gi, replacement: 'also' },
    { pattern: /consequently/gi, replacement: 'so' },
    { pattern: /In conclusion/gi, replacement: 'So yeah' },
    { pattern: /In summary/gi, replacement: 'TL;DR' },
    { pattern: /It is worth noting/gi, replacement: '' },
    { pattern: /It is important to note/gi, replacement: '' },
    { pattern: /It should be mentioned/gi, replacement: '' },
  ],
  // 人性化标点
  punctuationHumanize: {
    useEmDashes: true,               // 使用破折号
    useEllipses: true,               // 使用省略号
    useCasualCommas: true,           // 随意逗号
    avoidOxfordComma: 0.5,           // 50%概率避免牛津逗号
    useExclamationModerately: true,  // 适度使用感叹号
    useParentheses: true,            // 使用括号补充
  },
  // 合理错误注入（模拟真人打字）
  realisticErrors: {
    typoProbability: 0.02,           // 2%概率出现打字错误
    typoTypes: ['transposition', 'doubling', 'omission', 'substitution'],
    commonTypos: {
      'the': ['teh', 'th'],
      'and': ['adn', 'an'],
      'you': ['yuo', 'u'],
      'that': ['taht', 'tht'],
      'with': ['wiht', 'wth'],
      'really': ['realy', 'rly'],
      'because': ['becuase', 'cuz'],
    },
    autoCorrectProbability: 0.3,     // 30%概率"自动纠正"（打错了又改回来）
  },
  // 个性化风格
  personalStyle: {
    useFillerWords: ['honestly', 'tbh', 'ngl', 'like', 'basically', 'literally', 'actually', 'right'],
    fillerProbability: 0.15,
    useOpinionMarkers: ['I think', 'imo', 'from what I\'ve seen', 'in my experience', 'personally'],
    opinionProbability: 0.2,
    useHedging: ['kinda', 'sort of', 'probably', 'I guess', 'maybe', 'ish'],
    hedgingProbability: 0.1,
    useCasualOpeners: ['So,', 'Look,', 'Okay so', 'Here\'s the thing -', 'Real talk:', 'Not gonna lie,'],
    casualOpenerProbability: 0.2,
  },
};

// ── 去AI味处理引擎 ───────────────────────────────────
class DeAIProcessor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.llmEndpoint = opts.llmEndpoint || 'http://localhost:11434/api/generate';
    this.llmModel = opts.llmModel || 'llama3';
    this.intensity = opts.intensity || 'medium'; // light, medium, strong
    this.preservePlatformRules = opts.preservePlatformRules || true;
    this.iterationCount = opts.iterationCount || 2;
  }

  // 检测AI痕迹并评分
  detectAI(content) {
    const text = content.body || content.text || content.caption || '';
    const signals = [];
    let score = 0;

    // 1. 检查过渡词
    const transitionsFound = AIPatterns.transitionWords.filter(w => text.includes(w));
    if (transitionsFound.length > 0) {
      score += transitionsFound.length * 5;
      signals.push({ type: 'transition_words', count: transitionsFound.length, items: transitionsFound });
    }

    // 2. 检查句式模式
    let patternMatches = 0;
    for (const pattern of AIPatterns.sentencePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        patternMatches += matches.length;
        score += matches.length * 8;
      }
    }
    if (patternMatches > 0) {
      signals.push({ type: 'sentence_patterns', count: patternMatches });
    }

    // 3. 检查空洞表达
    const hollowFound = AIPatterns.hollowExpressions.filter(e => text.toLowerCase().includes(e.toLowerCase()));
    if (hollowFound.length > 0) {
      score += hollowFound.length * 6;
      signals.push({ type: 'hollow_expressions', count: hollowFound.length, items: hollowFound });
    }

    // 4. 检查句长均匀性
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    if (sentences.length > 3) {
      const lengths = sentences.map(s => s.trim().split(/\s+/).length);
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const variance = lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / avg; // 变异系数

      if (cv < 0.2) {
        score += 15;
        signals.push({ type: 'uniform_sentence_length', cv, avg, stdDev });
      }
    }

    // 5. 检查情感平衡性
    const positiveWords = (text.match(/\b(great|amazing|excellent|wonderful|fantastic|perfect|love|awesome)\b/gi) || []).length;
    const negativeWords = (text.match(/\b(bad|terrible|awful|horrible|hate|worst|disappointing)\b/gi) || []).length;
    if (positiveWords > 0 && negativeWords === 0) {
      score += 10;
      signals.push({ type: 'too_positive', positiveCount: positiveWords });
    }

    // 6. 检查段落结构过于工整
    if (content.body) {
      const paragraphs = content.body.split(/\n\n+/).filter(p => p.trim().length > 0);
      if (paragraphs.length === 3 || paragraphs.length === 5) {
        const paraLengths = paragraphs.map(p => p.split(/\s+/).length);
        const avgLen = paraLengths.reduce((a, b) => a + b, 0) / paraLengths.length;
        const lenVariation = paraLengths.every(l => Math.abs(l - avgLen) < avgLen * 0.2);
        if (lenVariation) {
          score += 12;
          signals.push({ type: 'uniform_paragraph_structure' });
        }
      }
    }

    // 7. 检查是否缺少个人语气
    const personalPronouns = (text.match(/\b(I|me|my|mine|we|us|our)\b/gi) || []).length;
    const totalWords = text.split(/\s+/).length;
    const personalRatio = personalPronouns / totalWords;
    if (personalRatio < 0.02) {
      score += 10;
      signals.push({ type: 'lack_of_personal_voice', ratio: personalRatio });
    }

    let level = 'human';
    if (score >= 50) level = 'highly_ai';
    else if (score >= 30) level = 'moderately_ai';
    else if (score >= 15) level = 'slightly_ai';

    return { score, level, signals, totalWords };
  }

  // 执行去AI味处理
  async process(content, opts = {}) {
    const platform = opts.platform || 'reddit';
    const intensity = opts.intensity || this.intensity;
    const iterations = opts.iterations || this.iterationCount;

    this.emit('deai:started', { platform, intensity, iterations });

    let processed = { ...content };
    const originalText = processed.body || processed.text || processed.caption || '';

    // 第一轮：规则基础处理
    processed = this._applyRuleBasedDeAI(processed, intensity);

    // 第二轮：LLM增强处理（如果可用）
    if (this.llmEndpoint) {
      try {
        processed = await this._applyLLMDeAI(processed, platform, intensity);
      } catch (e) {
        this.emit('deai:llm_fallback', { error: e.message });
        // LLM不可用时使用高级规则处理
        processed = this._applyAdvancedRuleDeAI(processed, intensity);
      }
    } else {
      processed = this._applyAdvancedRuleDeAI(processed, intensity);
    }

    // 多轮迭代优化
    for (let i = 1; i < iterations; i++) {
      const aiScore = this.detectAI(processed);
      if (aiScore.score < 15) break; // 足够自然了

      processed = this._applyRuleBasedDeAI(processed, intensity);
      if (this.llmEndpoint) {
        try {
          processed = await this._applyLLMDeAI(processed, platform, intensity);
        } catch (e) {
          // 忽略LLM错误，继续使用规则
        }
      }
    }

    // 最终检测
    const finalDetection = this.detectAI(processed);
    const originalDetection = this.detectAI({ ...content });

    const result = {
      original: content,
      processed,
      originalAIScore: originalDetection.score,
      finalAIScore: finalDetection.score,
      improvement: originalDetection.score - finalDetection.score,
      improvementPercent: originalDetection.score > 0 ? Math.round((1 - finalDetection.score / originalDetection.score) * 100) : 0,
      aiLevel: finalDetection.level,
      remainingSignals: finalDetection.signals,
    };

    this.emit('deai:completed', result);
    return result;
  }

  // 规则基础去AI味
  _applyRuleBasedDeAI(content, intensity) {
    let text = content.body || content.text || content.caption || '';
    const factor = intensity === 'strong' ? 1.0 : intensity === 'medium' ? 0.7 : 0.4;

    // 1. 替换AI过渡词和句式
    for (const transform of DeAIRules.colloquialTransforms) {
      text = text.replace(transform.pattern, transform.replacement);
    }

    // 2. 删除空洞表达
    for (const hollow of AIPatterns.hollowExpressions) {
      const regex = new RegExp(hollow, 'gi');
      text = text.replace(regex, '');
    }

    // 3. 句式多样化
    if (factor > 0.5) {
      text = this._diversifySentences(text, factor);
    }

    // 4. 添加个性化表达
    if (Math.random() < DeAIRules.personalStyle.casualOpenerProbability * factor) {
      const opener = DeAIRules.personalStyle.useCasualOpeners[
        Math.floor(Math.random() * DeAIRules.personalStyle.useCasualOpeners.length)
      ];
      text = `${opener} ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }

    // 5. 添加filler words
    if (Math.random() < DeAIRules.personalStyle.fillerProbability * factor) {
      const filler = DeAIRules.personalStyle.useFillerWords[
        Math.floor(Math.random() * DeAIRules.personalStyle.useFillerWords.length)
      ];
      // 在随机位置插入
      const sentences = text.split('. ');
      if (sentences.length > 1) {
        const idx = Math.floor(Math.random() * sentences.length);
        sentences[idx] = `${filler}, ${sentences[idx].charAt(0).toLowerCase()}${sentences[idx].slice(1)}`;
        text = sentences.join('. ');
      }
    }

    // 6. 人性化标点
    if (factor > 0.5) {
      text = this._humanizePunctuation(text, factor);
    }

    // 7. 注入合理错误（仅在strong模式）
    if (intensity === 'strong' && Math.random() < DeAIRules.realisticErrors.typoProbability) {
      text = this._injectRealisticErrors(text);
    }

    // 8. 添加个人观点标记
    if (Math.random() < DeAIRules.personalStyle.opinionProbability * factor) {
      const marker = DeAIRules.personalStyle.useOpinionMarkers[
        Math.floor(Math.random() * DeAIRules.personalStyle.useOpinionMarkers.length)
      ];
      // 在第二句或第三句前插入
      const sentences = text.split('. ');
      if (sentences.length > 2) {
        sentences[1] = `${marker}, ${sentences[1].charAt(0).toLowerCase()}${sentences[1].slice(1)}`;
        text = sentences.join('. ');
      }
    }

    // 更新内容
    if (content.body) content.body = text;
    else if (content.text) content.text = text;
    else if (content.caption) content.caption = text;

    return content;
  }

  // 句式多样化
  _diversifySentences(text, factor) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const diversified = sentences.map((sentence, i) => {
      let s = sentence.trim();
      const words = s.split(/\s+/);
      const len = words.length;

      // 偶尔合并短句
      if (i > 0 && len < 8 && Math.random() < 0.3 * factor) {
        return s.charAt(0).toLowerCase() + s.slice(1);
      }

      // 偶尔使用句子片段
      if (len > 25 && Math.random() < 0.15 * factor) {
        const midPoint = Math.floor(len / 2);
        const firstHalf = words.slice(0, midPoint).join(' ') + '.';
        const secondHalf = words.slice(midPoint).join(' ');
        return `${firstHalf} ${secondHalf}`;
      }

      return s;
    });

    return diversified.join(' ');
  }

  // 人性化标点
  _humanizePunctuation(text, factor) {
    // 使用破折号替换部分逗号
    if (DeAIRules.punctuationHumanize.useEmDashes && Math.random() < 0.2 * factor) {
      text = text.replace(/, (?:which|that|where|when) /, ' — ');
    }

    // 使用省略号
    if (DeAIRules.punctuationHumanize.useEllipses && Math.random() < 0.1 * factor) {
      text = text.replace(/\. /, '... ');
    }

    // 适度使用感叹号
    if (DeAIRules.punctuationHumanize.useExclamationModerately && Math.random() < 0.15 * factor) {
      text = text.replace(/\.$/, '!');
    }

    return text;
  }

  // 注入合理错误
  _injectRealisticErrors(text) {
    const words = text.split(/\s+/);
    const errorTypes = DeAIRules.realisticErrors.typoTypes;

    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[^a-zA-Z]/g, '').toLowerCase();
      if (DeAIRules.realisticErrors.commonTypos[word] && Math.random() < 0.3) {
        const typos = DeAIRules.realisticErrors.commonTypos[word];
        const typo = typos[Math.floor(Math.random() * typos.length)];
        // 保持原始大小写和标点
        const prefix = words[i].match(/^[^a-zA-Z]*/)[0];
        const suffix = words[i].match(/[^a-zA-Z]*$/)[0];
        const core = words[i].slice(prefix.length, words[i].length - suffix.length);
        const replacement = core.charAt(0) === core.charAt(0).toUpperCase()
          ? typo.charAt(0).toUpperCase() + typo.slice(1)
          : typo;
        words[i] = prefix + replacement + suffix;
      }
    }

    return words.join(' ');
  }

  // 高级规则去AI味（LLM不可用时的备选方案）
  _applyAdvancedRuleDeAI(content, intensity) {
    let text = content.body || content.text || content.caption || '';
    const factor = intensity === 'strong' ? 1.0 : intensity === 'medium' ? 0.7 : 0.4;

    // 1. 打破完美段落结构
    const paragraphs = text.split(/\n\n+/);
    if (paragraphs.length >= 3) {
      // 随机合并相邻段落或拆分段落
      if (Math.random() < 0.3 * factor) {
        const mergeIdx = Math.floor(Math.random() * (paragraphs.length - 1));
        paragraphs[mergeIdx] = paragraphs[mergeIdx] + ' ' + paragraphs[mergeIdx + 1];
        paragraphs.splice(mergeIdx + 1, 1);
      }
      text = paragraphs.join('\n\n');
    }

    // 2. 添加个人轶事（模板化）
    if (Math.random() < 0.2 * factor) {
      const anecdotes = [
        'Reminds me of when I first started out - total disaster lol',
        'I remember struggling with this exact thing a few months back',
        'Actually dealt with something similar recently',
        'Been there, done that, got the t-shirt',
      ];
      const anecdote = anecdotes[Math.floor(Math.random() * anecdotes.length)];
      const sentences = text.split('. ');
      if (sentences.length > 2) {
        const insertIdx = Math.floor(Math.random() * (sentences.length - 1)) + 1;
        sentences.splice(insertIdx, 0, anecdote);
        text = sentences.join('. ');
      }
    }

    // 3. 添加不确定性表达
    if (Math.random() < 0.15 * factor) {
      const hedges = DeAIRules.personalStyle.useHedging;
      const hedge = hedges[Math.floor(Math.random() * hedges.length)];
      text = text.replace(/\. /, `, ${hedge}. `);
    }

    // 更新内容
    if (content.body) content.body = text;
    else if (content.text) content.text = text;
    else if (content.caption) content.caption = text;

    return content;
  }

  // LLM增强去AI味
  async _applyLLMDeAI(content, platform, intensity) {
    const text = content.body || content.text || content.caption || '';
    const prompt = `Rewrite the following text to make it sound more human and natural. Remove AI-like patterns (overly formal transitions, perfect structure, generic phrases). Make it conversational, add personality, vary sentence length. Keep the same meaning and key points.

Platform: ${platform}
Intensity: ${intensity}

Original text:
${text}

Rewritten text (output ONLY the rewritten text, no explanations):`;

    // 【2026-09-09 修复】原实现把 LLM 的错误响应（如 Ollama 的 "400 Bad Request"）当作正文写回 content，
    // 污染后的内容一路通过质检（quality_score 模板分恒 75+）进入发布池，实测外发过 114+ 条垃圾帖。
    // 现在：① 调用失败不覆盖原文；② 命中错误响应/占位黑名单不覆盖；③ 过短的改写不覆盖。
    const BAD_LLM = /^(400|401|403|404|405|408|429|500|502|503|504)\b|bad request|internal server error|service unavailable|unauthorized|forbidden|not found|gateway|error occurred|timed? ?out|model .* not found/i;
    let response = '';
    try {
      response = (await this._callLLM(prompt)) || '';
    } catch (e) {
      this._lastError = e.message;
      return content; // 保持原文，绝不把异常文本写成正文
    }
    const out = String(response).trim();
    if (out.length > 30 && !BAD_LLM.test(out.slice(0, 80))) {
      if (content.body) content.body = out;
      else if (content.text) content.text = out;
      else if (content.caption) content.caption = out;
    } else if (out) {
      this._lastError = `去AI味输出被拒（长度 ${out.length}，或命中错误响应黑名单）`;
    }

    return content;
  }

  // 调用LLM API
  _callLLM(prompt) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: this.llmModel,
        prompt,
        stream: false,
        options: { temperature: 0.8, top_p: 0.9 },
      });

      const url = new URL(this.llmEndpoint);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      };

      const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          // ① HTTP 非 2xx —— 一律视为失败，绝不把错误页面当正文返回
          if (res.statusCode >= 400) {
            return reject(new Error(`LLM HTTP ${res.statusCode}: ${body.slice(0, 80)}`));
          }
          let json = null;
          try { json = JSON.parse(body); } catch (_) { json = null; }
          if (!json) {
            // ② 非 JSON 响应（错误页/纯文本）—— 同样视为失败
            return reject(new Error(`LLM 返回非 JSON: ${body.slice(0, 80)}`));
          }
          if (json.error) {
            // ③ Ollama 业务错误（如 model not found）
            return reject(new Error(`LLM error: ${String(json.error).slice(0, 80)}`));
          }
          resolve(json.response || json.output || '');
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('LLM timeout')); });
      req.write(data);
      req.end();
    });
  }

  // 批量处理
  async batchProcess(contents, opts = {}) {
    const results = [];
    for (const content of contents) {
      try {
        const result = await this.process(content, opts);
        results.push(result);
      } catch (e) {
        results.push({ error: e.message, original: content });
      }
    }
    return results;
  }
}

module.exports = { DeAIProcessor, AIPatterns, DeAIRules };
