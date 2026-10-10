'use strict';
const path = require('path');
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const PY = 'C:/Users/AS/.workbuddy/binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = 'http://127.0.0.1:10808';
const SITEKEY = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';
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
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST' && u.split('/').pop() === 'nrksaaknsdzc') {
      const txt = await r.text();
      log('FULL 400: ' + txt);
    }
  });
  const { stdout: mbOut } = await execFileP(PY, [path.join(WS, 'mail_1secmail.py')], { encoding: 'utf8', timeout: 30000 });
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
  const blogName = 'mscms' + Date.now().toString(36).slice(-8);
  await page.fill('input[name=blogName]', blogName);
  await page.waitForTimeout(3000);
  const token = await page.evaluate(async (sk) => {
    return await new Promise((resolve) => {
      try { window.grecaptcha.enterprise.ready(async () => { try { const t = await window.grecaptcha.enterprise.execute(sk, { action: 'register' }); resolve(t); } catch (e) { resolve('ERR'); } }); }
      catch (e) { resolve('ERR'); }
    });
  }, SITEKEY);
  await page.evaluate((t) => { let el = document.getElementById('g-recaptcha-response'); if (!el) { el = document.createElement('textarea'); el.id = 'g-recaptcha-response'; el.name = 'g-recaptcha-response'; el.style.display = 'none'; document.body.appendChild(el); } el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, token);
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
  await page.waitForTimeout(5000);
  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
