/**
 * tools/b2-live-page-acceptance.js — B2 页面验收（真实 Chromium）
 *
 * 运行：node tools/b2-live-page-acceptance.js
 *
 * 为什么不用 agent-browser：
 *   /v14-live.html 是 SSE 长连接页面，networkidle 永远不会到达，
 *   `agent-browser open` 会永久挂起（实测挂 5 分钟）。这里用 playwright-core
 *   显式 waitUntil:'domcontentloaded'，绕开该缺陷。
 *
 * 验收项：
 *   1. 页面无 JS 运行时错误（console error / pageerror）
 *   2. 无失败请求（404 等）
 *   3. SSE 连接成功且收到帧（连接状态文案 + 帧计数）
 *   4. KPI 卡渲染出非占位数值
 *   5. 因果链阶段渲染
 *   6. 轮询页（dash）默认刷新间隔 = 10 分钟且显示为「轮询」而非假的「实时」
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE_CANDIDATES = [
  'C:/Users/AS/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Users/AS/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe',
];
const BASE = process.env.MSCMS_BASE || 'http://:3002';
const OUT_DIR = path.join(__dirname, '..', 'reports');
const SHOT_DIR = path.join(OUT_DIR, 'b2-shots');

let pass = 0, fail = 0;
const fails = [];
 t(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(`${name}\n      expected ${e}\n      actual   ${a}`); console.log('  ✗ ' + name + '  expected=' + e + ' actual=' + a); }
}
 tOk(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
}

 pickExe() {
  for (const p of EXE_CANDIDATES) { if (fs.existsSync(p)) return p; }
  throw new Error('未找到 Chromium 可执行文件，候选：' + EXE_CANDIDATES.join(', '));
}

(async  main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const exe = pickExe();
  console.log('Chromium:', exe);
  console.log('Base    :', BASE);
  console.log('');

  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const summary = { live: null, dash: null };

  try {
    // ══════════════════════════════════════════════
    // 场景 1：/v14-live.html 秒级实时页（SSE）
    // ══════════════════════════════════════════════
    console.log('── 场景 1：/v14-live.html（SSE 实时页）──');
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
      const page = await ctx.newPage();
      const consoleErrors = [], pageErrors = [], failedReqs = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('requestfailed', (r) => failedReqs.push(r.url() + ' :: ' + ((r.failure() || {}).errorText || '?')));

      await page.goto(BASE + '/v14-live.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 等 SSE 握手 + 首帧 + 至少一次定时 tick（服务端 5s 一轮）
      await page.waitForTimeout(13000);

      const s1 = await page.evaluate(() => {
        const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
        const cls = (id) => { const e = document.getElementById(id); return e ? e.className : null; };
        const cards = [];
        '#cards .card').forEach((c) => {
          const k = c.querySelector('.k'), v = c.querySelector('.v');
          cards.push({ k: k ? k.textContent.trim() : null, v: v ? v.textContent.trim() : null, pending: v ? v.classList.contains('pending') : null });
        });
        const v = (id) => { const e = document.querySelector('#' + id + ' .v'); return e ? e.textContent.trim() : null; };
        return {
          connTxt: txt('conn-txt'), connDot: cls('conn-dot'),
          lastTs: txt('last-ts'), frameN: txt('frame-n'),
          cardCount: cards.length, cards,
          phaseCount: '#chain .phase',
          feedCount: '#feed .ev',
          mInterval: txt('m-interval'), mTtl: txt('m-ttl'), mSubs: txt('m-subs'),
          mPushed: txt('m-pushed'), mSkipped: txt('m-skipped'), mHit: txt('m-hit'),
          noticeClass: cls('notice'),
          hasEmptyFeed: !!document.querySelector('#feed .empty'),
        };
      });

      const shot = path.join(SHOT_DIR, 'v14-live.png');
      await page.screenshot({ path: shot, fullPage: true });

      t('live: 无 JS 运行时错误', pageErrors, []);
      t('live: 无 console error', consoleErrors, []);
      t('live: 无失败请求', failedReqs, []);
      t('live: SSE 连接状态为「实时」', s1.connTxt, '实时');
      tOk('live: 连接指示点为绿色 live 态', String(s1.connDot).includes('live'), s1.connDot);
      tOk('live: 已收到数据帧（frames > 0）', Number(s1.frameN) > 0, 'frame-n=' + s1.frameN);
      t('live: KPI 卡数量 = 12', s1.cardCount, 12);
      tOk('live: 至少 10 张卡有真实数值（非占位 —）',
        s1.cards.filter((c) => c.v && c.v !== '—' >= 10,
        '有值卡数=' + s1.cards.filter((c) => c.v && c.v !== '—');
      tOk('live: 因果链阶段已渲染（>=7）', s1.phaseCount >= 7, 'phases=' + s1.phaseCount);
      tOk('live: 事件流已收到条目', s1.feedCount > 0, 'feed=' + s1.feedCount);
      t('live: 推送间隔显示 5s', s1.mInterval, '5s');
      t('live: 缓存 TTL 显示 60s', s1.mTtl, '60s');
      tOk('live: 订阅客户端数已显示', s1.mSubs !== null && s1.mSubs !== '—', 'subs=' + s1.mSubs);
      tOk('live: 未误报 stale 告警', !String(s1.noticeClass).includes('show'), s1.noticeClass);
      tOk('live: 已产生推送/跳过统计', Number(s1.mPushed) > 0, 'pushed=' + s1.mPushed + ' skipped=' + s1.mSkipped);

      // 二次采样：验证「持续在线 + 帧继续累积」
      await page.waitForTimeout(7000);
      const frameN2 = await page.evaluate(() => { const e = document.getElementById('frame-n'); return e ? e.textContent.trim() : null; });
      const conn2 = await page.evaluate(() => { const e = document.getElementById('conn-txt'); return e ? e.textContent.trim() : null; });
      t('live: 7s 后仍保持「实时」（长连接未断）', conn2, '实时');
      tOk('live: 帧计数非递减（持续接收）', Number(frameN2) >= Number(s1.frameN), s1.frameN + ' → ' + frameN2);

      summary.live = { ...s1, frameN2, screenshot: shot, consoleErrors, pageErrors, failedReqs };
      await ctx.close();
    }

    console.log('');

    // ══════════════════════════════════════════════
    // 场景 2：/v14-dash.html 轮询页（10 分钟默认 + 诚实刷新态）
    // ══════════════════════════════════════════════
    console.log('── 场景 2：/v14-dash.html（轮询页 · 10 分钟默认）──');
    {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 980 } });
      const page = await ctx.newPage();
      const consoleErrors = [], pageErrors = [], failedReqs = [], badReqs = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('requestfailed', (r) => failedReqs.push(r.url() + ' :: ' + ((r.failure() || {}).errorText || '?')));
      page.on('response', (r) => { if (r.status() >= 400) badReqs.push(r.status() + ' ' + r.url()); });

      await page.goto(BASE + '/v14-dash.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(9000);

      const s2 = await page.evaluate(() => {
        const on = document.querySelector('#refreshseg button.on');
        const lt = document.getElementById('livetxt'), ld = document.getElementById('livedot');
        return {
          onBtnDataR: on ? on.getAttribute('data-r') : null,
          onBtnText: on ? on.textContent.trim() : null,
          refreshBtnCount: '#refreshseg button',
          liveTxt: lt ? lt.textContent.trim() : null,
          liveDot: ld ? ld.className : null,
          stateRefresh: (typeof state !== 'undefined' && state) ? state.refresh : null,
          hasTimer: (typeof state !== 'undefined' && state) ? !!state.timer : null,
        };
      });

      const shot2 = path.join(SHOT_DIR, 'v14-dash.png');
      await page.screenshot({ path: shot2, fullPage: false });

      t('dash: 无 JS 运行时错误', pageErrors, []);
      t('dash: 默认选中 10 分钟（data-r=600）', s2.onBtnDataR, '600');
      t('dash: 默认按钮文案 = 10m', s2.onBtnText, '10m');
      t('dash: 刷新分段含 6 个选项（含「实时」入口）', s2.refreshBtnCount, 6);
      tOk('dash: 状态文案不再是误导性的「实时」', s2.liveTxt !== '实时', 'livetxt=' + s2.liveTxt);
      tOk('dash: 状态文案如实标注轮询间隔', String(s2.liveTxt).includes('轮询'), 'livetxt=' + s2.liveTxt);
      t('dash: state.refresh = 600', s2.stateRefresh, 600);
      t('dash: 轮询定时器已启动', s2.hasTimer, true);
      t('dash: 无 4xx/5xx 响应', badReqs, []);
      t('dash: 无失败请求', failedReqs, []);

      summary.dash = { ...s2, screenshot: shot2, consoleErrors, pageErrors, failedReqs, badReqs };
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // ── 汇总 ──
  console.log('');
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('');
  }
  const out = path.join(OUT_DIR, 'b2-page-acceptance.json');
  fs.writeFileSync(out, JSON.stringify({ ok: fail === 0, pass, fail, fails, summary, at: new Date().toISOString() }, null, 2), 'utf-8');
  console.log(`B2 页面验收：${pass}/${pass + fail} PASS，${fail} FAIL`);
  console.log('截图：', SHOT_DIR);
  console.log('报告：', out);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验收脚本异常:', e && e.stack ? e.stack : e);
  process.exit(2);
});
