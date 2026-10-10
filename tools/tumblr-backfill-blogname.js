#!/usr/bin/env node
/**
 * tools/tumblr-backfill-blogname.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 回填 Tumblr token 的 blogName（缺失 blog 名 = 发布被拒的隐藏原因）
 *
 * 背景（2026-09-10 定位）：
 *   有 26 个账号【持有有效 OAuth token】，但 token 记录里没有 blogName。
 *   `tumblr-publisher.ownBlogNameOf()` 返回空串 → cloud-publisher 判为无法发布，
 *   却打出 `NO_OAUTH_TOKEN: 未完成 OAuth 授权` —— 与实际原因不符（误导排查）。
 *   这些账号其实只需补一个 blog 名就能立即恢复发布（每个账号每天可多发 6 帖）。
 *
 * 做法：用账号【自己的】token 调 GET /v2/user/info，取 primary blog 名并回写。
 *
 * 用法（必须先停 3002 服务，否则 DataStore 内存副本会覆盖本次写盘）：
 *   node tools/tumblr-backfill-blogname.js --dry-run      # 只探测不写盘
 *   node tools/tumblr-backfill-blogname.js               # 探测并回写
 *   node tools/tumblr-backfill-blogname.js --limit=5     # 只处理前 5 个
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ProxyAgent, fetch } = require('undici');

const STORAGE = process.env.MSCMS_STORAGE_ROOT || 'D:/mscms-ws';
const DATA = process.env.DATA_DIR || path.join(STORAGE, 'data');
const TOKEN_FILE = path.join(DATA, 'tumblr_token.json');
const CONFIG_FILE = path.join(DATA, 'tumblr_config.json');
const POOL_FILE = process.env.MSCMS_PROXY_POOL || path.join(__dirname, '..', 'proxy-pool.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 0);

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const API = 'https://api.tumblr.com/v2/user/info';

const enc = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** OAuth 1.0a 签名（HMAC-SHA1）— 与 tumblr-publisher.js 同算法 */
function oauthHeader({ method, url, consumerKey, consumerSecret, token, tokenSecret }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const paramStr = Object.keys(oauth).sort().map((k) => enc(k) + '=' + enc(oauth[k])).join('&');
  const base = method.toUpperCase() + '&' + enc(url) + '&' + enc(paramStr);
  const key = enc(consumerSecret) + '&' + enc(tokenSecret);
  const sig = crypto.createHmac('sha1', key).update(base).digest('base64');
  const parts = Object.keys(oauth).sort().map((k) => enc(k) + '="' + enc(oauth[k]) + '"');
  parts.push('oauth_signature="' + enc(sig) + '"');
  return 'OAuth ' + parts.join(', ');
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeAtomic(p, obj) {
  const tmp = p + '.tmp_' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** 候选出口：TUMBLR_PROXY → proxy-pool.json 中 enabled 且 usage=post 的条目 */
function proxyCandidates() {
  const list = [];
  if (process.env.TUMBLR_PROXY) list.push(process.env.TUMBLR_PROXY);
  try {
    const raw = readJson(POOL_FILE);
    const arr = Array.isArray(raw) ? raw : (raw.proxies || raw.items || []);
    for (const p of arr) {
      if (!p || !p.url) continue;
      if (p.enabled === false) continue;
      if (String(p.usage || 'post') !== 'post') continue;
      if (String(p.url).startsWith('bdunlocker://')) continue;
      if (!list.includes(p.url)) list.push(p.url);
    }
  } catch (e) { /* ignore */ }
  if (!list.includes('http://127.0.0.1:10808')) list.push('http://127.0.0.1:10808');
  return list;
}

(async () => {
  if (!fs.existsSync(TOKEN_FILE)) { console.error('找不到 token 文件:', TOKEN_FILE); process.exit(1); }
  const tokens = readJson(TOKEN_FILE);
  const configsRaw = readJson(CONFIG_FILE);
  const configs = Array.isArray(configsRaw) ? configsRaw : (configsRaw.items || []);
  const main = configs.find((c) => c && c.id === 'main') || configs[0];
  if (!main || !main.consumerKey) { console.error('找不到 consumerKey（tumblr_config.json）'); process.exit(1); }

  // 【关键】本项目存在多个 Tumblr App：token 是按「授权时所用 App」签名的，
  // 用错 App 的 consumerKey 会得到 HTTP 401 Unauthorized（code 1013）。
  // 因此必须按账号 id 取其自己的 config 条目，缺省才回落到 main。
  const cfgById = new Map();
  for (const c of configs) { if (c && c.id) cfgById.set(c.id, c); }
  const effCfg = (id) => {
    const own = cfgById.get(id);
    if (own && own.consumerKey && own.consumerSecret) return own;
    return main;
  };
  const appsUsed = new Set();
  for (const id of Object.keys(tokens)) { const c = effCfg(id); if (c) appsUsed.add(String(c.consumerKey).slice(0, 10)); }
  console.log('共享 App（默认）consumerKey:', main.consumerKey.slice(0, 12) + '...');
  console.log('本次涉及的 App 数:', appsUsed.size, '→', [...appsUsed].join(', '));

  const targets = Object.keys(tokens).filter((id) => {
    const t = tokens[id];
    return t && t.oauthToken && t.oauthTokenSecret && !t.blogName;
  });
  const work = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
  console.log(`待回填 blogName 的账号: ${targets.length} 个${LIMIT ? `（本次处理前 ${work.length} 个）` : ''}`);
  if (work.length === 0) { console.log('无需回填 ✅'); return; }

  const proxies = proxyCandidates();
  console.log(`候选出口: ${proxies.length} 个（首选: ${proxies[0]}）\n`);

  const CONCURRENCY = Number((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || 4);
  const TIMEOUT_MS = Number((args.find(a => a.startsWith('--timeout=')) || '').split('=')[1] || 15000);
  const MAX_ATTEMPT = Math.min(proxies.length, 3);

  let ok = 0, fail = 0, written = 0;
  const failures = [];
  const t0 = Date.now();

  if (!DRY) {
    const bak = TOKEN_FILE + '.bak_' + Date.now();
    fs.copyFileSync(TOKEN_FILE, bak);
    console.log(`已备份 token 文件 → ${path.basename(bak)}\n`);
  }

  // 增量落盘：每成功一个就写一次，进程被杀也不丢进度
  const flush = () => {
    if (DRY) return;
    writeAtomic(TOKEN_FILE, tokens);
    written++;
  };

  async function handleOne(id, idx) {
    const t = tokens[id];
    const cfg = effCfg(id);
    for (let attempt = 0; attempt < MAX_ATTEMPT; attempt++) {
      const proxyUrl = proxies[attempt]; // 每个账号都从「首选出口」开始试
      let dispatcher = null;
      try {
        dispatcher = new ProxyAgent(proxyUrl);
        const res = await fetch(API, {
          method: 'GET',
          headers: {
            Authorization: oauthHeader({
              method: 'GET', url: API,
              consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret,
              token: t.oauthToken, tokenSecret: t.oauthTokenSecret,
            }),
            'User-Agent': MOBILE_UA,
            Accept: 'application/json',
          },
          dispatcher,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = await res.text();
        if (res.status !== 200) {
          if (attempt === MAX_ATTEMPT - 1) failures.push(`${id} → HTTP ${res.status} ${body.slice(0, 100)}`);
          continue;
        }
        let json; try { json = JSON.parse(body); } catch (e) { break; }
        const user = (json.response && json.response.user) || {};
        const blogs = user.blogs || [];
        const primary = blogs.find((b) => b.primary) || blogs[0];
        const name = primary && primary.name;
        if (name) {
          t.blogName = name;
          t.blogUrl = primary.url || `https://${name}.tumblr.com`;
          t.blogBackfilledAt = new Date().toISOString();
          ok++;
          console.log(`  [${ok + fail}/${work.length}] ✅ ${id} → blog=${name}  (${proxyUrl.replace(/^http:\/\/127\.0\.0\.1:/, 'port')}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
          flush();
          return;
        }
        failures.push(`${id} → 200 但无 blog（blogs=${blogs.length}）`);
        break;
      } catch (e) {
        if (attempt === MAX_ATTEMPT - 1) failures.push(`${id} → ${e.message}`);
      } finally {
        try { if (dispatcher) dispatcher.destroy(); } catch (e) { /* ignore */ }
      }
    }
    fail++;
    console.log(`  [${ok + fail}/${work.length}] ❌ ${id} 失败`);
  }

  // 简单并发池
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
    while (cursor < work.length) {
      const idx = cursor++;
      await handleOne(work[idx], idx);
    }
  });
  await Promise.all(workers);

  console.log(`\n结果：成功 ${ok} / 失败 ${fail} / 共 ${work.length} | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failures.length) { console.log('失败明细（前 15 条）:'); failures.slice(0, 15).forEach((f) => console.log('  -', f)); }

  if (DRY) { console.log('\n[dry-run] 未写盘'); return; }
  if (ok > 0) {
    console.log(`已增量写回 ${TOKEN_FILE}（${written} 次）`);
    const remain = Object.keys(tokens).filter((id) => tokens[id].oauthToken && !tokens[id].blogName).length;
    console.log(`仍缺 blogName 的 token: ${remain} 个`);
  } else {
    console.log('无成功项，未写盘');
  }
})().catch((e) => { console.error('执行异常:', e); process.exit(1); });
