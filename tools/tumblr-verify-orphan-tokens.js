#!/usr/bin/env node
/**
 * 验证「孤儿 token」（token 表里有、accounts.json 里无）的授权是否仍然有效。
 * 用法：node tools/tumblr-verify-orphan-tokens.js [--all] [--concurrency=4]
 *   --all  校验全部 token（默认只校验孤儿）
 * 只读，不写盘。输出：有效 / 失效（401）明细。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let ProxyAgent, fetch;
try { ({ ProxyAgent, fetch } = require('undici')); } catch (e) {
  console.error('undici 不可用：', e.message); process.exit(1);
}
// 【坑】必须用 undici 自带的 fetch，不能用 Node 内置 globalThis.fetch。
// Node 内置 fetch 有自己的 undici 实例，传入外部 undici 的 ProxyAgent 会直接抛
// "fetch failed"（且 cause 被吞），表现为「全部出口不可用」的假象。

const DATA = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const RES = process.env.MSCMS_RES_DIR || 'D:/MSCMS-Desktop/resources';
const TOKEN_FILE = path.join(DATA, 'tumblr_token.json');
const CONFIG_FILE = path.join(DATA, 'tumblr_config.json');
// 与 tumblr-backfill-blogname.js 保持一致：优先工作区 proxy-pool.json，回落 D 盘
const POOL_FILE = fs.existsSync(path.join(__dirname, '..', 'proxy-pool.json'))
  ? path.join(__dirname, '..', 'proxy-pool.json')
  : path.join(RES, 'proxy-pool.json');

const API = 'https://api.tumblr.com/v2/user/info';
const MOBILE_UA = 'Tumblr/Android/33.0 (Android 13; Pixel 6)';

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const CONC = Number((args.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1] || 4);

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }

function oauthHeader(o) {
  const p = {
    oauth_consumer_key: o.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: o.token,
    oauth_version: '1.0',
  };
  const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const base = ['GET', enc(o.url), enc(Object.keys(p).sort().map((k) => `${enc(k)}=${enc(p[k])}`).join('&'))].join('&');
  const key = `${enc(o.consumerSecret)}&${enc(o.tokenSecret)}`;
  p.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(p).sort().map((k) => `${enc(k)}="${enc(p[k])}"`).join(', ');
}

const accounts = readJSON(path.join(DATA, 'accounts.json'), []);
const accArr = Array.isArray(accounts) ? accounts : (accounts.items || []);
const ids = new Set(accArr.map((a) => String(a.id)));

const tokens = readJSON(TOKEN_FILE, {});
const cfgRaw = readJSON(CONFIG_FILE, []);
const configs = Array.isArray(cfgRaw) ? cfgRaw : (cfgRaw.items || []);
const main = configs.find((c) => c && c.id === 'main') || configs[0];

const targets = ALL ? Object.keys(tokens) : Object.keys(tokens).filter((k) => !ids.has(k));

// 代理候选：优先最快出口
const poolRaw = readJSON(POOL_FILE, []);
const pool = Array.isArray(poolRaw) ? poolRaw : (poolRaw.proxies || poolRaw.items || []);
const proxies = pool
  .filter((p) => p && p.url && p.enabled !== false && String(p.usage || 'post') === 'post' && !String(p.url).startsWith('bdunlocker://'))
  .sort((a, b) => (a.latencyMs || 9999) - (b.latencyMs || 9999))
  .map((p) => p.url);
if (!proxies.length) proxies.push('http://127.0.0.1:10808');

console.log(`目标: ${targets.length} 个 token (${ALL ? '全部' : '仅孤儿'}) | 出口: ${proxies.length} 个 | 并发 ${CONC}\n`);

(async () => {
  let ok = 0, auth = 0, other = 0;
  const bad = [];
  const queue = targets.slice();
  async function worker(wid) {
    while (queue.length) {
      const id = queue.shift();
      const t = tokens[id];
      const c = configs.find((x) => x.id === id);
      const app = c && c.consumerKey ? c : main;
      let done = false;
      for (let a = 0; a < Math.min(proxies.length, 4) && !done; a++) {
        const proxyUrl = proxies[(a + wid) % proxies.length];
        let disp = null;
        try {
          disp = new ProxyAgent(proxyUrl);
          const res = await fetch(API, {
            method: 'GET',
            headers: { Authorization: oauthHeader({ method: 'GET', url: API, consumerKey: app.consumerKey, consumerSecret: app.consumerSecret, token: t.oauthToken, tokenSecret: t.oauthTokenSecret }), 'User-Agent': MOBILE_UA, Accept: 'application/json' },
            dispatcher: disp,
            signal: AbortSignal.timeout(20000),
          });
          const body = await res.text();
          if (res.status === 200) {
            let name = null;
            try { const j = JSON.parse(body); const blogs = (j.response && j.response.user && j.response.user.blogs) || []; const pb = blogs.find((b) => b.primary) || blogs[0]; name = pb && pb.name; } catch (e) { /* ignore */ }
            const match = name === t.blogName;
            console.log(`  ✅ ${id} | blog=${t.blogName} | 实际=${name} ${match ? '' : '⚠️ 不一致'}`);
            ok++; done = true;
          } else if (res.status === 401 || res.status === 403) {
            if (a === Math.min(proxies.length, 4) - 1) { console.log(`  ❌ ${id} | HTTP ${res.status} ${body.slice(0, 90)}`); auth++; bad.push({ id, status: res.status, msg: body.slice(0, 120) }); }
          } else {
            if (a === Math.min(proxies.length, 4) - 1) { console.log(`  ⚠️ ${id} | HTTP ${res.status} ${body.slice(0, 80)}`); other++; bad.push({ id, status: res.status, msg: body.slice(0, 120) }); }
          }
        } catch (e) {
          const detail = e.cause ? `${e.message} (${e.cause.code || e.cause.message || ''})` : e.message;
          if (a === Math.min(proxies.length, 4) - 1) { console.log(`  ⚠️ ${id} | ${detail.slice(0, 90)}`); other++; bad.push({ id, status: 0, msg: detail.slice(0, 140) }); }
        } finally { try { if (disp) await disp.close(); } catch (e) { /* ignore */ } }
      }
      if (!done && !bad.find((b) => b.id === id)) { other++; bad.push({ id, status: -1, msg: 'unknown' }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, (_, i) => worker(i)));
  console.log(`\n结果：有效 ${ok} / 鉴权失败 ${auth} / 其它 ${other} / 共 ${targets.length}`);
  if (bad.length) { console.log('明细:'); bad.slice(0, 40).forEach((b) => console.log(`  - ${b.id} → ${b.status} ${b.msg.slice(0, 80)}`)); }
})().catch((e) => { console.error('异常:', e); process.exit(1); });
