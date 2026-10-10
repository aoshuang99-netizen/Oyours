'use strict';
/**
 * trend-intel.js — 真实热点情报模块
 *
 * 数据源（真实、无需伪造）：
 *  1) Google Trends RSS（按地区的实时搜索热点）—— 主自动源，无需任何 API key
 *  2) 代理（本 agent）用 WebSearch 实时抓取的真实热点 —— 通过 seed() 注入
 *
 * 严禁伪造数据：所有 trending 记录均来自上述真实源；抓取失败只记录日志，绝不回填假数据。
 *
 * 存储：DataStore module = 'trending'
 *  记录字段：{ id, source, geo, keyword, title, tags[], url, traffic, articles[], fetchedAt, score, comments }
 */
const { fetchExt } = require('./http-client');

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'x';
}

function deriveTags(keyword, geo) {
  const words = String(keyword).trim().split(/\s+/).filter(Boolean);
  const tags = [];
  // 单词/短语转 hashtag（保留重音字母与中日韩字符，仅去除空白/标点/符号）
  for (const w of words) {
    const clean = w.replace(/[\s\p{P}\p{S}]+/gu, '');
    if (clean) tags.push('#' + clean);
  }
  // 连写整体（无空格）
  const joined = words.join('');
  if (joined.length > 3 && !tags.includes('#' + joined)) tags.push('#' + joined);
  if (geo && geo !== 'US') tags.push('#' + geo);
  tags.push('#trending');
  // 去重 + 限制 6 个
  return Array.from(new Set(tags)).slice(0, 6);
}

function parseGTRss(xml, geo) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
      return r ? r[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1').trim() : '';
    };
    const title = get('title');
    if (!title) continue;
    const link = get('link');
    const traffic = get('ht:approx_traffic');
    // 关联新闻条目
    const articles = [];
    const niTitleRe = /<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/gi;
    const niUrlRe = /<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/gi;
    const titles = [];
    let t;
    while ((t = niTitleRe.exec(block)) !== null) titles.push(t[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1').trim());
    const urls = [];
    let u;
    while ((u = niUrlRe.exec(block)) !== null) urls.push(u[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1').trim());
    for (let i = 0; i < titles.length; i++) {
      articles.push({ title: titles[i], url: urls[i] || '' });
    }
    const id = `trend-gt-${geo}-${slugify(title)}`;
    out.push({
      id,
      source: 'google-trends',
      geo,
      keyword: title,
      title,
      tags: deriveTags(title, geo),
      url: link,
      traffic: traffic || '',
      articles: articles.slice(0, 5),
      fetchedAt: new Date().toISOString(),
      score: 0,
      comments: 0
    });
  }
  return out;
}

class TrendIntel {
  constructor(dataStore, opts = {}) {
    this.dataStore = dataStore;
    this.geos = opts.geos || ['US'];
    this.maxKeep = opts.maxKeep || 300;
    this.autoRefreshMs = opts.autoRefreshMs || 30 * 60 * 1000;
    this._timer = null;
  }

  /**
   * 抓取所有配置地区的热点，写入 DataStore（去重 upsert）
   */
  async scrape() {
    const all = [];
    for (const geo of this.geos) {
      try {
        const url = `https://trends.google.com/trending/rss?geo=${geo}`;
        const r = await fetchExt(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
        });
        if (!r.ok) {
          console.warn(`[TrendIntel] geo=${geo} RSS 返回 ${r.status}，跳过`);
          continue;
        }
        const xml = await r.text();
        const items = parseGTRss(xml, geo);
        console.log(`[TrendIntel] geo=${geo} 解析到 ${items.length} 条真实热点`);
        all.push(...items);
      } catch (e) {
        console.warn(`[TrendIntel] geo=${geo} 抓取失败: ${e.message}`);
      }
    }
    if (all.length) this._upsert(all);
    return all;
  }

  _upsert(items) {
    for (const it of items) {
      const existing = this.dataStore.get('trending', it.id);
      if (existing) {
        this.dataStore.update('trending', it.id, { ...it, createdAt: existing.createdAt });
      } else {
        this.dataStore.create('trending', it);
      }
    }
    // 控制总量
    this.dataStore.prune('trending', this.maxKeep);
  }

  /**
   * 由外部（agent WebSearch 实时抓取）注入真实热点
   * items: [{ keyword, tags?, url?, geo?, traffic?, articles? }]
   */
  seed(items) {
    if (!Array.isArray(items)) return [];
    const now = new Date().toISOString();
    const out = [];
    for (const raw of items) {
      if (!raw || !raw.keyword) continue;
      const tags = Array.isArray(raw.tags) && raw.tags.length
        ? raw.tags
        : deriveTags(raw.keyword, raw.geo);
      const id = raw.id || `trend-ws-${slugify(raw.keyword)}-${now.slice(0, 10)}`;
      const rec = {
        id,
        source: 'agent-websearch',
        geo: raw.geo || '',
        keyword: raw.keyword,
        title: raw.title || raw.keyword,
        tags,
        url: raw.url || '',
        traffic: raw.traffic || '',
        articles: raw.articles || [],
        fetchedAt: now,
        score: 0,
        comments: 0
      };
      const existing = this.dataStore.get('trending', id);
      if (existing) this.dataStore.update('trending', id, rec);
      else this.dataStore.create('trending', rec);
      out.push(rec);
    }
    this.dataStore.prune('trending', this.maxKeep);
    return out;
  }

  list(opts = {}) {
    const o = Object.assign({ sort: 'fetchedAt', order: 'desc', limit: 50 }, opts);
    return this.dataStore.list('trending', o);
  }

  getById(id) {
    return this.dataStore.get('trending', id);
  }

  /**
   * 由热点生成短视频脚本金文本（供 video-render 渲染）
   * 返回: { lines: string[], title, tags, duration }
   */
  buildVideoScript(trend, opts = {}) {
    const kw = (trend && trend.keyword) || '今日热点';
    const tags = (trend && trend.tags) || [];
    const topArticle = (trend && trend.articles && trend.articles[0] && trend.articles[0].title) || '';
    const lines = [
      `今日热点 · ${kw}`,
      topArticle ? topArticle.slice(0, 38) : '实时趋势解读',
      tags.slice(0, 4).join(' ')
    ].filter(Boolean);
    return {
      title: kw,
      lines,
      tags,
      duration: opts.duration || 8
    };
  }

  startAuto() {
    if (this._timer) return;
    // 启动时先抓一次
    this.scrape().catch(e => console.warn('[TrendIntel] 初始抓取异常', e.message));
    this._timer = setInterval(() => {
      this.scrape().catch(e => console.warn('[TrendIntel] 周期抓取异常', e.message));
    }, this.autoRefreshMs);
    if (this._timer.unref) this._timer.unref();
    console.log(`[TrendIntel] 自动抓取已启动，间隔 ${this.autoRefreshMs / 60000} 分钟`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = { TrendIntel, deriveTags, parseGTRss };
