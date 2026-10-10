'use strict';
/**
 * tumblr-recover-token.js — 为「已注册但缺 OAuth token」的遗留账号补授权
 * -----------------------------------------------------------------
 * 适用场景：账号已被 Tumblr 真实创建（落库 status=unverified / token=MISSING），
 *           但因历史 bug（OAuth 握手未走代理）没拿到 oauth_token，无法发布。
 *
 * 流程：用 ShardX 指纹浏览器登入该账号 → 跑标准 OAuth 三步握手
 *       （beginAuth -> 浏览器点 Allow -> completeAuth）-> 落库 token。
 *
 * 用法：
 *   node tumblr-recover-token.js tumblr_plqbwutg
 *   node tumblr-recover-token.js            # 默认 tumblr_plqbwutg
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { TumblrPublisher } = require('./tumblr-publisher.js');
const { decryptPassword } = require('./account-crypto');
const { DataStore } = require('./data-store.js');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const API = 'http://127.0.0.1:40325';
const CALLBACK_URL = 'http://localhost:3122/callback';
const ACCOUNTS = path.join(WS, 'data', 'accounts.json');
const OUT_PROXY = 'http://127.0.0.1:10808';
process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
// [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
const dataStore = new DataStore(path.join(WS, 'data'));

const log = (m, pfx = '') => console.log(pfx + m);

process.env.HTTP_PROXY = process.env.HTTP_PROXY || OUT_PROXY;
process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || OUT_PROXY;
process.env.NO_PROXY = process.env.NO_PROXY || '127.0.0.1,localhost';

const TOKEN = fs.readFileSync(path.join(WS, '_shardx_token.txt'), 'utf8').trim();
const SHX_HDR = { Authorization: 'Bearer ' + TOKEN };

async function shx(pathname, opts = {}) {
  const r = await fetch(API + pathname, {
    ...opts,
    headers: { 'content-type': 'application/json', ...SHX_HDR },
    signal: AbortSignal.timeout(60000),
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error('ShardX ' + pathname + ' HTTP ' + r.status + ' ' + txt.slice(0, 200));
  try { return JSON.parse(txt); } catch (_) { return txt; }
}

// ---------- OAuth 本地回调服务器（与注册脚本一致）----------
const http = require('http');
function startCallbackServer(port) {
  return new Promise((resolve) => {
    let resolveVerifier;
    const verifierPromise = new Promise((res) => { resolveVerifier = res; });
    let listenErr = null;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const verifier = u.searchParams.get('oauth_verifier');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('OK - Tumblr callback captured. This window can be closed.');
      resolveVerifier({ verifier, token: u.searchParams.get('oauth_token') });
    });
    server.on('error', (e) => { listenErr = e.message; resolveVerifier({ verifier: null, token: null, err: e.message }); });
    server.listen(port, '127.0.0.1', () => resolve({ server, verifierPromise, getListenError: () => listenErr }));
  });
}

// ---------- 登入已有账号 ----------
async function loginWithShardX(page, email, pw) {
  log('  goto /login');
  const gr = await page.goto('https://www.tumblr.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('    HTTP ' + (gr ? gr.status() : 'ERR') + ' final=' + page.url().slice(0, 70));
  await page.waitForSelector('input[name=email]', { timeout: 30000 });

  log('  填 email=' + email + ' / password');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.waitForTimeout(600);

  log('  点登录 (button[type=submit])');
  await page.click('button[type=submit]');
  await page.waitForTimeout(6000);

  const after = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    body: (document.body ? document.body.innerText : '').slice(0, 240).replace(/\s+/g, ' '),
    btns: Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim() + (b.disabled ? '(d)' : '')).slice(0, 10),
  }));
  log('  登录后 url=' + after.url.slice(0, 80));
  log('  登录后 body=' + after.body.slice(0, 160));

  // 判定是否登录成功：仪表盘 / 出现发帖入口 / 不再停留在 /login
  const loggedIn = !/tumblr\.com\/login/.test(after.url) && !/log in/i.test(after.body.slice(0, 40));
  if (!loggedIn) {
    // 可能是邮箱验证拦截、人机验证、或密码错。返回现场供诊断。
    return { ok: false, url: after.url, body: after.body, btns: after.btns };
  }
  return { ok: true };
}

// ---------- OAuth 授权（复用注册脚本逻辑）----------
async function oauthInPage(page, accountId, appIdx) {
  const publisher = new TumblrPublisher(dataStore);
  let apps = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(WS, 'tumblr_apps.json'), 'utf8'));
    if (Array.isArray(raw)) apps = raw.filter(a => a && a.consumerKey && a.consumerSecret);
  } catch (e) {}
  if (apps.length) {
    const app = apps[appIdx % apps.length];
    publisher.consumerKey = app.consumerKey;
    publisher.consumerSecret = app.consumerSecret;
    log('  OAuth App: ' + (app.label || app.consumerKey.slice(0, 8)) + '...');
  }

  const cb = await startCallbackServer(3122 + (appIdx % 40));
  let capturedFromRequest = null;
  const onReq = (req) => {
    const u = req.url();
    const hit = u.indexOf('3122/callback') >= 0 || u.indexOf('localhost:3122') >= 0;
    if (!hit) return;
    try {
      const q = u.split('oauth_verifier=')[1];
      if (q) capturedFromRequest = decodeURIComponent(q.split('&')[0]);
    } catch (_) {}
  };
  page.on('request', onReq);
  try {
    const beginRes = await publisher.beginAuth(accountId, CALLBACK_URL);
    const authorizeUrl = beginRes.authorizeUrl;
    log('  beginAuth ok -> ' + authorizeUrl.slice(0, 90) + '...');
    await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    const clicked = await page.evaluate(() => {
      const allowWords = ['allow', 'authorize', 'approve', '授权', '允许'];
      const els = document.querySelectorAll('button, a');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.offsetParent === null) continue;
        const txt = (el.textContent || '').trim().toLowerCase();
        let matched = false;
        for (let w = 0; w < allowWords.length; w++) {
          if (txt.indexOf(allowWords[w]) >= 0) { matched = true; break; }
        }
        if (matched) { el.click(); return el.textContent.trim().slice(0, 20); }
      }
      const subs = document.querySelectorAll('button[type=submit]');
      for (let i = 0; i < subs.length; i++) {
        if (!subs[i].disabled) { subs[i].click(); return 'submit=' + subs[i].textContent.trim().slice(0, 20); }
      }
      return null;
    });
    log('  授权点击: ' + clicked);

    const timeoutP = new Promise((r) => setTimeout(() => r({ verifier: null, source: 'timeout' }), 35000));
    const serverP = cb.verifierPromise.then((r) => { r.source = 'server'; return r; });
    const cbRes = await Promise.race([serverP, timeoutP]);
    let verifier = cbRes.verifier || capturedFromRequest;
    if (!verifier) {
      const m = page.url().split('oauth_verifier=')[1];
      if (m) verifier = m.split('&')[0];
    }
    if (!verifier) {
      log('  未拿到 verifier (src=' + cbRes.source + ', req=' + !!capturedFromRequest + ', url=' + page.url().slice(0, 70) + ')', '❌ ');
      return null;
    }
    log('  verifier 来源: ' + ((capturedFromRequest && !cbRes.verifier) ? 'request-intercept' : (cbRes.source || 'url-fallback')));
    const res = await publisher.completeAuth(verifier, accountId);
    log('  completeAuth: ' + JSON.stringify(res).slice(0, 160));
    return dataStore.get('tumblr_token', accountId) || res;
  } finally {
    page.off('request', onReq);
    cb.server.close();
  }
}

// ---------- 主流程 ----------
(async () => {
  const accountId = process.argv[2] || 'tumblr_plqbwutg';
  log('===== 回收 OAuth token: ' + accountId + ' =====');

  // 1. 取账号凭据
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
  const acc = arr.find(a => a.id === accountId);
  if (!acc) { console.error('❌ 账号不存在: ' + accountId); process.exit(2); }
  const email = acc.email;
  const pw = decryptPassword(acc.password);
  const blogName = acc.blog_name;
  if (!pw) { console.error('❌ 密码解密失败（密钥不匹配？）'); process.exit(2); }
  log('  email=' + email + ' blog=' + blogName + ' status=' + acc.status);

  // 2. ShardX 前置自检
  const h = await shx('/health');
  log('  ShardX: ' + h.name + ' v' + h.version + ' ok=' + h.ok);

  // 3. 建临时 profile（新指纹）
  let profile = null;
  try {
    profile = await shx('/profiles/temporary', {
      method: 'POST',
      body: JSON.stringify({ name: 'recover-' + accountId, proxy: OUT_PROXY, platform: 'Windows', folder: '' }),
    });
  } catch (e) { log('  临时 profile 失败，回退 running: ' + e.message, '⚠️ '); }
  if (profile && profile.id) log('  profile=' + profile.id);

  let ws;
  if (profile && profile.id) {
    const st = await shx('/profiles/' + profile.id + '/start', { method: 'POST', body: '{}' });
    ws = (st && st.cdp && st.cdp.web_socket_debugger_url) || (st && st.web_socket_debugger_url);
  }
  if (!ws) {
    const running = await shx('/running');
    if (!running.length) throw new Error('没有可用浏览器');
    ws = running[0].cdp.web_socket_debugger_url;
  }
  log('  CDP ws=' + ws);

  let browser = null;
  try {
    browser = await chromium.connectOverCDP(ws, { timeout: 30000 });
    const ctx = browser.contexts()[0] || await browser.newContext({ locale: 'en-US' });
    const page = await ctx.newPage();

    // 4. 登录
    const login = await loginWithShardX(page, email, pw);
    if (!login.ok) {
      log('  ❌ 登录失败（可能邮箱未验证/人机验证/密码错）。现场 url=' + login.url, '❌ ');
      log('     body=' + (login.body || '').slice(0, 200), '❌ ');
      process.exit(3);
    }
    log('  ✅ 登录成功');

    // 5. OAuth 授权
    const tok = await oauthInPage(page, accountId, 0).catch(e => { log('  OAuth 异常: ' + e.message, '⚠️ '); return null; });
    if (tok && tok.oauthToken) {
      log('  ✅ token 已落库: ' + accountId + ' blog=' + (tok.blogName || blogName), '✅ ');
      // 同步把账号状态从 unverified 提升（仅标记有 token，不改 email 验证事实）
      acc.status = 'active';
      fs.writeFileSync(ACCOUNTS, JSON.stringify(arr, null, 2), 'utf8');
      log('  📝 accounts.json status -> active');
      process.exit(0);
    } else {
      log('  ❌ 未拿到 token', '❌ ');
      process.exit(4);
    }
  } catch (e) {
    log('  ❌ 流程异常: ' + e.message, '❌ ');
    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    if (profile && profile.id) {
      await shx('/profiles/' + profile.id + '/stop', { method: 'POST', body: '{}' }).catch(() => {});
    }
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
