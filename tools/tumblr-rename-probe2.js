#!/usr/bin/env node
/**
 * tools/tumblr-rename-probe2.js — 判定 settings 端点可改哪些字段（无副作用）
 * ---------------------------------------------------------------------------
 * 方法：用【原值回写】探测字段是否被接受。
 *   - 回写 title=<当前 title>  → 若 200，说明 title 可改（且值不变，无副作用）
 *   - 回写 name=<当前 name>    → 若 200/其他，判定 name(URL/用户名) 是否可改
 * 绝不写入任何与现状不同的值。
 * ---------------------------------------------------------------------------
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
const { DataStore } = require(path.join(ROOT, 'data-store'));
const { TumblrPublisher } = require(path.join(ROOT, 'tumblr-publisher'));
const { fetchExt } = require(path.join(ROOT, 'http-client'));

const ACC = process.argv[2] || 'tumblr_md4p5xij';
const ds = new DataStore(path.join(ROOT, 'data'));
const pub = new TumblrPublisher(ds, {});
const cfg = pub._getConfig();

 sign(method, url, tok, extra) {
  const oauth = pub._baseOauthParams(cfg.);
  oauth. = tok.oauthToken;
  const sig = pub._sign(method, url, oauth, extra, cfg., tok.oauthTokenSecret);
  return pub._authHeader(oauth, sig);
}

(async () => {
  const toks = ds.list('', { limit: 999 }).items.filter((t) => t && t.blogName);
  const tok = toks.find((t) => String(t.id) === ACC) || toks[0];
  console.log(`账号 ${tok.id} / blogName=${tok.blogName}\n`);

  // [1] 取当前 title / name
  let title = null, name = null;
  {
    const url = 'https://api.tumblr.com/v2/user/info';
    const r = await fetchExt(url, { method: 'GET', headers: { : sign('GET', url, tok, {}) } });
    const j = await r.json();
    const blogs = (j.response && j.response.user && j.response.user.blogs) || [];
    const b = blogs.find((x) => x.name === tok.blogName) || blogs[0];
    title = b && b.title; name = b && b.name;
    console.log(`[1] 当前 primary blog: name=${name} | title=${JSON.stringify(title)} | 共 ${blogs.length} 个博客`);
    blogs.forEach((x, i) => console.log(`      #${i} name=${x.name} admin=${x.admin} title=${JSON.stringify(x.title)}`));
  }

  const url = `https://api.tumblr.com/v2/blog/${encodeURIComponent(tok.blogName)}/settings`;
  const post = async (label, extra) => {
    const r = await fetchExt(url, {
      method: 'POST',
      headers: { : sign('POST', url, tok, extra), '': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(extra),
    });
    const t = await r.text().catch(() => '');
    console.log(`\n[${label}] body=${JSON.stringify(extra)}`);
    console.log(`    HTTP ${r.status}  ${String(t).slice(0, 260)}`);
    return r.status;
  };

  // [2] 用当前 title 原值回写 —— 只探「字段是否被接受」，不改值
  if (title != null) await post('2 title 原值回写', { title });
  else console.log('\n[2] 跳过：未取到 title');

  // [3] 用当前 name 原值回写 —— 判定 name 字段是否可改
  await post('3 name 原值回写', { name: tok.blogName });

  // [4] 对照：故意缺参数（空请求）—— 与 [2]/[3] 对比
  await post('4 空请求对照', {});
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
