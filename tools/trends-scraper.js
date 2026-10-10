#!/usr/bin/env node
/**
 * trends-scraper.js — P1 抓取链路：多源热点采集 + SimHash 去重 + 落盘
 *
 * 设计原则（零伪造）：
 *  1. 只用经实测可用的免费公开源，抓不到就是 0，绝不用假数据填充。
 *  2. 每个源独立 try/catch，单源失败不影响整体。
 *  3. 落盘到 D:/mscms-ws/data/trends.json，server 侧直接读盘（不进 DataStore，
 *     避免 5s flush 内存覆盖磁盘的问题）。
 *
 * 实测源状态（2026-09-08）：
 *   ✅ Google Trends RSS  200 / ~10 条   真实热搜词（最高价值）
 *   ✅ Dev.to API         200 / ~30 条   科技·AI 文章标题
 *   ✅ HN Algolia         200 / 可扩量   科技热点
 *   ✅ Medium tag RSS     200 / ~10 条
 *   ✅ Lobsters RSS       200 / ~25 条
 *   ❌ Reddit JSON        403（反爬，需 OAuth，已排除）
 *   ❌ Tumblr tagged API  401（需 api_key，已排除）
 */
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('../http-client.js');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const OUT_FILE = path.join(DATA_DIR, 'trends.json');
const MAX_KEEP = 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────── 业务相关性打分 ───────────────────────────
// 推广站点 hlua.cc.cd / molie.cc.cd 面向 AI 聊天与社交/情感受众，
// Google Trends 常抓到体育/名人等无关热搜（如 "toronto blue jays"），
// 必须用相关性分把内容方向拉回业务轨道，否则热点越多、内容越偏。
const TOPIC_KEYWORDS = {
  // AI / 科技（核心）
  ai: 3, llm: 3, gpt: 3, chatgpt: 3, 'machine learning': 3, openai: 3, agent: 2,
  anthropic: 2, claude: 2, model: 1, neural: 2, bot: 2, chatbot: 3,
  // 开发 / 软件
  coding: 2, developer: 2, programming: 2, software: 2, code: 2, api: 1,
  github: 1, dev: 1, javascript: 1, python: 2, rust: 1, database: 1,
  // 商业 / 效率
  tech: 1, technology: 1, startup: 2, saas: 2, product: 1, founder: 1,
  'remote work': 2, productivity: 2, career: 2, interview: 1, hiring: 1,
  // 社交 / 情感（molie 受众）
  relationship: 2, dating: 2, 'mental health': 2, loneliness: 2, love: 1,
  community: 1, social: 1, chat: 2, companion: 2,
  // 安全 / 数据
  security: 1, privacy: 2, data: 1, cloud: 1, encryption: 1,
};
function relevanceOf(text) {
  const t = String(text || '').toLowerCase();
  let s = 0;
  for (const k of Object.keys(TOPIC_KEYWORDS)) if (t.includes(k)) s += TOPIC_KEYWORDS[k];
  return s;
}

// ─────────────────────────── SimHash（32 位）───────────────────────────
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}
function simhash(text) {
  const v = new Array(32).fill(0);
  const toks = tokenize(text);
  if (!toks.length) return 0;
  for (const t of toks) {
    const h = fnv1a32(t);
    for (let i = 0; i < 32; i++) v[i] += (h & (1 << i)) ? 1 : -1;
  }
  let out = 0;
  for (let i = 0; i < 32; i++) if (v[i] > 0) out |= (1 << i);
  return out >>> 0;
}
function hamming32(a, b) {
  let x = (a ^ b) >>> 0;
  let c = 0;
  while (x) { c += x & 1; x >>>= 1; }
  return c;
}

// ─────────────────────────── 各源采集器 ───────────────────────────
// ── 抓取出口轮换（IPRoyal 5 静态 IP）──────────────────────────────
// 这些 IP 对 Tumblr 不可达（ECONNRESET），所以不进发布/养号池；但抓公开源完全可用，
// 5 个 IP 轮换可显著降低单 IP 限流。任一条失败即回落默认出口，零风险。
const IPR = (() => {
  try {
    const j = JSON.parse(fs.readFileSync('D:/mscms-ws/config/iproyal.json', 'utf8'));
    return (j.proxies || []).filter((p) => p.enabled !== false && p.url);
  } catch (_) { return []; }
})();
let _iprIdx = 0;
const nextIpr = () => (IPR.length ? IPR[(_iprIdx++) % IPR.length].url : null);
// 抓取主出口：默认本机中继（10808），可用 MSCMS_SCRAPE_PROXY 覆盖
const SCRAPE_PROXY = process.env.MSCMS_SCRAPE_PROXY || 'http://127.0.0.1:10808';

async function get(url, asJson) {
  const opts = {
    headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : 'application/rss+xml,text/xml,*/*' },
    timeout: 20000,
  };
  // ① 主出口：本机中继（BWG，实测 5 源全通）
  try {
    const r = await fetchExt(url, opts, SCRAPE_PROXY);
    if (r.ok) return asJson ? r.json() : r.text();
  } catch (_) { /* 落到 ② */ }
  // ② 采购出口轮换（最多试 2 条）—— 分散 IP，降低单 IP 限流
  for (let i = 0; i < Math.min(2, IPR.length); i++) {
    const p = nextIpr();
    try {
      const r = await fetchExt(url, opts, p);
      if (r.ok) return asJson ? r.json() : r.text();
    } catch (_) { /* 继续下一条 */ }
  }
  // ③ 最后：不指定代理（由 http-client 自动路由）
  const r = await fetchExt(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return asJson ? r.json() : r.text();
}

