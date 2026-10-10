// 抓取指定 tab 渲染后的完整文本与 HTML 片段，用于区分「数据为空」vs「渲染异常」
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:3002';
const TARGETS = (process.env.TARGETS || 'content/factory,mkt/campaigns,acct/platforms,acct/register,content/loop,conv/ab,mixpost/hashtags,links/matrix,sys/dag,sys/health,ainl/nlq,links/scrm,conv/attr,conv/cloak,mkt/overview').split(',');

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
  page.on('pageerror', (e) => console.log('  [pageerror] ' + e.message.split('\n')[0]));

  await page.goto(BASE + '/login.html', { waitUntil: 'load' });
  await page.fill('input:not([type=password])', 'admin');
  await page.fill('input[type=password]', 'MSCMS@2026');
  await page.click('button');
  await page.waitForTimeout(3000);
  await page.goto(BASE + '/v14-dash.html', { waitUntil: 'load' });
  await page.waitForTimeout(5000);

  for (const t of TARGETS) {
    const [m, tab] = t.split('/');
    await page.evaluate(([mid, tid]) => selectTab(mid, tid), [m, tab]);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const sc = document.getElementById('scroll');
      return { txt: (sc.innerText || '').trim().slice(0, 420), html: (sc.innerHTML || '').slice(0, 300) };
    });
    console.log('\n===== ' + t + ' =====');
    console.log('[TEXT] ' + r.txt.replace(/\n+/g, ' ⏎ '));
    if (r.txt.length < 220) console.log('[HTML] ' + r.html.replace(/\s+/g, ' '));
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
