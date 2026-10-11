#!/usr/bin/env node
/**
 * daily-report.js — MSCMS v14 每日数据日报引擎
 * ---------------------------------------------------------------
 * 目的：消除「系统在忙但业务不知道」的信息断层。
 * 每天采集账号 / 内容 / 发布 / 因果链 / 异常告警，输出：
 *   1. D:/mscms-ws/reports/daily/report-<date>.json   结构化数据（机器可读）
 *   2. D:/mscms-ws/reports/daily/report-<date>.html   自包含日报（人可读）
 *   3. D:/MSCMS-Desktop/resources/reports/latest-daily-report.html
 *      → 浏览器 http://127.0.0.1:3002/reports/latest-daily-report.html 直看
 *   4. Telegram 文本摘要（tools/telegram-notify.js，缺凭证则跳过并明示，不伪造）
 *
 * 铁律：
 *   - 零伪造：所有数字来自真实 JSON 数据；无数据源的字段直接标「无数据」
 *   - 只读数据文件，不写 data/*.json（避免与 3002 的 5s flush 冲突）
 *
 * 用法：
 *   node tools/daily-report.js                    # 生成今日日报
 *   node tools/daily-report.js --date 2026-09-06  # 补指定日
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const REPORT_DIR = 'D:/mscms-ws/reports/daily';
// 3002 静态根 = server.js 所在目录；历史上也曾以 D:/MSCMS-Desktop/resources 为根启动。
// 双写两处，无论哪个进程形态都能通过 /reports/latest-daily-report.html 访问。
const STATIC_DIRS = [path.join(__dirname, '..', 'reports'), 'D:/MSCMS-Desktop/resources/reports'];

const argv = process.argv.slice(2);
const dateArg = (() => { const i = argv.indexOf('--date'); return i >= 0 ? argv[i + 1] : null; })();
// 日切必须按业务时区 GMT+8（源时间戳为 UTC，直接 slice(0,10) 会把 00:00~08:00 的业务数据
// 算到前一天，导致「今日发布」等计数严重偏低 —— 2026-09-26 实测：UTC 口径 7 条 vs GMT+8 口径 143 条）。
const cnDay = (t) => new Date((t instanceof Date ? t.getTime() : Date.parse(t)) + 8 * 3600e3).toISOString().slice(0, 10);
const DAY = dateArg || cnDay(new Date());

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch (e) { return fallback; }
}
const arr = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : (parseFloat(v) || 0);
const inDay = (iso, d) => {
  const s = String(iso || '');
  if (!s) return false;
  const t = Date.parse(s);
  return isFinite(t) ? cnDay(s) === d : s.slice(0, 10) === d;
};
const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;

// ─────────────────────────── 采集 ───────────────────────────
const accounts = arr(readJson('accounts.json', []));
const content = arr(readJson('content.json', []));
const publish = arr(readJson('publish.json', []));
const dauLog = arr(readJson('dau_log.json', []));
const nurtureLogs = arr(readJson('nurture_logs.json', []));

// 账号
const accTotal = accounts.length;
const accByStatus = {}; accounts.forEach(a => { const s = a.active_status || a.status || 'unknown'; accByStatus[s] = (accByStatus[s] || 0) + 1; });
const accByPhase = {}; accounts.forEach(a => { const p = a.causal_phase || '未知'; accByPhase[p] = (accByPhase[p] || 0) + 1; });
const accBySite = {}; accounts.forEach(a => { const s = a.promo_site || '未分配'; accBySite[s] = (accBySite[s] || 0) + 1; });
const accNewToday = accounts.filter(a => inDay(a.createdAt || a.reg_time, DAY)).length;
const accActiveToday = accounts.filter(a => inDay(a.last_active_at || a.last_action_at, DAY)).length;
const healths = accounts.map(a => num(a.health_score)).filter(v => v > 0);
const healthAvg = healths.length ? Math.round(healths.reduce((s, v) => s + v, 0) / healths.length) : 0;

// 内容
const GARBLE = ['400 bad request', 'auto-generated content'];
const isGarble = (c) => GARBLE.includes(String(c.title || '').trim().toLowerCase());
const cByStatus = {}; content.forEach(c => { const s = c.status || 'unknown'; cByStatus[s] = (cByStatus[s] || 0) + 1; });
const cNewToday = content.filter(c => inDay(c.createdAt, DAY)).length;
const cGarbleTotal = content.filter(isGarble).length;
const cGarbleNewToday = content.filter(c => isGarble(c) && inDay(c.createdAt, DAY)).length;
// 已隔离的垃圾（P0 止血后移出 content.json，单独存放，仍需在日报中留痕）
const quarantined = arr(readJson('content_quarantine.json', []));
const quarantinedPublished = quarantined.filter(c => c._was_published).length;

// 发布
// [ACCEL-2026-09-22 · P0-3] 「今日发布」拆成两个可证伪口径：
//   pToday   = published_at 落在当日的全部记录
//   pTodayOk = 其中 publish_url 非空的**真实成功**条数（判成败的唯一判据）
//   二者差值 = 当日失败/无 URL 记录，彻底消除「日报说 2 条、publish.json 有 127 条」式口径分裂。
const pToday = publish.filter(p => inDay(p.published_at, DAY));
const pTodayOk = pToday.filter(p => p.publish_url);
const reachTotal = publish.reduce((s, p) => s + num(p.reach), 0);
const reachToday = pToday.reduce((s, p) => s + num(p.reach), 0);
const likesTotal = publish.reduce((s, p) => s + num(p.likes), 0);
const commentsTotal = publish.reduce((s, p) => s + num(p.comments), 0);
const pGarbleToday = pToday.filter(p => GARBLE.includes(String(p.content_title || '').trim().toLowerCase())).length;
// [ACCEL-2026-09-22 · P0-3] 覆盖口径统一为「与当前账号池的交集」。
//   原 pubAccts = publish 全量去重 account_id ⇒ 混入已删除/历史账号
//   ⇒ 实测出现「发布覆盖 150/123」这种 >100% 的荒谬值，直接摧毁日报可信度。
//   现与 neverPub 共用同一集合，保证 pubAccts + neverPub === accTotal（恒等式可自检）。
const publishedAcctIds = new Set(publish.map(p => p.account_id));
const pubAccts = accounts.filter(a => publishedAcctIds.has(a.id)).length;
const pubAcctsAllTime = publishedAcctIds.size;   // 历史口径（含已删除账号），仅供对照
const neverPub = accTotal - pubAccts;

// ── P1 抓取链路：热点池（trends.json 由 tools/trends-scraper.js 落盘）──
const trends = arr(readJson('trends.json', []));
const trendsToday = trends.filter(t => inDay(t.fetchedAt, DAY)).length;
const trendsRel = trends.filter(t => (t.relevance || 0) > 0).length;
const trendsBySource = {};
trends.forEach(t => { const s = t.source || 'unknown'; trendsBySource[s] = (trendsBySource[s] || 0) + 1; });
// P1 质检单轨：新内容带 quality_v2（≥60 方可发布）
const withQ2 = content.filter(c => c.quality_v2 !== undefined && c.quality_v2 !== null);
const q2Pass = withQ2.filter(c => Number(c.quality_v2) >= 60).length;

// 因果链推进（今日 timeline 事件）
let phaseMovesToday = 0; const phaseMoveDetail = {};
accounts.forEach(a => {
  (Array.isArray(a.causal_timeline) ? a.causal_timeline : []).forEach(ev => {
    if (ev && inDay(ev.at, DAY)) { phaseMovesToday++; const k = (ev.from || '?') + '→' + (ev.phase || ev.to || '?'); phaseMoveDetail[k] = (phaseMoveDetail[k] || 0) + 1; }
  });
});

// 告警（真实规则，不臆造）
const alerts = [];
if (cGarbleNewToday > 0) alerts.push({ level: 'P0', msg: `今日仍生成垃圾内容 ${cGarbleNewToday} 条（标题为 400 Bad Request / Auto-generated content），生成链路存在故障，切勿让它们进入发布队列` });
if (pGarbleToday > 0) alerts.push({ level: 'P0', msg: `今日把垃圾内容发布到线上 ${pGarbleToday} 条，已污染真实账号的博文历史` });
if (reachToday === 0 && pTodayOk.length > 0) alerts.push({ level: 'P1', msg: `今日真实发布 ${pTodayOk.length} 条但 reach=0，内容可能无曝光（限流/内容质量）` });
if (pTodayOk.length === 0) alerts.push({ level: 'P1', msg: '今日零成功发布，发布链路未运转' });
if (cNewToday === 0) alerts.push({ level: 'P2', msg: '今日零内容生成，生成链路未运转' });
if (trendsToday === 0) alerts.push({ level: 'P1', msg: '今日零热点入库，抓取链路未运转（内容将失去真实来源，reach 难以提升）' });

// ── P2 发布回采：post_metrics.json（由 /api/v14/tumblr/post-metrics/harvest 落盘）──
const pmRaw = readJson('post_metrics.json', null) || {};
const pmPosts = Object.values(pmRaw.posts || {});
const pmNotes = pmPosts.reduce((s, p) => s + (Number(p.note_count) || 0), 0);
const pmWithNotes = pmPosts.filter(p => Number(p.note_count) > 0).length;
if (pmRaw.updated_at && pmPosts.length === 0) {
  alerts.push({ level: 'P1', msg: `回采已执行但未取得任何真实互动数据（Tumblr 对唯一出口 IP 限流 429，Bright Data 桥对该端点返回 502）→ 发布效果仍无法度量` });
} else if (pmPosts.length === 0) {
  alerts.push({ level: 'P2', msg: '尚未执行过发布回采，无法回答「发出去的帖子有没有效果」' });
}
if (withQ2.length > 0 && q2Pass < withQ2.length) alerts.push({ level: 'P2', msg: `质检单轨：新内容 ${withQ2.length} 条中 ${withQ2.length - q2Pass} 条未达 quality_v2≥60，已拦截不进发布池` });
if (accNewToday === 0) alerts.push({ level: 'P2', msg: '今日零新注册账号' });

// ── 出口（公网 IP）健康：429 限流 = 空转的根因，必须每日可见 ──
let exits = { total: 0, uniqueExitIps: 0, cooling: 0, atRisk: false, list: [] };
try {
  const { ProxyPool } = require('../proxy-pool');
  const pool = new ProxyPool();
  const snap = pool.healthSnapshot();
  const ips = new Set(snap.map((e) => e.exitIp).filter(Boolean));
  exits = {
    total: snap.length,
    uniqueExitIps: ips.size,
    cooling: snap.filter((e) => e.cooling).length,
    atRisk: ips.size <= 1,
    list: snap.map((e) => ({ name: e.name, ip: e.exitIp, ok: e.ok, fails: e.fails, cooling: e.cooling, lastErr: e.lastErr })),
  };
  if (ips.size <= 1) {
    alerts.push({ level: 'P0', msg: `唯一出口 IP 仅 ${ips.size} 个（${[...ips].join('/')}）→ Tumblr 限流 429 无法分散，发布/回采必然空转；需新增出口（新机场订阅 / Cloudflare Workers / 更多自有 VPS）` });
  } else if (exits.cooling > 0) {
    alerts.push({ level: 'P1', msg: `${exits.cooling}/${exits.total} 个出口处于冷却（429/连续失败），账号已自动切到健康出口` });
  }
} catch (e) { /* 代理池不可用时不影响日报 */ }
if (cGarbleTotal > 0) alerts.push({ level: 'P1', msg: `库存垃圾内容累计 ${cGarbleTotal} 条（占 ${pct(cGarbleTotal, content.length)}%），建议清洗 content.json 并定位生成端故障` });
if (quarantined.length > 0 && cGarbleTotal === 0) alerts.push({ level: 'P2', msg: `已隔离历史垃圾 ${quarantined.length} 条（其中 ${quarantinedPublished} 条曾外发，待人工决定是否删帖）；当前发布池已无垃圾` });

