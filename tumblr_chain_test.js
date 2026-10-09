'use strict';
/**
 * tumblr_chain_test.js — 全链路真实业务测试
 * 目标：用 ShardX 新注册账号的 OAuth token 直接打 Tumblr 官方 API，
 *   1) getUserInfo  -> 真实认证读（验证 token 有效）
 *   2) postText     -> 真实认证写（返回真实 post_url，验证 token 可发布）
 * 零伪造：失败如实抛出，不编造任何返回。
 */
const fs = require('fs');
const path = require('path');
const { DataStore } = require('./data-store.js');
const { TumblrPublisher } = require('./tumblr-publisher.js');

const WS = __dirname;
const DATA_DIR = 'D:/mscms-ws/data';

 pickFreshAccount() {
  const tok = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.json'), 'utf8'));
  const arr = Array.isArray(tok) ? tok : Object.entries(tok).map(([id, t]) => Object.assign({ id }, t));
  // 选一个最近的、带 oauthToken 且 blog 形如 mscms* 的账号
  const fresh = arr
    .filter(t => t.oauthToken && t.oauthTokenSecret && /mscms/.test(t.blogName || ''))
    .slice(-1);
  return fresh[0] || null;
}

async  main() {
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(DATA_DIR);
  const publisher = new TumblrPublisher(dataStore);

  const acct = pickFreshAccount();
  if (!acct) { console.error('未找到可用的新注册账号'); process.exit(2); }
  const accountId = acct.id;
  const blog = acct.blogName;

  console.log('=== 全链路真实业务测试 ===');
  console.log('accountId :', accountId);
  console.log('blog      :', blog);

  console.log('status    : invoking real API to verify (no synthetic check)');

  let pass = { read: false, write: false };
  let readDetail = null, writeDetail = null, writeErr = null;

  // 1) 真实认证读：/user/info
  try {
    const info = await publisher.getUserInfo(accountId);
    readDetail = {
      name: info.name,
      blogs: (info.blogs || []).map(b => b.name || (b.url || '').replace(/^https?:\/\//, '').replace(/\.tumblr\.com\/?$/, '')),
      following: info.following,
    };
    pass.read = true;
    console.log('READ  ✅  /user/info =>', JSON.stringify(readDetail));
  } catch (e) {
    console.log('READ  ❌  /user/info =>', e.message);
  }

  // 2) 真实认证写：发一条文本帖（state=published），拿真实 post_url
  try {
    const res = await publisher.postText(blog, {
      title: '[MSCMS 全链路真实测试]',
      body: 'This is an automated end-to-end chain verification post from MSCMS v14 (ShardX-ed account). Token usability confirmed via real Tumblr API call. ' + new Date().toISOString(),
      tags: ['mscms', 'e2e', 'verification'],
      state: 'published',
    }, accountId);
    pass.write = !!(res && res.postUrl);
    writeDetail = res;
    console.log('WRITE ✅  postText =>', JSON.stringify(res));
  } catch (e) {
    writeErr = e.message;
    console.log('WRITE ❌  postText =>', e.message);
  }

  console.log('\n=== 结果汇总 ===');
  console.log(`READ  (user/info) : ${pass.read ? 'PASS' : 'FAIL'}`);
  console.log(`WRITE (postText)  : ${pass.write ? 'PASS' : 'FAIL'}`);
  const ok = pass.read && pass.write;
  console.log('OVERALL          :', ok ? 'PASS ✅ 全链路 token 闭环可用' : 'FAIL ❌');
  return ok ? 0 : 1;
}

main().then(code => process.exit(code)).catch(e => { console.error('FATAL', e); process.exit(3); });
