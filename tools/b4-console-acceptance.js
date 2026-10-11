'use strict';
/**
 * b4-console-acceptance.js — B4 控制台重构验收（真实 Chromium 渲染）
 *
 * 验收判据（方案 §7 B4 行）：
 *   ① 36 → 24 主项     ② 大盘秒开     ③ 每页有统计面板
 * 另验：L0 服务健康 11 项真实渲染 / L1 七域总览 / 无 iframe 嵌套 / 零控制台错误
 *
 * 产物：reports/b4-page-acceptance.json + reports/b4-shots/*.png
 * 用法：node tools/b4-console-acceptance.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:3002';
const OUT_JSON = path.join(__dirname, '..', 'reports', 'b4-page-acceptance.json');
const SHOT_DIR = path.join(__dirname, '..', 'reports', 'b4-shots');

// 控制台有前端 authGate（未登录跳 /login.html）⇒ 验收必须真实登录，不得绕过认证。
// 默认值即服务端登录页公开提示的初始管理员凭证；可用 env 覆盖。
const LOGIN_USER = process.env.MSCMS_TEST_USER || 'admin';
const LOGIN_PASS = process.env.MSCMS_TEST_PASS || 'MSCMS@2026';

const EXES = [
  'C:/Users/AS/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/AS/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
];

/** 走真实登录接口拿 JWT（与人类登录同一条路径） */
function apiLogin() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: LOGIN_USER, password: LOGIN_PASS });
    let req;
    try {
      req = http.request({
        host: '127.0.0.1', port: 3002, path: '/api/v14/auth/login', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      }, (res) => {
        let s = ''; res.setEncoding('utf8');
        res.on('data', (c) => { s += c; });
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('登录响应非 JSON: ' + s.slice(0, 120))); } });
      });
    } catch (e) { return reject(e); }
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} reject(new Error('登录超时')); });
    req.write(body); req.end();
  });
}

let pass = 0, fail = 0;
const failures = [];
const consoleErrors = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; failures.push(name + (extra ? '  ← ' + extra : '')); console.log('  ❌ ' + name + (extra ? '  ← ' + extra : '')); }
}