const report = {
  date: DAY, generatedAt: new Date().toISOString(),
  accounts: {
    total: accTotal, byStatus: accByStatus, byPhase: accByPhase, byPromoSite: accBySite,
    newToday: accNewToday, activeToday: accActiveToday, healthAvg,
  },
  content: { total: content.length, byStatus: cByStatus, newToday: cNewToday, garbleTotal: cGarbleTotal, garbleNewToday: cGarbleNewToday, garblePct: pct(cGarbleTotal, content.length), quarantined: quarantined.length, quarantinedPublished, withQ2: withQ2.length, q2Pass },
  trends: { total: trends.length, newToday: trendsToday, relevant: trendsRel, bySource: trendsBySource },
  harvest: { updatedAt: pmRaw.updated_at || null, trackedPosts: pmPosts.length, withNotes: pmWithNotes, totalNotes: pmNotes, blogs: (pmRaw.harvested_blogs || []).length, totalBlogs: pmRaw.total_blogs || 0 },
  exits,
  publish: {
    total: publish.length, today: pToday.length, reachTotal, reachToday,
    likesTotal, commentsTotal, garbleToday: pGarbleToday,
    accountsPublished: pubAccts, accountsNeverPublished: neverPub,
  },
  causal: { movesToday: phaseMovesToday, movesDetail: phaseMoveDetail },
  // [ACCEL-2026-09-22 · P0-3] DAU 区块补齐「真实 / 自驱 / 目标 / 缺口」四要素。
  //   原实现只数记录条数（entries / today），**从不显示真实 DAU 值**
  //   ⇒ 「离目标还差多远」在日报里无从得知，这正是加速失焦的度量根因之一。
  dau: (() => {
    const _todayLogs = dauLog.filter(d => inDay(d.createdAt || d.date || d.at || d.timestamp, DAY));
    const _last = _todayLogs.length ? _todayLogs[_todayLogs.length - 1] : (dauLog[dauLog.length - 1] || {});
    const _real = num(_last.realDAU !== undefined && _last.realDAU !== null ? _last.realDAU : _last.currentDAU);
    const _tgt = num(_last.targetDAU);
    return {
      entries: dauLog.length,
      today: _todayLogs.length,
      realDAU: _real,
      systemDAU: num(_last.systemDAU),
      rawTodayDAU: num(_last.rawTodayDAU),
      targetDAU: _tgt,
      gap: Math.max(0, _tgt - _real),
      targetSource: _last.targetSource || 'n/a',
      lastAt: _last.createdAt || _last.timestamp || null,
    };
  })(),
  nurture: { logsToday: nurtureLogs.filter(l => inDay(l.createdAt || l.at || l._ts, DAY)).length },
  alerts,
};

