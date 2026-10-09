// find-bad-template.js — 提取 v14-console.html 内联 JS 的所有 template 字符串，在真实 Vue 里逐个编译
const { chromium } = require('playwright-core');
const fs = require('fs');
const exe = 'C:/Users/AS/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';

// 提取 template: `...` / '...' / "..."（处理转义）
 extractTemplates(src) {
  const out = [];
  const re = /template\s*:\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(src))) {
    let raw = m[1];
    const line = src.slice(0, m.index).split('\n';
    // 反转义为真实字符串值
    let val;
    try { val = eval('(' + raw + ')'); } catch (e) { val = null; }
    out.push({ line, val });
  }
  return out;
}

(async () => {
  const src = fs.readFileSync('v14-console.html', 'utf8');
  // 只取第三个内联块（主应用）
  const m3 = src.match(/<script>\n?([\s\S]*)<\/script>\s*<\/body>/);
  const code = m3 ? m3[1] : src;
  const tpls = extractTemplates(code);
  console.log('提取到模板数:', tpls.length);

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  await page.goto('http://:3002/login.html', { waitUntil: 'load' }); // 借一个同源页面
  await page.addScriptTag({ url: 'http://:3002/vue.global.prod.js' });
  const results = await page.evaluate((tpls) => {
    const out = [];
    for (let i = 0; i < tpls.length; i++) {
      const t = tpls[i];
      if (!t.val) { out.push({ i, line: t.line, err: '(原始串 eval 失败)' }); continue; }
      try { Vue.compile(t.val); } catch (e) { out.push({ i, line: t.line, err: String(e), head: String(t.val).slice(0, 200) }); }
    }
    return out;
  }, tpls);
  console.log('编译失败数:', results.length);
  for (const r of results.slice(0, 10)) {
    console.log('--- docLine', r.line, '|', r.err);
    if (r.head) console.log('    head:', JSON.stringify(r.head));
  }
  await browser.close();
  if (!results.length) console.log('全部模板编译通过 —— 问题可能不在模板');
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
