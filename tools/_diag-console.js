'use strict';
/** 诊断：抓取 v14-console.html 的全部控制台输出与 DOM 状态 */
const fs = require('fs');
const { chromium } = require('playwright-core');
const EXES = [
  'C:/Users/AS/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/AS/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
];
(async () => {
  const exe = EXES.find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text().slice(0, 300)));
  page.on('pageerror', (e) => logs.push('[PAGEERROR] ' + (e.stack || e.message).slice(0, 600)));
  page.on('requestfailed', (r) => logs.push('[REQFAIL] ' + r.url().slice(0, 120) + ' ' + (r.failure() || {}).errorText));
  await page.goto('http://127.0.0.1:3002/v14-console.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(6000);
  const state = await page.evaluate(() => ({
    navExists: !!document.querySelector('nav'),
    navItemCount: document.querySelectorAll('nav .nav-group-item').length,
    navHTMLlen: (document.querySelector('nav') || {}).innerHTML ? document.querySelector('nav').innerHTML.length : 0,
    appInnerLen: (document.querySelector('#app') || {}).innerHTML ? document.querySelector('#app').innerHTML.length : 0,
    svcChip: document.querySelectorAll('.svc-chip').length,
    statsPanel: !!document.querySelector('.stats-panel'),
    bodyStart: (document.body.innerText || '').slice(0, 300),
  }));
  console.log('=== DOM 状态 ===');
  console.log(JSON.stringify(state, null, 1));
  console.log('\n=== 控制台/错误日志（前 25 条）===');
  logs.slice(0, 25).forEach((l) => console.log('  ' + l));
  console.log('\n共 ' + logs.length + ' 条日志');
  await browser.close();
})();
