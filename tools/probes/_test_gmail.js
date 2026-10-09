'use strict';
const path = require('path');
const { chromium } = require('playwright-core');
const SITEKEY = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';
const PROXY = 'http://:10808';
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
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  let createStatus = null;
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST' && u.split('/').pop() === 'nrksaaknsdzc') createStatus = r.status();
  });
  // 用 gmail 格式（收不到邮件，但测创建是否通过）
  const email = 'mscmstest' + Math.random(36).slice(2, 8) + '@gmail.com';
  const pw = 'Aa1' + Math.random(36).slice(2, 10) + '!';
  log('测试 gmail 格式: ' + email);
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
  log('gmail 创建结果: ' + (createStatus === 200 ? '✅ 200 成功' : '❌ ' + (createStatus || '无请求')));
  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
