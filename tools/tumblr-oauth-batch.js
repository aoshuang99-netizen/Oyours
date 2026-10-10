#!/usr/bin/env node
/**
 * tumblr-oauth-batch.js — Tumblr OAuth1 批量补授权工具
 *
 * 背景（2026-09-10）：
 *   系统已有 111 个账号的 OAuth token，发布走 API 通道已完全打通（实测真实外网链接）。
 *   但 accounts.json 里另有约 20 个 tumblr 账号从未授权 → 发布时被诚实地标记为
 *   NO_OAUTH_TOKEN（早期代码会兜底借他人 token 发到别人 blog，已修）。
 *
 * Tumblr 的 OAuth 是「每个账号必须由用户点一次『允许』」的协议 ——
 * **不存在批量申请 API 的接口**。补齐的唯一路径是用浏览器自动化把这一步跑掉：
 *
 *   beginAuth(accountId, callback) → authorizeUrl
 *   → 浏览器登录该账号 → 打开 authorizeUrl → 点 Allow
 *   → Tumblr 重定向到 http://localhost:3122/callback?oauth_verifier=...
 *   → 本地回调服务器捕获 verifier → completeAuth(verifier, accountId) → token 落库
 *
 * callback 必须与 Tumblr App 后台登记的 redirect URL 完全一致。本项目注册流程
 * （tumblr-onboard.js）用的是 http://localhost:3122/callback，直接复用。
 * 默认的 'oob' 已被 Tumblr 拒绝：400 Disallowed oauth_callback specified。
 *
 * 用法：
 *   node tools/tumblr-oauth-batch.js --dry-run        # 只统计缺口 + 跑 begin，不登录
 *   node tools/tumblr-oauth-batch.js --limit=1        # 只处理 1 个账号（先小样验证）
 *   node tools/tumblr-oauth-batch.js --only=tumblr_xxx
 *
 * 环境变量：
 *   MSCMS_API=http://127.0.0.1:3002        服务地址
 *   MSCMS_RES=D:/MSCMS-Desktop/resources   运行目录（account-crypto / playwright-core）
 *   MSCMS_DATA=D:/mscms-ws/data            数据目录
 *   OAUTH_CALLBACK=http://localhost:3122/callback
 *   OAUTH_BATCH_HEADFUL=1                  显示浏览器（排查用）
 *   OAUTH_BATCH_TIMEOUT_MS=90000
 *
 * 铁律：只写真实拿到的 token；任何失败都如实报错，绝不伪造。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const API = process.env.MSCMS_API || 'http://127.0.0.1:3002';
const RES = process.env.MSCMS_RES || 'D:/MSCMS-Desktop/resources';
const DATA = process.env.MSCMS_DATA || 'D:/mscms-ws/data';
const TIMEOUT_MS = parseInt(process.env.OAUTH_BATCH_TIMEOUT_MS || '90000', 10);
const SHOT_DIR = process.env.MSCMS_TMP_DIR || 'D:/mscms-tmp';
const CB_PORT = parseInt(process.env.OAUTH_CB_PORT || '3122', 10);
const CALLBACK_URL = process.env.OAUTH_CALLBACK || `http://localhost:${CB_PORT}/callback`;
const PROXY = process.env.OAUTH_PROXY || 'http://127.0.0.1:10808';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => {
  const p = args.find((a) => a.startsWith(`--${k}=`));
  return p ? p.slice(k.length + 3) : d;
};
const DRY = has('--dry-run');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ONLY = arg('only', '');

const { decryptPassword } = require(path.join(RES, 'account-crypto.js'));
const log = (...a) => console.log(...a);

async function api(p, body) {
  const r = await fetch(API + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { return { ok: false, error: 'non-json: ' + t.slice(0, 120) }; }
}

const loadJson = (p) => {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : (j.items || j.data || []);
};

/** 本地 OAuth 回调服务器：捕获 Tumblr 重定向回来的 oauth_verifier */
function startCallbackServer(port) {
  let resolveVerifier;
  const verifierPromise = new Promise((res) => { resolveVerifier = res; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${port}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif"><h2>授权回调已接收 ✅</h2><p>可以关闭此页面。</p></body></html>');
    resolveVerifier({ verifier: u.searchParams.get('oauth_verifier'), token: u.searchParams.get('oauth_token') });
  });
  let listenErr = null;
  server.on('error', (e) => { listenErr = e.message; resolveVerifier({ verifier: null, err: e.message }); });
  server.listen(port, '127.0.0.1', () => {});
  return { server, verifierPromise, getListenError: () => listenErr };
}

/** 找出缺 token 的 tumblr 账号 */
function findMissing() {
  const accounts = loadJson(path.join(DATA, 'accounts.json')).filter((a) => a.platform === 'tumblr');
  const tokens = JSON.parse(fs.readFileSync(path.join(DATA, 'tumblr_token.json'), 'utf8'));
  return accounts.filter((a) => {
    const t = tokens[a.id];
    return !(t && t.oauthToken && t.oauthTokenSecret);
  });
}

