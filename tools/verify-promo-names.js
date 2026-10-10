// 验证：v14-dash 账号面板已展示「推广站前缀-序号」展示名，且登录名仍作为副标题可见
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
function findChromium() {
  const base = 'C:/Users/AS/AppData/Local/ms-playwright';
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  return null;
}
(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));

  await page.goto('http://127.0.0.1:3002/v14-dash.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof MENUS !== 'undefined', { timeout: 20000 });

  // 1) 账号全景
  await page.evaluate(() => { selectMenu('acct'); selectTab('acct', 'overview'); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '.tmp/verify-acct-overview.png' });

  const acctInfo = await page.evaluate(() => {
    const tbls = [...document.querySelectorAll('table')];
    const cells = tbls.flatMap(t => [...t.querySelectorAll('tbody tr')].map(r => {
      const td = r.querySelector('td');
      return td ? td.innerText.trim() : '';
    })).filter(Boolean);
    return {
      firstCols: cells.slice(0, 8),
      hasPromoName: cells.some(c => /\b(hlua|molie)-\d{3}\b/.test(c)),
      promoCount: cells.filter(c => /\b(hlua|molie)-\d{3}\b/.test(c)).length,
      hasLoginName: cells.some(c => /mscms[a-z0-9]{6,}/.test(c)),
      headers: [...document.querySelectorAll('table th')].map(t => t.innerText.trim()).slice(0, 8)
    };
  });

  // 2) 养号监控
  await page.evaluate(() => { selectMenu('acct'); selectTab('acct', 'nurture'); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '.tmp/verify-acct-nurture.png' });
  const nurtureInfo = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('table')].flatMap(t => [...t.querySelectorAll('tbody tr')].map(r => {
      const td = r.querySelector('td'); return td ? td.innerText.trim() : '';
    })).filter(Boolean);
    return { first: cells.slice(0, 5), promoCount: cells.filter(c => /\b(hlua|molie)-\d{3}\b/.test(c)).length };
  });

  console.log('=== 账号全景 ===');
  console.log('  表头: ' + JSON.stringify(acctInfo.headers));
  console.log('  首列样例: ' + JSON.stringify(acctInfo.firstCols.slice(0, 5)));
  console.log('  含展示名(hlua-/molie-)的行: ' + acctInfo.promoCount + '   含登录名(mscms*)的行: ' + (acctInfo.hasLoginName ? '是' : '否'));
  console.log('=== 养号监控 ===');
  console.log('  首列样例: ' + JSON.stringify(nurtureInfo.first));
  console.log('  含展示名的行: ' + nurtureInfo.promoCount);
  console.log('=== JS 运行时错误 ===');
  console.log(errs.length ? errs.slice(0, 5).join('\n') : '  无');
  await browser.close();

  const ok = acctInfo.hasPromoName && acctInfo.promoCount > 0;
  console.log('\n结果: ' + (ok ? 'PASS 展示名已生效' : 'FAIL 未检测到展示名'));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
