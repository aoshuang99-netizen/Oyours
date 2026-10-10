// 用真实点击验证 console 侧栏「仪表盘」与「全域监控大盘(iframe)」的渲染
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:3002';

function findChromium() {
  const base = 'C:/Users/AS/AppData/Local/ms-playwright';
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base).sort().reverse()) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const exe = path.join(base, d, sub, 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

(async () => {
  const exe = findChromium();
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push('[http ' + r.status() + '] ' + r.url()); });

  await page.goto(BASE + '/login.html', { waitUntil: 'load' });
  await page.fill('input:not([type=password])', 'admin');
  await page.fill('input[type=password]', 'MSCMS@2026');
  await page.click('button');
  await page.waitForTimeout(3000);

  await page.goto(BASE + '/v14-console.html', { waitUntil: 'load' });
  await page.waitForTimeout(6000);

  async function clickNav(text) {
    const ok = await page.evaluate((t) => {
      const a = [...document.querySelectorAll('.sidebar nav a')].find((x) => x.textContent.replace(/\s+/g, ' ').includes(t));
      if (!a) return false;
      a.click();
      return true;
    }, text);
    if (!ok) { console.log('!! 未找到菜单: ' + text); return null; }
    await page.waitForTimeout(text.includes('大盘') ? 7000 : 2500);
    return page.evaluate(() => {
      const main = document.querySelector('main.main') || document.querySelector('.main');
      return {
        h1: (main.querySelector('h1') || {}).innerText || '(无 h1)',
        textLen: (main.innerText || '').trim().length,
        iframes: [...main.querySelectorAll('iframe')].map((f) => (f.getAttribute('src') || '') + ' ' + f.clientWidth + 'x' + f.clientHeight),
      };
    });
  }

  console.log('### 仪表盘 → ' + JSON.stringify(await clickNav('仪表盘')));
  console.log('### 全域监控大盘 → ' + JSON.stringify(await clickNav('全域监控大盘')));

  const frames = page.frames().filter((f) => (f.url() || '').includes('v14-dash'));
  console.log('### iframe 数量: ' + frames.length);
  if (frames.length) {
    const inner = await frames[0].evaluate(() => {
      const sc = document.getElementById('scroll');
      return { title: document.title, menus: document.querySelectorAll('#side .mi').length, scrollLen: sc ? (sc.innerText || '').trim().length : -1 };
    });
    console.log('### iframe 内部 → ' + JSON.stringify(inner));
  }

  console.log('\n=== 错误 ===\n' + ([...new Set(errors)].join('\n') || '(无)'));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
