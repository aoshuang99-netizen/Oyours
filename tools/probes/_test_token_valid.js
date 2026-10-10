'use strict';
const path = require('path');
const crypto = require('crypto');
const { fetchExt } = require(path.join('C:/Users/AS/WorkBuddy/2026-06-13-19-42-19', 'http-client'));
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`, { flush: true }); }

function percentEncode(str) { return encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function genNonce() { return crypto.randomBytes(16).toString('hex'); }
function genTimestamp() { return Math.floor(Date.now() / 1000); }

function sign(method, url, oauthParams, extraParams, consumerSecret, tokenSecret) {
  const params = Object.assign({}, extraParams, oauthParams);
  const keys = Object.keys(params).sort();
  const base = keys.map(k => `${percentEncode(k)}=${percentEncode(String(params[k]))}`).join('&');
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(base)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret || '')}`;
  return crypto.createHmac('sha1', key).update(baseString).digest('base64');
}

(async () => {
  const { DataStore } = require(path.join(WS, 'data-store.js'));
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(path.join(WS, 'data'));
  const accountId = process.argv[2] || 't_test_4ixpph';
  const cfg = dataStore.get('tumblr_config', 'main');
  const tok = dataStore.get('tumblr_token', accountId);
  if (!tok || !tok.oauthToken) { log('无 token'); process.exit(1); }
  log('账号: ' + accountId + ' blog=' + tok.blogName);

  const ck = cfg.consumerKey, cs = cfg.consumerSecret;
  const ot = tok.oauthToken, ots = tok.oauthTokenSecret;

  // 1. user/info
  const infoUrl = 'https://api.tumblr.com/v2/user/info';
  let oauth = { oauth_consumer_key: ck, oauth_nonce: genNonce(), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: genTimestamp(), oauth_version: '1.0', oauth_token: ot };
  let sig = sign('GET', infoUrl, oauth, {}, cs, ots);
  let header = 'OAuth ' + Object.keys(Object.assign({}, oauth, { oauth_signature: sig })).sort().map(k => `${percentEncode(k)}="${percentEncode(String(Object.assign({}, oauth, { oauth_signature: sig })[k]))}"`).join(', ');
  let r = await fetchExt(infoUrl, { method: 'GET', headers: { 'Authorization': header } });
  let j = await r.json().catch(() => ({}));
  log('user/info: ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));

  // 2. 发文本帖（/blog/{blogName}/post）
  const postUrl = `https://api.tumblr.com/v2/blog/${tok.blogName}/post`;
  const body = { type: 'text', title: '自动测试', body: '✅ 自动化授权链路验证 ' + new Date().toISOString() };
  oauth = { oauth_consumer_key: ck, oauth_nonce: genNonce(), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: genTimestamp(), oauth_version: '1.0', oauth_token: ot };
  sig = sign('POST', postUrl, oauth, body, cs, ots);
  header = 'OAuth ' + Object.keys(Object.assign({}, oauth, { oauth_signature: sig })).sort().map(k => `${percentEncode(k)}="${percentEncode(String(Object.assign({}, oauth, { oauth_signature: sig })[k]))}"`).join(', ');
  const params = new URLSearchParams(body).toString();
  r = await fetchExt(postUrl, { method: 'POST', headers: { 'Authorization': header, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  j = await r.json().catch(() => ({}));
  log('发帖: ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));

  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
