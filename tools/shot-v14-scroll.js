#!/usr/bin/env node
/**
 * 抓取 v14-console.html 首页的滚动容器与整页长度，并按屏分段截图（只读）
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'reports', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:3002';
const USER = 'admin', PASS = process.env.MSCMS_PASS || '';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  const page = await ctx.newPage();

  await page.goto(BASE + '/v14', { waitUntil: 'load', timeout: 90000 });
  const needLogin = await page.evaluate(() => !!document.querySelector('input[type=password]'));
  if (needLogin && PASS) {
    await page.fill('input[type=text], input[name=username], #username', USER).catch(() => {});
    await page.fill('input[type=password], #password', PASS).catch(() => {});
    await page.click('button[type=submit], .login-btn, button').catch(() => {});
    await page.waitForTimeout(3000);
    await page.goto(BASE + '/v14', { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  }
  await page.waitForSelector('.pipeline-stage', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // 找滚动容器：主内容区固定为 main.main（aside 也在滚动，需排除）
  const scroller = await page.evaluate(() => {
    const main = document.querySelector('main.main') || document.querySelector('main');
    const aside = document.querySelector('aside.sidebar');
    const out = [];
    const push = (e, name) => {
      if (!e) return;
      out.push({
        name,
        tag: e.tagName.toLowerCase(),
        cls: (e.className || '').toString().slice(0, 40),
        clientH: e.clientHeight,
        scrollH: e.scrollHeight,
        screens: +(e.scrollHeight / e.clientHeight).toFixed(2),
      });
    };
    push(aside, 'sidebar');
    push(main, 'main');
    return out;
  });
  console.log('════════ 滚动容器 ════════');
  scroller.forEach((s) => console.log(
    '  [' + s.name + '] <' + s.tag + ' class="' + s.cls + '">  clientH=' + s.clientH +
    '  scrollH=' + s.scrollH + '  → ' + s.screens + ' 屏'
  ));
  const mainScrollH = (scroller.find((s) => s.name === 'main') || {}).scrollH || 0;
  const screens = Math.ceil(mainScrollH / 1050);
  console.log('\n▶ 首页总高约 ' + mainScrollH + 'px ≈ ' + screens + ' 屏（1680×1050）');

  // 每个主区块的相对位置（判断首屏该放什么）
  const blocks = await page.evaluate(() => {
    const cont = document.querySelector('main.main') || document.querySelector('main') || document.body;
    const top = cont.getBoundingClientRect().top;
    const items = [];
    // 区块边界：h1 / section-title / panel / pipeline
    const marks = [...cont.querySelectorAll('h1, .dashboard-section-title, .panel, .pipeline, .stats, .sys-status-banner, .pipeline-start-bar, .grid-2')];
    marks.forEach((e) => {
      const r = e.getBoundingClientRect();
      const off = Math.round(r.top - top + cont.scrollTop);
      const cs = getComputedStyle(e);
      items.push({
        off,
        h: Math.round(r.height),
        kind: e.tagName === 'H1' ? 'H1' : (e.className || '').toString().split(' ')[0],
        text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46),
        font: cs.fontSize,
      });
    });
    return { items, total: cont.scrollHeight };
  });

  console.log('\n════════ 首页区块纵向分布（偏移量 / 高度 / 字号） ════════');
  blocks.items.forEach((b) => {
    const fold = b.off < 1050 ? '首屏' : ('第' + (Math.floor(b.off / 1050) + 1) + '屏');
    console.log(
      '  y=' + String(b.off).padStart(5) + '  h=' + String(b.h).padStart(4) +
      '  ' + b.font.padEnd(8) + ' [' + fold + '] ' + b.kind.padEnd(24) + b.text
    );
  });

  // 分段截图
  console.log('\n════════ 分段截图 ════════');
  const contSel = 'main.main';
  for (let i = 0; i < Math.min(screens, 6); i++) {
    await page.evaluate(({ sel, y }) => {
      const el = sel ? document.querySelector(sel) : document.scrollingElement;
      if (el) el.scrollTop = y;
    }, { sel: contSel, y: i * 1050 });
    await page.waitForTimeout(900);
    const f = path.join(OUT, 'v14-dash-s' + (i + 1) + '.png');
    await page.screenshot({ path: f });
    console.log('  ✅ v14-dash-s' + (i + 1) + '.png  (y=' + (i * 1050) + ')');
  }

  await browser.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
