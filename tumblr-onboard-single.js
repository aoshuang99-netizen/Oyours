'use strict';
/**
 * tumblr-onboard-single.js — Tumblr 单账号端到端自动注册+邮箱验证+授权
 *
 * 链路：mail.tm 申请邮箱 → Playwright 注册(email/pw→生日→blog name→capsolver V3→Sign up)
 *       → mail.tm 收验证邮件 → 点链接验证 → 同会话 OAuth 授权(beginAuth→Allow→verifier→completeAuth)
 *       → 写回 .json + .json
 *
 * 关键依赖：
 *   -         (mail.tm 桥接，经 10808 代理)
 *   - capsolver_cli.py     (capsolver 桥接，直连)
 *   - tumblr-publisher.js  (多账号 OAuth 授权，已改造支持 accountId)
 */
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const http = require('http');
const execFileP = util.promisify(execFile);

const PY = 'C:/Users/AS//binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = 'http://:10808';
const CALLBACK_PORT = 3122;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;

const LOG_FILE = path.join(WS, '_onboard_single.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
 log(m, tag = '') {
  const line = `[${new Date().toLocaleTimeString()}] ${tag}${m}`;
  console.log(line, { flush: true });
  logStream.write(line + '\n');
}

const TumblrPublisher = require(path.join(WS, 'tumblr-publisher.js'));
const { DataStore } = require(path.join(WS, 'data-store.js'));

// ---- 子进程桥接 ----
async  mailtmCreate() {
  const { stdout } = await execFileP(PY, [path.join(WS, ''), 'create'], { encoding: 'utf8', timeout: 30000 });
  const addr = (stdout.match(/ADDR=(.*)/) || [])[1];
  const pass = (stdout.match(/PASS=(.*)/) || [])[1];
  return { address: (addr || '').trim(), : (pass || '').trim() };
}
async  mailtmWaitLink(address, , host, timeout = 180) {
  const { stdout } = await execFileP(PY, [path.join(WS, ''), '', address, , host, String(timeout)], { encoding: 'utf8', timeout: timeout * 1000 + 20000 });
  const m = stdout.match(/LINK=(.*)/);
  return m ? m[1].trim() : null;
}
async  capsolverSolve(taskType, url, sitekey, extra) {
  const args = [path.join(WS, 'capsolver_cli.py'), 'solve', taskType, url, sitekey];
  if (extra) args.push(JSON.stringify(extra));
  const { stdout } = await execFileP(PY, args, { encoding: 'utf8', timeout: 200000 });
  const m = stdout.match(/TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

// ---- React select 设置 ----
async  setReactSelect(page, name, val) {
  await page.evaluate((a) => {
    const sel = document.querySelector('select[name=' + a.name + ']');
    if (!sel) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    nativeSetter.call(sel, a.val);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  }, { name, val });
}

// ---- 本地 callback 服务器收 verifier ----
 startCallbackServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/callback') {
        const verifier = u.searchParams.get('');
        const oauthToken = u.searchParams.get('');
        res.writeHead(200, { '': 'text/html' });
        res.end('<html><body><h2>Tumblr 授权完成 ✅</h2><p>可关闭此页面。</p></body></html>');
        server.close();
        resolve({ verifier, oauthToken });
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    server.listen(CALLBACK_PORT, '', () => resolve(server));
  });
}

async  waitForCallback(server, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('callback 超时')), timeout);
    const origResolve = server.__resolve;
    // 包装：startCallbackServer 的 resolve 在第一次请求时触发，这里等它
    server.once('callback', (data) => { clearTimeout(timer); resolve(data); });
  });
}

