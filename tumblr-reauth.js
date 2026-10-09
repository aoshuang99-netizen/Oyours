'use strict';
/**
 * tumblr-reauth.js — 6 个「有邮箱密码但 token 丢失」的真实 Tumblr 账户自动重授权
 *
 * 复用：
 *   - tumblr-login-check.js 的登录选择器流程（email → continue →  → login）
 *   - tumblr-onboard.js 的 OAuth 回调服务器 + Allow 点击 + completeAuth 落盘
 *   - tumblr-publisher.js 的 beginAuth/completeAuth（共享 main consumer key）
 *
 * 链路（单账号）：
 *   1. Playwright 用 email+ 登录 tumblr.com/login
 *   2. 同会话 publisher.beginAuth(accountId, callback) → authorizeUrl
 *   3. 跳转 authorizeUrl → 点击 Allow → 捕获 （回调服务器 + page.url 兜底）
 *   4. publisher.completeAuth(verifier, accountId) → token 落盘 dataStore
 *   5. 校验 token 存在 → 关闭浏览器
 *
 * 用法：
 *   node tumblr-reauth.js                 # 自动处理全部「缺 token 且有凭据」的 tumblr 账号
 *   node tumblr-reauth.js tumblr_xxxx     # 只处理指定账号
 *   node tumblr-reauth.js --dry           # 只列出待处理账号，不实际授权
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');
// 解密 .json 中 AES-256-GCM 信封化的密码（落盘无明文）
const { decrypt } = require('./account-crypto');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = process.env.TUMBLR_PROXY || 'http://:10808';
// 确保外部 fetch（publisher 走 http-client）也走代理
if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = PROXY;

// 自动探测本地 Chromium（与 tumblr-onboard.js 同逻辑）
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
        return nb - na;
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
const CALLBACK_URL = 'http://localhost:3122/callback';

 log(m, tag = '') { console.log(`[${new Date().toLocaleTimeString()}] ${tag}${m}`, { flush: true }); }

// ---- 本地 OAuth 回调服务器：捕获 Tumblr 重定向回来的  ----
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

// ---- 登录单个账号（复用 tumblr-login-check.js 选择器） ----
async  loginOnePage(page, account) {
  let result = { ok: false, stage: 'start', url: '' };
  try {
    await page.goto('https://www.tumblr.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const emailSel = 'email], email], input#email';
    await page.waitForSelector(emailSel, { timeout: 15000 }).catch(() => {});
    await page.fill(emailSel, account.email).catch(e => { result.stage = 'fill-email:' + e.message; });
    await page.waitForTimeout(800);
    const continueBtn = await page.evaluate(() => {
      const b = [...'button')].find(x => /continue|next|下一步|继续/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    if (continueBtn) { await page.waitForTimeout(2000); }
    const pwSel = '], ], input#';
    await page.waitForSelector(pwSel, { timeout: 15000 }).catch(() => {});
    await page.fill(pwSel, decrypt(account.)).catch(e => { result.stage = '' + e.message; });
    await page.waitForTimeout(800);
    const loginBtn = await page.evaluate(() => {
      const b = [...'button')].find(x => /log ?in|sign ?in|登录|登入/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!loginBtn) { result.stage = 'no-login-btn'; return result; }
    await page.waitForTimeout(6000);
    result.url = page.url();
    result.ok = await page.evaluate(() => {
      const u = location.href;
      if (u.includes('/dashboard') || u.includes('/timeline')) return true;
      const txt = document.body.innerText.toLowerCase();
      if (txt.includes('log out') || txt.includes('your blog') || txt.includes('dashboard')) return true;
      return false;
    });
    result.stage = result.ok ? 'logged-in' : 'unknown-state';
  } catch (e) {
    result.stage = 'err:' + e.message;
  }
  return result;
}

// ---- 单账号重授权 ----
async  reauthAccount(publisher, account) {
  const accountId = account.id;
  const launchOpts = { headless: true, proxy: { server: PROXY, bypass: '' }, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (CHROMIUM_EXE) launchOpts.executablePath = CHROMIUM_EXE;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();

  try {
    log(`[${accountId}] 登录中 email=${account.email}`, '🔐 ');
    const login = await loginOnePage(page, account);
    if (!login.ok) {
      await browser.close();
      return { accountId, ok: false, reason: 'login:' + login.stage };
    }
    log(`[${accountId}] 登录成功 ✅ (${login.url.slice(0, 60)})`, '✅ ');

    // 起回调服务器（立即返回句柄，verifier 后续单独等，避免死锁）
    const cb = startCallbackServer(3122);
    if (cb.getListenError()) {
      await browser.close();
      return { accountId, ok: false, reason: 'callback-server:' + cb.getListenError() };
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
    try { await page.waitForURL('**/callback**', { timeout: 30000 }); } catch (_) {}
    const cbRes = await Promise.race([
      cb.verifierPromise,
      new Promise((r) => setTimeout(() => r({ verifier: null }), 35000))
    ]);
    let verifier = cbRes.verifier;
    if (!verifier) {
      const m = page.url().match(/=([^&]+)/);
      verifier = m ? m[1] : null;
    }
    try { cb.server.close(); } catch (_) {}
    if (!verifier) {
      await browser.close();
      return { accountId, ok: false, reason: 'no-verifier' };
    }
    const res = await publisher.completeAuth(verifier, accountId);
    log(`[${accountId}] completeAuth: ${JSON.stringify(res)}`, '✅ ');
    await browser.close();
    return { accountId, ok: true, blogName: res.blogName };
  } catch (e) {
    try { await browser.close(); } catch (_) {}
    return { accountId, ok: false, reason: e.message };
  }
}

