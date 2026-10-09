'use strict';
/** 探针：深入 blog name 页 reCAPTCHA 机制 + Sign up 提交 */
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

async  capsolverSolve(taskType, url, sitekey, extra) {
  const args = [path.join(WS, 'capsolver_cli.py'), 'solve', taskType, url, sitekey];
  if (extra) args.push(JSON.stringify(extra));
  const { stdout } = await execFileP(PY, args, { encoding: 'utf8', timeout: 200000 });
  const m = stdout.match(/TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

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
    if (u.includes('/') && r.request().method() === 'POST') {
      log('  [POST] ' + r.status() + ' ' + u.slice(0, 80));
    }
    if (u.includes('recaptcha') || u.includes('captcha')) {
      log('  [CAPTCHA NET] ' + r.status() + ' ' + u.slice(0, 80));
    }
  });

  // 用 mail.tm 申请邮箱
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

  log('=== blog 页结构探测 ===');
  const struct = await page.evaluate(() => {
    const iframes = [...'iframe')].map(f => ({ src: f.src, cls: f.className, id: f.id }));
    const grec = document.getElementById('');
    const inputs = [...'input')].map(i => ({ name: i.name, id: i.id, type: i.type, cls: i.className }));
    const btns = [...'button')].map(b => b.textContent.trim());
    return { iframes, hasGrec: !!grec, inputs: inputs.slice(0, 12), btns: btns.filter(Boolean) };
  });
  log('iframes: ' + JSON.stringify(struct.iframes));
  log(' 存在: ' + struct.hasGrec);
  log('inputs: ' + JSON.stringify(struct.inputs));
  log('buttons: ' + JSON.stringify(struct.btns));

  // 填 blog name
  const blogName = 'mscms' + Math.random(36).slice(2, 9);
  await page.fill('blogName]', blogName);
  await page.waitForTimeout(1000);

  // 尝试 1: Enterprise token 注入到  + 提交
  log('=== 尝试 Enterprise token 注入 ===');
  const tokenEnt = await capsolverSolve('', 'https://www.tumblr.com/', SITEKEY, { isInvisible: true });
  log('Enterprise token: ' + (tokenEnt ? 'got' : 'NULL'));
  if (tokenEnt) {
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
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // 也尝试触发 grecaptcha 的回调
      if (window.grecaptcha && window.grecaptcha.getResponse) {
        try { log('grecaptcha 已有响应'); } catch(e) {}
      }
    }, tokenEnt);
    await page.waitForTimeout(1000);
    await page.evaluate(() => { const b = [...'button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(5000);
    log('Enterprise 提交后 URL: ' + page.url());
    const txt1 = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' ').slice(0, 200);
    log('Enterprise 提交后文本: ' + txt1);
  }

  // 如果还失败，dump 当前页面所有 form/button 及可能的错误
  if (page.url().includes('/')) {
    log('=== 提交仍卡在 ，dump 错误 ===');
    const err = await page.evaluate(() => {
      const errEls = [...'[class*="error" i], [role="alert"], .notice, .alert')].map(e => e.textContent.trim()).filter(Boolean);
      const disabledBtns = [...'button')].filter(b => b.disabled).map(b => b.textContent.trim());
      return { errors: errEls.slice(0, 5), disabledBtns };
    });
    log('页面错误: ' + JSON.stringify(err.errors));
    log('disabled 按钮: ' + JSON.stringify(err.disabledBtns));
  }

  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
