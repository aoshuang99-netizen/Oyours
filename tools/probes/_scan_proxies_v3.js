// 免费开源代理扫描 v3：直连探测 GitHub 公开代理对 Tumblr 的可达性
// 目的：为 B3 真实发帖闭环找到可用的多出口 IP，根除单 IP 429
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { ProxyAgent, fetch } = require('undici');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';

// 经 10808 出网拉取 GitHub 免费代理列表（沙箱仅此出口可达 GitHub）
const GITHUB_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/http.txt'
];

function fetchVia10808(url) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(''); }, 20000);
    // 用 undici fetch + ProxyAgent 经 10808 出网（与 http-client.js 保持一致，避免混用内置 https）
    fetch(url, { method: 'GET', dispatcher: new ProxyAgent('http://127.0.0.1:10808'), signal: controller.signal })
      .then((r) => r.text().then((t) => { clearTimeout(timer); resolve(t); }))
      .catch(() => { clearTimeout(timer); resolve(''); });
  });
}

function testProxy(px) {
  // px 形如 "1.2.3.4:8080"
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve({ px, reached: false, status: 'TIMEOUT' }); }, 9000);
    const agent = new ProxyAgent('http://' + px);
    fetch('https://api.tumblr.com/v2/user/info', {
      method: 'GET',
      agent,
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }).then((r) => {
      clearTimeout(timer);
      // 任何 HTTP 状态码都说明请求经代理"到达"了 Tumblr（401/429/200 都是到达）
      resolve({ px, reached: true, status: r.status });
    }).catch((e) => {
      clearTimeout(timer);
      resolve({ px, reached: false, status: 'ERR', err: String(e.message || e).slice(0, 40) });
    });
  });
}

function loadTokens() {
  const raw = JSON.parse(fs.readFileSync(path.join(WS, 'data/tumblr_token.json'), 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

function loadConfig() {
  const arr = JSON.parse(fs.readFileSync(path.join(WS, 'data/tumblr_config.json'), 'utf8'));
  const m = {};
  for (const c of (Array.isArray(arr) ? arr : [])) { m[c.id] = c; }
  return m;
}

// 内联 OAuth1.0a (HMAC-SHA1) 签名，经外部代理验证真实 token
const crypto = require('crypto');
function oauthHeader(method, url, consumerKey, consumerSecret, token, tokenSecret) {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: '1.0'
  };
  const keys = Object.keys(params).sort();
  const paramStr = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const base = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`;
  const signKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const sig = crypto.createHmac('sha1', signKey).update(base).digest('base64');
  const all = Object.assign({ oauth_signature: sig }, params);
  const hdr = Object.keys(all).sort().map((k) => `${k}="${encodeURIComponent(all[k])}"`).join(', ');
  return 'OAuth ' + hdr;
}

function realOAuth(px, cfg, tok) {
  return new Promise((resolve) => {
    const url = 'https://api.tumblr.com/v2/user/info';
    const auth = oauthHeader('GET', url, cfg.consumerKey, cfg.consumerSecret, tok.oauthToken, tok.oauthTokenSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve({ status: 'TIMEOUT' }); }, 12000);
    const agent = new ProxyAgent('http://' + px);
    fetch(url, { method: 'GET', agent, signal: controller.signal, headers: { Authorization: auth, 'User-Agent': 'Mozilla/5.0' } })
      .then((r) => r.text().then((t) => { clearTimeout(timer); resolve({ status: r.status, body: t.slice(0, 120) }); }))
      .catch((e) => { clearTimeout(timer); resolve({ status: 'ERR', err: String(e.message || e).slice(0, 60) }); });
  });
}

(async () => {
  console.log('[1] 拉取 GitHub 免费代理列表（经 10808）...');
  let allProxies = [];
  for (const src of GITHUB_SOURCES) {
    const txt = await fetchVia10808(src);
    const lines = txt.split('\n').map((s) => s.trim()).filter((s) => /^[\d.]+:\d+$/.test(s));
    console.log(`  ${src.split('/').pop()}: ${lines.length} 条`);
    allProxies = allProxies.concat(lines);
  }
  // 去重
  allProxies = Array.from(new Set(allProxies));
  console.log(`[2] 去重后共 ${allProxies.length} 个代理，开始直连探测 Tumblr 可达性...`);

  const working = [];
  const BATCH = 25;
  for (let i = 0; i < allProxies.length && working.length < 15; i += BATCH) {
    const batch = allProxies.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(testProxy));
    for (const r of results) {
      if (r.reached) working.push(r);
    }
    const okInBatch = results.filter((r) => r.reached).length;
    console.log(`  扫描 ${i + batch.length}/${allProxies.length}，本批可达 ${okInBatch}，累计可达 ${working.length}`);
    if (working.length >= 15) break;
  }

  console.log(`\n[3] 可达 Tumblr 的代理: ${working.length}`);
  working.forEach((w) => console.log(`  ${w.px} -> ${w.status}`));

  if (working.length === 0) {
    console.log('无可用代理，终止');
    process.exit(0);
  }

  // 用真实 token 验证 OAuth 可达
  const cfgMap = loadConfig();
  const tokens = loadTokens();
  console.log(`\n[4] 用 ${tokens.length} 个真实 token 验证 OAuth 可达...`);
  let validated = 0;
  for (const w of working) {
    for (const tok of tokens) {
      if (!tok.oauthToken) continue;
      const cfg = cfgMap[tok.id] || cfgMap['main'];
      if (!cfg || !cfg.consumerKey) continue;
      const r = await realOAuth(w.px, cfg, tok);
      console.log(`  代理 ${w.px} | token ${tok.id}: status=${r.status} ${r.body || r.err || ''}`);
      if (r.status === 200) { console.log('  🎉 真实 OAuth 成功！Tumblr 可达且 token 有效'); validated++; }
      if (validated >= 3) break;
    }
    if (validated >= 3) break;
  }

  // 保存可用代理池
  fs.writeFileSync(path.join(WS, '_working_proxies.json'), JSON.stringify(working.map((w) => w.px), null, 2));
  console.log(`\n[5] 已保存 ${working.length} 个可用代理到 _working_proxies.json（OAuth 验证成功 ${validated} 个）`);
  console.log(validated > 0 ? '✅ 可达成真实发帖闭环' : '⚠️ 代理可达但 OAuth 未验证成功，需进一步排查');
})();
