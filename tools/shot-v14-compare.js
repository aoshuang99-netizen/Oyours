#!/usr/bin/env node
/**
 * 截图重构原型并量化对比「层级感」（只读）
 * 对比对象：线上 /v14 首页 dashboard vs /v14-redesign-preview.html
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'reports', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://:3002';
const PASS = process.env.MSCMS_PASS || '';

async  audit(page, label) {
  const d = await page.evaluate(() => {
    const main = document.querySelector('main.main') || document.querySelector('.wrap') || document.body;
    const sc = document.querySelector('main.main') || document.querySelector('.wrap') || document.documentElement;
    // 收集所有可见文本元素的字号
    const fonts = {};
    const all = [...main.querySelectorAll('h1,h2,h3,div,span,b,td,th,p,summary')]
      .filter((e) => {
        if (!e.offsetParent && e.tagName !== 'BODY') return false;
        const t = (e.textContent || '').trim();
        if (!t || t.length > 60) return false;
        // 只取叶子节点（避免父容器重复计数）
        return ![...e.children].some((c) => (c.textContent || '').trim( > 0);
      });
    all.forEach((e) => {
      const fsx = getComputedStyle(e).fontSize;
      fonts[fsx] = (fonts[fsx] || 0) + 1;
    });
    const secTitles = [...main.querySelectorAll('h2, .dashboard-section-title')].map((e) => ({
      t: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26),
      fs: getComputedStyle(e).fontSize,
      mt: getComputedStyle(e).marginTop,
    }));
    const h1 = [...main.querySelectorAll('h1')].map((e) => ({
      t: (e.textContent || '').trim().slice(0, 26),
      fs: getComputedStyle(e).fontSize,
    }));
    // 顶层模块数（首屏内）
    const topBlocks = [...main.children].map((e) => ({
      cls: (e.className || '').split(' ')[0] || e.tagName.toLowerCase(),
      h: Math.round(e.getBoundingClientRect().height),
    }));
    return {
      scrollH: sc.scrollHeight, clientH: sc.clientHeight,
      fonts, secTitles, h1, topBlocks,
      screens: +(sc.scrollHeight / sc.clientHeight).toFixed(2),
    };
  });

  console.log('\n════════ ' + label + ' ════════');
  console.log('总高 ' + d.scrollH + 'px / 视口 ' + d.clientH + 'px → ' + d.screens + ' 屏');
  console.log('H1: ' + JSON.stringify(d.h1));
  console.log('分组标题 (' + d.secTitles.length + ' 个):');
  d.secTitles.forEach((s) => console.log('   ' + s.fs.padEnd(8) + ' mt=' + s.mt.padEnd(8) + ' | ' + s.t));
  console.log('顶层模块 (' + d.topBlocks.length + ' 个):');
  d.topBlocks.forEach((b) => console.log('   h=' + String(b.h).padStart(4) + '  ' + b.cls));
  const fsSorted = Object.entries(d.fonts).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
  console.log('字号分布 (' + fsSorted.length + ' 种): ' +
    fsSorted.map(([k, v]) => k + '×' + v).join('  '));
  return d;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push('PAGEERROR: ' + e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('CONSOLE: ' + m.text().slice(0, 160)); });

  // ---------- 1. 线上首页 ----------
  await page.goto(BASE + '/v14', { waitUntil: 'load', timeout: 90000 });
  if (await page.evaluate(() => !!document.querySelector(']')) && PASS) {
    await page.fill('text], ], #', 'admin').catch(() => {});
    await page.fill('], #', PASS).catch(() => {});
    await page.click('button[type=submit], button').catch(() => {});
    await page.waitForTimeout(3000);
    await page.goto(BASE + '/v14', { waitUntil: 'load', timeout: 90000 }).catch(() => {});
  }
  await page.waitForSelector('.pipeline-stage', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const before = await audit(page, '改前 · 线上 /v14 首页');
  await page.screenshot({ path: path.join(OUT, 'cmp-before.png') });

  // ---------- 2. 重构原型 ----------
  await page.goto(BASE + '/v14-redesign-preview.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('.hero-card', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const after = await audit(page, '改后 · /v14-redesign-preview.html');
  await page.screenshot({ path: path.join(OUT, 'cmp-after.png') });
  await page.setViewportSize({ width: 414, height: 896 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'cmp-after-mobile.png') });
  await page.setViewportSize({ width: 1680, height: 1050 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'cmp-after-full.png'), fullPage: true });

  console.log('\n════════ 对比小结 ════════');
  console.log('JS 错误   共 ' + jsErrors.length + ' 条' + (jsErrors.length ? '  ← 必须为 0' : ''));
  jsErrors.slice(0, 8).forEach((e) => console.log('   ! ' + e));
  console.log('页高      ' + before.scrollH + 'px  →  ' + after.scrollH + 'px');
  console.log('屏数      ' + before.screens + '  →  ' + after.screens);
  console.log('首屏模块  ' + before.topBlocks.filter((b) => b.h > 0 + '  →  ' + after.topBlocks.filter((b) => b.h > 0);
  console.log('分组标题  ' + before.secTitles.length + '  →  ' + after.secTitles.length);
  console.log('字号种类  ' + Object.keys(before.fonts + '  →  ' + Object.keys(after.fonts);

  await browser.close();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
