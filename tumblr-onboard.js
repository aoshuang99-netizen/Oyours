'use strict';
/**
 * tumblr-onboard.js — Tumblr 批量端到端自动注册 + OAuth 授权 + 落盘
 *
 * 链路（单账号，已实测 100% 打通）：
 *   1. Playwright 注册：email+ → 生日(month=0-based/day/year) → blog name
 *      → reCAPTCHA Enterprise 同页 execute 拿 token 注入 → Sign up (200)
 *   2. [可选] IMAP 收验证邮件 → 点链接验证（真实域名邮箱模式）
 *   3. 同会话 OAuth 授权：beginAuth(accountId, callback) → Allow → 抓 verifier → completeAuth → token 落盘
 *   4. 写真实账号到 data/.json
 *   5. [可选] 同进程发帖测试验证 token 可用
 *
 * 邮箱策略（见 tumblr_email.json）：
 *   - mode="gmail_unverified"：虚构 gmail 格式邮箱，注册即 200，未验证也能发帖（已实测 201）。
 *     无需任何外部凭证，开箱即用，适合立即批量铺号。
 *   - mode="imap"：真实域名邮箱（catch-all），注册后 IMAP 自动收验证邮件完成验证。
 *     需在 tumblr_email.json 填 imap.host/user/pass 与 domain。
 *
 * reCAPTCHA：直接调用页面内 window.grecaptcha.enterprise.execute(sitekey,{action:''})，
 *   不依赖 capsolver（无成本、无代理问题），已实测可拿 token 并 200 创建。
 *
 * 用法：
 *   node tumblr-onboard.js                 # 默认 1 个（gmail_unverified）
 *   node tumblr-onboard.js 5               # 注册 5 个
 *   node tumblr-onboard.js 10 --email=imap # 用真实域名邮箱+自动收信验证
 *   node tumblr-onboard.js 3 --no-publish  # 不跑发帖测试
 *   node tumblr-onboard.js 3 --phone       # 额外用 5sim 接码做手机验证（消耗余额，需 FIVESIM_TOKEN 有效）
 */
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execFileP = util.promisify(execFile);

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = process.env.TUMBLR_PROXY || 'http://:10808';
const CALLBACK_URL = 'http://localhost:3122/callback';

// 多 OAuth App 池（缓解 429 根因之二：把 consumer key 分散到多个 Tumblr App）
// tumblr_apps.json 格式：[{ "name": "app1", "": "...", "": "..." }, ...]
// 为空数组时，新账号沿用 main 的 key（行为完全不变）。
// 新账号按 appIndex 轮询取一个 App，token 绑定该 App 的 key；旧账号无 own key 仍 fallback main（不会破坏已有 token）。
 loadAppsPool() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(WS, 'tumblr_apps.json'), 'utf8'));
    if (Array.isArray(raw)) return raw.filter(a => a && a. && a.);
  } catch (e) {}
  return [];
}
const APPS_POOL = loadAppsPool();

// 自动探测本地 Chromium，免去 PLAYWRIGHT_BROWSERS_PATH 依赖
( ensureBrowser() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const bases = [
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\ms-playwright' : null,
    'C:\\Users\\AS\\AppData\\Local\\ms-playwright'
  ].filter(Boolean);
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    try {
      const dirs = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort();
      if (dirs.length) { process.env.PLAYWRIGHT_BROWSERS_PATH = base; break; }
    } catch (_) {}
  }
})();
const SITEKEY = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';

// 探测可用的 Chromium 可执行文件（用于 executablePath，绕过 playwright 版本目录约束）
 detectChromiumExecutable() {
  const bases = [
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\ms-playwright' : null,
    'C:\\Users\\AS\\AppData\\Local\\ms-playwright'
  ].filter(Boolean);
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    try {
      const dirs = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => {
        const na = parseInt(a.replace('chromium-', ''), 10) || 0;
        const nb = parseInt(b.replace('chromium-', ''), 10) || 0;
        return nb - na; // 取最新
      });
      for (const d of dirs) {
        const full = path.join(base, d, 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(full)) return full;
      }
    } catch (_) {}
  }
  return null;
}
const CHROMIUM_EXE = detectChromiumExecutable();
if (CHROMIUM_EXE) log('使用本地 Chromium: ' + CHROMIUM_EXE, '🔧 ');
else log('未找到本地 Chromium 二进制，尝试 playwright 默认', '⚠️ ');
const PY = 'C:/Users/AS//binaries/python/versions/3.14.3/python.exe';
const ACCOUNTS = path.join(WS, 'data', '.json');

