'use strict';
// 真实发布连通性验证：经 10808 兜底链路，对真实 Tumblr 账号做 OAuth getUserInfo + postText。
// 证明要点：Tumblr 真实发布经 10808（数据中心 IP）已可用，无需 Web Unlocker / 住宅代理。
const { TumblrPublisher } = require('./tumblr-publisher.js');
const fs = require('fs');

const apps = JSON.parse(fs.readFileSync('tumblr_apps.json', 'utf8'));
const tok = JSON.parse(fs.readFileSync('data/tumblr_token.json', 'utf8'));

let id = null, t = null;
for (const k of Object.keys(tok)) {
  const v = tok[k];
  if (v && v.oauthToken && v.blogName) { id = k; t = v; break; }
}
if (!id) { console.log('NO VALID TOKEN'); process.exit(1); }
console.log('使用账号:', id, ' blog:', t.blogName);

const stubDS = { get() {}, create() {}, update() {}, all() { return {}; }, getModule() { return {}; } };
const pub = new TumblrPublisher(stubDS, { callback: 'oob' });
pub.setProxyResolver(() => null); // 走全局 10808 兜底（http-client 的 proxyAgent）

async function tryApp(app) {
  // 直接覆写取数方法注入真实凭据（绕过 dataStore）
  pub._getEffectiveConfig = () => ({ consumerKey: app.consumerKey, consumerSecret: app.consumerSecret });
  pub._getToken = () => ({ oauthToken: t.oauthToken, oauthTokenSecret: t.oauthTokenSecret });
  try {
    const info = await pub.getUserInfo(id);
    console.log('  [APP ' + app.label + '] getUserInfo OK ->', JSON.stringify(info).slice(0, 160));
    const r = await pub.postText(t.blogName, {
      title: 'MSCMS 实时发布验证',
      body: 'MSCMS v14 真实发布连通性自测 @ ' + new Date().toISOString() + ' （经 10808 链路）',
      tags: ['mscms', 'test'],
      state: 'published',
    }, id);
    console.log('  [APP ' + app.label + '] postText OK -> postUrl=', r.postUrl, ' postId=', r.postId);
    return true;
  } catch (e) {
    console.log('  [APP ' + app.label + '] FAILED:', e.message.slice(0, 220));
    return false;
  }
}

(async () => {
  for (const a of apps) {
    if (await tryApp(a)) { console.log('SUCCESS with app:', a.label); process.exit(0); }
  }
  console.log('ALL APPS FAILED — 10808 真实发布不可用');
  process.exit(2);
})();