/** 登录 + 授权，返回 verifier */
async function authorizeViaBrowser(account, authorizeUrl, cb) {
  const { chromium } = require(path.join(RES, 'node_modules', 'playwright-core'));
  const browser = await chromium.launch({
    headless: !process.env.OAUTH_BATCH_HEADFUL,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    proxy: PROXY ? { server: PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = await ctx.newPage();
  const shot = async (tag) => {
    try {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, `oauth-${account.id}-${tag}.png`) });
    } catch (_) {}
  };

  try {
    log('   → 登录');
    await page.goto('https://www.tumblr.com/login', { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForTimeout(4000);

    const password = decryptPassword(account.password);
    if (!password) throw new Error('密码解密失败');

    const emailSel = 'input[name="email"], input[type="email"], input#signup_email, input[name="username"]';
    await page.waitForSelector(emailSel, { timeout: 30000 });
    await page.fill(emailSel, account.email || account.username);

    for (const sel of ['button:has-text("Use password")', 'button:has-text("Continue")', 'button:has-text("Next")']) {
      const el = await page.$(sel);
      if (el) { await el.click().catch(() => {}); await page.waitForTimeout(2500); break; }
    }

    await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 30000 });
    await page.fill('input[name="password"], input[type="password"]', password);
    await shot('filled');

    let submitted = false;
    for (const sel of ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("登录")']) {
      const el = await page.$(sel);
      if (el) { await el.click().catch(() => {}); submitted = true; break; }
    }
    if (!submitted) await page.keyboard.press('Enter');
    await page.waitForTimeout(9000);
    await shot('after-login');

    if (/\/login/i.test(page.url())) {
      const body = (await page.textContent('body').catch(() => '') || '').replace(/\s+/g, ' ').slice(0, 160);
      throw new Error('登录未通过（可能验证码/密码错）: ' + body);
    }
    log('   → 已登录');

    log('   → 授权页');
    await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForTimeout(4500);
    await shot('authorize-page');

    for (const sel of ['button:has-text("Allow")', 'button:has-text("允许")',
      'button:has-text("Authorize")', 'input[value="Allow"]', 'button[type="submit"]']) {
      const el = await page.$(sel);
      if (el) { await el.click().catch(() => {}); break; }
    }
    await page.waitForTimeout(5000);
    await shot('after-allow');

    // 优先等回调服务器；兜底从 URL 抓
    const got = await Promise.race([
      cb.verifierPromise,
      new Promise((res) => setTimeout(() => res({ verifier: null, timeout: true }), 30000)),
    ]);
    if (got && got.verifier) return got.verifier;

    const m = page.url().match(/oauth_verifier=([^&\s]+)/);
    if (m) return decodeURIComponent(m[1]);
    throw new Error('未取得 oauth_verifier（见截图 oauth-' + account.id + '-after-allow.png）');
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

(async () => {
  log('=== Tumblr OAuth 批量补授权 ===');
  log('服务:', API, '| 回调:', CALLBACK_URL, '| 代理:', PROXY);

  let targets = findMissing();
  if (ONLY) targets = targets.filter((a) => a.id === ONLY);
  log(`缺 token 的 tumblr 账号: ${targets.length}`);
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  if (!targets.length) { log('无缺口'); return; }

  let ok = 0, fail = 0;
  for (const [i, acc] of targets.entries()) {
    log(`\n[${i + 1}/${targets.length}] ${acc.id} (${acc.username})`);
    try {
      const begin = await api('/api/v14/tumblr/oauth/begin', { accountId: acc.id, callbackUrl: CALLBACK_URL });
      if (!begin.ok || !begin.authorizeUrl) throw new Error('begin 失败: ' + (begin.error || '').slice(0, 140));
      log('   authorizeUrl OK');
      if (DRY) { ok++; continue; }

      const cb = startCallbackServer(CB_PORT);
      if (cb.getListenError()) throw new Error('回调端口占用: ' + cb.getListenError());

      let verifier;
      try {
        verifier = await authorizeViaBrowser(acc, begin.authorizeUrl, cb);
      } finally {
        cb.server.close();
      }
      log('   verifier:', String(verifier).slice(0, 12) + '…');

      const done = await api('/api/v14/tumblr/oauth/complete', { verifier, accountId: acc.id });
      if (!done.ok) throw new Error('complete 失败: ' + (done.error || '').slice(0, 140));
      log('   ✅ 授权完成');
      ok++;
    } catch (e) {
      log('   ❌ 失败:', e.message.slice(0, 180));
      fail++;
    }
  }

  log(`\n=== 完成：成功 ${ok} / 失败 ${fail} / 共 ${targets.length} ===`);
  if (fail) log('已授权的会跳过，修复后可重跑。');
})();