// ---- 发现待处理账号 ----
 findTargets(dataStore, idArg) {
  const accts = dataStore.list('', { filter: { : 'tumblr' }, limit: 100 }).items;
  const toks = dataStore.list('', { limit: 100 }).items;
  const tokIds = new Set(toks.filter(t => t.oauthToken).map(t => t.id));
  let targets = accts.filter(a => a.email && a. && !tokIds.has(a.id));
  if (idArg) targets = targets.filter(a => a.id === idArg);
  return targets;
}

async  main() {
  const args = process.argv.slice(2);
  const idArg = args.find(a => a.startsWith('tumblr_'));
  const dry = args.includes('--dry');

  const { DataStore } = require('./data-store.js');
  const { TumblrPublisher } = require('./tumblr-publisher.js');
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(path.join(WS, 'data'));
  const publisher = new TumblrPublisher(dataStore);

  const targets = findTargets(dataStore, idArg);
  log(`待重授权账号 ${targets.length} 个${dry ? '（DRY 模式）' : ''}: ` + (targets.map(t => t.id).join(', ') || '无'), '🎯 ');
  if (!targets.length) { process.exit(0); }
  if (dry) { process.exit(0); }

  let okCount = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = await reauthAccount(publisher, targets[i]);
    if (r.ok) {
      okCount++;
      // 校验落盘
      const tok = dataStore.get('', r.accountId);
      const saved = !!(tok && tok.oauthToken);
      log(`[${r.accountId}] 重授权成功 ✅ blog=${r.blogName || '?'} 落盘=${saved}`, '🎉 ');
    } else {
      log(`[${targets[i].id}] 重授权失败: ${r.reason}`, '❌ ');
    }
    if (i < targets.length - 1) {
      const delay = 8000 + Math.floor(Math.random() * 7000);
      log(`等待 ${Math.round(delay / 1000)}s 防限流...`, '⏳ ');
      await new Promise(res => setTimeout(res, delay));
    }
  }
  log(`重授权完成：成功 ${okCount}/${targets.length}`, okCount === targets.length ? '🎉 ' : '⚠️ ');
  process.exit(0);
}

module.exports = { reauthAccount, findTargets, loginOnePage };

if (require.main === module) {
  main().catch(e => { log('FATAL: ' + e.message, '❌ '); process.exit(1); });
}
