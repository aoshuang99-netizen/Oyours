// sweep-pages.js — 全站页面黑屏扫描：真实 Chromium 逐页加载，收集 JS 错误与渲染情况
const { chromium } = require('playwright-core');
const exe = 'C:/Users/AS/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

const PAGES = [
  'login.html', 'v14-console.html', 'console.html', 'account-manager.html',
  'user-manager.html', 'message-center.html', 'v14-dash.html', 'v14-remix.html',
  'v14-loop-quality.html', 'workbench.html', 'system-overview.html',
  'access-guide.html', 'publish-device-selector.html',
  'tumblr-nurture-dashboard.html', 'tumblr-nurture-logs.html', 'tumblr-nurture-plan.html'
];

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 预置鉴权 token（先通过 API 登录取真 token）
  const lr = await page.request.post('http://:3002/api/v14/auth/login', {
    data: { : 'admin', : 'MSCMS@2026' }
  });
  const lj = await lr.json();
  const token = lj.token || '';
  await page.addInitScript((t) => {
    if (t) {
      localStorage.setItem('', t);
      localStorage.setItem('mscms-auth-user', JSON.stringify({ : 'admin', role: 'admin' }));
    }
  }, token);

  const rows = [];
  for (const p of PAGES) {
    const errs = [];
    const onErr = e => errs.push(e.message.slice(0, 80));
    const onCon = m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errs.push(m.text().slice(0, 80)); };
    page.on('pageerror', onErr); page.on('console', onCon);
    let status = 0;
    try {
      const resp = await page.goto('http://:3002/' + p, { waitUntil: 'load', timeout: 20000 });
      status = resp ? resp.status() : 0;
      await page.waitForTimeout(3500);
    } catch (e) { errs.push('LOAD_FAIL ' + e.message.slice(0, 60)); }
    let vis = -1, text = '';
    try {
      const r = await page.evaluate(() => {
        const els = Array.from('body *'));
        const v = els.filter(e => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && e.textContent && e.textContent.trim(); });
        return { v: v.length, t: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 40) };
      });
      vis = r.v; text = r.t;
    } catch (e) { /* 页面可能 crash */ }
    page.off('pageerror', onErr); page.off('console', onCon);
    rows.push({ page: p, status, visible: vis, errs: errs.slice(0, 2), text });
    console.log(
      (errs.length ? '❌' : (vis > 20 ? '✅' : '⚠️ ')),
      p, '| http', status, '| 可见元素', vis,
      errs.length ? '| ' + errs.join(' ;; ') : '',
      text ? '| ' + text : ''
    );
  }
  const bad = rows.filter(r => r.errs.length);
  console.log('\n==== 汇总: 共', rows.length, '页, 异常', bad.length, '页 ====');
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
