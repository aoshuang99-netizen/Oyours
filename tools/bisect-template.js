// bisect-template.js — 对 #app 内 DOM 模板做二分定位：找出哪个子元素导致 Vue.compile 语法错误
const { chromium } = require('playwright-core');
const exe = 'C:/Users/AS/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

(async () => {
  const TARGET = process.argv[2] || '/v14-console.html';
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  await page.goto('http://:3002/login.html', { waitUntil: 'load' });
  await page.addScriptTag({ url: 'http://:3002/vue.global.prod.js' });

  // 在浏览器里抓取目标页 #app 的 outerHTML
  const appHTML = await page.evaluate(async (target) => {
    const r = await fetch(target);
    const txt = await r.text();
    const doc = new DOMParser().parseFromString(txt, 'text/html');
    const app = doc.querySelector('#app');
    return app ? app.outerHTML : '(no #app)';
  }, TARGET);
  console.log('目标', TARGET, '#app HTML 长度:', appHTML.length, appHTML.startsWith('(no') ? appHTML : '');

  const result = await page.evaluate((appHTML) => {
    const log = [];
    const tryCompile = (h) => { try { Vue.compile(h); return true; } catch (e) { return String(e); } };
    // 1) 整体
    const whole = tryCompile(appHTML);
    if (whole === true) return { verdict: '整体编译通过，问题不在 DOM 模板', log };
    log.push('整体失败: ' + whole);
    // 2) 逐子元素二分
    const doc = new DOMParser().parseFromString(appHTML, 'text/html');
    const app = doc.querySelector('#app');
    const kids = Array.from(app.children);
    log.push('#app 子元素数: ' + kids.length);
    let bad = -1;
    for (let k = 1; k <= kids.length; k++) {
      const wrap = '<div id="app">' + kids.slice(0, k).map(c => c.outerHTML).join('\n') + '</div>';
      if (tryCompile(wrap) !== true) { bad = k - 1; break; }
    }
    if (bad < 0) { log.push('前缀法未复现（可能需要完整结构）'); return { verdict: 'partial', log }; }
    const el = kids[bad];
    log.push('首个失败子元素: <' + el.tagName.toLowerCase() + '> id=' + el.id + ' class=' + el.className);
    // 3) 在该元素内继续二分其子元素
    let cur = el;
    while (cur && cur.children && cur.children.length) {
      const gk = Array.from(cur.children);
      let g = -1;
      for (let k = 1; k <= gk.length; k++) {
        const clone = cur.cloneNode(true);
        const cc = Array.from(clone.children);
        for (let j = cc.length - 1; j >= k; j--) cc[j].remove();
        // 用 clone 的 outerHTML + 父链包装近似编译
        if (tryCompile('<div>' + clone.outerHTML + '</div>') !== true) { g = k - 1; break; }
      }
      if (g < 0) break;
      cur = gk[g];
      log.push('下钻 → <' + cur.tagName.toLowerCase() + '> id=' + cur.id + ' class=' + String(cur.className).slice(0, 60));
    }
    log.push('最终嫌疑元素 outerHTML(前600): ' + (cur ? cur.outerHTML.slice(0, 600) : '(none)'));
    return { verdict: 'found', log };
  }, appHTML);

  console.log(result.verdict);
  for (const l of result.log) console.log('  ' + l);
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
