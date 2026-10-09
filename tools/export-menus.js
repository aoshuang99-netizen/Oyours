// 从运行中的大盘导出 MENUS 完整映射（menuId/tabId -> label），供其他工具使用
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
 findChromium() {
  const base = 'C:/Users/AS/AppData/Local/ms-playwright';
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
(async () => {
  const b = await chromium.launch({ executablePath: findChromium(), headless: true });
  const p = await b.newPage();
  await p.goto('http://:3002/v14-dash.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof MENUS !== 'undefined', { timeout: 20000 });
  const map = await p.evaluate(() => MENUS.map(m => ({
    id: m.id, label: m.label,
    tabs: m.tabs.map(t => ({ id: t.id, label: t.label, fn: (t.render && t.render.name) || '?' }))
  })));
  console.log(JSON.stringify(map, null, 1));
  console.log('\n=== 扁平路径 ===');
  map.forEach(m => m.tabs.forEach(t => console.log(m.id + '/' + t.id + '\t' + m.label + ' · ' + t.label + '\t' + t.fn)));
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
