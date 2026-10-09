#!/usr/bin/env node
/**
 * 抓取源可达性探测（P1 抓取链路前置验证）
 * 零伪造原则：抓不到就如实报 0 / 报错误，绝不用假数据填充。
 */
const { fetchExt } = require('../http-client.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TARGETS = [
  ['Reddit hot JSON', 'https://www.reddit.com/r/technology/hot.json?limit=5'],
  ['Google Trends RSS', 'https://trends.google.com/trending/rss?geo=US'],
  ['Tumblr tagged API', 'https://www.tumblr.com/api/v2/tagged?tag=technology&limit=5'],
  ['HackerNews Algolia', 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=5'],
  ['Lobsters RSS', 'https://lobste.rs/rss'],
  // ── 第二批：Reddit 备用入口 + 无 key 内容源 ──
  ['Reddit old.', 'https://old.reddit.com/r/technology/hot.json?limit=5'],
  ['Reddit 自定义UA', 'https://www.reddit.com/r/technology/hot.json?limit=5&raw_json=1'],
  ['Dev.to articles', 'https://dev.to/api/articles?top=7&per_page=10'],
  ['Dev.to latest AI', 'https://dev.to/api/articles?tag=ai&per_page=10'],
  ['Medium tech feed', 'https://medium.com/feed/tag/technology'],
  ['GitHub trending', 'https://github.com/trending'],
];

(async () => {
  for (const [name, url] of TARGETS) {
    const t0 = Date.now();
    try {
      const r = await fetchExt(url, {
        headers: { '': UA, Accept: 'application/json,text/xml,application/rss+xml,*/*' },
        timeout: 20000,
      });
      const txt = await r.text();
      let n = -1;
      let sample = '';
      try {
        const j = JSON.parse(txt);
        if (j.data && j.data.children) { n = j.data.children.length; sample = (j.data.children[0] && j.data.children[0].data && j.data.children[0].data.title || '').slice(0, 60); }
        else if (j.hits) { n = j.hits.length; sample = (j.hits[0] && j.hits[0].title || '').slice(0, 60); }
        else if (j.response) { n = (j.response || []; sample = String((j.response[0] || {}).summary || '').slice(0, 60); }
        else { n = -2; sample = txt.slice(0, 70).replace(/\n/g, ' '); }
      } catch (e) {
        // 非 JSON：按 XML/RSS 粗判
        const items = (txt.match(/<item[\s>]/g) || [] || (txt.match(/<entry[\s>]/g) || [];
        n = items;
        sample = txt.slice(0, 70).replace(/\n/g, ' ');
      }
      const ms = Date.now() - t0;
      console.log('[' + r.status + '] ' + name + ' ' + ms + 'ms 条数=' + n + ' 样例=' + sample);
    } catch (e) {
      const ms = Date.now() - t0;
      console.log('[ERR] ' + name + ' ' + ms + 'ms ' + e.message);
    }
  }
  process.exit(0);
})();