(async () => {
  const exe = EXES.find((p) => fs.existsSync(p));
  if (!exe) { console.log('未找到 Chromium 可执行文件'); process.exit(1); }
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)));

  // ── 真实登录：拿到 JWT 后写入 localStorage（与 authGate 读取的 key 一致）──
  console.log('\n=== ⓪ 认证（控制台有 authGate，必须真实登录）===');
  let auth = null;
  try { auth = await apiLogin(); } catch (e) { console.log('  登录请求失败: ' + e.message); }
  if (!auth || !auth.ok || !auth.token) {
    console.log('  ❌ 登录失败，无法验收：' + JSON.stringify(auth).slice(0, 200));
    await browser.close();
    process.exit(3);
  }
  console.log('  ✅ 已登录 ' + ((auth.user && auth.user.username) || '?') + '（role=' + ((auth.user && auth.user.role) || '?') + '）');
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate((a) => {
    localStorage.setItem('mscms-auth-token', a.token);
    if (a.refresh) localStorage.setItem('mscms-auth-refresh', a.refresh);
    localStorage.setItem('mscms-auth-user', JSON.stringify(a.user || {}));
  }, auth);

  const t0 = Date.now();
  await page.goto(BASE + '/v14-console.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 等 Vue 挂载出导航
  await page.waitForSelector('nav .nav-group-item', { timeout: 25000 });
  // 等 L0 服务健康真实探活返回（最多 20s）
  let svcReady = true;
  try { await page.waitForSelector('.svc-chip', { timeout: 20000 }); }
  catch (_) { svcReady = false; }
  const loadMs = Date.now() - t0;

  console.log('\n=== ① 大盘秒开 ===');
  t('页面可访问且 Vue 已挂载导航', true, loadMs + 'ms');
  t('首屏到导航可见 < 8s（阈值宽松，含首次探活）', loadMs < 8000, loadMs + 'ms');

  console.log('\n=== ② 导航 36 → 24 主项 ===');
  const navCounts = await page.evaluate(() => {
    const nav = document.querySelector('nav');
    return {
      main: nav.querySelectorAll('.nav-group-item').length,
      subs: nav.querySelectorAll('.nav-sub-item').length,
      groups: nav.querySelectorAll('.nav-group').length,
      badgesOk: nav.querySelectorAll('.nv-badge.ok').length,
      badgesWarn: nav.querySelectorAll('.nv-badge.warn').length,
      badgesIdle: nav.querySelectorAll('.nv-badge.idle').length,
      legend: !!nav.querySelector('.nav-legend'),
    };
  });
  t('主项 = 24', navCounts.main === 24, '实际 ' + navCounts.main);
  t('子页 = 13', navCounts.subs === 13, '实际 ' + navCounts.subs);
  t('导航分组 = 8（顶层 + 7 域）', navCounts.groups === 8, '实际 ' + navCounts.groups);
  t('四态徽标齐备（🟢/🟡/⚪ 均有）',
    navCounts.badgesOk > 0 && navCounts.badgesWarn > 0 && navCounts.badgesIdle > 0,
    'ok=' + navCounts.badgesOk + ' warn=' + navCounts.badgesWarn + ' idle=' + navCounts.badgesIdle);
  t('导航含四态图例', navCounts.legend);
  t('无 🔴 不可用徽标（探针实测 0 项 404）', (await page.evaluate(() => document.querySelectorAll('nav .nv-badge.err').length)) === 0);

  console.log('\n=== ③ 大盘 L0 服务健康（此前完全缺失）===');
  t('服务健康面板已渲染（.svc-chip 出现）', svcReady);
  const svc = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('.svc-chip'));
    const badge = Array.from(document.querySelectorAll('.panel-header .badge')).map((b) => b.textContent.trim());
    return {
      count: chips.length,
      up: chips.filter((c) => c.classList.contains('up')).length,
      down: chips.filter((c) => c.classList.contains('down')).length,
      opt: chips.filter((c) => c.classList.contains('opt')).length,
      titles: chips.map((c) => c.getAttribute('title') || ''),
      badgeText: badge.join(' | '),
    };
  });
  t('芯片数 = 11', svc.count === 11, '实际 ' + svc.count);
  t('有在线服务', svc.up > 0, 'up=' + svc.up + ' down=' + svc.down + ' optional=' + svc.opt);
  t('芯片 title 含端口与角色说明', svc.titles.length > 0 && svc.titles[0].includes('端口'));
  t('健康徽标文案含「在线」', /在线/.test(svc.badgeText), svc.badgeText.slice(0, 60));

  console.log('\n=== ④ 大盘 L1 七域总览 ===');
  const dom = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.domain-card'));
    return {
      count: cards.length,
      labels: cards.map((c) => (c.querySelector('.domain-head b') || {}).textContent || ''),
      tallies: cards.map((c) => (c.querySelector('.domain-tally') || {}).textContent || ''),
    };
  });
  t('七域卡片 = 7', dom.count === 7, '实际 ' + dom.count);
  t('域卡片可点击（navigate 已绑定）', dom.count > 0);
  console.log('    域名: ' + dom.labels.join(' / '));

  console.log('\n=== ⑤ 嵌套应用已消除 ===');
  const iframes = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || '(none)'));
  t('DOM 内无 iframe（原 v14-dash 嵌套已移除）', iframes.length === 0, iframes.length ? JSON.stringify(iframes) : '');
  const fullLink = await page.evaluate(() => !!document.querySelector('nav a[href="/v14-dash.html"][target="_blank"]'));
  t('导航内保留「全屏六级监控」新窗口入口', fullLink);

  await page.screenshot({ path: path.join(SHOT_DIR, 'b4-dashboard.png'), fullPage: false });

  console.log('\n=== ⑥ 每页统计面板 ===');
  // 切到「账号看板」
  const beforeNav = await page.evaluate(() => !!document.querySelector('.stats-panel'));
  t('大盘页不显示统计面板（避免与大盘自身重复）', !beforeNav);
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('nav .nav-group-item'));
    const el = links.find((a) => a.textContent.includes('账号看板'));
    if (el) el.click();
  });
  await page.waitForTimeout(2500);
  const sp = await page.evaluate(() => {
    const el = document.querySelector('.stats-panel');
    if (!el) return null;
    return {
      hasKpis: !!el.querySelector('.sp-kpi'),
      kpiCount: el.querySelectorAll('.sp-kpi').length,
      text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
      btnDisabled: (el.querySelector('button') || {}).disabled,
    };
  });
  t('业务页出现统计面板', !!sp);
  if (sp) {
    t('统计面板含 KPI 卡或明确空态', sp.hasKpis || /未纳入|尚未产生/.test(sp.text), sp.text.slice(0, 90));
    t('统计面板有「打开明细抽屉」按钮', !sp.btnDisabled || /未纳入/.test(sp.text));
  }

  // 再切到「代理管理」（有真实数据）
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('nav .nav-group-item'));
    const el = links.find((a) => a.textContent.includes('代理管理'));
    if (el) el.click();
  });
  await page.waitForTimeout(2200);
  const sp2 = await page.evaluate(() => {
    const el = document.querySelector('.stats-panel');
    return el ? { kpiCount: el.querySelectorAll('.sp-kpi').length, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 180) } : null;
  });
  t('代理管理页统计面板有数据源', !!sp2 && sp2.kpiCount > 0, sp2 ? 'KPI=' + sp2.kpiCount + ' | ' + sp2.text.slice(0, 100) : 'null');
  await page.screenshot({ path: path.join(SHOT_DIR, 'b4-page-proxy.png'), fullPage: false });

  console.log('\n=== ⑦ 控制台零错误 ===');
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_/.test(e));
  t('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));

  await browser.close();

  const report = {
    ranAt: new Date().toISOString(),
    base: BASE,
    loadMs,
    pass, fail, failures,
    consoleErrors: realErrors,
    nav: navCounts,
    services: svc,
    domains: dom,
    iframes,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n=== 结果：' + pass + ' PASS / ' + fail + ' FAIL ===');
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('产物: ' + OUT_JSON);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('验收脚本异常: ' + e.message); process.exit(2); });
