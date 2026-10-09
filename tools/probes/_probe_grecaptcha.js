'use strict';
/** 探针：直接在页面里操作 grecaptcha.enterprise 拿 token 并注入 React state */
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
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('/') && r.request().method() === 'POST') log('  [POST] ' + r.status() + ' ' + u.slice(0, 70));
  });

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
  await page.waitForTimeout(1500);

  log('=== 探测 grecaptcha.enterprise 对象 ===');
  const grecInfo = await page.evaluate(() => {
    const info = { hasGR: !!window.grecaptcha, hasEnt: !!(window.grecaptcha && window.grecaptcha.enterprise) };
    if (info.hasEnt) {
      info.ready = typeof window.grecaptcha.enterprise.ready;
      info.execute = typeof window.grecaptcha.enterprise.execute;
    }
    // 找 React fiber 里的 onSubmit / captcha 相关 state
    const root = document.getElementById('onboardingBlogname');
    return info;
  });
  log('g ' + JSON.stringify(grecInfo));

  // 尝试直接调用 grecaptcha.enterprise.execute 拿 token
  log('=== 尝试 grecaptcha.enterprise.execute ===');
  const execResult = await page.evaluate(async (sitekey) => {
    return await new Promise((resolve) => {
      try {
        if (!window.grecaptcha || !window.grecaptcha.enterprise) { resolve({ err: 'no enterprise' }); return; }
        window.grecaptcha.enterprise.ready(async () => {
          try {
            const tok = await window.grecaptcha.enterprise.execute(sitekey, { action: '' });
            resolve({ token: tok ? tok.slice(0, 30) + '...' : null });
          } catch (e) { resolve({ err: e.message }); }
        });
      } catch (e) { resolve({ err: e.message }); }
    });
  }, SITEKEY);
  log('execute 结果: ' + JSON.stringify(execResult));

  if (execResult.token) {
    // 拿到 token 后，找 React 的 captcha 字段并写入
    log('=== 注入 token 到 React state ===');
    const injected = await page.evaluate((tok) => {
      // 尝试找隐藏的 captcha input
      const hidden = document.querySelector('"captcha"], ""], "hidden"][name*="captcha" i]');
      if (hidden) { hidden.value = tok; hidden.dispatchEvent(new Event('input', { bubbles: true })); return 'hidden-input:' + hidden.name; }
      // 创建 
      let el = document.getElementById('');
      if (!el) { el = document.createElement(''); el.id = ''; el.name = ''; el.style.display = 'none'; document.body.appendChild(el); }
      el.value = tok; el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'created-';
    }, execResult.token);
    log('注入方式: ' + injected);
    await page.waitForTimeout(1000);
    await page.evaluate(() => { const b = [...'button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(5000);
    log('提交后 URL: ' + page.url());
    log('提交后文本: ' + (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' ').slice(0, 200));
  }

  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