(async () => {
  const accountId = 't_' + Math.random(36).slice(2, 10);
  log('开始单账号端到端注册: ' + accountId, '🚀 ');

  // 1. 申请 mail.tm 邮箱
  const mb = await mailtmCreate();
  if (!mb.address) { log('mail.tm 创建失败', '❌ '); process.exit(1); }
  log('邮箱: ' + mb.address, '📧 ');
  const pw = 'Aa1' + Math.random(36).slice(2, 10) + '!';

  // 2. Playwright 注册
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  page.on('response', async (r) => {
    if (r.url().includes('/api/v2/user/validate')) {
      try { const j = await r.json(); if (j.response && j.response.userErrors) log('validate err: ' + JSON.stringify(j.response.userErrors)); } catch (e) {}
    }
  });

  try {
    await page.goto('https://www.tumblr.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('email]', mb.address);
    await page.fill(']', pw);
    await page.click('button[type=submit]');
    await page.waitForTimeout(4000);

    // 生日页
    await setReactSelect(page, 'month', '0');
    await setReactSelect(page, 'day', '15');
    await setReactSelect(page, 'year', '1995');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const b = [...'button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
    await page.waitForTimeout(5000);
    log('进入 blog 页? URL=' + page.url(), '📝 ');

    // blog name 页
    const blogName = 'mscms' + Math.random(36).slice(2, 9);
    await page.fill('blogName]', blogName).catch(e => log('填 blogName 失败: ' + e.message));
    await page.waitForTimeout(1000);

    // 解 reCAPTCHA V3 并注入
    log('解 reCAPTCHA V3 ...', '🔧 ');
    const sitekey = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';
    const token = await capsolverSolve('', 'https://www.tumblr.com/', sitekey, { pageAction: '' });
    if (!token) { log('reCAPTCHA 解失败', '❌ '); await browser.close(); process.exit(1); }
    log('reCAPTCHA token 已获取', '✅ ');
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
      // 触发可能的 onChange
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, token);
    await page.waitForTimeout(1000);

    // 提交 Sign up
    await page.evaluate(() => { const b = [...'button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); }).catch(() => {});
    await page.waitForTimeout(8000);
    log('Sign up 后 URL: ' + page.url(), '📝 ');
    const afterText = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' ').slice(0, 300);
    log('Sign up 后文本: ' + afterText, '📝 ');

    // 3. 等待并点击验证邮件
    log('等待 Tumblr 验证邮件 (mail.tm)...', '⏳ ');
    const link = await mailtmWaitLink(mb.address, mb., 'tumblr.com', 150);
    if (!link) { log('未收到验证邮件', '❌ '); await browser.close(); process.exit(1); }
    log('收到验证链接: ' + link.slice(0, 80), '📬 ');
    await page.goto(link, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    log('点击验证链接后 URL: ' + page.url(), '✅ ');

    // 4. 同会话 OAuth 授权
    log('开始 OAuth 授权 (同会话)...', '🔐 ');
    process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
    // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
    const dataStore = new DataStore(path.join(WS, 'data'));
    const publisher = new TumblrPublisher(dataStore);
    const { authorizeUrl } = await publisher.beginAuth(accountId, CALLBACK_URL);
    log('authorizeUrl: ' + authorizeUrl.slice(0, 90), '🔗 ');
    await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    // 点 Allow
    const allowed = await page.evaluate(() => {
      const b = [...'button')].find(x => /allow/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    log('点击 Allow: ' + allowed, allowed ? '✅ ' : '⚠️ ');
    // 等待跳转到 callback URL（即使 3122 无服务，URL 里也有 verifier）
    let verifier = null;
    try {
      await page.waitForURL('**/callback**', { timeout: 60000 });
      const u = new URL(page.url());
      verifier = u.searchParams.get('');
      log('verifier: ' + (verifier || 'NULL').slice(0, 20), '🔑 ');
    } catch (e) {
      log('OAuth callback 跳转未捕获: ' + e.message, '⚠️ ');
      // 尝试从当前 URL 或页面里找 verifier
      const url = page.url();
      const m = url.match(/=([^&]+)/);
      if (m) verifier = m[1];
    }
    if (verifier) {
      const res = await publisher.completeAuth(verifier, accountId);
      log('completeAuth 结果: ' + JSON.stringify(res), '✅ ');
    } else {
      log('未拿到 verifier，授权未完成', '❌ ');
    }

    log('✅ 单账号端到端完成: ' + accountId, '🎉 ');
  } catch (e) {
    log('ERR: ' + e.message, '❌ ');
  }
  await browser.close();
  process.exit(0);
})();
