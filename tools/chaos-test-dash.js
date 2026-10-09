// 故障注入：把后端返回篡改为脏数据（数字 id / 对象替标量 / 对象替数组 / 字符串百分比 / null）
// 然后遍历全部 42 页，统计「渲染错误」出现次数与降级格数量。
// 目的：证明容错层生效 —— 脏数据只降级单元格，不再让整个面板消失。
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

const CHAOS = `
((){
  const orig = window.fetch;
   dirty(o, depth){
    if(depth>6||o==null||typeof o!=='object') return o;
    if(Array.isArray(o)) return o.map(x=>dirty(x,depth+1));
    const out={};
    for(const k of Object.keys(o)){
      let v=o[k];
      // 1) id 类字段改成数字（原 .slice 崩溃点）
      if(/^(id|_id|content_id|link_id)$/i.test(k) && typeof v==='string') v=Number(v)||123456789;
      // 2) 计数类字段改成对象（原 [object Object] 崩溃点）
      else if(/^(reviewQueue|actions|totalIntercepted|avgReach|avgLikes|queue|running)$/i.test(k) && typeof v==='number') v={pending:v,total:v,ok:v};
      // 3) 数组字段改成对象（原 .slice/.map is not a ）
      else if(Array.isArray(v) && /^(items|devices||links|events|phases|workflows)$/i.test(k)) v={__obj:true, a:v[0]||{}, b:v[1]||{}};
      // 4) 比率字段改成字符串百分比（原 NaN%）
      else if(/Rate$|rate$/i.test(k) && typeof v==='number') v=(v*100).toFixed(1)+'%';
      // 5) 随机置 null
      else if(typeof v==='string' && v.length>0 && (v.charCodeAt(0)%7===0)) v=null;
      out[k]=dirty(v,depth+1);
    }
    return out;
  }
  window.fetch=(u,opt){
    return orig(u,opt).then(r=>{
      if(!/\\/api\\//.test(String(u))) return r;
      return r.text().then(t=>{
        let j; try{ j=JSON.parse(t);}catch(e){ return r; }
        const d=dirty(j,0);
        return new Response(JSON.stringify(d),{status:r.status'':'application/json'}});
      });
    });
  };
})();
`;

(async () => {
  const exe = findChromium();
  if (!exe) throw new Error('chromium not found');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = new Set();
  page.on('pageerror', e => errors.add(String(e.message).slice(0, 120)));

  await page.addInitScript(CHAOS);
  await page.goto('http://:3002/v14-dash.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof MENUS !== 'undefined', { timeout: 20000 });

  const map = await page.evaluate(() => MENUS.map(m => ({ id: m.id, label: m.label, tabs: m.tabs.map(t => ({ id: t.id, label: t.label })) })));

  const rows = [];
  for (const m of map) {
    for (const t of m.tabs) {
      await page.evaluate(([mid, tid]) => { selectMenu(mid); selectTab(mid, tid); }, [m.id, t.id]);
      await page.waitForTimeout(420);
      const r = await page.evaluate(() => {
        const s = document.querySelector('#scroll');
        const txt = s ? s.innerText : '';
        return {
          len: txt.length,
          renderErr: /渲染失败|渲染错误|该面板渲染失败/.test(txt),
          objObj: (txt.match(/\[object Object\]/g) || [],
          nan: (txt.match(/NaN/g) || [],
          undef: (txt.match(/undefined/g) || [],
          dash: (txt.match(/(^|\s)-(\s|$)/g) || []
        };
      });
      rows.push({ menu: m.label, tab: t.label, ...r });
    }
  }

  console.log('=== 故障注入测试（所有 API 返回脏数据）===');
  console.log('菜单'.padEnd(14) + '页签'.padEnd(20) + 'LEN'.padStart(6) + '  渲染失败  [objObj]  NaN  undefined');
  console.log('-'.repeat(84));
  let bad = 0, ooo = 0, nan = 0;
  rows.forEach(r => {
    if (r.renderErr) bad++;
    ooo += r.objObj; nan += r.nan;
    const flag = r.renderErr ? '❌ 整面板失败' : (r.objObj || r.nan ? '⚠️ 脏值残留' : '✅');
    console.log(r.menu.padEnd(14) + r.tab.padEnd(20) + String(r.len).padStart(6) + '  ' +
      String(r.renderErr).padEnd(10) + String(r.objObj).padStart(5) + String(r.nan).padStart(6) + String(r.undef).padStart(11) + '  ' + flag);
  });
  console.log('\n整面板渲染失败: ' + bad + ' 页');
  console.log('[object Object] 残留: ' + ooo + ' 处');
  console.log('NaN 残留: ' + nan + ' 处');
  console.log('页面级 JS 错误: ' + (errors.size ? [...errors].join(' | ') : '无'));

  await page.evaluate(() => { selectMenu('content'); selectTab('content', 'factory'); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.tmp/dash-chaos-factory.png', fullPage: false });
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