// ─────────────────────────── HTML ───────────────────────────
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const alertColor = l => l === 'P0' ? '#ef4444' : l === 'P1' ? '#f59e0b' : '#6b7280';
const kv = (label, v, sub) => `<div class="kpi"><div class="kl">${esc(label)}</div><div class="kv">${esc(v)}</div><div class="ks">${esc(sub || '')}</div></div>`;

const phaseRows = Object.entries(report.accounts.byPhase).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td><td>${pct(v, accTotal)}%</td></tr>`).join('');
const siteRows = Object.entries(report.accounts.byPromoSite).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td><td>${pct(v, accTotal)}%</td></tr>`).join('');
const moveRows = Object.entries(phaseMoveDetail).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">今日无阶段推进</td></tr>';
const alertHtml = alerts.length
  ? alerts.map(a => `<div class="alert" style="border-left:4px solid ${alertColor(a.level)}"><b>${esc(a.level)}</b> ${esc(a.msg)}</div>`).join('')
  : '<div class="alert" style="border-left:4px solid #22c55e"><b>OK</b> 今日无告警</div>';

const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>MSCMS 每日数据日报 ${DAY}</title><style>
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:28px}
h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 10px;color:#94a3b8;border-bottom:1px solid #1e293b;padding-bottom:6px}
.sub{color:#64748b;font-size:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.kpi{background:#1e293b;border-radius:10px;padding:14px}
.kl{font-size:11px;color:#94a3b8}.kv{font-size:26px;font-weight:700;margin:4px 0}.ks{font-size:11px;color:#64748b}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:7px 10px;border-bottom:1px solid #1e293b;text-align:left}th{color:#94a3b8;font-weight:500}
.mut{color:#64748b}.alert{background:#1e293b;border-radius:8px;padding:10px 14px;margin-bottom:8px;font-size:13px}
.pos{color:#22c55e}.neg{color:#ef4444}
</style></head><body>
<h1>MSCMS v14 每日数据日报</h1>
<div class="sub">日期 ${DAY} · 生成于 ${esc(report.generatedAt.replace('T', ' ').slice(0, 19))} · 数据源 D:/mscms-ws/data（真实数据，零伪造）</div>

<h2>⚠ 告警（${alerts.length}）</h2>
${alertHtml}

<h2>账号</h2>
<div class="grid">
${kv('账号总数', accTotal, `今日新增 ${accNewToday}`)}
${kv('今日活跃', accActiveToday, `占比 ${pct(accActiveToday, accTotal)}%`)}
${kv('平均健康分', healthAvg, healthAvg >= 80 ? '健康' : '偏低')}
${kv('已推广归属', Object.entries(accBySite).filter(([k]) => k !== '未分配').reduce((s, [, v]) => s + v, 0), Object.entries(accBySite).map(([k, v]) => k + ' ' + v).join(' · '))}
</div>
<h2>因果链阶段分布（S1~S7）</h2>
<table><tr><th>阶段</th><th>账号数</th><th>占比</th></tr>${phaseRows}</table>
<div class="sub" style="margin-top:8px">今日阶段推进事件 ${phaseMovesToday} 次 ${Object.keys(phaseMoveDetail).length ? '：' + Object.entries(phaseMoveDetail).map(([k, v]) => k + '×' + v).join('，') : ''}</div>

<h2>内容</h2>
<div class="grid">
${kv('内容总量', content.length, `今日新增 ${cNewToday}`)}
${kv('ready 待发布', cByStatus.ready || 0, `queued ${cByStatus.queued || 0}`)}
${kv('已发布标记', cByStatus.published || 0, '')}
${kv('垃圾内容(发布池)', cGarbleTotal, cGarbleTotal === 0 ? '✅ 已清零' : `占 ${report.content.garblePct}% · 今日新增 ${cGarbleNewToday}`)}
${kv('已隔离垃圾', quarantined.length, quarantinedPublished > 0 ? `${quarantinedPublished} 条曾外发待复核` : '未外发' )}
</div>
<div class="sub" style="margin-top:8px">垃圾内容 = 标题为「400 Bad Request」或「Auto-generated content」的占位数据，这类内容不该被发布</div>

<h2>发布与效果</h2>
<div class="grid">
${kv('热点池', trends.length, `今日+${trendsToday} · 业务相关 ${trendsRel} · 来源 ${Object.keys(trendsBySource).join('/') || '无'}`)}
${kv('质检单轨 v2', withQ2.length ? `${q2Pass}/${withQ2.length} 通过` : '存量内容无 v2 评分', withQ2.length ? `拦截 ${withQ2.length - q2Pass} 条未达 60 分` : '新生成内容启用')}
${kv('今日发布(成功)', pTodayOk.length, `当日记录 ${pToday.length} 条 · 累计 ${publish.length}`)}
${kv('发布回采', report.harvest.trackedPosts + ' 帖', report.harvest.trackedPosts
    ? `真实互动 ${report.harvest.totalNotes} · 有互动 ${report.harvest.withNotes} 帖 · 已采 ${report.harvest.blogs}/${report.harvest.totalBlogs} 博客`
    : (report.harvest.updatedAt ? '已执行但 0 条（Tumblr 429 限流 / BD 桥 502）' : '尚未执行'))}
${kv('今日 reach', reachToday, `累计 ${reachTotal}`)}
${kv('累计 likes', likesTotal, '')}
${kv('累计 comments', commentsTotal, '')}
${kv('已发布账号', pubAccts, `占 ${pct(pubAccts, accTotal)}% · 历史口径(含已删账号) ${pubAcctsAllTime}`)}
${kv('从未发布账号', neverPub, `占 ${pct(neverPub, accTotal)}% · 沉睡资产`)}
</div>

<h2>推广站点归属</h2>
<table><tr><th>站点</th><th>账号数</th><th>占比</th></tr>${siteRows}</table>

<h2>其他链路</h2>
<div class="grid">
${kv('真实 DAU', report.dau.realDAU, `目标 ${report.dau.targetDAU}(${report.dau.targetSource}) · 缺口 ${report.dau.gap}`)}
${kv('DAU 记录(累计)', report.dau.entries, `今日 ${report.dau.today} · 自驱 system=${report.dau.systemDAU} / raw含自驱=${report.dau.rawTodayDAU}`)}
${kv('养号日志(今日)', report.nurture.logsToday, '')}
</div>
</body></html>`;

// ─────────────────────────── 写盘 ───────────────────────────
fs.mkdirSync(REPORT_DIR, { recursive: true });
STATIC_DIRS.forEach((d) => fs.mkdirSync(d, { recursive: true }));
const jsonPath = path.join(REPORT_DIR, `report-${DAY}.json`);
const htmlPath = path.join(REPORT_DIR, `report-${DAY}.html`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
fs.writeFileSync(htmlPath, html, 'utf8');
STATIC_DIRS.forEach((d) => fs.writeFileSync(path.join(d, 'latest-daily-report.html'), html, 'utf8'));

console.log(`[日报] ${jsonPath}`);
console.log(`[日报] ${htmlPath}`);
console.log(`[静态] http://127.0.0.1:3002/reports/latest-daily-report.html`);

// Telegram 摘要文本（由 telegram-notify.js 消费）
const summary = [
  `📊 MSCMS 日报 ${DAY}`,
  `账号 ${accTotal}（今日+${accNewToday}，活跃 ${accActiveToday}，健康均分 ${healthAvg}）`,
  `内容 ${content.length}（今日+${cNewToday}，垃圾累计 ${cGarbleTotal}${withQ2.length ? `，质检 v2 通过 ${q2Pass}/${withQ2.length}` : ''}）`,
  `热点池 ${trends.length} 条（今日+${trendsToday}，业务相关 ${trendsRel}）`,
  `发布 今日成功 ${pTodayOk.length} 条（记录 ${pToday.length}）/ reach +${reachToday}（累计 ${publish.length} / ${reachTotal}，likes ${likesTotal}）`,
  `发布覆盖 ${pubAccts}/${accTotal} 账号，${neverPub} 个从未发布`,
  `真实 DAU ${report.dau.realDAU}/${report.dau.targetDAU}（缺口 ${report.dau.gap}，自驱 system=${report.dau.systemDAU} 不计入）`,
  `因果推进 ${phaseMovesToday} 次`,
  `出口 ${exits.uniqueExitIps} 个独立公网 IP（${exits.cooling} 个冷却中）${exits.atRisk ? ' ⚠️单一出口=429空转风险' : ''}`,
  alerts.length ? `告警 ${alerts.length} 条：` + alerts.slice(0, 3).map(a => `[${a.level}] ${a.msg}`).join(' | ') : '无告警',
].join('\n');
fs.writeFileSync(path.join(REPORT_DIR, `summary-${DAY}.txt`), summary, 'utf8');
console.log('[摘要] ' + path.join(REPORT_DIR, `summary-${DAY}.txt`));
console.log('---');
console.log(summary);
