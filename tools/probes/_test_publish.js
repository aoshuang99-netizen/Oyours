'use strict';
const path = require('path');
const { chromium } = require('playwright-core');
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`, { flush: true }); }
(async () => {
  const { DataStore } = require(path.join(WS, 'data-store.js'));
  const { TumblrPublisher } = require(path.join(WS, 'tumblr-publisher.js'));
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(path.join(WS, 'data'));
  const publisher = new TumblrPublisher(dataStore);

  // 找刚创建的 gmail 账号 token
  const accountId = process.argv[2] || 't_test_4ixpph';
  const tok = dataStore.get('tumblr_token', accountId);
  if (!tok || !tok.oauthToken) { log('无 token: ' + accountId); process.exit(1); }
  log('测试账号: ' + accountId + ' | blog=' + tok.blogName);

  try {
    const res = await publisher.publishText
      ? await publisher.publishText({ accountId, body: '自动化测试帖 ✅ ' + new Date().toISOString() })
      : await publisher.publishVideo({ accountId, caption: 'test', filePath: null });
    log('发帖结果: ' + JSON.stringify(res));
  } catch (e) {
    log('发帖失败: ' + e.message);
  }
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