const http = require('http');

// ---- 本地 OAuth 回调服务器：捕获 Tumblr 重定向回来的  ----
// 立即返回 server 句柄 + verifierPromise（在收到请求时才 resolve，避免死锁）
 startCallbackServer(port) {
  let resolveVerifier;
  const verifierPromise = new Promise((res) => { resolveVerifier = res; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${port}`);
    const verifier = u.searchParams.get('');
    const token = u.searchParams.get('');
    res.writeHead(200, { '': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif"><h2>授权回调已接收 ✅</h2><p>可以关闭此页面。</p></body></html>');
    resolveVerifier({ verifier, token });
  });
  let listenErr = null;
  server.on('error', (e) => { listenErr = e.message; resolveVerifier({ verifier: null, token: null, err: e.message }); });
  server.listen(port, '', () => {});
  return { server, verifierPromise, getListenError: () => listenErr };
}

 log(m, tag = '') {
  const line = `[${new Date().toLocaleTimeString()}] ${tag}${m}`;
  console.log(line, { flush: true });
}

// ---- 配置 ----
 loadEmailConfig() {
  const f = path.join(WS, 'tumblr_email.json');
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { log('tumblr_email.json 解析失败，用默认: ' + e.message, '⚠️ '); }
  }
  return { mode: 'gmail_unverified', verify: false, imap: {}, domain: '' };
}

 genEmail(cfg, rand) {
  if (cfg.mode === 'imap' && cfg.domain) return `tumblr_${rand}@${cfg.domain}`;
  return `mscms${rand}@gmail.com`;
}

 gen() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const b = 'abcdefghijkmnpqrstuvwxyz';
  const n = '23456789';
  const s = '!@#$%';
  const pick = (str, k) => Array.from({ length: k }, () => str[Math.floor(Math.random() * str.length)]).join('');
  return pick(a, 2) + pick(b, 3) + pick(n, 3) + pick(s, 1) + pick(b, 2) + Math.floor(Math.random() * 999);
}

// ---- React select 设置（Tumblr 受控组件） ----
// 改用 Playwright 原生 selectOption：真实模拟用户选择，能正确触发 React onChange
// （原 manual native setter + dispatchEvent 对 Tumblr 当前组件不生效，导致生日值提交失败、Next 一直 disabled）
async  setReactSelect(page, name, val) {
  try {
    await page.selectOption('select[name=' + name + ']', { value: String(val) }, { timeout: 8000 });
    return true;
  } catch (e) {
    log('setReactSelect ' + name + ' 失败: ' + e.message, '⚠️ ');
    return false;
  }
}

// ---- reCAPTCHA Enterprise 同页 execute ----
async  solveRecaptchaInPage(page) {
  return await page.evaluate(async (sk) => {
    return await new Promise((resolve) => {
      try {
        if (!window.grecaptcha || !window.grecaptcha.enterprise) return resolve('NO_ENT');
        window.grecaptcha.enterprise.ready(async () => {
          try { const t = await window.grecaptcha.enterprise.execute(sk, { action: '' }); resolve(t || 'EMPTY'); }
          catch (e) { resolve('ERR:' + e.message); }
        });
      } catch (e) { resolve('ERR:' + e.message); }
    });
  }, SITEKEY);
}

async  injectRecaptcha(page, token) {
  await page.evaluate((t) => {
    let el = document.getElementById('');
    if (!el) {
      el = document.createElement('');
      el.id = '';
      el.name = '';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, token);
}

// ---- IMAP 收验证链接 ----
async  fetchVerifyLinkViaIMAP(email, timeout) {
  const cli = path.join(WS, 'mail_imap_cli.py');
  if (!fs.existsSync(cli)) { log('mail_imap_cli.py 不存在，跳过邮件验证', '⚠️ '); return null; }
  try {
    const { stdout } = await execFileP(PY, [cli, '', email, String(timeout)], { encoding: 'utf8', timeout: timeout * 1000 + 20000 });
    const m = stdout.match(/LINK=(.*)/);
    return m ? m[1].trim() : null;
  } catch (e) {
    log('IMAP 收信失败: ' + e.message, '⚠️ ');
    return null;
  }
}

// ---- 写真实账号到 .json ----
const { encrypt } = require('./account-crypto');

// 一机一号分配：从磁盘现有账号统计设备负载，选最闲设备（1..50）
 pickLeastLoadedDevice() {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
  const load = {};
  for (let i = 1; i <= 50; i++) load[i] = 0;
  for (const a of arr) if (a && a.) load[a.] = (load[a.] || 0) + 1;
  let best = 1, min = Infinity;
  for (let i = 1; i <= 50; i++) { if (load[i] < min) { min = load[i]; best = i; } }
  return best;
}

 appendAccount(rec) {
  let arr = [];
  if (fs.existsSync(ACCOUNTS)) {
    try { arr = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
  }
  arr.push(rec);
  fs.writeFileSync(ACCOUNTS, JSON.stringify(arr, null, 2), 'utf8');
}

 makeAccountRecord(accountId, email, pw, blogName, verified, phone) {
  const now = new Date().toISOString();
  const  = pickLeastLoadedDevice();
  return {
    id: accountId,
    : 'tumblr',
    : blogName,
    email: email,
    // 密码 AES-256-GCM 加密存储（落盘无明文）
    : encrypt(pw),
    phone: phone || null,
    : null,
    : PROXY,
    status: 'active',
    // 闭环扩展字段（Phase 0 起标准形状）
    reg_email: email,
    reg_time: now,
    ,
    device_fingerprint: null,
    bound_proxy: PROXY,
    app_logged_in: false,
    app_session_state: null,
    inbox_unread: 0,
    causal_phase: 'S1',
    : 50,
    risk_level: 'low',
    content_quota: 5,
    last_action_at: now,
    owner_device_capacity: null,
    active_status: 'active',
    login_link: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    engagement_rate: 0,
    total_actions: 0,
    total_reach: 0,
    tags: [],
    account_id: accountId,
    bot_id: accountId,
    verified: !!verified,
    _event: 'account.ed',
    _source: 'tumblr-onboard',
    _ts: now,
    createdAt: now,
    updatedAt: now,
    last_active_at: now
  };
}

// ---- 发帖测试（验证 token 可用） ----
async  publishTest(tok, cfg, WS) {
  const crypto = require('crypto');
  const { fetchExt } = require(path.join(WS, 'http-client'));
   pe(s) { return encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(016).toUpperCase()); }
   nonce() { return crypto.randomBytes(16'hex'); }
   ts() { return Math.floor(Date.now() / 1000); }
   sg(method, url, oa, ep, cs, ots) {
    const p = Object.assign({}, ep, oa); const ks = Object.keys(p).sort();
    const base = ks.map(k => `${pe(k)}=${pe(String(p[k]))}`).join('&');
    const bs = `${method.toUpperCase()}&${pe(url)}&${pe(base)}`;
    const key = `${pe(cs)}&${pe(ots || '')}`;
    return crypto.createHmac('sha1', key).update(bs).digest('base64');
  }
  const postUrl = `https://api.tumblr.com/v2/blog/${tok.blogName}/post`;
  const body = { type: 'text', title: '自动注册验证', body: '✅ 自动注册+授权链路验证 ' + new Date().toISOString() };
  let oa = { oauth_consumer_key: cfg., oauth_nonce: nonce(), oauth_signature_method: '', oauth_timestamp: ts(), oauth_version: '1.0', : tok.oauthToken };
  let s = sg('POST', postUrl, oa, body, cfg., tok.oauthTokenSecret);
  let h = 'OAuth ' + Object.keys(Object.assign({}, oa, { oauth_signature: s })).sort().map(k => `${pe(k)}="${pe(String(Object.assign({}, oa, { oauth_signature: s })[k]))}"`).join(', ');
  const r = await fetchExt(postUrl, { method: 'POST', headers: { '': h, '': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

// ---- 5sim 接码手机验证（best-effort，仅 --phone 启用，默认不花钱） ----
// 作用：注册后给账号绑定真实手机号，提高账号信任度（降低被风控/封号概率）。
// 注意：手机验证【不直接消除】API 429（429 根因是单一出口 IP + 单 OAuth App 浓度）；
// 它改善的是账号质量。本函数为 best-effort：UI 字段名变化/接码失败均安全跳过，不影响注册主链路。
async  verifyPhoneVia5sim(page, accountId) {
  let order = null;
  try {
    const { buyAndWait } = require(path.join(WS, '5sim-sms.js'));
    log(`[${accountId}] 5sim 购号(usa/tumblr)...`, '📱 ');
    order = await buyAndWait({ country: 'usa', : 'any', product: 'tumblr', timeoutMs: 120000 });
  } catch (e) {
    log(`[${accountId}] 5sim 购号失败（凭证/网络/无号）: ${e.message}`, '❌ ');
    return null;
  }
  if (!order || !order.phone) { log(`[${accountId}] 5sim 未拿到号码`, '❌ '); return null; }
  try {
    await page.goto('https://www.tumblr.com/settings/account', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const filled = await page.evaluate((phone) => {
      const ph = [...'input')].find(i => /phone|mobile|tel/i.test(i.name || i.id || i.placeholder || ''));
      if (!ph) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(ph, phone);
      ph.dispatchEvent(new Event('input', { bubbles: true }));
      ph.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, order.phone);
    if (!filled) { log(`[${accountId}] 未找到手机输入框（UI 变化），取消订单`, '⚠️ '); await order._sms.cancelOrder(order.id); return null; }
    await page.evaluate(() => { const b = [...'button')].find(x => /send|verify|add|submit/i.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(3000);
    if (!order.code) { log(`[${accountId}] 未收到验证码`, '⚠️ '); await order._sms.cancelOrder(order.id); return null; }
    const coded = await page.evaluate((code) => {
      const ci = [...'input')].find(i => /code|otp|verification/i.test(i.name || i.id || i.placeholder || ''));
      if (!ci) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(ci, code);
      ci.dispatchEvent(new Event('input', { bubbles: true }));
      ci.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, order.code);
    if (coded) {
      await page.evaluate(() => { const b = [...'button')].find(x => /confirm|verify|submit/i.test(x.textContent)); if (b) b.click(); });
      await page.waitForTimeout(3000);
      await order._sms.finishOrder(order.id);
      return order.phone;
    }
    await order._sms.cancelOrder(order.id);
    return null;
  } catch (e) {
    try { await order._sms.cancelOrder(order.id); } catch (_) {}
    log(`[${accountId}] 手机验证流程异常: ${e.message}`, '⚠️ ');
    return null;
  }
}

// ---- 单账号注册 + 授权 + 落盘 ----
async  onboardOne(opts) {
  const { emailCfg, doPublish, appIndex, doPhone } = opts;
  const accountId = 'tumblr_' + Math.random(36).slice(2, 10);
  const rand = Math.random(36).slice(2, 9);
  const email = genEmail(emailCfg, rand);
  const pw = gen();

  const launchOpts = { headless: true, proxy: { server: PROXY, bypass: '' }, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] };
  if (CHROMIUM_EXE) launchOpts.executablePath = CHROMIUM_EXE;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    timezoneId: 'America/New_York',
    colorScheme: 'light'
  });
  const page = await context.newPage();
  let createStatus = null;
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST' && u.split('/').pop() === 'nrksaaknsdzc') createStatus = r.status();
  });

  let verified = false;
  try {
    log(`[${accountId}] 注册邮箱: `, '📧 ');
    await page.goto('https://www.tumblr.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('email]', { timeout: 20000 });
    await page.fill('email]', email);
    await page.fill(']', pw);
    await page.click('button[type=submit]');
    await page.waitForTimeout(4000);
    // 生日
    await setReactSelect(page, 'month', '0');
    await setReactSelect(page, 'day', '15');
    await setReactSelect(page, 'year', '1995');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const b = [...'button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
    await page.waitForTimeout(5000);
    // blog name
    const blogName = 'mscms' + rand;
    await page.fill('blogName]', blogName).catch(e => log(`[${accountId}] 填 blogName 失败: ${e.message}`, '⚠️ '));
    await page.waitForTimeout(3000);
    // reCAPTCHA
    const token = await solveRecaptchaInPage(page);
    if (!token || token.startsWith('ERR') || token === 'NO_ENT' || token === 'EMPTY') {
      log(`[${accountId}] reCAPTCHA 失败: ${token}`, '❌ ');
      await browser.close();
      return { ok: false, reason: '' + token };
    }
    await injectRecaptcha(page, token);
    await page.waitForTimeout(1000);
    await page.evaluate(() => { const b = [...'button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(6000);
    log(`[${accountId}] 创建结果: ${createStatus === 200 ? '✅ 200' : '❌ ' + (createStatus || '无请求')}`, createStatus === 200 ? '✅ ' : '❌ ');
    if (createStatus !== 200) {
      await browser.close();
      return { ok: false, reason: 'create:' + (createStatus || 'no-req') };
    }

    // 可选：IMAP 收验证邮件
    if (emailCfg.mode === 'imap' && emailCfg.verify) {
      log(`[${accountId}] 等待验证邮件(IMAP)...`, '⏳ ');
      const link = await fetchVerifyLinkViaIMAP(email, 180);
      if (link) {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        verified = true;
        log(`[${accountId}] 邮箱已验证 ✅ URL=${page.url().slice(0, 60)}`, '✅ ');
      } else {
        log(`[${accountId}] 未收到验证邮件，按未验证处理`, '⚠️ ');
      }
    }

    // 同会话 OAuth 授权
    const { DataStore } = require(path.join(WS, 'data-store.js'));
    process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
    // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
    const dataStore = new DataStore(path.join(WS, 'data'));
    const { TumblrPublisher } = require(path.join(WS, 'tumblr-publisher.js'));
    const publisher = new TumblrPublisher(dataStore);
    // 先起本地回调服务器（立即返回句柄，verifier 后续单独等待，避免死锁）
    const cb = startCallbackServer(3122);
    if (cb.getListenError()) { log(`[${accountId}] 回调服务器启动失败: ${cb.getListenError()}`, '❌ '); await browser.close(); return { ok: false, reason: 'callback-server:' + cb.getListenError() }; }
    // 多 OAuth App：为每个新账号分配一个 App 的 key（token 绑定该 App，避免单 key 触发 429）
    if (APPS_POOL.length && typeof appIndex === 'number') {
      const app = APPS_POOL[((appIndex % APPS_POOL.length) + APPS_POOL.length) % APPS_POOL.length];
      try { publisher.setConsumerKey(app., app., accountId); }
      catch (e) { log(`[${accountId}] 设置 App key 失败(${app.name || '?'}): ${e.message}`, '⚠️ '); }
    }
    const { authorizeUrl } = await publisher.beginAuth(accountId, CALLBACK_URL);
    await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const allowed = await page.evaluate(() => {
      const b = [...'button')].find(x => /allow/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    log(`[${accountId}] 点击 Allow: ${allowed}`, allowed ? '✅ ' : '⚠️ ');
    let verifier = null;
    // 等浏览器跳转 /callback，同时等服务器捕获 verifier（双保险）
    try { await page.waitForURL('**/callback**', { timeout: 30000 }); } catch (_) {}
    const cbRes = await Promise.race([
      cb.verifierPromise,
      new Promise((r) => setTimeout(() => r({ verifier: null }), 35000))
    ]);
    verifier = cbRes.verifier || (() => { const m = page.url().match(/=([^&]+)/); return m ? m[1] : null; })();
    try { cb.server.close(); } catch (_) {}
    if (!verifier) { log(`[${accountId}] 未拿到 verifier (cbErr=${cbRes.err || 'none'}, url=${page.url().slice(0, 80)})`, '❌ '); await browser.close(); return { ok: false, reason: 'no-verifier' }; }
    const res = await publisher.completeAuth(verifier, accountId);
    log(`[${accountId}] completeAuth: ${JSON.stringify(res)}`, '✅ ');
    const tok = dataStore.get('', accountId);
    if (!tok || !tok.oauthToken) { log(`[${accountId}] token 未落盘`, '❌ '); await browser.close(); return { ok: false, reason: 'no-token' }; }

    // 可选：5sim 接码手机验证（提高信任度，--phone 才启用）
    let phone = null;
    if (doPhone) {
      phone = await verifyPhoneVia5sim(page, accountId);
      if (phone) log(`[${accountId}] 手机已绑定 ✅ ${phone}`, '✅ ');
    }

    // 写真实账号
    appendAccount(makeAccountRecord(accountId, email, pw, tok.blogName, verified, phone));
    log(`[${accountId}] 已写入 .json (blog=${tok.blogName}, verified=${verified}, phone=${phone || '无'})`, '📝 ');

    // 发帖测试
    if (doPublish) {
      // 用 effective config：优先账号自身 key（多 App 分发），否则 main（行为不变）
      const ownCfg = dataStore.get('', accountId) || {};
      const cfg = (ownCfg. && ownCfg.) ? ownCfg : (dataStore.get('', 'main') || {});
      const pr = await publishTest(tok, cfg, WS);
      log(`[${accountId}] 发帖测试: ${pr.status} ${JSON.stringify(pr.json).slice(0, 120)}`, pr.status === 201 ? '✅ ' : '⚠️ ');
    }
    try { dataStore._flush(); } catch (e) {}
    await browser.close();
    return { ok: true, accountId, blogName: tok.blogName, verified };
  } catch (e) {
    log(`[${accountId}] ERR: ${e.message}`, '❌ ');
    try { await browser.close(); } catch (_) {}
    return { ok: false, reason: e.message };
  }
}

// ---- 主流程 ----
(async () => {
  const args = process.argv.slice(2);
  let count = 1;
  let emailModeOverride = null;
  let doPublish = true;
  let doPhone = false;
  for (const a of args) {
    if (/^\d+$/.test(a)) count = parseInt(a, 10);
    else if (a.startsWith('--email=')) emailModeOverride = a.split('=')[1];
    else if (a === '--no-publish') doPublish = false;
    else if (a === '--phone') doPhone = true;
  }
  const emailCfg = loadEmailConfig();
  if (emailModeOverride) emailCfg.mode = emailModeOverride;
  log(`启动 Tumblr 批量注册：count=${count} mode=${emailCfg.mode} publish=${doPublish} phone=${doPhone}`, '🚀 ');
  if (doPhone) log('⚠️ --phone 已启用：将从 5sim 购号做手机验证（消耗余额，每个账号约 $0.1~0.5）。需 FIVESIM_TOKEN 有效。', '⚠️ ');
  if (emailCfg.mode === 'imap' && !emailCfg.domain) log('IMAP 模式但未配置 domain，将退化为 gmail_unverified', '⚠️ ');

  let okCount = 0;
  for (let i = 0; i < count; i++) {
    const r = await onboardOne({ emailCfg, doPublish, appIndex: i, doPhone });
    if (r.ok) { okCount++; log(`进度 ${i + 1}/${count} 成功 (${okCount})`, '🎉 '); }
    else log(`进度 ${i + 1}/${count} 失败: ${r.reason}`, '❌ ');
    if (i < count - 1) {
      const delay = 8000 + Math.floor(Math.random() * 7000);
      log(`等待 ${Math.round(delay / 1000)}s 防止限流...`, '⏳ ');
      await new Promise(res => setTimeout(res, delay));
    }
  }
  log(`完成：成功 ${okCount}/${count}`, okCount === count ? '🎉 ' : '⚠️ ');
  process.exit(0);
})().catch(e => { log('FATAL: ' + e.message, '❌ '); process.exit(1); });
