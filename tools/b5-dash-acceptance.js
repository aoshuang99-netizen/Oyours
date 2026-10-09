#!/usr/bin/env node
'use strict';
/**
 * tools/b5-dash-acceptance.js — B5「时间维度 + 可视化」真实浏览器验收
 * =========================================================================
 * 用 playwright-core 驱动本机 Edge（Chromium 内核）打开真实 3002 服务页面，验收：
 *   1. v14-chart.js 是否真的加载并挂载了顶栏时间维度控件
 *   2. 8 域 × 44 tab 逐页切换：是否有 JS 报错 / 面板渲染失败 / 未捕获拒绝
 *   3. 时间维度 今日→本周→本月→本年→自定义 切换后，图表是否【真的变了】
 *      （比较 SVG 折线路径 d 与 x 轴标签；路径完全不变即视为「切了没生效」）
 *   4. 自定义窗口非法（起始 >= 结束）是否被拒绝：控件报错 + 图表口径【不变】
 *   5. 迷你趋势列（.msc-spark）是否出现
 *
 * 零伪造：本脚本只读取浏览器里的真实 DOM/控制台，不注入任何假数据；
 *   任何一项不达标都如实计入 FAIL 并以非 0 退出码结束。
 *
 * 用法：node tools/b5-dash-acceptance.js [--base http://:3002] [--headed]
 * =========================================================================
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = argOf('--base', process.env.MSCMS_BASE || 'http://:3002');
const HEADED = argv.includes('--headed');
const OUT_DIR = process.env.MSCMS_REPORT_DIR || 'D:\\mscms-ws\\reports\\b5';
const QUIET_MS = Number(process.env.MSCMS_B5_QUIET_MS || 1500);

// [tabId, tabLabel]；tabLabel 用于「页面错位」回归断言（实际渲染标题必须与请求的 tab 一致）
const MENUS = [
  { id: 'ov', tabs: [['compass', '核心指标罗盘'], ['causal', '7 阶段漏斗'], ['timeline', '周期时间线'], ['guard', '停滞守卫·转化率']] },
  { id: 'acct', tabs: [['overview', '账号全景'], ['s', '平台分布'], ['', '注册工厂'], ['nurture', '养号监控'], ['closedloop', '闭环一致性'], ['fleet', '云手机舰队'], ['finger', '指纹反检测'], ['proxy', '代理健康'], ['exits', '出口调度·IP'], ['keepalive', '保活自愈']] },
  { id: 'content', tabs: [['factory', '内容工厂'], ['editor', '内容编辑'], ['funnel', '发布漏斗'], ['loop', '平台闭环'], ['inspire', '热点灵感·视频工厂'], ['tumblr', 'Tumblr 发布台'], ['providers', 'Mixpost 提供方'], ['posts', '版本化发布'], ['hashtags', '标签组']] },
  { id: 'traffic', tabs: [['overview', '引流总览'], ['matrix', '链接矩阵'], ['trend', '流量趋势'], ['dau', 'DAU 监控'], ['scrm', 'SCRM 私域']] },
  { id: 'conv', tabs: [['funnel', '转化漏斗'], ['ab', 'A-B 实验'], ['attr', '归因模型'], ['cloak', 'Cloaking 风控'], ['alerts', '告警中心']] },
  { id: 'mkt', tabs: [['overview', '营销总览'], ['campaigns', '活动编排'], ['quick', '快速任务']] },
  { id: 'sysops', tabs: [['health', '系统健康'], ['dag', 'DAG 拓扑'], ['bus', '事件总线'], ['decision', '决策引擎']] },
  { id: 'ai', tabs: [['insight', 'AI 洞察'], ['nlq', 'AI 问答'], ['report', '周报月报'], ['root', '根因建议']] },
];

let pass = 0, fail = 0;
const findings = [];
 ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; findings.push({ name, detail: detail || '' }); console.log('  ❌ ' + name + (detail ? '\n        ' + detail : '')); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 等页面渲染稳定：轮询 #scroll，直到内容非空、不含「加载中…」且长度连续两次不变。
 * 必要性：gotoPage() 会连发两次渲染，且各页接口耗时不同，固定 sleep 会读到中间态
 * （曾把 traffic/matrix 的内容误读成 traffic/trend 的验收结果）。
 */