function parseRSS(xml, source) {
  const out = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  const entryRe = /<entry[\s>][\s\S]*?<\/entry>/gi;
  const blocks = [...String(xml).matchAll(itemRe), ...String(xml).matchAll(entryRe)].map((m) => m[0]);
  for (const b of blocks) {
    const pick = (tag) => {
      const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(b);
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
    };
    const title = pick('title');
    if (!title) continue;
    out.push({ source, title, url: pick('link') || pick('id') || '', summary: pick('description').slice(0, 200), fetchedAt: new Date().toISOString(), score: 0 });
  }
  return out;
}

const SOURCES = {
  // ① Google Trends RSS — 真实搜索热词
  async googleTrends() {
    const xml = await get('https://trends.google.com/trending/rss?geo=US', false);
    const items = parseRSS(xml, 'google_trends');
    // RSS 的 <title> 是热词，附带近似流量放在 ht:approx_traffic
    const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    blocks.forEach((b, i) => {
      if (items[i]) {
        const tr = /<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/i.exec(b);
        items[i].meta = tr ? tr[1].trim() : '';
      }
    });
    return items;
  },
  // ② Dev.to — 科技/AI 文章
  async devto() {
    const j = await get('https://dev.to/api/articles?top=7&per_page=30', true);
    return (Array.isArray(j) ? j : []).map((a) => ({
      source: 'devto',
      title: a.title,
      url: a.url,
      summary: (a.description || '').slice(0, 200),
      score: a.public_reactions_count || 0,
      tags: a.tag_list || [],
      fetchedAt: new Date().toISOString(),
    }));
  },
  // ③ HackerNews Algolia — 首页热点
  async hackernews() {
    const j = await get('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30', true);
    return (j.hits || []).map((h) => ({
      source: 'hackernews',
      title: h.title || h.story_title,
      url: h.url || ('https://news.ycombinator.com/item?id=' + h.objectID),
      summary: (h.story_text || '').replace(/<[^>]+>/g, '').slice(0, 200),
      score: h.points || 0,
      fetchedAt: new Date().toISOString(),
    })).filter((x) => x.title);
  },
  // ④ Medium 技术标签
  async medium() {
    const xml = await get('https://medium.com/feed/tag/technology', false);
    return parseRSS(xml, 'medium');
  },
  // ⑤ Lobsters
  async lobsters() {
    const xml = await get('https://lobste.rs/rss', false);
    return parseRSS(xml, 'lobsters');
  },
};

// ─────────────────────────── 主流程 ───────────────────────────
async function scrapeAll() {
  const startedAt = new Date().toISOString();
  const result = { startedAt, sources: {}, items: [], added: 0, dup: 0, errors: [] };

  const names = Object.keys(SOURCES);
  const settled = await Promise.allSettled(names.map((n) => SOURCES[n]()));
  names.forEach((n, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      result.sources[n] = { ok: true, count: s.value.length };
      result.items.push(...s.value);
    } else {
      result.sources[n] = { ok: false, error: String(s.reason && s.reason.message || s.reason) };
      result.errors.push(n + ': ' + (s.reason && s.reason.message));
    }
  });

  // 读取存量做去重
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) { existing = []; }
  const seenHashes = existing.map((x) => x.simhash).filter((h) => typeof h === 'number');
  const newHashes = [];

  for (const it of result.items) {
    it.simhash = simhash(it.title);
    it.relevance = relevanceOf((it.title || '') + ' ' + (it.summary || '') + ' ' + ((it.tags || []).join(' ')));
    // 与本次已收录的比对（汉明距离 ≤3 视为重复）
    const isDup = [...newHashes, ...seenHashes].some((h) => hamming32(h, it.simhash) <= 3);
    if (isDup) { result.dup++; continue; }
    newHashes.push(it.simhash);
    existing.push(it);
    result.added++;
  }

  // 裁剪 + 落盘
  if (existing.length > MAX_KEEP) existing = existing.slice(existing.length - MAX_KEEP);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(existing, null, 2), 'utf8');

  result.finishedAt = new Date().toISOString();
  result.totalOnDisk = existing.length;
  console.log('[抓取] ' + JSON.stringify(result.sources));
  console.log('[抓取] 采集 ' + result.items.length + ' 条 → 新增 ' + result.added + ' 条，重复 ' + result.dup + ' 条');
  console.log('[抓取] 落盘 ' + OUT_FILE + '（累计 ' + result.totalOnDisk + ' 条）');
  if (result.errors.length) console.log('[抓取] 失败源: ' + result.errors.join(' | '));
  return result;
}

// ─────────────────────────── CLI ───────────────────────────
if (require.main === module) {
  const arg = process.argv[2] || '--run';
  if (arg === '--stats') {
    try {
      const all = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      const by = {};
      all.forEach((x) => { by[x.source] = (by[x.source] || 0) + 1; });
      console.log('累计 ' + all.length + ' 条，来源分布: ' + JSON.stringify(by));
      console.log('最新 5 条:');
      all.slice(-5).forEach((x) => console.log('  [' + x.source + '] ' + String(x.title).slice(0, 60)));
    } catch (e) { console.log('尚无数据: ' + e.message); }
    process.exit(0);
  }
  scrapeAll().then(() => process.exit(0)).catch((e) => { console.error('[抓取] 致命错误: ' + e.message); process.exit(1); });
}

module.exports = { scrapeAll, simhash, hamming32, relevanceOf, OUT_FILE };
