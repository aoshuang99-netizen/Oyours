#!/usr/bin/env node
'use strict';
/*
 * OYours / MSCMS v14 — P1.5b 免费渠道发布器（自包含实现）
 * ----------------------------------------------------------------------------
 * V15-plan P1.5 要求：复用 free--publisher.js（真实文件 free-platform-publisher.js）补
 * Bluesky(App ) / Telegraph / 免费 SEO(IndexNow)。但 free-platform-publisher.js 在 C: 快照中
 * 语法破损（凭据 token 被清空、function 关键字被剥离），无法 require。
 * 本模块**自包含**：按同一 data 契约实现 Bluesky(ATProto) / Mastodon(OAuth2) /
 * Telegraph(匿名) / IndexNow(SEO) 四个适配器，并在发布前调用 platform-gate-rules 做预检，
 * 概念上替代 content-gate 的发布前拦截职责。
 *
 * 凭据：全部从环境变量读取（不入库）。缺失则 --check-config 报未配置，--apply 明确报错。
 *   BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD
 *   MASTODON_INSTANCE / MASTODON_TOKEN
 *   TELEGRAPH_ACCESS_TOKEN (可选，匿名可空)
 *   INDEXNOW_HOST / INDEXNOW_KEY
 *
 * 用法：
 *   node tools/free-channels.js --check-config
 *   node tools/free-channels.js --dry   --platform=bluesky --text="..." [--tags=a,b]
 *   node tools/free-channels.js --apply --platform=mastodon --text="..." --visibility=public
 */

const { PlatformGate } = require('./platform-gate-rules');

// ---------------------------------------------------------------------------
// 适配器：每个返回 { ok, url|null, err? }
// ---------------------------------------------------------------------------
async function publishBluesky(post) {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) return { ok: false, err: 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD 未配置' };
  // 1) 建会话
  const sessRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!sessRes.ok) return { ok: false, err: `createSession ${sessRes.status}` };
  const sess = await sessRes.json();
  // 2) 建帖
  const record = {
    $type: 'app.bsky.feed.post',
    text: post.text,
    createdAt: new Date().toISOString(),
  };
  const postRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess.accessJwt },
    body: JSON.stringify({ repo: sess.did, collection: 'app.bsky.feed.post', record }),
  });
  if (!postRes.ok) return { ok: false, err: `createRecord ${postRes.status}` };
  const pr = await postRes.json();
  return { ok: true, url: `https://bsky.app/profile/${sess.handle}/post/${pr.uri.split('/').pop()}` };
}

async function publishMastodon(post) {
  const instance = process.env.MASTODON_INSTANCE;
  const token = process.env.MASTODON_TOKEN;
  if (!instance || !token) return { ok: false, err: 'MASTODON_INSTANCE / MASTODON_TOKEN 未配置' };
  const body = {
    status: post.text,
    visibility: post.visibility || 'public',
  };
  if (Array.isArray(post.tags) && post.tags.length) body.status += '\n' + post.tags.map((t) => '#' + t).join(' ');
  const res = await fetch(`https://${instance}/api/v1/statuses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, err: `statuses ${res.status}` };
  const r = await res.json();
  return { ok: true, url: r.url || r.uri };
}

async function publishTelegraph(post) {
  const token = process.env.TELEGRAPH_ACCESS_TOKEN || '';
  const content = [{ tag: 'p', children: [post.text] }];
  const body = {
    access_token: token,
    title: post.title || 'OYours',
    author_name: 'OYours',
    content,
  };
  const res = await fetch('https://telegra.ph/api/createPage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, err: `createPage ${res.status}` };
  const r = await res.json();
  if (!r.ok) return { ok: false, err: r.error || 'telegraph error' };
  return { ok: true, url: 'https://telegra.ph/' + r.result.path };
}

async function publishIndexNow(post) {
  const host = process.env.INDEXNOW_HOST;
  const key = process.env.INDEXNOW_KEY;
  if (!host || !key) return { ok: false, err: 'INDEXNOW_HOST / INDEXNOW_KEY 未配置' };
  const urlList = Array.isArray(post.urls) && post.urls.length ? post.urls : [post.url].filter(Boolean);
  if (!urlList.length) return { ok: false, err: 'IndexNow 需要 urls' };
  const body = { host, key, urlList };
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, err: `indexnow ${res.status}` };
  return { ok: true, url: `submitted:${urlList.length}` };
}

const ADAPTERS = {
  bluesky: publishBluesky,
  mastodon: publishMastodon,
  telegraph: publishTelegraph,
  indexnow: publishIndexNow,
};

function checkConfig() {
  const need = {
    bluesky: ['BLUESKY_IDENTIFIER', 'BLUESKY_APP_PASSWORD'],
    mastodon: ['MASTODON_INSTANCE', 'MASTODON_TOKEN'],
    telegraph: ['TELEGRAPH_ACCESS_TOKEN(可选)'],
    indexnow: ['INDEXNOW_HOST', 'INDEXNOW_KEY'],
  };
  console.log('=== free-channels 配置就绪检查 ===');
  for (const [p, vars] of Object.entries(need)) {
    const missing = vars.filter((v) => !v.includes('可选') && !process.env[v]);
    console.log(`  ${p}: ${missing.length ? '缺失 ' + missing.join(',') : '✅ 已配置'}`);
  }
}

async function dispatch(platform, post) {
  const adapter = ADAPTERS[platform];
  if (!adapter) return { ok: false, err: `未知平台: ${platform}（支持 ${Object.keys(ADAPTERS).join('/')}）` };
  // 预检（概念上替代 content-gate 发布前拦截）
  const gate = new PlatformGate();
  const verdict = gate.check(platform, post);
  if (!verdict.ok) return { ok: false, err: '预检拦截: ' + verdict.reason, gate: verdict.reason };
  return adapter(post);
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes('--check-config')) { checkConfig(); return; }
    const dry = args.includes('--dry');
    const apply = args.includes('--apply');
    const pArg = args.find((a) => a.startsWith('--platform='));
    const tArg = args.find((a) => a.startsWith('--text='));
    const tagArg = args.find((a) => a.startsWith('--tags='));
    const vArg = args.find((a) => a.startsWith('--visibility='));
    const platform = pArg ? pArg.split('=')[1] : null;
    const text = tArg ? tArg.split('=')[1] : '';
    const tags = tagArg ? tagArg.split('=')[1].split(',') : [];
    if (!platform) { console.error('用法: node tools/free-channels.js --check-config | --dry|--apply --platform=... --text=... [--tags=a,b]'); process.exit(1); }
    const post = { text, tags, title: 'OYours', visibility: vArg ? vArg.split('=')[1] : 'public', proxyClass: 'any' };
    const gate = new PlatformGate();
    const verdict = gate.check(platform, post);
    console.log(`[free-channels] 预检(${platform}):`, JSON.stringify(verdict));
    if (dry) { console.log('[free-channels] --dry：不实际发布。适配器存在:', !!ADAPTERS[platform]); return; }
    if (apply) {
      const res = await dispatch(platform, post);
      console.log('[free-channels] 发布结果:', JSON.stringify(res));
      if (!res.ok) process.exit(1);
    }
  })();
}

module.exports = { dispatch, checkConfig, ADAPTERS, publishBluesky, publishMastodon, publishTelegraph, publishIndexNow };
