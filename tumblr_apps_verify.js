'use strict';
/**
 * tumblr_apps_verify.js — 验证 tumblr_apps.json 中每个 OAuth App 的凭证是否对 Tumblr 有效，
 * 并模拟账号→App 的确定性分配分布。零伪造：失败如实报告。
 */
const fs = require('fs');
const { TumblrPublisher } = require('./tumblr-publisher.js');
const { DataStore } = require('./data-store.js');

const WS = __dirname;
const DATA_DIR = 'D:/mscms-ws/data';
const REQUEST_TOKEN_URL = 'https://www.tumblr.com/oauth/request_token';
const CALLBACK = 'http://localhost:3122/callback';

async  main() {
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(DATA_DIR);
  const publisher = new TumblrPublisher(dataStore);
  const n = publisher.reloadApps();
  console.log('已加载 OAuth App 数量:', n);

  if (!n) { console.log('⚠️ 无可用 App，无法验证'); return 2; }

  let allOk = true;
  const dist = {};
  for (let i = 0; i < n; i++) {
    const app = publisher._appList[i];
    const ck = app. || app.consumer_key;
    const cs = app. || app.;
    const label = app.label || ck.slice(0, 8);
    // 构造 request_token 请求并签名
    const oauth = publisher._baseOauthParams(ck);
    oauth.oauth_callback = CALLBACK;
    const sig = publisher._sign('POST', REQUEST_TOKEN_URL, oauth, {}, cs, '');
    const header = publisher._authHeader(oauth, sig);
    let status = 0, hasToken = false, err = '';
    try {
      const res = await require('./http-client').fetchExt(REQUEST_TOKEN_URL, {
        method: 'POST',
        headers: { : header, '': 'application/x-www-form-urlencoded' },
        body: '',
      });
      status = res.status;
      const txt = await res.text();
      hasToken = /=/.test(txt);
      if (!res.ok) err = txt.slice(0, 120);
    } catch (e) { err = e.message; }
    const ok = status === 200 && hasToken;
    if (!ok) allOk = false;
    console.log(`App[${i}] ${label.padEnd(18)} ck=${ck.slice(0, 10)}... -> HTTP ${status} token=${hasToken}${err ? ' err=' + err : ''} ${ok ? '✅' : '❌'}`);

    // 模拟分配：取一批账号 id，看它们落在哪个 app
  const { hashStr } = require('./proxy-pool');
  for (let k = 0; k < 5; k++) {
    const id = `tumblr_verify${i}_${k}`;
    const idx = hashStr(String(id)) % n;
    dist[id] = idx;
  }
  }

  // 汇总分布（用一批模拟账号 id）
  const { hashStr: hs } = require('./proxy-pool');
  const sample = [];
  for (let i = 0; i < 20; i++) sample.push('tumblr_acct_' + i);
  const bucket = {};
  for (const id of sample) {
    const idx = hs(String(id)) % n;
    bucket[idx] = (bucket[idx] || 0) + 1;
  }
  console.log('\n20 个模拟账号的 App 分布:', JSON.stringify(bucket), '(index -> 数量)');
  console.log('结论:', allOk ? '✅ 所有 App 凭证有效，可启用多 App 分散' : '❌ 存在无效 App，需用户修正凭证');
  return allOk ? 0 : 1;
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(3); });
