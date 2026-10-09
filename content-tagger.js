/**
 * content-tagger.js — MSCMS v14 内容标签与正文指纹（P1-B1 / P1-D）
 *
 * 背景（2026-09-15 实测）：
 *   - 12,608 条内容中「带 tags」= 0 → 发布时恒传空标签；
 *   - 旧 id 查重恒 miss（内容池产物没有 id，落库时用 `content_direct_<ts>_<i>` 兜底）；
 *   - 实际重复率 65.3%（唯一正文 1,969 / 12,608），说明去重口径完全失效。
 *
 * 本模块只做「纯规则」推导（P1 决策：先跑规则，LLM 提质留到 P2）：
 *   1. deriveTags()       —— 由 topic / title / body / tone / audience 推导 ≤8 个标签
 *   2. bodyFingerprint()  —— 正文归一化指纹（sha1 前 16 位），供硬闸门与跨账号复用检测
 *
 * 零伪造约定：提不出标签就返回空数组，由调用方（质检闸门）决定丢弃，
 *            绝不填充编造的关键词。
 */

const crypto = require('crypto');
const { normalizeTagList } = require('./content-pool.js');

// 英文停用词（与 content-intelligence 的 extractTrendKeywords 同口径）
const TAG_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'are', 'am', 'us', 'ok', 'via', 'per', 'etc',
  'it', 'its', 'this', 'that', 'these', 'those', 'you', 'your',
  'how', 'why', 'what', 'when', 'which', 'who', 'from', 'at', 'by', 'as', 'we', 'they', 'them',
  'he', 'she', 'his', 'her', 'not', 'no', 'but', 'if', 'then', 'than', 'so', 'up', 'out',
  'about', 'into', 'over', 'after', 'new', 'using', 'use', 'used', 'get', 'got', 'can', 'will',
  'just', 'more', 'most', 'all', 'one', 'two', 'also', 'has', 'have', 'had', 'do', 'does', 'did',
  'my', 'me', 'our', 'their', 'there', 'here', 'now', 'only', 'ever', 'never', 'still', 'even',
  'like', 'really', 'very', 'much', 'many', 'some', 'any', 'each', 'other', 'same', 'own',
  'because', 'while', 'where', 'would', 'could', 'should', 'make', 'makes', 'made', 'take',
  // 缩写形式（撇号被剥离后的形态，避免 doesnt/didnt/wasnt 之类成为标签）
  'doesnt', 'didnt', 'wasnt', 'isnt', 'arent', 'werent', 'couldnt', 'wouldnt', 'shouldnt',
  'dont', 'cant', 'wont', 'havent', 'hasnt', 'hadnt', 'im', 'ive', 'youre', 'theyre', 'thats',
  'whats', 'lets', 'heres', 'theres', 'ill', 'isnt', 'aint', 'gonna', 'wanna', 'gotta',
  'took', 'goes', 'went', 'say', 'said', 'know', 'think', 'want', 'need', 'see', 'saw', 'way',
  'thing', 'things', 'time', 'times', 'day', 'days', 'year', 'years', 'people', 'person',
]);

// 各平台通用兜底标签（仅在候选为空时按平台补，属平台事实而非编造）
const PLATFORM_BASE_TAGS = {
  tumblr: ['tumblr'],
  reddit: ['reddit'],
  instagram: ['instagram'],
  tiktok: ['tiktok'],
  x: ['x'],
  discord: ['discord'],
  facebook: ['facebook'],
};

