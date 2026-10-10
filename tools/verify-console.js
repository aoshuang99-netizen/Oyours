// verify-console.js — 用真实 Chromium 复现登录 → 控制台，收集 JS 错误
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findChromium() {
  const root = path.join(os.tmpdir(), '..');
  const bases = [
    process.env.LOCALAPPDATA + '\\ms-playwright',
    'C:\\Users\\AS\\AppData\\Local\\ms-playwright'
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const exe = path.join(base, d, sub, 'chrome.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.log('NO_CHROMIUM'); process.exit(1); }
  console.log('chromium:', exe);
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  // 1) 登录页
  await page.goto('http://127.0.0.1:3002/login.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);
  console.log('login title:', await page.title());

  // 2) 填表登录（故意用全角＠验证归一化 + UI 全流程）
  await page.fill('input[type="text"], input:not([type="password"])', 'admin').catch(() => {});
  await page.fill('input[type="password"]', 'MSCMS＠2026').catch(() => {});
  await page.click('button.btn-login, button[type="submit"]').catch(() => {});
  await page.waitForTimeout(3500);
  console.log('after login url:', page.url());

  // 3) 进入控制台
  await page.goto('http://127.0.0.1:3002/v14-console.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(6000);
  console.log('console url:', page.url());
  console.log('console title:', await page.title());

  // 黑屏检测：页面是否渲染出可见内容（导航/卡片等）
  const vis = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('body *'));
    const visible = els.filter(e => {
      const s = getComputedStyle(e);
      return s.display !== 'none' && s.visibility !== 'hidden' && e.textContent && e.textContent.trim().length > 0;
    });
    return { totalEls: els.length, visibleEls: visible.length, bodyText: document.body.innerText.slice(0, 120) };
  });
  console.log('visibility:', JSON.stringify(vis));

  // 全局错误横幅内容
  const banner = await page.evaluate(() => {
    const el = document.getElementById('global-error');
    return el ? el.textContent.slice(0, 300) : '(no #global-error element)';
  });
  console.log('global-error banner:', JSON.stringify(banner));

  console.log('--- 收集到的 JS 错误 ---');
  console.log(errors.length ? errors.slice(0, 15).join('\n') : '(无)');

  await page.screenshot({ path: 'D:/mscms-tmp/console-verify.png', fullPage: false });
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
