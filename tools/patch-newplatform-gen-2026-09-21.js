#!/usr/bin/env node
/**
 * tools/patch-newplatform-gen-2026-09-21.js
 * ─────────────────────────────────────────────────────────────
 * 第 4 层修复：新平台（nostr / bluesky / mastodon / telegram / devto / hashnode / github）
 * 在内容生成链路中「无规格、无模板、无规则」⇒ `Unknown platform` 抛错 ⇒ 永不产出内容。
 *
 * 本脚本以原子方式（单脚本串行 + 幂等 marker + 锚点命中数断言 + 落盘复核）应用 8 处补丁：
 *   [A] aigc-content-generator.js  × 3  (SPECS / TEMPLATES / DEFAULT_TYPES)
 *   [B] platform-content-rules.js  × 3  (PlatformContentRules / _getPlatformSpecs / 中性兜底)
 *   [C] content-pipeline.js        × 1  (_getPlatformSpecs)
 *   [D] server.js                  × 1  (fallback 标记错位 → 日志如实)
 *
 * 用法：
 *   node tools/patch-newplatform-gen-2026-09-21.js          # 应用
 *   node tools/patch-newplatform-gen-2026-09-21.js --dry    # 只检查锚点，不写盘
 *
 * 回滚：使用同目录生成的 *.bak-20260921 备份（脚本自动创建）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const MARK = '[NEWPLAT-2026-09-21]';
// ⚠️ 教训：marker 如果直接插入目标代码而没带 `//`，会被 JS 解析成**计算属性键**
// （`[NEWPLAT-2026-09-21]` = [NaN]），对象字面量随即语法错误。
// 所有插入目标文件的 marker 必须走 CMARK（带注释前缀）。
const CMARK = '// [NEWPLAT-2026-09-21]';
const BAK_SUFFIX = '.bak-20260921';

const GEN = 'aigc-content-generator.js';
const RULES = 'platform-content-rules.js';
const PIPE = 'content-pipeline.js';
const SERVER = 'server.js';

// ── 七个新平台的生成规格 ─────────────────────────────
const SPEC_BLOCK = `  ${CMARK}
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
  mastodon: {
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
  telegram: {
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
  hashnode: {
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
`;

const TPL_BLOCK = `  ${CMARK}
  nostr: \`You are a Nostr user writing a kind:1 note about "{topic}".
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

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}\`,

  bluesky: \`You are a Bluesky user writing a short post about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- HARD LIMIT 300 characters total. Count carefully; shorter is better.
- Conversational, like replying to a friend
- One idea only, sharp and specific
- No hashtags beyond 1
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}\`,

  mastodon: \`You are a Mastodon user writing a post about "{topic}" for your instance's local timeline.
Tone: {tone}
Structure: {structure}
Rules:
- Length: 200-450 characters, hard cap 500
- The fediverse dislikes promotion: write to share, not to sell
- Add a content warning only if the topic is genuinely sensitive
- Use at most 3 hashtags, they matter for discoverability here
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}\`,

  telegram: \`You are the owner of a Telegram channel posting about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 200-600 characters
- Lead with the most useful fact; channel readers skim
- Short lines, generous line breaks, easy to read on mobile
- One clear next step at the end
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"body":"...","tags":["..."],"content_type":"text"}\`,

  devto: \`You are a developer writing a DEV Community article about "{topic}".
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

Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}\`,

  hashnode: \`You are a developer writing a Hashnode blog post about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 800-2500 characters. Hard cap 5000.
- Narrative but technical: explain your reasoning, not just the outcome
- Use markdown headings (##) for at least two sections
- Include one honest limitation or trade-off you hit
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}\`,

  github: \`You are a maintainer writing a GitHub issue or release note about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- Length: 200-800 characters. Hard cap 2000.
- Be precise and factual; no marketing language at all
- State what changed, why it matters, and how to verify it
- Reference concrete identifiers (version, file, flag) where possible
- No emoji
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}\`,

  // ${MARK} 修复孤儿 spec：twitter 存在于 PLATFORM_SPECS 却无模板
  // → _buildPrompt 对 undefined.replace() 抛 TypeError（实测）
  twitter: \`You are a viral Twitter/X creator. Write a tweet about "{topic}".
Tone: {tone}
Structure: {structure}
Rules:
- HARD LIMIT 280 characters. Count carefully.
- Hook in the first 5 words
- One sharp idea; no thread, no "1/5"
- {emojiLevel} emoji usage
{customInstructions}

Output ONLY raw JSON (no markdown code fences, no commentary): {"text":"..."}\`,
`;

const TYPES_BLOCK = `  ${CMARK}
  nostr: CONTENT_TYPES.TEXT,
  bluesky: CONTENT_TYPES.TEXT,
  mastodon: CONTENT_TYPES.TEXT,
  telegram: CONTENT_TYPES.TEXT,
  devto: CONTENT_TYPES.TEXT,
  hashnode: CONTENT_TYPES.TEXT,
  github: CONTENT_TYPES.TEXT,
`;

// ── 七个新平台的内容管理规则（platform-content-rules.js）──
const RULE_BLOCK = `  ${CMARK}
  nostr: {
    name: 'Nostr',
    contentPolicy: {
      prohibited: [
        '禁止非法内容（儿童剥削、恐怖主义、暴力威胁）',
        '禁止 spam（同一事件重复广播、批量刷 tag）',
        '禁止冒充他人（NIP-05 身份冒用）',
        '禁止推广非法产品或服务',
      ],
      // Nostr 无平台级配额；限制来自所连 relay 的速率策略
      rateLimits: {
        newAccount: { postsPerHour: 3, postsPerDay: 10 },
        normal: { postsPerHour: 10, postsPerDay: 50 },
      },
    },
    moderationTriggers: {
      duplicateEvent: { threshold: 2, action: 'relay_reject', score: 35 },
      tagStuffing: { threshold: 10, action: 'relay_reject', score: 20 },
      relayFlood: { threshold: 'high_velocity', action: 'relay_rate_limit', score: 25 },
    },
    safeHashtags: ['nostr', 'bitcoin', 'dev', 'art', 'writing'],
    bannedHashtags: [],
    linkPolicy: {
      newAccount: 'limited',
      minAge: 1,
      allowedDomains: [],
      suspiciousDomains: ['bit.ly', 'tinyurl.com', 'short.link'],
    },
    contentTips: [
      '单条 note 控制在 600 字符内，长文用长文格式另行处理',
      '同一正文不要重复广播到同一 relay（会被 relay 拒收）',
      'tag 控制在 2 个以内，Nostr 的 tag 用于检索而非曝光',
      '正文长度必须 ≥30 字符，否则会被本地质检闸门丢弃',
    ],
  },
  bluesky: {
    name: 'Bluesky',
    contentPolicy: {
      prohibited: [
        '禁止非法内容（儿童剥削、恐怖主义、暴力威胁）',
        '禁止骚扰、仇恨言论、人肉搜索',
        '禁止 spam 与重复刷屏',
        '禁制冒充他人或品牌',
      ],
      rateLimits: {
        newAccount: { postsPerDay: 5, repliesPerDay: 20 },
        normal: { postsPerDay: 20, repliesPerDay: 100 },
      },
    },
    moderationTriggers: {
      duplicateBody: { threshold: 2, action: 'label_risk', score: 30 },
      replySpam: { threshold: 10, action: 'rate_limit', score: 25 },
      reportRatio: { threshold: 0.1, action: 'label', score: 30 },
    },
    safeHashtags: ['dev', 'art', 'science', 'books'],
    bannedHashtags: [],
    linkPolicy: { newAccount: 'limited', minAge: 3, allowedDomains: [], suspiciousDomains: ['bit.ly', 'tinyurl.com'] },
    contentTips: [
      '正文硬上限 300 字符 —— 超限会被 API 直接拒绝',
      '标签通过 facets 实现，不要写成裸 #tag 文本',
      '语录式短文表现优于长段落',
    ],
  },
  mastodon: {
    name: 'Mastodon',
    contentPolicy: {
      prohibited: [
        '禁止非法内容（儿童剥削、恐怖主义、暴力威胁）',
        '禁止骚扰、仇恨言论、人肉搜索',
        '禁止 spam 与商业推广刷屏',
        '禁止未标注内容的敏感媒材（各实例规则不同）',
      ],
      instanceSpecific: true,        // 各实例有独立规则
      rateLimits: {
        newAccount: { postsPerDay: 5, boostsPerDay: 20 },
        normal: { postsPerDay: 20, boostsPerDay: 100 },
      },
    },
    moderationTriggers: {
      duplicateBody: { threshold: 2, action: 'instance_silence_risk', score: 35 },
      linkVelocity: { threshold: 5, action: 'rate_limit', score: 20 },
      reportRatio: { threshold: 0.1, action: 'instance_moderation', score: 30 },
    },
    safeHashtags: ['introductions', 'dev', 'art', 'fediverse'],
    bannedHashtags: [],
    linkPolicy: { newAccount: 'limited', minAge: 3, allowedDomains: [], suspiciousDomains: ['bit.ly', 'tinyurl.com'] },
    contentTips: [
      '正文上限通常 500 字符（实例可调）',
      '热门 tag 用 CamelCase 提升可读性与可检索性',
      '跨实例传播靠 tag 而非算法，tag 选准比选多重要',
      '商业推广会被大量实例封锁，保持分享口吻',
    ],
  },
  telegram: {
    name: 'Telegram',
    contentPolicy: {
      prohibited: [
        '禁止非法内容（儿童剥削、恐怖主义）',
        '禁止 spam 与批量拉人',
        '禁止冒充频道或官方身份',
      ],
      channelBroadcast: true,
      rateLimits: {
        newAccount: { postsPerHour: 5, postsPerDay: 20 },
        normal: { postsPerHour: 20, postsPerDay: 100 },
      },
    },
    moderationTriggers: {
      channelFlood: { threshold: 'high_velocity', action: 'flood_wait', score: 30 },
      duplicateBody: { threshold: 3, action: 'spam_filter', score: 20 },
    },
    safeHashtags: [],
    bannedHashtags: [],
    linkPolicy: { newAccount: 'limited', minAge: 1, allowedDomains: [], suspiciousDomains: [] },
    contentTips: [
      '频道推送以「一眼可读」为先，短行 + 空行分隔',
      '正文上限 4096 字符，本系统按 1000 字符控制',
      '含外链的推送到达率下降，链接放末尾',
    ],
  },
  devto: {
    name: 'DEV Community',
    contentPolicy: {
      prohibited: [
        '禁止纯广告与推广软文（DEV 会直接降权）',
        '禁止抄袭或未署名转载',
        '禁止误导性技术内容（安全风险）',
        '禁止 AI 灌水式低质长文',
      ],
      minBodyLength: 200,
      rateLimits: {
        newAccount: { postsPerDay: 2 },
        normal: { postsPerDay: 6 },
      },
    },
    moderationTriggers: {
      duplicateBody: { threshold: 2, action: 'article_unlisted', score: 40 },
      lowEffortContent: { threshold: 'short_article', action: 'unlisted', score: 25 },
      repeatedDomain: { threshold: 3, action: 'spam_filter', score: 25 },
    },
    safeHashtags: ['dev', 'javascript', 'node', 'webdev', 'tutorial'],
    bannedHashtags: [],
    linkPolicy: { newAccount: 'limited', minAge: 1, allowedDomains: [], suspiciousDomains: ['bit.ly', 'tinyurl.com'] },
    contentTips: [
      '正文过短（<200 字符）会被判 low-effort 并下架首页',
      '标题必须具体，禁止「Introduction to X」式空泛标题',
      '外链一律放正文，放标题或首行会被降权',
      'markdown 标题用 ##，DEV 渲染器会生成目录',
    ],
  },
  hashnode: {
    name: 'Hashnode',
    contentPolicy: {
      prohibited: [
        '禁止抄袭与未署名转载',
        '禁止纯营销落地页式内容',
        '禁止误导性技术内容',
      ],
      minBodyLength: 200,
      rateLimits: { newAccount: { postsPerDay: 2 }, normal: { postsPerDay: 4 } },
    },
    moderationTriggers: {
      duplicateBody: { threshold: 2, action: 'deindex_risk', score: 35 },
      lowEffortContent: { threshold: 'short_article', action: 'reduce_reach', score: 20 },
    },
    safeHashtags: ['webdev', 'javascript', 'programming', 'nodejs', 'tutorial'],
    bannedHashtags: [],
    linkPolicy: { newAccount: 'limited', minAge: 1, allowedDomains: [], suspiciousDomains: ['bit.ly'] },
    contentTips: [
      '正文过短会被判低质，建议 ≥800 字符',
      '原创性是 Hashnode 的核心排序因子，避免跨平台同稿',
      '封面图可显著提升点击，但正文本身必须有信息量',
    ],
  },
  github: {
    name: 'GitHub',
    contentPolicy: {
      prohibited: [
        '禁止发布凭据 / 密钥 / 隐私数据',
        '禁止垃圾 issue 与无关推广',
        '禁止冒充项目或维护者',
      ],
      rateLimits: {
        newAccount: { issuesPerDay: 5, commentsPerDay: 20 },
        normal: { issuesPerDay: 20, commentsPerDay: 100 },
      },
    },
    moderationTriggers: {
      duplicateBody: { threshold: 2, action: 'spam_flag', score: 40 },
      lowEffortContent: { threshold: 'short_body', action: 'close_no_contribution', score: 25 },
    },
    safeHashtags: [],
    bannedHashtags: [],
    linkPolicy: { newAccount: 'limited', minAge: 1, allowedDomains: [], suspiciousDomains: ['bit.ly'] },
    contentTips: [
      '正文必须「可验证」：写清版本 / 文件 / 复现步骤',
      '不使用营销语言，维护者对此高度敏感',
      '禁止在正文中出现任何 token / 密钥 / 内网地址',
    ],
  },
`;

// ── 八处补丁定义 ─────────────────────────────────────
const EDITS = [
  // ── [A] aigc-content-generator.js ──────────────────
  {
    id: 'A1-generator-SPECS',
    sentinel: `style: 'decentralized_microblog',`,
    file: GEN,
    desc: 'PLATFORM_SPECS 补 7 个真实通道',
    find: `    contentTypes: ['text', 'photo', 'quote', 'chat', 'link', 'audio'],
  },
};

// ── 内容模板提示词 ────────────────────────────────`,
    replace: `    contentTypes: ['text', 'photo', 'quote', 'chat', 'link', 'audio'],
  },
${SPEC_BLOCK}};

// ── 内容模板提示词 ────────────────────────────────`,
  },
  {
    id: 'A2-generator-TEMPLATES',
    sentinel: 'kind:1 note',
    file: GEN,
    desc: 'PROMPT_TEMPLATES 补 7 个新平台 + 修复 twitter 孤儿',
    find: `Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}\`,
};

// ── 内容类型常量 ──────────────────────────────────`,
    replace: `Output ONLY raw JSON (no markdown code fences, no commentary): {"title":"...","body":"...","tags":["..."],"content_type":"text"}\`,

${TPL_BLOCK}};

// ── 内容类型常量 ──────────────────────────────────`,
  },
  {
    id: 'A3-generator-DEFAULTTYPES',
    sentinel: 'nostr: CONTENT_TYPES.TEXT,',
    file: GEN,
    desc: 'PLATFORM_DEFAULT_TYPES 补 7 个真实通道',
    find: `  tumblr: CONTENT_TYPES.TEXT,
};

// ── 生成任务 ──────────────────────────────────────`,
    replace: `  tumblr: CONTENT_TYPES.TEXT,
${TYPES_BLOCK}};

// ── 生成任务 ──────────────────────────────────────`,
  },

  // ── [B] platform-content-rules.js ──────────────────
  {
    id: 'B1-rules-PlatformContentRules',
    sentinel: `nostr: {\n    name: 'Nostr',\n    contentPolicy: {`,
    file: RULES,
    desc: 'PlatformContentRules 补 7 个真实通道',
    find: `      '新账号先养号再发链接，避免首日带外链',
    ],
  },
  x: {`,
    replace: `      '新账号先养号再发链接，避免首日带外链',
    ],
  },
${RULE_BLOCK}  x: {`,
  },
  {
    id: 'B2-rules-getPlatformSpecs',
    sentinel: 'nostr: { maxLength: 2000, titleMaxLength: 0 },',
    file: RULES,
    desc: '_getPlatformSpecs 补 7 个新平台长度规格',
    find: `      tumblr: { maxLength: 4096, titleMaxLength: 0 },   // Tumblr 正文上限 4096（原实现回落 reddit 40000，误判）
    };
    return specs[this.platform] || specs.reddit;`,
    replace: `      tumblr: { maxLength: 4096, titleMaxLength: 0 },   // Tumblr 正文上限 4096（原实现回落 reddit 40000，误判）
      ${CMARK}
      nostr: { maxLength: 2000, titleMaxLength: 0 },
      bluesky: { maxLength: 300, titleMaxLength: 0 },
      mastodon: { maxLength: 500, titleMaxLength: 0 },
      telegram: { maxLength: 1000, titleMaxLength: 0 },
      devto: { maxLength: 5000, titleMaxLength: 128 },
      hashnode: { maxLength: 5000, titleMaxLength: 128 },
      github: { maxLength: 2000, titleMaxLength: 120 },
    };
    return specs[this.platform] || specs.reddit;`,
  },
  {
    id: 'B3-rules-neutral-fallback',
    sentinel: 'NEUTRAL_CONTENT_RULES',
    file: RULES,
    desc: 'ContentRuleChecker 未知平台兜底由 reddit 改为中性规则',
    find: `class ContentRuleChecker extends EventEmitter {
  constructor(platform = 'reddit') {
    super();
    this.platform = platform;
    this.rules = PlatformContentRules[platform] || PlatformContentRules.reddit;
  }`,
    replace: `// ${MARK} 未知平台的中性默认规则
// 原实现回落 PlatformContentRules.reddit，会把 reddit 特有的 karma / 账号年龄
// 门槛与 subreddit 语义误加到非 reddit 平台（实测：nostr 落到 reddit 规则）。
// 这里改为中性规则，未知平台不再继承任何平台特有门槛。
const NEUTRAL_CONTENT_RULES = {
  name: 'Generic',
  contentPolicy: {
    prohibited: [
      '禁止非法内容（儿童剥削、恐怖主义、暴力威胁）',
      '禁止骚扰、仇恨言论、人肉搜索',
      '禁止 spam（重复正文、批量刷 tag）',
      '禁止冒充他人或品牌',
    ],
    rateLimits: {
      newAccount: { postsPerDay: 3 },
      normal: { postsPerDay: 12 },
    },
  },
  moderationTriggers: {
    duplicateBody: { threshold: 2, action: 'quality_gate', score: 30 },
  },
  safeHashtags: [],
  bannedHashtags: [],
  linkPolicy: { newAccount: 'limited', minAge: 3, allowedDomains: [], suspiciousDomains: [] },
  contentTips: [
    '正文保持 30 字符以上（本地质检闸门硬性要求）',
    '避免同一正文跨平台原样复用',
  ],
};

class ContentRuleChecker extends EventEmitter {
  constructor(platform = 'reddit') {
    super();
    this.platform = platform;
    this.rules = PlatformContentRules[platform] || NEUTRAL_CONTENT_RULES;
  }`,
  },

  // ── [C] content-pipeline.js ──────────────────
  {
    id: 'C1-pipeline-getPlatformSpecs',
    sentinel: 'nostr: { maxLength: 2000 },',
    file: PIPE,
    desc: '_getPlatformSpecs 补 7 个新平台长度规格',
    find: `      tumblr: { maxLength: 4096 },
    };
    return specs[platform] || specs.reddit;`,
    replace: `      tumblr: { maxLength: 4096 },
      ${CMARK}
      nostr: { maxLength: 2000 },
      bluesky: { maxLength: 300 },
      mastodon: { maxLength: 500 },
      telegram: { maxLength: 1000 },
      devto: { maxLength: 5000 },
      hashnode: { maxLength: 5000 },
      github: { maxLength: 2000 },
    };
    return specs[platform] || specs.reddit;`,
  },

  // ── [D] server.js ──────────────────
  {
    id: 'D1-server-fallback-marker',
    sentinel: 'generated.content.fallback',
    file: SERVER,
    desc: 'fallback 标记错位修正（让日志如实反映根因）',
    find: `        if (!generated || !generated.content || generated.fallback) {
          // 无真实内容时跳过，不填充假数据
          console.warn(\`[causal] ⚠️ 跳过假内容生成: platform=\${platform}, 无可用AI模型\`);`,
    replace: `        // ${MARK} 原判据只看外层包装对象 generated.fallback，而 contentPipeline
        // 把 fallback:true 打在内层 content 上 ⇒ 该分支永不触达，真实的
        // 「无可用内容源」被误报成「正文过短(<30字符)」，掩盖根因。
        if (!generated || !generated.content || generated.fallback || generated.content.fallback) {
          // 无真实内容时跳过，不填充假数据
          const _fbDetail = generated && generated.content && generated.content.error
            ? \` | \${generated.content.error}\` : '';
          console.warn(\`[causal] ⚠️ 跳过假内容生成: platform=\${platform}, 无可用AI模型\${_fbDetail}\`);`,
  },

  // ── [E] server.js · P2c 保底配额（本轮实测发现已丢失，需重做）──────
  {
    id: 'E1-server-floor-quota',
    sentinel: 'MSCMS_CONTENT_MIN_SHARE',
    file: SERVER,
    desc: 'P2c 保底配额 + 队首 + 真实通道保护（重做）',
    find: `      if (platformQuota) {
        // 按策略配额构建生成队列
        for (const [platform, count] of Object.entries(platformQuota)) {
          if (disabledPlatforms.includes(platform)) continue;
          for (let j = 0; j < count; j++) {
            platformQueue.push(platform);
          }
        }
        // 混洗以增加多样性
        platformQueue.sort(() => Math.random() - 0.5);
      } else {
        // 无策略决定器时回退到轮流模式
        platformQueue = allPlatforms;
      }`,
    replace: `      // ${MARK} P2c 保底配额 + 队首 + 真实通道保护
      // 背景：allocateContentQuota() 是数据驱动策略器，对**无历史表现数据的新通道**
      // 权重恒为 0 ⇒ 新平台永远分不到配额（冷启动死锁）。实测现场（2026-09-21）：
      //   禁发=[reddit,x,discord,tiktok,instagram,tumblr] / 配额: facebook:2
      // 即策略器把唯一有真实账号的 tumblr 判为禁发，nostr 完全未入选 ⇒ 新平台 0 投放。
      // 兜底：对 MSCMS_REAL_CHANNELS（默认 tumblr,nostr）强制保底并**置于队首**
      // （needed 常为 2，保底通道若排在队尾会被 sort() 混洗沉底，等于没兜住）。
      let _floorList = [];
      if (platformQuota) {
        const _minShareRaw = process.env.MSCMS_CONTENT_MIN_SHARE;
        const _minShare = (_minShareRaw == null || _minShareRaw === '')
          ? 1 : Math.max(0, Number(_minShareRaw) || 0);
        const _realChans = String(process.env.MSCMS_REAL_CHANNELS || 'tumblr,nostr')
          .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const _forceReal = process.env.MSCMS_CONTENT_FORCE_REAL_CHANNELS !== '0';

        if (_minShare > 0) {
          for (const ch of _realChans) {
            const wasDisabled = disabledPlatforms.includes(ch);
            if (wasDisabled && !_forceReal) continue;
            const cur = Number(platformQuota[ch] || 0);
            if (cur < _minShare) {
              platformQuota[ch] = _minShare;
              _floorList.push(ch);
              if (wasDisabled) {
                console.warn(\`[causal] ⚠️ 策略器把真实发布通道 \${ch} 判为禁发（健康数据失真），已由保底配额放行\`);
              }
            }
          }
          if (_floorList.length) {
            console.log(\`[causal] 🌱 新通道保底配额: \${_floorList.map(c => c + '=' + platformQuota[c]).join(' ')}\`);
          }
        }

        // 按策略配额构建生成队列（保底通道稍后单独置于队首）
        for (const [platform, count] of Object.entries(platformQuota)) {
          if (_floorList.includes(platform)) continue;          // 保底通道单独处理
          if (disabledPlatforms.includes(platform)) continue;
          for (let j = 0; j < count; j++) {
            platformQueue.push(platform);
          }
        }
        // 其余平台混洗以增加多样性
        const _restQueue = platformQueue.sort(() => Math.random() - 0.5);
        // 保底通道按各自配额置于队首
        const _floorQueue = [];
        for (const ch of _floorList) {
          const c = Math.max(1, Number(platformQuota[ch] || 1));
          for (let j = 0; j < c; j++) _floorQueue.push(ch);
        }
        platformQueue = _floorQueue.concat(_restQueue);
      } else {
        // 无策略决定器时回退到轮流模式
        platformQueue = allPlatforms;
      }`,
  },

  // ── F1 · 诊断口径：PLATFORM_TO_ACCOUNT 补 provider 通道平台 ────────────
  // 背景：上一轮（P4）曾补过此处，但在后续的「从备份还原」操作中丢失。
  // 影响评估：使用处为 `PLATFORM_TO_ACCOUNT[content.platform] || content.platform`，
  //   nostr 不在表中时取 'nostr' 本身，**结果完全相同** ⇒ **零功能影响**。
  //   本次补齐的意义是「让映射表与 SUPPORTED_PUBLISH_PLATFORMS 口径一致」，属诊断/可维护性。
  {
    id: 'F1-server-PLATFORM_TO_ACCOUNT',
    sentinel: "'nostr': 'nostr'",
    file: SERVER,
    desc: 'PLATFORM_TO_ACCOUNT 补 provider 通道（诊断口径，与 SUPPORTED_PUBLISH_PLATFORMS 一致）',
    find: `    const PLATFORM_TO_ACCOUNT = { 'x': 'twitter', 'twitter': 'twitter', 'reddit': 'reddit', 'instagram': 'instagram', 'tiktok': 'tiktok', 'discord': 'discord', 'facebook': 'facebook', 'tumblr': 'tumblr' };`,
    replace: `    ${CMARK} 补 provider 通道平台，使映射表与 SUPPORTED_PUBLISH_PLATFORMS 口径一致
    //   （使用处有 \`|| content.platform\` 兜底，故本项为诊断/可维护性改进，非功能必需）
    const PLATFORM_TO_ACCOUNT = { 'x': 'twitter', 'twitter': 'twitter', 'reddit': 'reddit', 'instagram': 'instagram', 'tiktok': 'tiktok', 'discord': 'discord', 'facebook': 'facebook', 'tumblr': 'tumblr', 'nostr': 'nostr', 'bluesky': 'bluesky', 'mastodon': 'mastodon', 'telegram': 'telegram', 'devto': 'devto', 'hashnode': 'hashnode', 'github': 'github' };`,
  },
];

// ── 执行 ─────────────────────────────────────────────
function apply() {
  const report = [];
  let applied = 0, skipped = 0, failed = 0;

  // 按文件分组，保证同名文件顺序处理
  const byFile = new Map();
  for (const e of EDITS) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }

  for (const [file, edits] of byFile) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
      for (const e of edits) { failed++; report.push(`❌ ${e.id}  文件不存在: ${file}`); }
      continue;
    }
    let src = fs.readFileSync(abs, 'utf8');
    const before = src;
    let touched = false;

    for (const e of edits) {
      // 幂等：逐条 sentinel 判据（不能用统一的 CMARK —— 同一文件多处补丁
      // 会因首条插入 CMARK 后，后续条目误判为「已应用」而互相跳过，实测踩到）
      const sentinel = e.sentinel || CMARK;
      if (src.includes(sentinel)) {
        skipped++; report.push(`⏭  ${e.id}  已应用（sentinel 命中），跳过`); continue;
      }
      const hits = src.split(e.find).length - 1;
      if (hits === 0) {
        // 若目标内容已存在（幂等兜底），不算失败
        if (src.includes(e.replace.slice(0, 60))) {
          skipped++; report.push(`⏭  ${e.id}  目标内容已存在，跳过`); continue;
        }
        failed++; report.push(`❌ ${e.id}  锚点未命中（期望 1 处，实际 0）— ${e.desc}`); continue;
      }
      if (hits > 1) {
        failed++; report.push(`❌ ${e.id}  锚点不唯一（实际 ${hits} 处），拒绝写入 — ${e.desc}`); continue;
      }
      // 写入时插一行 id 标记以便幂等（不改语义，仅注释）
      src = src.replace(e.find, e.replace);
      touched = true;
      applied++; report.push(`✅ ${e.id}  已应用 — ${e.desc}`);
    }

    if (touched && !DRY) {
      const bak = abs + BAK_SUFFIX;
      if (!fs.existsSync(bak)) fs.writeFileSync(bak, before, 'utf8');
      fs.writeFileSync(abs, src, 'utf8');

      // ① 落盘复核：写回内容必须与内存一致
      const back = fs.readFileSync(abs, 'utf8');
      if (back !== src) { report.push(`❌ ${file} 落盘复核失败（写回内容不一致）`); failed++; continue; }

      // ② 硬闸门：语法自检。本轮实测教训 —— 若 marker 未加 `//` 前缀，会被
      //    JS 解析成计算属性键（[NEWPLAT-2026-09-21] = [NaN]）导致语法错误。
      //    补丁器必须自证产出可解析，否则自动回滚。
      let syntaxOk = true, syntaxErr = '';
      try {
        execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
      } catch (err) {
        syntaxOk = false;
        syntaxErr = String(err.stderr || err.stdout || err.message).split('\n').slice(0, 6).join(' | ');
      }
      if (!syntaxOk) {
        fs.writeFileSync(abs, before, 'utf8');   // 自动回滚
        failed++;
        report.push(`❌ ${file} 语法自检失败，已自动回滚 —— ${syntaxErr}`);
      } else {
        report.push(`   ↳ ${file} 已写盘，备份 ${path.basename(bak)}；落盘复核 ✅ 语法自检 ✅`);
      }
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`补丁执行结果（${DRY ? 'DRY-RUN 未写盘' : '已写盘'}）：应用 ${applied} / 跳过 ${skipped} / 失败 ${failed}`);
  console.log('─'.repeat(70));
  for (const r of report) console.log('  ' + r);
  console.log('─'.repeat(70));

  if (failed > 0) { console.error('\n存在失败项，请检查上方锚点。'); process.exit(1); }
}

apply();
