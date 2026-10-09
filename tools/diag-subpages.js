// 点击每个导航项 → 记录内容区文本 + 该页触发的失败 API
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://:3002';

 findChromium() {
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
  let bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(BASE, '').slice(0, 90)); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0].slice(0, 80)));

  await page.goto(BASE + '/login.html', { waitUntil: 'load' });
  await page.fill('])', 'admin');
  await page.fill(']', 'MSCMS@2026');
  await page.click('button');
  await page.waitForTimeout(3000);
  await page.goto(BASE + '/v14-console.html', { waitUntil: 'load' });
  await page.waitForTimeout(7000);

  const navs = await page.evaluate(() => {
    const out = [], seen = new Set();
    '[class*=side],[class*=menu],[class*=nav],nav,aside').forEach((box) => {
      box.querySelectorAll('a,button,li,div[class*=item]').forEach((el) => {
        const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
        const r = el.getBoundingClientRect();
        if (!t || seen.has(t) || r.height < 10 || r.height > 80) return;
        seen.add(t);
        out.push(t);
      });
    });
    return out;
  });

  console.log('导航项', navs.length, '个\n');
  for (const t of navs) {
    bad = []; errs.length = 0;
    let txt = '', elems = 0;
    try {
      await page.click(`text="${t}"`, { timeout: 2500 });
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => {
        // 取当前可见的主内容区
        const cands = [...'#app > div, main, .main, .content, .panel, section')];
        let best = null, bestN = 0;
        for (const c of cands) {
          const st = getComputedStyle(c);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          const n = c.querySelectorAll('*';
          const rect = c.getBoundingClientRect();
          if (rect.width > 300 && n > bestN) { bestN = n; best = c; }
        }
        const el = best || document.body;
        return {
          n: bestN,
          txt: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 110),
        };
      });
      elems = r.n; txt = r.txt;
    } catch (e) { txt = 'CLICK_FAIL ' + e.message.split('\n')[0].slice(0, 40); }
    const flag = errs.length ? 'JS错' : (bad.length ? 'API错' : (elems < 130 ? '空壳' : 'OK  '));
    console.log(`${flag} | ${t.padEnd(22)} | 元素${String(elems).padStart(4)} | ${txt}`);
    if (bad.length) [...new Set(bad)].slice(0, 2).forEach((b) => console.log(`        ↳ ${b}`));
    if (errs.length) console.log(`        ↳ ${errs[0]}`);
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