/**
 * 清理候选标签文本：去掉首尾/中间的标点，压缩空白
 * 例："#C++" → "c"；"Comparison!!!" → "comparison"；"Rust:" → "rust"
 */
 cleanTagText(s) {
  return String(s == null ? '' : s).trim()
    .replace(/^[^a-z0-9\u4e00-\u9fff]+/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+$/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 候选可用性判定
 * - 纯中文：2~12 字
 * - 含英文/数字：字母数字数 ≥2（保留 ai / ui / os 等 2 字母实义词），且不在停用词表
 */
 isUsableTag(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return false;
  if (/^[\u4e00-\u9fff]+$/.test(t)) return t.length >= 2 && t.length <= 12;
  const letters = t.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (letters.length < 2) return false;
  if (TAG_STOPWORDS.has(letters)) return false;
  return true;
}

/** 撇号归一：弯撇号/反引号 → 直撇号（U+2018/U+2019/U+0060） */
const APOS_RE = new RegExp("[" + String.fromCharCode(0x2018) + String.fromCharCode(0x2019) + "`]", "g");
 normalizeApostrophes(text) {
  return String(text == null ? '' : text).replace(APOS_RE, "'");
}

/** 英文高频实词（词频降序） */
 enKeywords(text, limit = 8) {
  const freq = new Map();
  // 先归一撇号并允许撇号参与匹配（doesn't → 整词 → doesnt → 命中停用词），避免产生 hasn/didn 之类碎片
  const words = normalizeApostrophes(text).toLowerCase().match(/[a-z][a-z0-9+#.'\-]{1,}/g) || [];
  for (const raw of words) {
    const t = cleanTagText(raw.replace(/'/g, ''));
    if (!isUsableTag(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

/** 中文候选：≤12 字的连续汉字段整段保留；超长段取其高频 2-gram（频次 ≥2） */
 zhSegments(text, limit = 4) {
  const out = [];
  const freq = new Map();
  const segs = String(text || '').match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of segs) {
    if (seg.length <= 12) { out.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2);
      freq.set(bg, (freq.get(bg) || 0) + 1);
    }
  }
  const top = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
  return [...out, ...top];
}

/**
 * 兼容保留：英文实词 + 中文段（供外部调试）
 */
 tokenizeForTags(text, limit = 12) {
  return [...enKeywords(text, limit), ...zhSegments(text, limit)].slice(0, limit);
}

/**
 * 规则标签推导
 * @param {object} input { topic, title, body, text, tone, target_audience, , keywords }
 * @returns {string[]} ≤8 个规范化标签（小写、无 #、去重、≤32 字符）；无可用标签返回 []
 */
/**
 * topic 归一化：把 string / {title,keywords,category,level} / 其它形态统一为字符串
 * 背景：实测落库出现过 topic="[object Object]" —— 对象被直接 String() 化。
 */
 normalizeTopic(v) {
  if (v == null) return null;
  if (typeof v === 'string') { const s = v.trim(); return s ? s.slice(0, 200) : null; }
  if (typeof v === 'object') {
    const s = v.title || v.topic || v.name || v.keyword || '';
    const out = String(s).trim();
    return out ? out.slice(0, 200) : null;
  }
  const s = String(v).trim();
  return s ? s.slice(0, 200) : null;
}

 deriveTags(input = {}) {
  const { topic, title, body, text, tone, target_audience, , keywords } = input;
  const bodyText = body || text || '';
  const cands = [];

  // 统一入口：先清洗再做可用性判定（"C++" → "c" → 过短被丢弃）
  const push = (v) => {
    const c = cleanTagText(v);
    if (isUsableTag(c)) cands.push(c);
  };

  // ① 显式关键词最高优先（调用方已判定相关）
  for (const k of (Array.isArray(keywords) ? keywords : [])) push(k);

  // ② topic：≤24 字才作为长尾标签整体入栈，同时总是拆词
  const topicStr = normalizeTopic(topic) || '';
  if (topicStr && !/^(general|general interest|trending)$/i.test(topicStr)) {
    if (topicStr.length <= 24) push(topicStr);
    for (const w of topicStr.split(/[\s,;/|+]+/)) push(w);
  }

  // ③ 目标受众
  if (target_audience && !/^general$/i.test(String(target_audience))) {
    push(target_audience);
  }

  // ④ 标题 + 正文：英文高频实词 + 中文连续段
  const fullText = `${title || ''} ${bodyText}`;
  for (const w of enKeywords(fullText, 8)) push(w);
  for (const w of zhSegments(fullText, 4)) push(w);

  // ⑤ tone（弱信号，置于末尾）
  if (tone && !/^neutral$/i.test(String(tone))) push(tone);

  let tags = normalizeTagList(cands);

  // ⑥ 平台兜底（仅当以上全部落空）
  if (tags.length === 0) {
    tags = normalizeTagList(PLATFORM_BASE_TAGS[] || []);
  }

  return tags;
}

/**
 * 正文归一化指纹
 * 归一化内容：小写、去 URL、去 #tag/@mention、仅保留字母/数字/中文、压缩空白
 * @returns {string|null} 16 位 sha1；正文为空返回 null
 */
 bodyFingerprint(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][a-z0-9_]+/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return null;
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}


// ── [P2-B4] 图文成品组装 ────────────────────────────
// 方案 §5.2 B4：标题 ≤ 平台上限、正文首行摘要、正文尾部 3~8 个标签。
// 设计约束：
//   · 纯函数 + 幂等：生成链路有多个落库点，同一正文可能被组装多次，不得叠加标签块；
//   · 最小改动：仅在「首行超过 LEAD_MAX」时才切分正文，其余情况正文原样返回；
//   · tumblr 的标签走 API 原生 tags 字段（tumblr-publisher form.tags），
//     故默认不把 hashtag 塞进正文，避免同一帖重复标注；
//   · 首行摘要只做确定性切分，不新造内容（零伪造）。
const BODY_HASHTAG_PLATFORMS = new Set(['instagram', 'tiktok', 'x', 'twitter']);
const LEAD_MAX = 140;
const TRAIL_TAG_MIN = 3;
const TRAIL_TAG_MAX = 8;

// 首行过长 → 在首个句末标点处确定性切开（切不动则硬截）
 _splitLead(body) {
  const b = String(body || "").trim();
  if (!b) return { lead: "", rest: "" };
  const nl = b.indexOf("\n");
  const first = (nl >= 0 ? b.slice(0, nl) : b).trim();
  const tail = nl >= 0 ? b.slice(nl + 1).trim() : "";
  if (first.length <= LEAD_MAX) return { lead: first, rest: tail };
  const window = first.slice(0, LEAD_MAX + 40);
  const m = window.match(/^([\s\S]{20,140}?[.!?。！？…]["\')\]）】]?)(?:\s+|$)/);
  if (m && m[1] && m[1].trim( >= 20) {
    const lead = m[1].trim();
    const rest = (first.slice(m[0].length).trim() + (tail ? "\n" + tail : "")).trim();
    return { lead, rest };
  }
  return {
    lead: first.slice(0, LEAD_MAX).trim(),
    rest: (first.slice(LEAD_MAX).trim() + (tail ? "\n" + tail : "")).trim(),
  };
}

// 移除正文末尾已存在的「全部由已知标签组成」的行（幂等保障）
 _stripTrailingTags(body, tags) {
  const lines = String(body || "").split("\n");
  const known = new Set((tags || []).map((t) => String(t).toLowerCase()));
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last) { lines.pop(); continue; }
    const toks = last.split(/\s+/).filter(Boolean);
    if (!toks.length || !toks.every((x) => /^#[\w-]{2,}$/.test(x) && known.has(x.slice(1).toLowerCase()))) break;
    lines.pop();
  }
  return lines.join("\n").trim();
}

/**
 * 组装成品帖
 * @param {{?:string,title?:string,body?:string,tags?:string[],titleMaxLength?:number}} opts
 * @returns {{title:string, body:string, tags:string[], :string}}
 */
 composePost(opts) {
  const o = opts || {};
  const  = String(o. || "").toLowerCase();
  const tags = Array.isArray(o.tags) ? o.tags.filter((x) => x && String(x).trim()) : [];
  const titleLimit = Number(o.titleMaxLength || 0);

  // ① 标题：按平台上限截断（优先词边界；titleMaxLength=0 表示无独立标题位）
  let title = String(o.title == null ? "" : o.title).trim();
  if (titleLimit > 0 && title.length > titleLimit) {
    const cut = title.slice(0, titleLimit);
    const sp = cut.lastIndexOf(" ");
    title = (sp > titleLimit * 0.6 ? cut.slice(0, sp) : cut).trim();
  }

  // ② 正文首行摘要（仅首行过长时才改动正文）
  let body = String(o.body == null ? "" : o.body);
  const firstLine = (body.split("\n")[0] || "").trim();
  if (firstLine.length > LEAD_MAX) {
    const sp = _splitLead(body);
    body = [sp.lead, sp.rest].filter(Boolean).join("\n\n");
  }

  // ③ 正文尾部 3~8 个标签（仅正文带 hashtag 约定的平台）
  if (tags.length && BODY_HASHTAG_PLATFORMS.has()) {
    body = _stripTrailingTags(body, tags);
    const n = Math.min(TRAIL_TAG_MAX, Math.max(TRAIL_TAG_MIN, tags.length));
    const block = tags.slice(0, n).map((t) => "#" + String(t).replace(/^#+/, "")).join(" ");
    body = body ? body + "\n\n" + block : block;
  }

  return { title, body, tags,  };
}
module.exports = { deriveTags, bodyFingerprint, tokenizeForTags, PLATFORM_BASE_TAGS, normalizeTopic, cleanTagText, isUsableTag, enKeywords, zhSegments, composePost, BODY_HASHTAG_PLATFORMS };
