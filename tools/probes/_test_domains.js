'use strict';
/** 快速测多个邮箱域名 Tumblr 创建接受度（只看 create 是否 200） */
const path = require('path');
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const PY = 'C:/Users/AS//binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = 'http://:10808';
const SITEKEY = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';

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

async  getEmailForDomain(domain) {
  // 用 guerrillamail API 但该域名；若失败用 1secmail 随机
  const axios = require('axios');
  try {
    const r = await axios.get('https://api.guerrillamail.com/ajax.php', { params: { f: 'get_email_address', ip: '', agent: 'Mozilla/5.0', domain }, timeout: 8000 });
    return r.data.email_addr;
  } catch (e) { return null; }
}

(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  let lastCreate = null;
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST' && u.split('/').pop() === 'nrksaaknsdzc') {
      lastCreate = r.status();
    }
  });

  const testDomains = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com', 'trashmail.com', 'yopmail.com'];
  for (const domain of testDomains) {
    lastCreate = null;
    const email = await getEmailForDomain(domain);
    if (!email) { log(domain + ': 无法获取邮箱'); continue; }
    log('=== ' + domain + ' | ' + email + ' ===');
    try {
      await page.goto('https://www.tumblr.com/', { waitUntil: 'networkidle', timeout: 30000 });
      await page.fill('email]', email);
      await page.fill(']', 'Aa1' + Math.random(36).slice(2, 10) + '!');
      await page.click('button[type=submit]');
      await page.waitForTimeout(3500);
      await setReactSelect(page, 'month', '0');
      await setReactSelect(page, 'day', '15');
      await setReactSelect(page, 'year', '1995');
      await page.waitForTimeout(800);
      await page.evaluate(() => { const b = [...'button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
      await page.waitForTimeout(4500);
      const blogName = 'mscms' + Date.now(36).slice(-8);
      await page.fill('blogName]', blogName);
      await page.waitForTimeout(2500);
      const token = await page.evaluate(async (sk) => {
        return await new Promise((resolve) => {
          try { window.grecaptcha.enterprise.ready(async () => { try { const t = await window.grecaptcha.enterprise.execute(sk, { action: '' }); resolve(t); } catch (e) { resolve('ERR'); } }); }
          catch (e) { resolve('ERR'); }
        });
      }, SITEKEY);
      if (token && !token.startsWith('ERR')) {
        await page.evaluate((t) => {
          let el = document.getElementById('');
          if (!el) { el = document.createElement(''); el.id = ''; el.name = ''; el.style.display = 'none'; document.body.appendChild(el); }
          el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
        }, token);
        await page.waitForTimeout(800);
        await page.evaluate(() => { const b = [...'button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
        await page.waitForTimeout(4000);
        log('  结果: ' + (lastCreate === 200 ? '✅ 创建成功' : '❌ ' + (lastCreate || '无请求')));
      }
    } catch (e) { log('  错误: ' + e.message); }
  }
  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
