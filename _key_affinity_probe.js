#!/usr/bin/env node
'use strict';
/**
 * _key_affinity_probe.js —— 只读判别：账号 oauthToken 实际绑在哪个 consumerKey 上。
 * 手法：用 key[1] (Explore API) 的 key 签该账号 token 请求 GET /v2/user/info。
 *   200 → token 绑 key[1]（可合法迁到 key[1]）
 *   401 → token 绑 key[0]（不可迁；main 兜底是正确的）
 *   429 → 该 key 配额耗尽，无法判定
 * 经 BD TLS 33335 直连（绕开本机闸门），不产生任何写入。
 * 代价：每个样本 1 次请求。默认只跑 --n（默认 8）个样本 + 2 个对照。
 */
const fs = require('fs');
const crypto = require('crypto');
const { ProxyAgent, fetch: ufetch } = require('undici');

const D = 'D:/mscms-ws/data/';
const BD = process.env.BD_TLS || 'https://brd-customer-hl_ac0f9818-zone-isp_proxy1:d2ream9zn4am@brd.superproxy.io:33335';

const pe = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function sign(method, url, oauth, extra, cs, ts) {
  const p = Object.assign({}, extra, oauth);
  const base = Object.keys(p).sort().map((k) => pe(k) + '=' + pe(p[k])).join('&');
  return crypto.createHmac('sha1', pe(cs) + '&' + pe(ts || '')).update(method.toUpperCase() + '&' + pe(url) + '&' + pe(base)).digest('base64');
}

const apps = JSON.parse(fs.readFileSync('tumblr_apps.json', 'utf8'));
const tokMap = JSON.parse(fs.readFileSync(D + 'tumblr_token.json', 'utf8'));
const cfgArr = JSON.parse(fs.readFileSync(D + 'tumblr_config.json', 'utf8'));
const cfg = new Map(); cfgArr.forEach((c) => cfg.set(c.id, c));

const args = process.argv.slice(2);
const N = Number((args.find((a) => a.startsWith('--n=')) || '--n=8').split('=')[1]);

const okTok = Object.keys(tokMap).filter((k) => tokMap[k] && tokMap[k].oauthToken && tokMap[k].oauthTokenSecret && tokMap[k].blogName);
const noCfg = okTok.filter((id) => !(cfg.get(id) || {}).consumerKey);
const ownK0 = okTok.filter((id) => { const c = cfg.get(id) || {}; return c.consumerKey === apps[0].consumerKey; });
const ownK1 = okTok.filter((id) => { const c = cfg.get(id) || {}; return c.consumerKey === apps[1].consumerKey; });

console.log('可发布 token =', okTok.length, ' 无 config =', noCfg.length, ' 显式 key0 =', ownK0.length, ' 显式 key1 =', ownK1.length);

async function probe(tag, appIdx, id) {
  const app = apps[appIdx];
  const t = tokMap[id];
  const url = 'https://api.tumblr.com/v2/user/info';
  const oauth = {
    oauth_consumer_key: app.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000),
    oauth_token: t.oauthToken,
    oauth_version: '1.0',
  };
  const sig = sign('GET', url, oauth, {}, app.consumerSecret, t.oauthTokenSecret);
  const h = 'OAuth ' + Object.keys(Object.assign({}, oauth, { oauth_signature: sig })).sort()
    .map((k) => pe(k) + '="' + pe(Object.assign({}, oauth, { oauth_signature: sig })[k]) + '"').join(', ');
  const t0 = Date.now();
  try {
    const r = await ufetch(url, { method: 'GET', dispatcher: new ProxyAgent(BD), signal: AbortSignal.timeout(45000), headers: { Authorization: h, 'User-Agent': 'Mozilla/5.0' } });
    const body = await r.text();
    let verdict = '';
    if (r.status === 200) verdict = `✅ 200 ⇒ token 绑 key[${appIdx}]`;
    else if (r.status === 401) verdict = `❌ 401 ⇒ token 不绑 key[${appIdx}]（签名/key 不匹配）`;
    else if (r.status === 429) verdict = `⏸ 429 ⇒ key[${appIdx}] 配额耗尽，无法判定`;
    else verdict = `? ${r.status}`;
    const dayRemain = r.headers.get('x-ratelimit-perday-remaining');
    console.log(`  [${tag}] ${id} 用 key[${appIdx}] ${apps[appIdx].label} → ${verdict}  (${Date.now() - t0}ms, perday-remaining=${dayRemain})`);
    if (r.status !== 200) console.log(`         body: ${body.slice(0, 160)}`);
    return r.status;
  } catch (e) {
    console.log(`  [${tag}] ${id} 用 key[${appIdx}] → 网络错误 ${String(e.message).slice(0, 100)}`);
    return 0;
  }
}

(async () => {
  console.log('\n=== A. 无 config 账号 用 key[1] 签（若 200 ⇒ 可搬 key1）===');
  const sampleA = noCfg.slice(0, N);
  const resA = [];
  for (const id of sampleA) resA.push(await probe('无cfg', 1, id));

  console.log('\n=== B. 显式绑 key[0] 的账号 用 key[1] 签（预期 401，作为对照）===');
  const sampleB = ownK0.slice(0, 2);
  for (const id of sampleB) await probe('对照K0', 1, id);

  console.log('\n=== C. 显式绑 key[1] 的账号 用 key[1] 签（预期 200，证明探测手法有效）===');
  const sampleC = ownK1.slice(0, 2);
  for (const id of sampleC) await probe('对照K1', 1, id);

  const n200 = resA.filter((s) => s === 200).length;
  const n401 = resA.filter((s) => s === 401).length;
  const n429 = resA.filter((s) => s === 429).length;
  console.log(`\n=== 结论 ===\n  无 config 样本 ${resA.length} 个：200=${n200} / 401=${n401} / 429=${n429}`);
  if (n200 > 0 && n401 === 0) console.log('  ⇒ 该批 token 实际绑 key[1]，main 兜底是历史误配 ⇒ 可安全显式改绑 key[1]');
  else if (n401 > 0 && n200 === 0) console.log('  ⇒ 该批 token 实际绑 key[0]，main 兜底正确 ⇒ 无法通过配置搬迁，只能重新 OAuth');
  else if (n429 > 0) console.log('  ⇒ key[1] 配额也受限，判定不完整，需换时刻重测');
  else console.log('  ⇒ 混合结果，需逐个判定');
})();
