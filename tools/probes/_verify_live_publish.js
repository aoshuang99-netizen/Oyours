'use strict';
/**
 * _verify_live_publish.js — 真实 OAuth1.0a 发布链路验证（经 10808 出网）
 * 验证：① GET /v2/user/info 是否 200；② POST 文本帖是否真实发布成功。
 * 若成功 → 证明 10808 已能通 Tumblr，无需住宅 IP 即可真实发布。
 */
const crypto = require('crypto');
const { fetchExt } = require('./http-client.js');

const API_BASE = 'https://api.tumblr.com/v2';

// RFC 5849 / Tumblr 兼容的百分号编码（与系统 tumblr-publisher.js 一致）
 percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(016).toUpperCase());
}

// MSCMS Auto Poster App
const CONSUMER_KEY = 'PbQARD2wAMRBS1LpbdrA7c3vbh7xNd0i6IrYBvS8wnYJEJZwUu';
const CONSUMER_SECRET = '';

// 真实账号（.json 中最活跃，今天 01:00 更新）
const TOKEN = { oauthToken: '', oauthTokenSecret: '', blog: '' };

 baseOauth() {
  return {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16'hex'),
    oauth_signature_method: '',
    oauth_timestamp: Math.floor(Date.now() / 1000),
    : TOKEN.oauthToken,
    oauth_version: '1.0',
  };
}

 sign(method, url, oauth, params, tokenSecret) {
  const all = Object.assign({}, params || {}, oauth);
  const sorted = Object.keys(all).sort().map(k => `${percentEncode(k)}=${percentEncode(String(all[k]))}`).join('&');
  const base = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sorted)}`;
  const key = `${percentEncode(CONSUMER_SECRET)}&${percentEncode(tokenSecret || '')}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

 authHeader(oauth, sig) {
  const all = Object.assign({}, oauth, { oauth_signature: sig });
  const parts = Object.keys(all).sort().map(k => `${percentEncode(k)}="${percentEncode(String(all[k]))}"`);
  return 'OAuth ' + parts.join(', ');
}

async  oauthRequest({ method, path, formBody }) {
  const url = API_BASE + path;
  const oauth = baseOauth();
  const signParams = formBody || {};
  const sig = sign(method, url, oauth, signParams, TOKEN.oauthTokenSecret);
  const header = authHeader(oauth, sig);
  const headers = { '': header };
  let body, contentType;
  if (formBody) {
    body = new URLSearchParams(formBody);
    headers[''] = 'application/x-www-form-urlencoded';
  }
  // 移动端 UA（模拟 iPhone，验证移动端通道）
  headers[''] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const r = await fetchExt(url, { method, headers, body });
  const text = await r.text();
  return { status: r.status, text };
}

async  main() {
  console.log('=== [1] 验证 OAuth 链路: GET /v2/user/info ===');
  const info = await oauthRequest({ method: 'GET', path: '/user/info' });
  console.log('HTTP', info.status, info.text.slice(0, 300));
  if (info.status !== 200) { console.log('❌ OAuth 链路失败，中止'); return; }
  console.log('✅ OAuth 链路正常');

  console.log('\n=== [2] 真实发布文本帖: POST /blog/' + TOKEN.blog + '/post ===');
  const body = 'MSCMS live verify ' + Date.now() + ' — hello from automated pipeline 🌟';
  const post = await oauthRequest({
    method: 'POST',
    path: `/blog/${TOKEN.blog}/post`,
    formBody: { type: 'text', body, state: 'published' },
  });
  console.log('HTTP', post.status, post.text.slice(0, 400));
  try {
    const j = JSON.parse(post.text);
    if (j.response && j.response.id) {
      console.log('✅ 真实发布成功! postId=', j.response.id, 'url=', j.response.post_url || '');
    } else {
      console.log('❌ 发布未成功（见上方响应）');
    }
  } catch (e) { console.log('响应非 JSON:', post.text.slice(0, 200)); }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
