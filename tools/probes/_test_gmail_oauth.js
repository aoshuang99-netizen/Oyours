'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const SITEKEY = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';
const PROXY = 'http://:10808';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const CALLBACK_URL = 'http://localhost:3122/callback';
 log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`, { flush: true }); }
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
(async () => {
  const accountId = 't_test_' + Math.random(36).slice(2, 8);
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  let createStatus = null;
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST' && u.split('/').pop() === 'nrksaaknsdzc') createStatus = r.status();
  });
  const email = 'mscmstest' + Math.random(36).slice(2, 8) + '@gmail.com';
  const pw = 'Aa1' + Math.random(36).slice(2, 10) + '!';
  log('注册邮箱: ' + email + ' | accountId=' + accountId);
  await page.goto('https://www.tumblr.com/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('email]', email);
  await page.fill(']', pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(4000);
  await setReactSelect(page, 'month', '0');
  await setReactSelect(page, 'day', '15');
  await setReactSelect(page, 'year', '1995');
  await page.waitForTimeout(800);
  await page.evaluate(() => { const b = [...'button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
  await page.waitForTimeout(5000);
  const blogName = 'mscms' + Date.now(36).slice(-8);
  await page.fill('blogName]', blogName);
  await page.waitForTimeout(3000);
  const token = await page.evaluate(async (sk) => {
    return await new Promise((resolve) => {
      try { window.grecaptcha.enterprise.ready(async () => { try { const t = await window.grecaptcha.enterprise.execute(sk, { action: '' }); resolve(t); } catch (e) { resolve('ERR'); } }); }
      catch (e) { resolve('ERR'); }
    });
  }, SITEKEY);
  await page.evaluate((t) => { let el = document.getElementById(''); if (!el) { el = document.createElement(''); el.id = ''; el.name = ''; el.style.display = 'none'; document.body.appendChild(el); } el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, token);
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const b = [...'button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
  await page.waitForTimeout(5000);
  log('创建结果: ' + (createStatus === 200 ? '✅ 200' : '❌ ' + (createStatus || '无请求')));
  log('创建后 URL: ' + page.url());

  // 同会话 OAuth 授权
  log('=== 同会话 OAuth 授权 ===');
  const { DataStore } = require(path.join(WS, 'data-store.js'));
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(path.join(WS, 'data'));
  const { TumblrPublisher } = require(path.join(WS, 'tumblr-publisher.js'));
  const publisher = new TumblrPublisher(dataStore);
  try {
    const { authorizeUrl } = await publisher.beginAuth(accountId, CALLBACK_URL);
    log('authorizeUrl: ' + authorizeUrl.slice(0, 80));
    await page.goto(authorizeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const allowed = await page.evaluate(() => {
      const b = [...'button')].find(x => /allow/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    log('点击 Allow: ' + allowed);
    let verifier = null;
    try {
      await page.waitForURL('**/callback**', { timeout: 30000 });
      const u = new URL(page.url());
      verifier = u.searchParams.get('');
    } catch (e) {
      const m = page.url().match(/=([^&]+)/);
      if (m) verifier = m[1];
    }
    log('verifier: ' + (verifier ? verifier.slice(0, 15) + '...' : 'NULL'));
    if (verifier) {
      const res = await publisher.completeAuth(verifier, accountId);
      log('completeAuth: ' + JSON.stringify(res));
      // 验证 token 已落盘
      const tok = dataStore.get('', accountId);
      log('落盘 token: ' + (tok && tok.oauthToken ? '✅ 有' : '❌ 无'));
      // 同进程立即发帖测试（验证 token 可用 + 未验证邮箱能否发帖）
      if (tok && tok.oauthToken) {
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
        const cfg = dataStore.get('', 'main');
        const postUrl = `https://api.tumblr.com/v2/blog/${tok.blogName}/post`;
        const body = { type: 'text', title: '自动测试', body: '✅ 自动化授权链路验证 ' + new Date().toISOString() };
        let oa = { oauth_consumer_key: cfg., oauth_nonce: nonce(), oauth_signature_method: '', oauth_timestamp: ts(), oauth_version: '1.0', : tok.oauthToken };
        let s = sg('POST', postUrl, oa, body, cfg., tok.oauthTokenSecret);
        let h = 'OAuth ' + Object.keys(Object.assign({}, oa, { oauth_signature: s })).sort().map(k => `${pe(k)}="${pe(String(Object.assign({}, oa, { oauth_signature: s })[k]))}"`).join(', ');
        const r = await fetchExt(postUrl, { method: 'POST', headers: { '': h, '': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
        const j = await r.json().catch(() => ({}));
        log('发帖测试: ' + r.status + ' ' + JSON.stringify(j).slice(0, 250));
      }
      // 确保 flush 到磁盘
      try { dataStore._flush(); } catch (e) {}
    }
  } catch (e) {
    log('OAuth 失败: ' + e.message);
  }
  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
