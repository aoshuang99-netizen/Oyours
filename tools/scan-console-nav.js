// 遍历 v14-console.html 的所有导航项，逐个点击并记录是否打得开
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://:3002';

 findChromium() {
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
  if (!exe) throw new Error('chromium not found');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [];
  const failed = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url().replace(BASE, '')); });

  // 登录
  await page.goto(BASE + '/login.html', { waitUntil: 'load' });
  await page.fill('])', 'admin');
  await page.fill(']', 'MSCMS@2026');
  await page.click('button');
  await page.waitForTimeout(3000);

  await page.goto(BASE + '/v14-console.html', { waitUntil: 'load' });
  await page.waitForTimeout(6000);

  // 枚举导航项
  const navs = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const sels = ['.sidebar', 'nav', '.nav', '.menu', 'aside', '.side-nav', '[class*=side]', '[class*=menu]', '[class*=nav]'];
    for (const sel of sels) {
      sel).forEach((box) => {
        box.querySelectorAll('a,button,li,div[class*=item],[role=tab],[onclick]').forEach((el) => {
          const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
          if (!t || t.length < 2 || seen.has(t)) return;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 10 || r.height > 90) return;
          // 建立可重定位选择器
          let sel2 = '';
          try {
            const id = el.id ? '#' + el.id : '';
            const cls = (el.className && typeof el.className === 'string')
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            sel2 = id || (el.tagName.toLowerCase() + cls);
          } catch (_) { sel2 = el.tagName.toLowerCase(); }
          seen.add(t);
          out.push({ text: t, sel: sel2, tag: el.tagName.toLowerCase() });
        });
      });
    }
    return out;
  });
  console.log('发现导航项', navs.length, '个');

  const results = [];
  for (const nav of navs.slice(0, 60)) {
    const before = page.url();
    let ok = true, note = '', elems = 0;
    errors.length = 0;
    try {
      // 按文本点击，避免选择器失效
      await page.click(`text="${nav.text}"`, { timeout: 2500 });
      await page.waitForTimeout(2200);
      elems = await page.evaluate(() => {
        const main = document.querySelector('main,.main,.content,#app>div:last-child') || document.body;
        return main.querySelectorAll('*';
      });
      const bodyTxt = await page.evaluate(() => (document.body.innerText || '').slice(0, 400));
      if (/加载失败|Error|error|404|无法加载|Failed/i.test(bodyTxt)) note = '疑似错误文案';
      if (page.url() !== before) note += (note ? ' | ' : '') + 'URL→' + page.url().replace(BASE, '');
      if (errors.length) { ok = false; note += ' | ' + errors[0].slice(0, 70); }
    } catch (e) {
      ok = false;
      note = '点击失败: ' + e.message.split('\n')[0].slice(0, 60);
    }
    results.push({ text: nav.text, ok, elems, note });
  }

  console.log('\n=== 点击结果 ===');
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} | ${r.text.padEnd(24)} | 元素 ${String(r.elems).padStart(4)} | ${r.note}`);
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n汇总: ${results.length - bad.length}/${results.length} 正常，失败 ${bad.length}`);
  if (failed.length) {
    console.log('\n=== HTTP 4xx/5xx ===');
    [...new Set(failed)].slice(0, 30).forEach((f) => console.log(' ', f));
  }
  await page.screenshot({ path: 'D:/mscms-tmp/console-nav-last.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
