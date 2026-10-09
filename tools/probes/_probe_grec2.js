'use strict';
/** 探针：等 reCAPTCHA 完全加载后检查 window.grecaptcha */
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

(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const { stdout: mbOut } = await execFileP(PY, [path.join(WS, ''), 'create'], { encoding: 'utf8', timeout: 30000 });
  const email = (mbOut.match(/ADDR=(.*)/) || [])[1].trim();
  const pw = 'Aa1' + Math.random(36).slice(2, 10) + '!';
  log('邮箱: ' + email);

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

  const blogName = 'mscms' + Math.random(36).slice(2, 9);
  await page.fill('blogName]', blogName);
  // 等 reCAPTCHA 完全加载
  await page.waitForTimeout(8000);

  log('=== 等 8 秒后检查 window.grecaptcha ===');
  const grec = await page.evaluate(() => {
    const has = !!window.grecaptcha;
    const info = { has: has };
    if (has) {
      info.hasEnt = !!(window.grecaptcha.enterprise);
      info.keys = Object.keys(window.grecaptcha);
      if (window.grecaptcha.enterprise) info.entKeys = Object.keys(window.grecaptcha.enterprise);
    }
    // 查找页面里所有 script 含 recaptcha 的 src
    const scripts = [...'script[src*="recaptcha"]')].map(s => s.src);
    info.scripts = scripts;
    return info;
  });
  log('g ' + JSON.stringify(grec));

  // 如果 grecaptcha.enterprise 存在，尝试 execute
  if (grec.has && grec.hasEnt) {
    log('=== execute ===');
    const res = await page.evaluate(async (sk) => {
      return await new Promise((resolve) => {
        try {
          window.grecaptcha.enterprise.ready(async () => {
            try { const t = await window.grecaptcha.enterprise.execute(sk, { action: '' }); resolve({ token: t ? t.slice(0, 20) : null }); }
            catch (e) { resolve({ err: e.message }); }
          });
        } catch (e) { resolve({ err: e.message }); }
      });
    }, SITEKEY);
    log('execute: ' + JSON.stringify(res));
  } else {
    log('grecaptcha.enterprise 仍不存在，尝试通过 document.querySelector 找 captcha widget');
    const w = await page.evaluate(() => {
      const iframes = [...'iframe')].map(f => f.src);
      const widgets = [...'[class*="recaptcha" i], [id*="recaptcha" i], [data-sitekey]')].map(e => ({ tag: e.tagName, cls: e.className, dk: e.getAttribute('data-sitekey') }));
      return { iframes, widgets };
    });
    log('widget: ' + JSON.stringify(w));
  }

  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
