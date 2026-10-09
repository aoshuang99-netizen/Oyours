#!/usr/bin/env node
/**
 * 截图 v14-console.html 首页（dashboard page）
 * 用途：首页面板重构前的视觉取证（只读，不改任何业务文件）
 * 输出：reports/shots/v14-dashboard-{full,fold,mobile}.png
 *
 * 登录处理：控制台有 authUser 门槛。本脚本自动尝试 /login 拿 session，
 * 失败则直接截（会拍到登录页）并如实报告，不伪造成功。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'reports', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.MSCMS_BASE || 'http://:3002';
const USER = process.env.MSCMS_USER || 'admin';
const PASS = process.env.MSCMS_PASS || '';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 200)));

  console.log('[1] 打开 ' + BASE + '/v14');
  // /v14 是 372KB 单文件 + 121KB 内联脚本，首次编译慢；给足超时并允许一次重试
  let resp = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      resp = await page.goto(BASE + '/v14', { waitUntil: 'load', timeout: 90000 });
      console.log('    HTTP', resp && resp.status(), '(第 ' + attempt + ' 次尝试)');
      break;
    } catch (e) {
      console.log('    第 ' + attempt + ' 次导航失败:', e.message.split('\n')[0]);
      if (attempt === 2) throw e;
      await page.waitForTimeout(3000);
    }
  }

  // 尝试登录（若被拦）
  const needLogin = await page.evaluate(() =>
    !!document.querySelector(']') ||
    /登录|login/i.test(document.title) ||
    location.pathname.includes('login')
  );
  console.log('    疑似登录页:', needLogin);

  if (needLogin && PASS) {
    console.log('[2] 尝试登录 ' + USER);
    try {
      await page.fill('text], ], #', USER).catch(() => {});
      await page.fill('], #', PASS).catch(() => {});
      await page.click('button[type=submit], .login-btn, button').catch(() => {});
      await page.waitForTimeout(3000);
      await page.goto(BASE + '/v14', { waitUntil: 'load', timeout: 90000 }).catch(() => {});
    } catch (e) {
      console.log('    登录失败:', e.message);
    }
  }

  // 等 Vue 渲染完成 + 首屏数据加载
  // 首页 dashboard 有 loading.dashboard 闸门，必须等它放行（pipeline-stage 出现）
  console.log('[3] 等待首屏数据加载…');
  try {
    await page.waitForSelector('.pipeline-stage', { timeout: 60000 });
    console.log('    ✅ pipeline 已渲染');
  } catch (e) {
    console.log('    ⚠️ 60s 内未等到 .pipeline-stage，按当前状态截图（如实记录）');
  }
  // 再等服务健康探活 + 罗盘 canvas 收尾
  await page.waitForTimeout(5000);

  // 收集首屏结构证据
  const info = await page.evaluate(() => {
    const app = document.getElementById('app');
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && getComputedStyle(el).display !== 'none';
    };
    const h1s = [...'h1')].filter(vis).map((e) => e.textContent.trim());
    const h2s = [...'h2')].filter(vis).map((e) => e.textContent.trim());
    const h3s = [...'h3')].filter(vis).map((e) => e.textContent.trim());
    const sects = [...'.dashboard-section-title')].filter(vis)
      .map((e) => e.textContent.trim().slice(0, 40));
    const cards = [...'.')].filter(vis);
    const panels = [...'.panel')].filter(vis);
    const stages = [...'.pipeline-stage')].filter(vis);
    const compass = [...'.compass-panel')].filter(vis);
    return {
      bodyH: document.body.scrollHeight,
      viewportH: window.innerHeight,
      h1s, h2s, h3s, sects,
      cardCount: cards.length,
      panelCount: panels.length,
      stageCount: stages.length,
      compassCount: compass.length,
      // 卡片可视高度分布
      cardHeights: cards.slice(0, 40).map((c) => Math.round(c.getBoundingClientRect().height)),
      // 侧栏有多少导航项
      navItems: [...'.nav-group-item,.nav-sub-item')].length,
      // 首屏内可见的卡片数（在 1050 高度内）
      cardsInFold: cards.filter((c) => c.getBoundingClientRect().top < window.innerHeight,
      errorBanner: (() => {
        const el = document.getElementById('global-error');
        return el && el.style.display !== 'none' ? el.textContent.slice(0, 300) : null;
      })(),
    };
  });

  console.log('\n════════ 首屏量化证据 ════════');
  console.log('文档总高:', info.bodyH, 'px   视口高:', info.viewportH, 'px');
  console.log('需滚动屏数:', (info.bodyH / info.viewportH).toFixed(1));
  console.log('可见 h1:', info.h1s.length, JSON.stringify(info.h1s));
  console.log('可见 h2:', info.h2s.length, JSON.stringify(info.h2s));
  console.log('可见 h3:', info.h3s.length);
  console.log('分组标题:', JSON.stringify(info.sects));
  console.log(' 可见数:', info.cardCount, '| panel 可见数:', info.panelCount);
  console.log('pipeline-stage 数:', info.stageCount, '| compass panel 数:', info.compassCount);
  console.log('首屏内  数:', info.cardsInFold);
  console.log('侧栏导航项数:', info.navItems);
  console.log('卡片高度样本:', JSON.stringify(info.cardHeights.slice(0, 20)));
  if (info.errorBanner) console.log('⚠️ 页面错误横幅:', info.errorBanner);
  if (errors.length) console.log('⚠️ JS 错误(' + errors.length + '):', errors.slice(0, 5));

  // ── 层级感量化：标题/卡片/间距的实际计算样式 ──
  const typo = await page.evaluate(() => {
    const pick = (sel, n = 3) => [...sel)].slice(0, n).map((e) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 34),
        font: cs.fontSize, weight: cs.fontWeight, color: cs.color,
        h: Math.round(r.height), w: Math.round(r.width),
        mt: cs.marginTop, mb: cs.marginBottom,
      };
    });
    return {
      h1: pick('h1', 2),
      sectionTitle: pick('.dashboard-section-title', 5),
      panelH3: pick('.panel-header h3', 3),
      statCard: pick('.', 4),
      domainCard: pick('.domain-card', 3),
      pipelineStage: pick('.pipeline-stage', 3),
      svcChip: pick('.svc-chip', 3),
      sub: pick('p.sub', 2),
    };
  });
  console.log('\n════════ 层级感量化（计算样式实测） ════════');
  const fmt = (label, arr) => {
    if (!arr || !arr.length) return;
    console.log('  ' + label + ':');
    arr.forEach((x) => console.log(
      '    ' + (x.font + '/' + x.weight).padEnd(13) +
      ('h=' + x.h + ' w=' + x.w).padEnd(15) +
      'mb=' + String(x.mb).padEnd(8) + ' │ ' + x.text
    ));
  };
  fmt('h1 页面标题', typo.h1);
  fmt('sub 副标题', typo.sub);
  fmt('分组标题 .dashboard-section-title', typo.sectionTitle);
  fmt('面板标题 .panel-header h3', typo.panelH3);
  fmt('KPI 卡 .', typo.statCard);
  fmt('七域卡 .domain-card', typo.domainCard);
  fmt('管道段 .pipeline-stage', typo.pipelineStage);
  fmt('服务 chip .svc-chip', typo.svcChip);

  // 字号去重统计
  const fontSet = new Set([
    ...typo.h1, ...typo.sectionTitle, ...typo.panelH3,
    ...typo.statCard, ...typo.domainCard, ...typo.pipelineStage,
  ].map((x) => x.font));
  console.log('\n  ▶ 以上元素的字号种类数:', fontSet.size, '→', [...fontSet].join(', '));

  console.log('\n════════ 截图 ════════');
  await page.screenshot({ path: path.join(OUT, 'v14-dashboard-fold.png') });
  console.log('  ✅ 首屏 v14-dashboard-fold.png');

  await page.screenshot({ path: path.join(OUT, 'v14-dashboard-full.png'), fullPage: true });
  console.log('  ✅ 全页 v14-dashboard-full.png');

  // 移动端
  await page.setViewportSize({ width: 414, height: 896 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'v14-dashboard-mobile.png') });
  console.log('  ✅ 移动端 v14-dashboard-mobile.png');

  await browser.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
