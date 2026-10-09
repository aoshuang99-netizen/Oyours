// 扫描 v14-dash.html（全域监控大盘）的全部 L2 菜单 × L3 tab
// 记录：渲染文本长度 / DOM 元素数 / 可视化元素(svg|canvas|bar) / JS 错误 / 失败 API / 占位异常
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

  const errors = new Set();
  const failed = new Set();
  page.on('pageerror', (e) => errors.add(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errors.add('[console] ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) failed.add(r.status() + ' ' + r.url().replace(BASE, '')); });

  // 登录
  await page.goto(BASE + '/login.html', { waitUntil: 'load' });
  await page.fill('])', 'admin');
  await page.fill(']', 'MSCMS@2026');
  await page.click('button');
  await page.waitForTimeout(3000);

  await page.goto(BASE + '/v14-dash.html', { waitUntil: 'load' });
  await page.waitForTimeout(5000);

  const menus = await page.evaluate(() => {
    if (typeof MENUS === 'undefined') return null;
    return MENUS.map((m) => ({ id: m.id, label: m.label, ic: m.ic, tabs: m.tabs.map((t) => ({ id: t.id, label: t.label })) }));
  });
  if (!menus) { console.log('!! MENUS 未定义 —— 页面脚本未执行到底'); await browser.close(); process.exit(1); }

  const rows = [];
  for (const m of menus) {
    for (const t of m.tabs) {
      errors.clear();
      await page.evaluate(([mid, tid]) => { if (typeof selectTab === '') selectTab(mid, tid); }, [m.id, t.id]);
      await page.waitForTimeout(1100);
      const info = await page.evaluate(() => {
        const sc = document.getElementById('scroll');
        const html = sc ? sc.innerHTML : '';
        const txt = (sc ? sc.innerText : '').trim();
        const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
        const root = doc.body.firstElementChild;
        return {
          len: txt.length,
          els: root ? root.querySelectorAll('*' : 0,
          svg: root ? root.querySelectorAll('svg,canvas' : 0,
          bars: (html.match(/class="[^"]*bar[^"]*"/g) || [],
          panels: root ? root.querySelectorAll('.panel' : 0,
          tables: root ? root.querySelectorAll('table' : 0,
          nan: /NaN|undefined|\[object Object\]|Infinity/.test(txt),
          err: typeof root !== 'undefined' && /渲染失败|加载失败|Error:/.test(txt),
          head: txt.slice(0, 90).replace(/\s+/g, ' '),
        };
      });
      rows.push({ menu: m.ic + ' ' + m.label, tab: t.label, ...info, errs: [...errors].slice(0, 2).join(' | ') });
    }
  }

  console.log('MENU'.padEnd(18) + 'TAB'.padEnd(22) + 'LEN'.padStart(6) + 'ELS'.padStart(6) + 'VIS'.padStart(5) + 'BAR'.padStart(5) + 'PNL'.padStart(5) + 'TBL'.padStart(5) + '  STATE');
  console.log('-'.repeat(110));
  for (const r of rows) {
    const bad = [];
    if (r.len < 60) bad.push('空');
    else if (r.len < 200) bad.push('薄');
    if (r.nan) bad.push('脏值');
    if (r.err) bad.push('报错文案');
    if (r.errs) bad.push('JS:' + r.errs.slice(0, 60));
    const state = bad.length ? '❌ ' + bad.join(',') : (r.svg + r.bars > 0 ? '✅ 含可视化' : '⚠️ 纯文本');
    console.log(r.menu.padEnd(18) + r.tab.padEnd(22) + String(r.len).padStart(6) + String(r.els).padStart(6) + String(r.svg).padStart(5) + String(r.bars).padStart(5) + String(r.panels).padStart(5) + String(r.tables).padStart(5) + '  ' + state);
  }
  console.log('\n=== 全局 JS 错误 ===');
  console.log([...errors].join('\n') || '(无)');
  console.log('\n=== 失败请求 ===');
  console.log([...failed].join('\n') || '(无)');
  fs.writeFileSync(path.join(__dirname, 'dash-scan.json'), JSON.stringify(rows, null, 2));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
