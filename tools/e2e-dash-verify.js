// 端到端验收需求1：从控制台真实点击进入看板（iframe），逐页核查渲染健康度
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [], failed = [];
  page.on('pageerror', e => errs.push('[console] ' + String(e.message).slice(0, 140)));
  page.on('requestfailed', r => failed.push(r.url()));

  // 步骤1：真实调用登录接口取 token（验证账号可用），再注入到浏览器
  console.log('步骤1  调用真实登录接口 /api/v14/auth/login …');
  const token = await new Promise((resolve) => {
    const http = require('http');
    const body = JSON.stringify({ : 'admin', : 'MSCMS@2026' });
    const req = http.request({ host: '', port: 3002, path: '/api/v14/auth/login', method: 'POST',
      headers: { '': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).token); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
  if (!token) { console.log('  ✗ 登录接口未返回 token'); await browser.close(); return; }
  console.log('  ✓ 登录成功，token ' + token.slice(0, 24) + '…');
  await ctx.addInitScript(t => { try { localStorage.setItem('', t); } catch (e) {} }, token);

  console.log('步骤2  打开控制台 /v14-console.html …');
  await page.goto('http://:3002/v14-console.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  console.log('  ↳ 当前 URL: ' + page.url());

  console.log('步骤3  点击侧栏「📡 全域监控大盘」…');
  const clicked = await page.evaluate(() => {
    const el = [...'a')].find(a => a.textContent.includes('全域监控大盘'));
    if (el) { el.click(); return true; }
    return false;
  });
  if (!clicked) { console.log('  ✗ 未找到菜单项'); await browser.close(); return; }
  await page.waitForTimeout(3500);

  const iframeInfo = await page.evaluate(() => {
    const f = [...'iframe')].find(x => /v14-dash/.test(x.src || ''));
    if (!f) return null;
    return { src: f.getAttribute('src'), w: f.clientWidth, h: f.clientHeight };
  });
  console.log('步骤4  看板 iframe: ' + (iframeInfo ? `已加载 ${iframeInfo.w}×${iframeInfo.h}` : '❌ 未找到'));
  if (!iframeInfo) { await browser.close(); return; }

  const frame = page.frames().find(f => /v14-dash/.test(f.url()));
  await frame.waitForFunction(() => typeof MENUS !== 'undefined', { timeout: 20000 });
  const map = await frame.evaluate(() => MENUS.map(m => ({ id: m.id, label: m.label, tabs: m.tabs.map(t => ({ id: t.id, label: t.label })) })));

  console.log('\n步骤5  逐页巡查（' + map.reduce((s, m) => s + m.tabs.length, 0) + ' 页）\n');
  console.log('分组'.padEnd(12) + '页面'.padEnd(18) + '字符'.padStart(6) + '  图表  表格   状态');
  console.log('-'.repeat(66));
  let bad = 0, totalVis = 0, totalTbl = 0;
  for (const m of map) {
    for (const t of m.tabs) {
      await frame.evaluate(([mid, tid]) => { const sc=document.querySelector('#scroll'); if(sc) sc.innerHTML='__PENDING__'; selectMenu(mid); selectTab(mid, tid); }, [m.id, t.id]);
      await frame.waitForFunction(()=>{const s=document.querySelector('#scroll');if(!s)return false;const t=s.innerText.trim();return t!=='__PENDING__'&&!/加载中/.test(t)&&t.length>2;},{timeout:12000}).catch(()=>{});
      const r = await frame.evaluate(() => {
        const s = document.querySelector('#scroll');
        const txt = s ? s.innerText : '';
        return {
          len: txt.length,
          vis: s ? s.querySelectorAll('svg,canvas,.bar,.funnel-row' : 0,
          tbl: s ? s.querySelectorAll('table' : 0,
          err: /渲染错误|该面板渲染失败/.test(txt),
          obj: (txt.match(/\[object Object\]/g) || [],
          nan: (txt.match(/NaN/g) || []
        };
      });
      totalVis += r.vis; totalTbl += r.tbl;
      if (r.err || r.obj || r.nan) bad++;
      const st = r.err ? '❌ 渲染失败' : (r.obj || r.nan) ? '⚠️ 脏值' : (r.vis > 0 ? '✅ 有图表' : (r.tbl > 0 ? '✅ 有表格' : '· 引导页'));
      console.log(m.label.padEnd(12) + t.label.padEnd(18) + String(r.len).padStart(6) + String(r.vis).padStart(7) + String(r.tbl).padStart(6) + '   ' + st);
    }
  }
  console.log('\n=== 汇总 ===');
  console.log('异常页: ' + bad + ' | 图表元素合计: ' + totalVis + ' | 表格合计: ' + totalTbl);
  console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
  console.log('失败请求: ' + (failed.length ? failed.slice(0, 3).join(' | ') : '无'));

  await frame.evaluate(() => { selectMenu('content'); selectTab('content', 'factory'); });
  await frame.waitForTimeout(1200);
  await page.screenshot({ path: '.tmp/e2e-dash-final.png' });
  console.log('\n截图: .tmp/e2e-dash-final.png');
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
