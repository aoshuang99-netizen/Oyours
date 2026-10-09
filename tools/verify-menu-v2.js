// 验证菜单 v2：8组43页结构 + ⚡常用智能区 + 搜索 + 截图
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
 findChromium() {
  const base = 'C:/Users/AS/AppData/Local/ms-playwright';
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  return null;
}
(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message).slice(0, 140)));
  await page.goto('http://:3002/v14-dash.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof MENUS !== 'undefined', { timeout: 20000 });

  const struct = await page.evaluate(() => MENUS.map(m => ({ id: m.id, ic: m.ic, label: m.label, n: m.tabs.length })));
  console.log('=== 菜单结构 ===');
  struct.forEach(m => console.log('  ' + m.ic + ' ' + m.label.padEnd(8) + '(' + m.id + ')  ' + m.n + ' 页'));
  console.log('  合计: ' + struct.length + ' 组 / ' + struct.reduce((s, m) => s + m.n, 0) + ' 页');

  // 模拟用户访问，产生频次（内容工厂访问 3 次 → 应排第一）
  const visits = [['content', 'factory'], ['traffic', 'trend'], ['acct', 'overview'], ['content', 'factory'], ['content', 'loop'], ['content', 'factory']];
  for (const [m, t] of visits) {
    await page.evaluate(([m, t]) => gotoPage(m, t), [m, t]);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(800);

  const freq = await page.evaluate(() => {
    const box = document.querySelector('#freqbar');
    if (!box) return null;
    return { display: getComputedStyle(box).display, text: box.innerText.replace(/\n/g, ' | '), chips: box.querySelectorAll('.fq' };
  });
  console.log('\n=== ⚡ 常用智能区 ===');
  console.log('  display: ' + (freq ? freq.display : 'NOT FOUND'));
  console.log('  快捷项: ' + (freq ? freq.chips : 0) + ' 个');
  console.log('  内容: ' + (freq ? freq.text : '-'));

  // 平台闭环页内容核查
  await page.evaluate(() => gotoPage('content', 'loop'));
  await page.waitForTimeout(1500);
  const loop = await page.evaluate(() => {
    const s = document.querySelector('#scroll');
    return { text: s.innerText.replace(/\n/g, ' · ').slice(0, 200), rows: s.querySelectorAll('table tbody tr' };
  });
  console.log('\n=== 恢复的「平台闭环」页 ===');
  console.log('  表格行: ' + loop.rows);
  console.log('  内容: ' + loop.text);

  // 搜索验证
  await page.fill('#mqi', '闭环');
  await page.waitForTimeout(500);
  const search = await page.evaluate(() => {
    const vis = [...'.mi')].filter(e => e.style.display !== 'none').map(e => e.innerText.trim().split('\n')[0]);
    const subs = [...'.subtab')].filter(e => e.style.display !== 'none' && e.offsetParent).map(e => e.innerText.trim());
    return { menus: vis, tabs: subs };
  });
  console.log('\n=== 搜索「闭环」 ===');
  console.log('  命中分组: ' + search.menus.join(' / '));
  console.log('  命中页面: ' + search.tabs.join(' / '));

  // 截图
  await page.fill('#mqi', '');
  await page.evaluate(() => { filterMenu(''); gotoPage('content', 'factory'); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '.tmp/menu-v2-default.png' });
  await page.evaluate(() => gotoPage('ai', 'insight'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '.tmp/menu-v2-ai.png' });

  console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
  console.log('截图: .tmp/menu-v2-default.png / .tmp/menu-v2-ai.png');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
