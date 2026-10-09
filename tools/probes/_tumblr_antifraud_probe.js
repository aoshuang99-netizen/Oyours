/**
 * ShardX 反检测浏览器 × Tumblr 反欺诈探针
 * ------------------------------------------------
 * 目标：判断用 ShardX 真实指纹浏览器（headed + 指纹注入）能否通过
 *       Tumblr 的 /api/v2/user/validate 与 blackbox-api/wp.com/v1/collect，
 *       这两处是此前 headless chromium 被 400 拒绝的两个卡点。
 *
 * 步骤：
 *   1. 用自签 JWT 从 Automation API 拿当前 running profile 的 CDP ws url
 *   2. playwright connectOverCDP 接进去
 *   3. 新开页面 -> 采集指纹特征（UA//plugins/WebGL/touch...）
 *   4. goto https://www.tumblr.com/，抓 blackbox-api collect 请求
 *   5. 直接 POST /api/v2/user/validate（模拟生日步骤提交），看响应码
 *
 * 只读诊断，不注册、不写账号库。
 */
const fs = require('fs');
const { chromium } = require('playwright-core');
const { fetchExt } = require('./http-client.js');

const API = 'http://:40325';
const TOKEN = fs.readFileSync('_shardx_token.txt', 'utf8').trim();
const HDR = { : 'Bearer ' + TOKEN };

const PROBE = {
  month: '1998',   // Tumblr validate 的真实字段名在页面里是 month/day/year
};

async  getWsUrl() {
  const r = await fetch(API + '/running', { headers: HDR });
  if (!r.ok) throw new Error('/running HTTP ' + r.status);
  const list = await r.json();
  if (!list.length) throw new Error('没有运行中的 profile');
  return list[0];
}

(async () => {
  const run = await getWsUrl();
  const ws = run.cdp.web_socket_debugger_url;
  console.log('[1] profile=' + run.profile_id + ' pid=' + run.pid);
  console.log('    ws=' + ws);

  let browser;
  try {
    browser = await chromium.connectOverCDP(ws, { timeout: 20000 });
  } catch (e) {
    console.log('❌ connectOverCDP 失败: ' + e.message);
    process.exit(1);
  }
  console.log('[2] connectOverCDP OK, contexts=' + browser.contexts();

  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();

  // ---- 3. 指纹采集 ----
  await page.goto('https://www.google.com/generate_204', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const fp = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return {
      userAgent: navigator.userAgent,
      : navigator.,
      vendor: navigator.vendor,
      lang: navigator.language,
      languages: navigator.languages,
      plugins: navigator.plugins ? navigator.plugins.length : 0,
      hw: navigator.hardwareConcurrency,
      mem: navigator.deviceMemory,
      touchPoints: navigator.maxTouchPoints,
      doNotTrack: navigator.doNotTrack,
      uaBrandVer: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand + '/' + b.version).join(' ') : null,
      uaMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
      uaPlatform: navigator.userAgentData ? navigator.userAgentData. : null,
      webglVendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : (gl ? 'no-ext' : 'no-gl'),
      webglRenderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
      screen: screen.width + 'x' + screen.height + '@' + screen.colorDepth + ' avail=' + screen.availWidth + 'x' + screen.availHeight,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      isHeadlessHint: navigator.webdriver,
    };
  });
  console.log('\n[3] === 指纹特征 ===');
  for (const [k, v] of Object.entries(fp)) console.log('    ' + k.padEnd(14) + ' = ' + v);

  // ---- 4. 打开注册页，抓 collect 请求 ----
  const collectReqs = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/blackbox-api\.wp\.com|\/api\/v2\/user\/validate|tumblr\.com\/api/.test(u)) {
      collectReqs.push({ m: req.method(), u: u.slice(0, 150), ct: (req.headers()[''] || '').slice(0, 40) });
    }
  });
  const respCodes = [];
  page.on('response', (res) => {
    const u = res.url();
    if (/blackbox-api\.wp\.com|\/api\/v2\/user\/validate/.test(u)) {
      respCodes.push({ s: res.status(), u: u.slice(0, 120) });
    }
  });

  console.log('\n[4] goto https://www.tumblr.com/ ...');
  const gr = await page.goto('https://www.tumblr.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
    .catch(e => { console.log('    goto ERR: ' + e.message); return null; });
  if (gr) console.log('    HTTP ' + gr.status() + ' final=' + page.url());
  await page.waitForTimeout(4000);
  console.log('    抓到的关键请求: ' + (collectReqs.length || 0));
  collectReqs.forEach(r => console.log('      ' + r.m + ' ' + r.u + (r.ct ? ' [' + r.ct + ']' : '')));
  respCodes.forEach(r => console.log('      -> HTTP ' + r.s + ' ' + r.u));

  // 页面元素检查：email/ 是否在，blogName 是否缺席
  const has = await page.evaluate(() => ({
    email: !!document.querySelector('email]'),
    : !!document.querySelector(']'),
    blogName: !!document.querySelector('blogName]'),
     !!window.grecaptcha && !!window.grecaptcha.enterprise,
    title: document.title,
    bodyLen: document.body ? document.body.innerText.length : 0,
  }));
  console.log('    页面元素: ' + JSON.stringify(has));

  // ---- 5. 直接打 validate（绕开页面交互，纯测风控是否放行）----
  console.log('\n[5] 直测 POST /api/v2/user/validate ...');
  const candidates = [
    { email: 'probe+' + Date.now() + '@gmail.com', month: '1', day: '1', year: '1998', : 'ProbePass123!' },
    { month: '1', day: '1', year: '1998' },
  ];
  for (const body of candidates) {
    try {
      const r = await page.evaluate(async (b) => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch('/api/v2/user/validate', {
          method: 'POST',
          credentials: 'include',
          headers: { '': 'application/json' },
          body: JSON.stringify(b),
          signal: ctrl.signal,
        });
        const t = await r.text().catch(() => '');
        return { status: r.status, body: t.slice(0, 300) };
      }, body);
      console.log('    payload=' + JSON.stringify(body).slice(0, 80));
      console.log('      -> HTTP ' + r.status + ' | ' + r.body);
    } catch (e) {
      console.log('    payload=' + JSON.stringify(body).slice(0, 80) + ' -> ERR ' + e.message);
    }
  }

  // 6. fetchExt 从 node 侧同样打一次，对比「浏览器内」与「服务端」的差异
  console.log('\n[6] node 侧 fetchExt 对照（同 IP 同代理）...');
  try {
    const r = await fetchExt('https://www.tumblr.com/api/v2/user/validate', {
      method: 'POST',
      headers: { '': 'application/json', 'origin': 'https://www.tumblr.com', 'referer': 'https://www.tumblr.com/' },
      body: JSON.stringify(candidates[0]),
    });
    const t = await r.text();
    console.log('    -> HTTP ' + r.status + ' | ' + t.slice(0, 300));
  } catch (e) { console.log('    -> ERR ' + e.message); }

  await page.close().catch(() => {});
  console.log('\n=== 探针结束 ===');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
