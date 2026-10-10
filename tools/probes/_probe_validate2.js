'use strict';
/** 探针：深入捕获 Sign up 提交时的完整网络请求序列 + validate 返回 */
const path = require('path');
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const PY = 'C:/Users/AS/.workbuddy/binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = 'http://127.0.0.1:10808';

function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`, { flush: true }); }

async function setReactSelect(page, name, val) {
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
  const reqLog = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') || u.includes('recaptcha') || u.includes('captcha')) {
      let body = null;
      if (r.method() === 'POST') {
        try { body = r.postData(); } catch (e) { body = '(unavailable)'; }
      }
      reqLog.push({ method: r.method(), url: u.slice(0, 70), body: body ? body.slice(0, 200) : null });
    }
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST') {
      try {
        const j = await r.json();
        log('  [RESP] ' + r.status() + ' ' + u.split('/').pop() + ' -> ' + JSON.stringify(j).slice(0, 300));
      } catch (e) { log('  [RESP] ' + r.status() + ' ' + u.split('/').pop() + ' (non-json)'); }
    }
  });

  const { stdout: mbOut } = await execFileP(PY, [path.join(WS, 'mailtm_cli.py'), 'create'], { encoding: 'utf8', timeout: 30000 });
  const email = (mbOut.match(/ADDR=(.*)/) || [])[1].trim();
  const pw = 'Aa1' + Math.random().toString(36).slice(2, 10) + '!';
  log('邮箱: ' + email);

  await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(4000);
  await setReactSelect(page, 'month', '0');
  await setReactSelect(page, 'day', '15');
  await setReactSelect(page, 'year', '1995');
  await page.waitForTimeout(800);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
  await page.waitForTimeout(5000);

  const blogName = 'mscms' + Math.random().toString(36).slice(2, 9);
  await page.fill('input[name=blogName]', blogName);
  await page.waitForTimeout(1500);
  log('=== 提交 Sign up（不注入 captcha，看后端校验返回） ===');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
  await page.waitForTimeout(6000);
  log('提交后 URL: ' + page.url());
  log('提交后文本: ' + (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' ').slice(0, 200));
  log('=== 请求序列 ===');
  reqLog.forEach(r => log('  ' + JSON.stringify(r)));

  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
