// 验证 v2 看板：搜索过滤 / Ctrl+K / 徽标 / 默认折叠，并截图
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://:3002';
const OUT = path.join(__dirname, '..', '.tmp');

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
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));

  await page.goto(BASE + '/login.html', { waitUntil: 'load' });
  await page.fill('])', 'admin');
  await page.fill(']', 'MSCMS@2026');
  await page.click('button');
  await page.waitForTimeout(3000);
  await page.goto(BASE + '/v14-dash.html', { waitUntil: 'load' });
  await page.waitForTimeout(6000);

  const struct = await page.evaluate(() => ({
    groups: [...'#side .mi')].map((e) => e.querySelector('.lbl').textContent + '(' + e.querySelector('.bad').textContent + ')'),
    expanded: [...'#side .subtabs')].filter((e) => e.style.display === 'block',
    searchBox: !!document.getElementById('mqi'),
  }));
  console.log('侧栏分组: ' + JSON.stringify(struct.groups, null, 0));
  console.log('默认展开组数: ' + struct.expanded + ' (应为 1)');
  console.log('搜索框存在: ' + struct.searchBox);
  await page.screenshot({ path: path.join(OUT, 'dash-v2-default.png') });

  // 搜索测试
  for (const q of ['漏斗', '归因', '设备', 'zzz']) {
    await page.fill('#mqi', q);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({
      groups: [...'#side .mi')].filter((e) => e.style.display !== 'none').map((e) => e.querySelector('.lbl').textContent),
      tabs: [...'#side .subtab')].filter((e) => e.style.display !== 'none' && e.offsetParent !== null).map((e) => e.textContent),
      empty: (() => { const p = document.getElementById('mqempty'); return p ? p.style.display !== 'none' : false; })(),
    }));
    console.log(`搜索「${q}」→ 组[${r.groups.join(',')}] 页[${r.tabs.join(',')}] 空态=${r.empty}`);
  }
  await page.screenshot({ path: path.join(OUT, 'dash-v2-search.png') });

  // 清除后恢复
  await page.click('#mqx');
  await page.waitForTimeout(300);
  const restored = await page.evaluate(() => [...'#side .mi')].filter((e) => e.style.display !== 'none');
  console.log('清除搜索后可见组数: ' + restored + ' (应为 7)');

  // 点选一个页面确认渲染
  await page.evaluate(() => gotoPage('conv', 'attr'));
  await page.waitForTimeout(2000);
  const t = await page.evaluate(() => ({ title: document.getElementById('ttl').textContent, len: (document.getElementById('scroll').innerText || '').trim( }));
  console.log('gotoPage(conv,attr) → ' + JSON.stringify(t));
  await page.screenshot({ path: path.join(OUT, 'dash-v2-attr.png') });

  console.log('\nJS 错误: ' + (errs.join('\n') || '(无)'));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