async  waitStable(page, timeoutMs) {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    const cur = await page.evaluate(() => {
      const sc = document.querySelector('#scroll');
      const h = sc ? sc.innerHTML : '';
      return { len: h.length, loading: /加载中…/.test(h) };
    });
    if (!cur.loading && cur.len > 100 && cur.len === last) stable++; else stable = 0;
    last = cur.len;
    if (stable >= 3) return true;
    await sleep(250);
  }
  return false;
}

(async () => {
  const started = Date.now();
  const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
  page.on('pageerror', e => pageErrors.push(String(e && e.message || e).slice(0, 400)));
  page.on('requestfailed', r => {
    const u = r.url();
    // favicon 之类的无关请求不计入
    if (/favicon|\.map$/.test(u)) return;
    failedReqs.push(u.slice(0, 160) + ' :: ' + (r.failure() && r.failure().errorText));
  });

  console.log('=== 打开 ' + BASE + '/v14-dash.html ===');
  await page.goto(BASE + '/v14-dash.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(QUIET_MS + 1500);

  // ── 1) 组件与控件挂载 ──────────────────────────────────────────────
  console.log('\n=== 1. 组件加载与时间维度控件挂载 ===');
  const mounted = await page.evaluate(() => ({
    hasComp: typeof window.MSCMSChart === 'object' && !!window.MSCMSChart.version,
    version: window.MSCMSChart && window.MSCMSChart.version,
    ctrl: !!document.querySelector('#tdhost .msc-td'),
    btns: Array.from('#tdhost .msc-td-b')).map(b => b.getAttribute('data-r')),
    gran: (document.querySelector('#tdhost [data-msc-gran]') || {}).textContent || '',
    allowed: !!(window.MSCMSChart && MSCMSChart.RANGES),
    state: window.MSCMSChart ? MSCMSChart.timeState.get() : null,
  }));
  ok('v14-chart.js 已加载（版本 ' + mounted.version + '）', mounted.hasComp);
  ok('顶栏时间维度控件已挂载', mounted.ctrl);
  ok('五个维度按钮齐全', JSON.stringify(mounted.btns) === JSON.stringify(['today', 'week', 'month', 'year', 'custom']),
    '实际：' + JSON.stringify(mounted.btns));
  ok('控件显示自动粒度（' + mounted.gran.trim() + '）', /粒度/.test(mounted.gran));
  ok('初始状态为今日', mounted.state && mounted.state.range === 'today', JSON.stringify(mounted.state));

  // ── 2) 全量页面遍历 ────────────────────────────────────────────────
  console.log('\n=== 2. 8 域 × 44 tab 逐页遍历 ===');
  const perTab = [];
  const totalTabs = MENUS.reduce((s, m) => s + m.tabs.length, 0);
  let visited = 0;
  for (const m of MENUS) {
    for (const [t, tlabel] of m.tabs) {
      const beforeErr = consoleErrors.length + pageErrors.length;
      await page.evaluate(([mid, tid]) => { if (typeof gotoPage === '') gotoPage(mid, tid); else location.hash = mid + '/' + tid; }, [m.id, t]);
      const settled = await waitStable(page, 25000);
      const st = await page.evaluate(() => {
        const sc = document.querySelector('#scroll');
        const html = sc ? sc.innerHTML : '';
        return {
          renderFail: /该面板渲染失败/.test(html),
          charts: '#scroll svg.msc-svg',
          nodata: '#scroll .msc-nodata',
          chartErr: '#scroll .msc-err',
          sparks: '#scroll .msc-spark',
          dashes: '#scroll .msc-tdim',
          tsHosts: '#scroll [data-ts-key]',
          ttl: ((document.querySelector('#ttl') || {}).textContent || '').replace(/\s+/g, ''),
          len: html.length,
        };
      });
      const newErr = (consoleErrors.length + pageErrors.length) - beforeErr;
      const norm = s => String(s).replace(/\s+/g, '');
      st.ttlOk = st.ttl.indexOf(norm(tlabel)) >= 0;
      visited++;
      perTab.push(Object.assign({ menu: m.id, tab: t, tabLabel: tlabel, newErr, settled }, st));
      const bad = st.renderFail || st.len < 200 || !settled || !st.ttlOk;
      const flag = bad ? '❌' : (st.charts || st.sparks ? '📈' : '  ');
      console.log('  ' + flag + ' ' + (m.id + '/' + t).padEnd(20) +
        ' len=' + String(st.len).padStart(6) +
        ' 图=' + st.charts + ' 趋势=' + st.sparks + ' 空图=' + st.nodata + ' 错误=' + st.chartErr +
        ' JS错=' + newErr + (settled ? '' : ' 未稳定') + (st.ttlOk ? '' : ' 标题错位(' + st.ttl + ')'));
    }
  }
  ok('全部 ' + totalTabs + ' 个 tab 均已访问', visited === totalTabs, '实际 ' + visited);
  const unsettled = perTab.filter(x => !x.settled);
  ok('全部 tab 渲染均已稳定（无超时）', unsettled.length === 0,
    unsettled.map(x => x.menu + '/' + x.tab).join(', '));
  // 页面错位回归：gotoPage 会连发两次渲染，旧渲染后到达曾覆盖新页面（B5 前实测 traffic/trend 显示 matrix 内容）
  const misplaced = perTab.filter(x => !x.ttlOk);
  ok('无页面错位（渲染标题 == 请求的 tab）', misplaced.length === 0,
    misplaced.map(x => x.menu + '/' + x.tab + ' 实际标题「' + x.ttl + '」期望含「' + x.tabLabel + '」').join(' | '));
  const renderFails = perTab.filter(x => x.renderFail);
  ok('无「面板渲染失败」页', renderFails.length === 0, renderFails.map(x => x.menu + '/' + x.tab).join(', '));
  const thin = perTab.filter(x => x.len < 200);
  ok('无空白页', thin.length === 0, thin.map(x => x.menu + '/' + x.tab + '(' + x.len + ')').join(', '));
  const jsonErrs = perTab.filter(x => x.newErr > 0);
  ok('切页过程无新增 JS 报错', jsonErrs.length === 0, jsonErrs.map(x => x.menu + '/' + x.tab + ' ×' + x.newErr).join(', '));
  const chartPage = perTab.filter(x => x.charts > 0);
  ok('出图页数 >= 4（工厂/趋势/闭环/罗盘应出图）', chartPage.length >= 4,
    '出图页：' + chartPage.map(x => x.menu + '/' + x.tab).join(', '));
  const sparkPage = perTab.filter(x => x.sparks > 0);
  ok('迷你趋势列出现（>=1 页）', sparkPage.length >= 1,
    '趋势列页：' + sparkPage.map(x => x.menu + '/' + x.tab + '(×' + x.sparks + ')').join(', '));
  const errPages = perTab.filter(x => x.chartErr > 0);
  ok('图表错误占位未出现（接口全通）', errPages.length === 0,
    errPages.map(x => x.menu + '/' + x.tab + ' ×' + x.chartErr).join(', '));

  // ── 3) 时间维度切换：图表必须真的变化 ──────────────────────────────
  console.log('\n=== 3. 时间维度切换（图表必须真的变）===');
  async  chartSig() {
    return await page.evaluate(() => {
      const host = document.querySelector('#scroll .ts-host');
      const h3 = document.querySelector('#scroll .panel h3');
      const lbl = document.querySelector('#scroll .msc-xlab span:not(:empty)');
      const path = host ? host.querySelector('svg path[fill="none"]') : null;
      return {
        title: h3 ? h3.textContent.trim() : '',
        d: path ? path.getAttribute('d').slice(0, 120) : '',
        firstX: lbl ? lbl.textContent : '',
        xCells: '#scroll .msc-xlab span',
        foot: (document.querySelector('#scroll .msc-foot') || {}).textContent || '',
      };
    });
  }
  await page.evaluate(() => { if (typeof gotoPage === '') gotoPage('content', 'factory'); });
  await sleep(QUIET_MS + 800);

  const sigs = {};
  for (const [r, name] of [['today', '今日'], ['week', '本周'], ['month', '本月'], ['year', '本年']]) {
    await page.click('#tdhost button[data-r="' + r + '"]');
    await sleep(QUIET_MS + 900);
    sigs[r] = await chartSig();
    console.log('  ' + name.padEnd(4) + ' 标题=' + sigs[r].title.slice(0, 34).padEnd(34) +
      ' 首标=' + sigs[r].firstX.padEnd(12) + ' 桶数=' + sigs[r].xCells + ' 曲线指纹=' + (sigs[r].d || '(空)').slice(0, 26));
  }
  const keys = Object.keys(sigs);
  ok('每个维度都有曲线路径', keys.every(k => sigs[k].d.length > 0), keys.filter(k => !sigs[k].d).join(','));
  const uniqD = new Set(keys.map(k => sigs[k].d));
  ok('四档维度曲线互不相同（真的切了）', uniqD.size === keys.length, '不同曲线数=' + uniqD.size);
  const uniqTitle = new Set(keys.map(k => sigs[k].title));
  ok('标题随维度变化', uniqTitle.size >= 2, JSON.stringify(keys.map(k => sigs[k].title)));
  ok('图表脚注暴露口径/覆盖', /口径|覆盖/.test(sigs.year.foot || sigs.month.foot || ''), sigs.month.foot);
  const bucketOrder = { today: 24, week: 7, month: 20, year: 9 };
  ok('今日按小时出 24 桶', sigs.today.xCells >= 19 && sigs.today.xCells <= 25, '实际 ' + sigs.today.xCells);
  ok('本年按月出桶（<=12）', sigs.year.xCells <= 12, '实际 ' + sigs.year.xCells);

  // ── 4) 自定义窗口 + 非法窗口拒绝 ───────────────────────────────────
  console.log('\n=== 4. 自定义时间窗口与非法窗口拒绝 ===');
  await page.click('#tdhost button[data-r="custom"]');
  await sleep(QUIET_MS + 800);
  const ctrlVisible = await page.evaluate(() => {
    const c = document.querySelector('#tdhost .msc-td-cus');
    return !!(c && c.style.display !== 'none');
  });
  ok('切到自定义后日期输入框出现', ctrlVisible);

  await page.fill('#tdhost input[data-msc-from]', '2026-09-01');
  await page.fill('#tdhost input[data-msc-to]', '2026-09-10');
  await page.click('#tdhost button[data-msc-apply]');
  await sleep(QUIET_MS + 900);
  const validSig = await chartSig();
  const validState = await page.evaluate(() => MSCMSChart.timeState.get());
  ok('合法自定义窗口已生效', validState.range === 'custom' && validState.from === '2026-09-01' && validState.to === '2026-09-10',
    JSON.stringify(validState));
  ok('自定义窗口出图（9 天 → 日粒度）', validSig.xCells === 9, '实际桶数 ' + validSig.xCells);

  // 非法：起始晚于结束 → 必须拒绝且不写入
  await page.fill('#tdhost input[data-msc-from]', '2026-09-20');
  await page.fill('#tdhost input[data-msc-to]', '2026-09-10');
  await page.click('#tdhost button[data-msc-apply]');
  await sleep(QUIET_MS + 500);
  const afterBad = await page.evaluate(() => ({
    err: (document.querySelector('#tdhost [data-msc-err]') || {}).textContent || '',
    errShown: !!document.querySelector('#tdhost [data-msc-err]') && document.querySelector('#tdhost [data-msc-err]').style.display !== 'none',
    state: MSCMSChart.timeState.get(),
  }));
  ok('非法窗口：控件显示错误', afterBad.errShown && /早于/.test(afterBad.err), JSON.stringify(afterBad.err));
  ok('非法窗口：状态未被改写', afterBad.state.from === '2026-09-01' && afterBad.state.to === '2026-09-10',
    JSON.stringify(afterBad.state));
  const badSig = await chartSig();
  ok('非法窗口：图表口径保持不变（未静默换窗口）', badSig.firstX === validSig.firstX, validSig.firstX + ' → ' + badSig.firstX);

  // ── 5) 迷你趋势列 & 点图开抽屉 ─────────────────────────────────────
  console.log('\n=== 5. 迷你趋势列 + 点图开抽屉 ===');
  await page.click('#tdhost button[data-r="month"]');
  await sleep(QUIET_MS + 600);
  await page.evaluate(() => { if (typeof gotoPage === '') gotoPage('ov', 'compass'); });
  await sleep(QUIET_MS + 2500);
  const trendCol = await page.evaluate(() => ({
    sparks: '#scroll .msc-spark',
    headerTrend: Array.from('#scroll th')).map(x => x.textContent).filter(x => x === '趋势',
    note: Array.from('#scroll .tip')).map(x => x.textContent).filter(x => /迷你趋势列/.test(x),
  }));
  ok('全模块 TOP12 表含「趋势」列', trendCol.headerTrend >= 1, '表头出现 ' + trendCol.headerTrend + ' 次');
  ok('趋势列渲染出迷你曲线', trendCol.sparks >= 3, '实际 ' + trendCol.sparks + ' 条');
  ok('趋势列脚注说明取数口径', trendCol.note >= 1);

  await page.evaluate(() => { if (typeof gotoPage === '') gotoPage('content', 'factory'); });
  await sleep(QUIET_MS + 1200);
  const drawn = await page.evaluate(() => {
    const r = document.querySelector('#scroll .ts-host svg [data-msc-i]');
    return !!r;
  });
  ok('图表存在可点击命中区（下钻入口）', drawn);
  if (drawn) {
    await page.click('#scroll .ts-host svg [data-msc-i]');
    await sleep(700);
    const drill = await page.evaluate(() => ({
      open: document.querySelector('#drawer').classList.contains('open'),
      title: (document.querySelector('#dh-t') || {}).textContent || '',
      body: (document.querySelector('#dbody') || {}).textContent || '',
    }));
    ok('点图打开抽屉', drill.open, JSON.stringify(drill.title));
    ok('抽屉含时间桶明细', /时间桶/.test(drill.body) && /条数/.test(drill.body), drill.body.slice(0, 120));
    ok('抽屉含可核对的聚合接口 URL', /metrics\/timeseries/.test(drill.body));
    await page.click('#dh-x');
    await sleep(400);
  }

  // ── 6) 无自动刷新守门（用户要求：只保留手动刷新）─────────────────
  console.log('\n=== 6. 手动刷新守门（取消 5s / 10m 自动刷新）===');
  const refreshAudit = await page.evaluate(async () => {
    const before = document.querySelector('#lastup').textContent;
    // 观察 8 秒内是否有任何业务请求被自动发出
    const reqs = [];
    const of = window.fetch;
    window.fetch =  (u, o) { reqs.push(String(u)); return of.apply(this, arguments); };
    await new Promise(r => setTimeout(r, 8000));
    window.fetch = of;
    return { before, after: document.querySelector('#lastup').textContent, autoReqs: reqs.filter(u => /\/api\//.test(u)) };
  });
  ok('静置 8 秒无自动业务请求（自动刷新已取消）', refreshAudit.autoReqs.length === 0,
    refreshAudit.autoReqs.slice(0, 5).join(', '));
  ok('静置 8 秒「更新」时间戳未自动推进', refreshAudit.before === refreshAudit.after,
    refreshAudit.before + ' → ' + refreshAudit.after);
  const segGone = await page.evaluate(() => '#refreshseg, #refreshseg button');
  ok('旧刷新分段控件（5s/15s/1m/10m）已不存在', segGone === 0);
  const refreshBtn = await page.evaluate(() => !!document.querySelector('#refreshbtn'));
  ok('手动「刷新」按钮存在', refreshBtn);

  // ── 汇总 ───────────────────────────────────────────────────────────
  console.log('\n=== 7. 全局错误汇总 ===');
  ok('无任何 pageerror', pageErrors.length === 0, pageErrors.slice(0, 5).join(' || '));
  const realConsoleErr = consoleErrors.filter(x => !/favicon|ERR_ABORTED|Failed to load resource: net::ERR/.test(x));
  ok('无实质性 console 错误', realConsoleErr.length === 0, realConsoleErr.slice(0, 5).join(' || '));
  ok('无失败的资源请求', failedReqs.length === 0, failedReqs.slice(0, 5).join(' || '));

  const durSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n──────────────────────────────');
  console.log('结果：' + pass + ' PASS, ' + fail + ' FAIL（耗时 ' + durSec + 's，页面 ' + visited + ' 个）');
  if (findings.length) {
    console.log('\n未通过项：');
    findings.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f.name + (f.detail ? ' → ' + f.detail : '')));
  }

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = {
      at: new Date().toISOString(), base: BASE, durationSec: +durSec,
      pass, fail, findings,
      pageErrors, consoleErrors, failedRequests: failedReqs,
      perTab, timeDimension: sigs, customWindow: { validState, validSig, badSig },
      trendColumn: trendCol, noAutoRefresh: refreshAudit,
    };
    const f = path.join(OUT_DIR, 'b5-dash-acceptance.json');
    fs.writeFileSync(f, JSON.stringify(out, null, 2));
    console.log('报告：' + f);
  } catch (e) { console.log('（报告写入失败：' + e.message + '）'); }

  await browser.close();
  if (fail > 0) process.exitCode = 1;
})().catch(e => { console.error('验收脚本异常：' + (e && e.stack || e)); process.exit(2); });
