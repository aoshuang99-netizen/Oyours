// 检查 v14-console.html 内所有 iframe 的真实加载状态
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:3002';

function findChromium() {
  const base = 'C:/Users/AS/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).sort().reverse()) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const exe = path.join(base, d, sub, 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(BASE, '')); });

  await page.goto(BASE + '/login.html', { waitUntil: 'load' });
  await page.fill('input:not([type=password])', 'admin');
  await page.fill('input[type=password]', 'MSCMS@2026');
  await page.click('button');
  await page.waitForTimeout(3000);

  await page.goto(BASE + '/v14-console.html', { waitUntil: 'load' });
  await page.waitForTimeout(9000);

  // 逐个点击侧栏，让对应 iframe 显示
  const frames = await page.evaluate(() => {
    return [...document.querySelectorAll('iframe')].map((f, i) => {
      let info = { i, src: f.src || '', error: '' };
      try {
        const d = f.contentDocument;
        info.accessible = !!d;
        if (d) {
          info.innerUrl = d.location ? d.location.href : '';
          info.title = (d.title || '').slice(0, 40);
          info.text = (d.body ? d.body.innerText : '').replace(/\s+/g, ' ').slice(0, 90);
          info.elems = d.body ? d.body.querySelectorAll('*').length : 0;
        }
      } catch (e) { info.error = 'cross-origin: ' + e.message.slice(0, 40); }
      return info;
    });
  });

  console.log('=== iframe 状态 ===');
  for (const f of frames) {
    const flag = f.innerUrl && f.innerUrl.includes('/login.html') ? '🔴 跳登录页'
      : (f.elems > 50 ? '✅ 有内容' : '⚪ 空/未加载');
    console.log(`${flag} | #${f.i} ${String(f.src).replace(BASE, '')}`);
    console.log(`      内部URL: ${(f.innerUrl || '(不可访问)').replace(BASE, '')}`);
    console.log(`      元素:${f.elems || 0} 标题:"${f.title || ''}" 文本:"${f.text || ''}"`);
  }

  // 再直接单独访问每个子页面，确认页面本身没问题
  console.log('\n=== 子页面独立访问 ===');
  for (const p of ['/tumblr-nurture/console', '/tumblr-nurture/logs', '/account-manager.html', '/message-center.html', '/v14-remix.html', '/v14-dash.html']) {
    const r = await page.request.get(BASE + p, { headers: { authorization: 'Bearer ' + (await page.evaluate(() => localStorage.getItem('mscms_token') || localStorage.getItem('token') || '')) } });
    const t = await r.text();
    const isLogin = t.includes('登录') && t.length < 40000;
    console.log(`${r.status()} | ${p} | ${t.length}B | ${isLogin ? '疑似登录页' : '正常页'}`);
  }

  if (bad.length) { console.log('\n=== 4xx/5xx ==='); [...new Set(bad)].slice(0, 20).forEach((b) => console.log(' ', b)); }
  await page.screenshot({ path: 'D:/mscms-tmp/console-iframe.png', fullPage: false });
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
