'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
// 解密 accounts.json 中 AES-256-GCM 信封化的密码（落盘无明文）
const { decryptPassword } = require('./account-crypto');
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = process.env.TUMBLR_PROXY || 'http://127.0.0.1:10808';
if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = PROXY;
function detectChromiumExecutable() {
  const bases = [process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\ms-playwright' : null, 'C:\\Users\\AS\\AppData\\Local\\ms-playwright'].filter(Boolean);
  for (const base of bases) { if (!fs.existsSync(base)) continue; try { const dirs = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => parseInt(b.replace('chromium-', ''), 10) - parseInt(a.replace('chromium-', ''), 10)); for (const d of dirs) { const f = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(f)) return f; } } catch (_) {} }
  return null;
}
const CHROMIUM_EXE = detectChromiumExecutable();
(async () => {
  const id = process.argv[2] || 'tumblr_y7jxcqge';
  const { DataStore } = require('./data-store.js');
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const ds = new DataStore(path.join(WS, 'data'));
  const acc = ds.list('accounts', { filter: { platform: 'tumblr' }, limit: 100 }).items.find(a => a.id === id);
  const launchOpts = { headless: true, proxy: { server: PROXY, bypass: 'localhost,127.0.0.1' }, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (CHROMIUM_EXE) launchOpts.executablePath = CHROMIUM_EXE;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newContext({ locale: 'en-US' }).then(c => c.newPage());
  await page.goto('https://www.tumblr.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await page.fill('input[name=email], input[type=email], input#email', acc.email).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /continue|next|下一步|继续/i.test(x.textContent)); if (b) b.click(); }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.fill('input[name=password], input[type=password], input#password', decryptPassword(acc.password)).catch(() => {});
  await page.waitForTimeout(800);
  // reCAPTCHA?
  const hasCaptcha = await page.evaluate(() => !!document.querySelector('.g-recaptcha, iframe[src*=recaptcha], [data-sitekey]'));
  console.log('hasCaptcha=', hasCaptcha, 'url=', page.url());
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /log ?in|sign ?in|登录|登入/i.test(x.textContent)); if (b) b.click(); }).catch(() => {});
  await page.waitForTimeout(8000);
  const url = page.url();
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
  console.log('after-login url=', url);
  console.log('after-login text=', txt.replace(/\n/g, ' ').slice(0, 300));
  await page.screenshot({ path: '_reauth_diag.png' }).catch(() => {});
  console.log('screenshot saved _reauth_diag.png');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
