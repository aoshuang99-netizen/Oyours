#!/usr/bin/env node
/**
 * Mastodon 官方 token flow 实测（依据 https://docs.joinmastodon.org/client/token/#flow）
 *
 * 该文档页给出的流程是【client_credentials 授权】——无需用户浏览器授权：
 *   1) POST /api/v1/apps            （已做过：app id 8931885）
 *   2) POST /oauth/token  grant_type=client_credentials
 *   3) GET  /api/v1/apps/verify_credentials  ← 注意是 apps 不是 accounts
 *
 * 本脚本只做「取证」：
 *   - 判别 401 的两种可能：① 账号仍在但 token 被撤销 ② 账号/应用已不存在
 *   - 实测 client_credentials 能否换出可用 token、该 token 能做什么
 *   - 生成 authorization_code 流程所需的授权 URL（供人工点选，不自动打开）
 * 不写盘、不改服务配置。
 */

const fs = require('fs');
const path = require('path');
const { fetchExt } = require(path.join(__dirname, '..', 'http-client.js'));

const WS = path.join(__dirname, '..');
const PROXY = 'http://127.0.0.1:10808'; // 实测可用出口（default-relay）
const mask = (v) => { const s = String(v == null ? '' : v); return s ? s.slice(0, 5) + '…(' + s.length + '字符)' : '(空)'; };

const cr = JSON.parse(fs.readFileSync(path.join(WS, 'mastodon-creds.json'), 'utf8'));
const INST = String(cr.instance || '').replace(/\/+$/, '');
const UA = { 'User-Agent': 'MSCMS/1.0' };

async function req(method, url, { headers = {}, body, form } = {}, timeout = 25000) {
  const opts = { method, headers: Object.assign({}, UA, headers), timeout };
  if (form) {
    opts.body = new URLSearchParams(form).toString();
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  try {
    const r = await fetchExt(url, opts, PROXY);
    const txt = await r.text();
    return { status: r.status, txt };
  } catch (e) {
    return { status: 0, txt: 'NETWORK: ' + e.message };
  }
}
const brief = (s) => {
  try { const j = JSON.parse(s); return JSON.stringify(j).slice(0, 260); } catch (_) { return String(s).slice(0, 260); }
};

(async () => {
  console.log('════════ A. 账号是否还存在（公开端点，无需 token） ════════');
  const lk = await req('GET', `${INST}/api/v1/accounts/lookup?acct=${encodeURIComponent(cr.username)}`);
  console.log(`  GET /api/v1/accounts/lookup?acct=${cr.username}  =>  HTTP ${lk.status}`);
  console.log(`    ${brief(lk.txt)}`);
  if (lk.status === 200) {
    try {
      const a = JSON.parse(lk.txt);
      console.log(`    ⇒ 账号仍在：id=${a.id} acct=${a.acct} statuses=${a.statuses_count} followers=${a.followers_count} created=${a.created_at}`);
      console.log(`       最后活跃 last_status_at=${a.last_status_at}`);
    } catch (_) {}
  } else if (lk.status === 404) {
    console.log('    ⇒ 账号已不存在（404）—— 说明 2026-07-18 那次注册已失效');
  }

  console.log('\n════════ B. 应用是否还存在（client_credentials 换 token） ════════');
  const tok = await req('POST', `${INST}/oauth/token`, {
    form: {
      client_id: cr.client_id,
      client_secret: cr.client_secret,
      redirect_uri: cr.redirect_uri,
      grant_type: 'client_credentials',
      scope: 'read write push',
    },
  });
  console.log(`  POST /oauth/token (grant_type=client_credentials)  =>  HTTP ${tok.status}`);
  console.log(`    ${brief(tok.txt)}`);
  let appToken = '';
  if (tok.status === 200) {
    try { appToken = JSON.parse(tok.txt).access_token || ''; } catch (_) {}
    console.log(`    ⇒ 换得 app 级 token: ${mask(appToken)}`);
  } else if (tok.status === 401 || tok.status === 400) {
    console.log('    ⇒ 应用凭据(client_id/secret)已失效 —— 需重新 POST /api/v1/apps 注册应用');
  }

  if (appToken) {
    console.log('\n════════ C. 该 app 级 token 能做什么 ════════');
    const v1 = await req('GET', `${INST}/api/v1/apps/verify_credentials`, { headers: { Authorization: 'Bearer ' + appToken } });
    console.log(`  GET /api/v1/apps/verify_credentials   =>  HTTP ${v1.status}`);
    console.log(`    ${brief(v1.txt)}   ← 文档就是用这个端点验证`);
    const v2 = await req('GET', `${INST}/api/v1/accounts/verify_credentials`, { headers: { Authorization: 'Bearer ' + appToken } });
    console.log(`  GET /api/v1/accounts/verify_credentials =>  HTTP ${v2.status}`);
    console.log(`    ${brief(v2.txt)}   ← 若无用户态，这里会拒绝（app token 不代表任何用户）`);

    console.log('\n════════ C2. 关键判定：app 级 token 能否发帖 ════════');
    const post = await req('POST', `${INST}/api/v1/statuses`, {
      headers: { Authorization: 'Bearer ' + appToken },
      form: { status: 'MSCMS capability probe (will be deleted if created)', visibility: 'private' },
    });
    console.log(`  POST /api/v1/statuses  =>  HTTP ${post.status}`);
    console.log(`    ${brief(post.txt)}`);
    if (post.status === 200) {
      let id = ''; try { id = JSON.parse(post.txt).id; } catch (_) {}
      console.log(`    ⚠️ 竟然创建成功（id=${id}）—— 立即回撤，避免留下测试帖`);
      if (id) {
        const del = await req('DELETE', `${INST}/api/v1/statuses/${id}`, { headers: { Authorization: 'Bearer ' + appToken } });
        console.log(`    DELETE /api/v1/statuses/${id}  =>  HTTP ${del.status}  ${brief(del.txt)}`);
      }
      console.log('    ⇒ 结论：client_credentials 可用于发帖（罕见，Mastodon 通常要求用户态）');
    } else {
      console.log('    ⇒ 结论：app 级 token 【不能】发帖 —— 发帖需要用户态 token（authorization_code 流程）');
    }
  }

  console.log('\n════════ D. authorization_code 流程所需授权 URL（供人工点选） ════════');
  const scope = 'read write push';
  const url = `${INST}/oauth/authorize?` + new URLSearchParams({
    client_id: cr.client_id,
    redirect_uri: cr.redirect_uri,
    response_type: 'code',
    scope,
  }).toString();
  console.log('  ' + url);
  console.log('  （redirect_uri 为 OOB ⇒ 授权后页面会直接显示一段 authorization code，无需回调服务器）');
  console.log('\n（本脚本只读为主：唯一副作用是 B 步在实例上生成一个 app 级 token，未修改任何本地文件）');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
