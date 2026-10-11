#!/usr/bin/env node
'use strict';
/**
 * kk20-daily-report.js — KKMatch 20 账号投放「每日发布 + 反馈」汇总
 *
 * 回答四个问题（每天一份，可被自动化调度）：
 *   1) 今天该发 40 条，实际发出去了几条？（口径：publish_url 非空 = 成功）
 *   2) 发到了哪些账号？分散度如何？有没有账号一条没发出去？
 *   3) 内容卡在哪个环节？（content 池 ready / queued / published 分布）
 *   4) 有没有真实互动？（Tumblr note_count —— 走 engagement-harvester 真实回收，不伪造）
 *
 * 数据源（全部为真实落盘 / 真实接口，零估算）：
 *   · D:/mscms-ws/data/publish.json   发布台账（account_id / content_id / publish_url / reach…）
 *   · D:/mscms-ws/data/content.json   内容池（status 分布 → 卡点定位）
 *   · POST /api/v14/tumblr/engagement/harvest + GET …/positive   MySQL 真实 note_count 时间序列
 *
 * ⚠️ 已知口径陷阱：publish 记录的 reach/likes/comments/shares **恒为 0**
 *   （从未回收），因此本报告**不把它们当作"零互动"结论**，而是显式标注为
 *   「台账字段未回收」，真实互动一律以 note_count 为准。
 *
 * 用法：
 *   node tools/kk20-daily-report.js                       # 今天
 *   node tools/kk20-daily-report.js --date 2026-09-22
 *   node tools/kk20-daily-report.js --harvest             # 先触发真实 note_count 回收再汇总
 *   node tools/kk20-daily-report.js --notify              # 额外推送 Telegram 摘要
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fetchExt } = require('../http-client');

const ROOT = path.dirname(__dirname);
const OUTDIR = path.join(ROOT, 'reports', 'kk20-daily');
const CANDIDATES = path.join(ROOT, '_kk20_candidates.json');
const BATCHDIR = path.join(ROOT, 'reports', 'kk20-batches');
const PUB_JSON = 'D:/mscms-ws/data/publish.json';
const CONTENT_JSON = 'D:/mscms-ws/data/content.json';
const API = process.env.KK20_API || 'http://127.0.0.1:3002';
const TG = path.join(ROOT, 'tools', 'telegram-notify.js');
const DAILY_TARGET = 40;          // 20 账号 × 早晚各 1 帖
/**
 * 正式内容 ID 模板：`kk20-<date>-<batch>-<n>`（可带 `-<rev>` 后缀）。
 * ⚠️ 必须精确匹配，不能用 `startsWith('kk20-')`：否则排障用的探针内容
 *    （如 `kk20-probe-editing`）会被计入「今日注入」，污染口径（实测踩到）。
 */
const KK_ID_RE = /^kk20-\d{4}-\d{2}-\d{2}-(morning|evening)-\d+/;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.includes(n);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function localDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function asList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (v.items) return v.items;
  return Object.values(v);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─────────────────────────── 数据采集 ───────────────────────────

async function harvestNotes() {
  try {
    const r = await fetchExt(`${API}/api/v14/tumblr/engagement/harvest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPerRun: 300 }),
      timeout: 240000,
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, data: j };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function fetchPositive(minNotes = 0, limit = 500) {
  try {
    const r = await fetchExt(`${API}/api/v14/tumblr/engagement/positive?minNotes=${minNotes}&limit=${limit}`, { timeout: 60000 });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && j && j.ok, items: (j && j.items) || [] };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

// ── 发布器限流/退避快照（2026-09-22 新增）──────────────────────────────
// 为什么需要：日报里「待发布 N 条」若没有这层信息，会被误读成「定向投放失败了」。
// 实测（09-22）确有 26 条被【全局限额暂停】冻了 15 分钟：仅 3 个 blog 撞到 Tumblr
// 瞬时 429（detail = "Measly little error. Try again."，非配额耗尽），
// 却因升级阈值固定为 3 而把全站 117 个账号一起停了。归因写进日报，次日才能一眼区分
// 「正常节流」「限流退避」「真故障」三态。
// 只读接口，失败不应影响报告生成 ⇒ 全程 try/catch，返回 ok:false 时渲染降级为「未知」。
async function fetchQuota() {
  try {
    const r = await fetchExt(`${API}/api/v14/publisher/quota`, { timeout: 20000 });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.backoff) return { ok: false, error: `HTTP ${r.status}` };
    const g = j.backoff.global || {};
    return {
      ok: true,
      globalActive: !!g.active,
      globalUntil: g.until || 0,
      globalReason: g.reason || null,
      acctBackoff: (j.backoff.accounts || []).map((a) => ({
        accountId: a.accountId, remainingMin: a.remainingMin,
      })),
      recentRateLimits: j.backoff.recentRateLimits || 0,
      thresholds: j.backoff.thresholds || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  const date = arg('--date', todayStr());
  const doHarvest = has('--harvest');
  fs.mkdirSync(OUTDIR, { recursive: true });

  console.log(`\n═══ KKMatch 投放日报 · ${date} ═══`);

  const cands = readJson(CANDIDATES) || [];
  const acctIds = new Set(cands.map((c) => String(c.id)));
  const acctById = Object.fromEntries(cands.map((c) => [String(c.id), c]));

  // 1) 发布台账
  const pubAll = asList(readJson(PUB_JSON));
  const kkPubAll = pubAll.filter((p) => KK_ID_RE.test(String(p.content_id || '')));
  const kkPubToday = kkPubAll.filter((p) => localDay(p.published_at) === date);
  const okToday = kkPubToday.filter((p) => p.publish_url);
  const failToday = kkPubToday.filter((p) => !p.publish_url);

  // 按批次拆分（content_id 形如 kk20-<date>-<batch>-<n>）
  const byBatch = { morning: [], evening: [], other: [] };
  for (const p of kkPubToday) {
    const m = String(p.content_id).match(/^kk20-\d{4}-\d{2}-\d{2}-(morning|evening)-/);
    (m ? byBatch[m[1]] : byBatch.other).push(p);
  }

  // 2) 内容池状态（定位卡点：注入了但没发布）
  const contentAll = asList(readJson(CONTENT_JSON));
  const kkContent = contentAll.filter((c) => KK_ID_RE.test(String(c.id || '')));
  const kkContentToday = kkContent.filter((c) => localDay(c.created_at || c.createdAt) === date);
  const statusTally = {};
  for (const c of kkContentToday) statusTally[c.status || '?'] = (statusTally[c.status || '?'] || 0) + 1;

  // 3) 批次执行记录
  const runs = [];
  for (const b of ['morning', 'evening']) {
    const f = path.join(BATCHDIR, `${date}-${b}.json`);
    if (fs.existsSync(f)) {
      const d = readJson(f);
      if (d) runs.push({
        batch: b, items: (d.items || []).length,
        art_ok: d.art_ok || 0, art_fail: d.art_fail || 0,
        injected: d.injected || 0, inject_failed: d.inject_failed || 0,
        finishedAt: d.finishedAt || null,
      });
    }
  }

  // 4) 真实互动（note_count）
  let harvestInfo = null;
  if (doHarvest) {
    console.log('[反馈] 触发真实 note_count 回收…');
    harvestInfo = await harvestNotes();
    console.log(`       回收结果: ${JSON.stringify(harvestInfo).slice(0, 200)}`);
  }
  const pos = await fetchPositive(0, 1000);
  const myFeedback = (pos.items || []).filter((x) => acctIds.has(String(x.accountId)));
  const noteTotal = myFeedback.reduce((s, x) => s + (Number(x.noteCount) || 0), 0);
  const growthTotal = myFeedback.reduce((s, x) => s + (Number(x.growthAbs) || 0), 0);
  const engaged = myFeedback.filter((x) => Number(x.noteCount) > 0);

  // 4b) 发布器限流/退避快照（解释「为什么还有 N 条没发出去」的第二层原因）
  const quota = await fetchQuota();

  // 5) 账号维度（今天各发了多少）
  const perAcct = {};
  for (const id of acctIds) perAcct[id] = { published: 0, urls: [], batch: new Set() };
  for (const p of okToday) {
    const a = perAcct[p.account_id];
    if (!a) continue;
    a.published++;
    if (p.publish_url) a.urls.push(p.publish_url);
    const m = String(p.content_id).match(/-(morning|evening)-/);
    if (m) a.batch.add(m[1]);
  }
  const silentAccts = Object.entries(perAcct).filter(([, v]) => v.published === 0).map(([k]) => k);

  // 待发布（已注入 ready/queued 但今日未出现在 publish 台账）
  const publishedIds = new Set(kkPubToday.map((p) => String(p.content_id)));
  const pendingToday = kkContentToday.filter((c) => !publishedIds.has(String(c.id)) && c.status !== 'published');

  // ── 待发原因分解（2026-09-22）──────────────────────────────────────────
  // 为什么需要：发布器对**每个账号**有 45 分钟最短发布间隔
  // （cloud-publisher.minIntervalMs，默认 2700000ms）。首日 40 条是「早批+晚批
  // 在同一窗口内注入」的，同一账号的两条只能互相排队 —— 表现为「已注入但久不发布」。
  // 若不归因，日报里「待发布 29 条」会被误读成故障。这里按账号核算距上次
  // **tumblr 成功发布**的分钟数（provider 通道如 nostr 不占用该窗口，须排除），
  // 把待发条目如实分成「等 45 分钟窗口」与「窗口已开、排队中」两类。
  const MIN_GAP_MIN = Math.round(Number(process.env.MSCMS_MIN_PUBLISH_INTERVAL_MS || 2700000) / 60000);
  const lastTumblrByAcct = {};
  for (const p of pubAll) {
    if (!p.publish_url) continue;
    if (String(p.platform || '').toLowerCase() !== 'tumblr') continue;
    const aid = String(p.account_id || p.accountId || '');
    if (!aid || !acctIds.has(aid)) continue;
    const t = Date.parse(p.published_at || p.publishedAt || p.createdAt);
    if (isNaN(t)) continue;
    if (!lastTumblrByAcct[aid] || t > lastTumblrByAcct[aid]) lastTumblrByAcct[aid] = t;
  }
  const pendingDetail = pendingToday.map((c) => {
    const aid = String(c.account_id || '');
    const last = lastTumblrByAcct[aid] || null;
    const elMin = last ? Math.floor((Date.now() - last) / 60000) : null;
    const blocked = elMin !== null && elMin < MIN_GAP_MIN;
    return {
      id: String(c.id), account_id: aid, status: c.status || '?',
      lastMin: elMin, blocked,
      reason: blocked
        ? `等 ${MIN_GAP_MIN} 分钟窗口（距该账号上次成功 ${elMin} 分钟）`
        : '窗口已开，排队等待发布',
    };
  });
  const pendingBlocked = pendingDetail.filter((d) => d.blocked).length;

  // ── 渲染 ──
  const metrics = {
    date,
    target: DAILY_TARGET,
    publishedOk: okToday.length,
    publishedFail: failToday.length,
    injectedToday: kkContentToday.length,
    pendingToday: pendingToday.length,
    pendingBlocked,
    pendingDetail,
    minGapMin: MIN_GAP_MIN,
    quota,
    acctSpread: Object.values(perAcct).filter((v) => v.published > 0).length,
    acctTotal: acctIds.size,
    silentAccts,
    statusTally,
    runs,
    batches: {
      morning: { ok: byBatch.morning.filter((p) => p.publish_url).length, total: byBatch.morning.length },
      evening: { ok: byBatch.evening.filter((p) => p.publish_url).length, total: byBatch.evening.length },
    },
    feedback: {
      harvested: doHarvest,
      harvestResult: harvestInfo ? (harvestInfo.ok ? 'ok' : (harvestInfo.error || 'failed')) : 'skipped',
      trackedPosts: myFeedback.length,
      noteTotal,
      growthTotal,
      engagedPosts: engaged.length,
      topPosts: engaged.sort((a, b) => (Number(b.noteCount) || 0) - (Number(a.noteCount) || 0)).slice(0, 10),
    },
    perAcct: Object.fromEntries(Object.entries(perAcct).map(([k, v]) => [k, { published: v.published, urls: v.urls, batches: [...v.batch], blog: (acctById[k] || {}).blogName || null }])),
  };

  // ── Markdown ──
  const md = [];
  md.push(`# KKMatch 投放日报 · ${date}`);
  md.push('');
  md.push(`> 生成时间 ${new Date().toISOString()} · 目标 ${DAILY_TARGET} 帖/天（20 账号 × 早晚各 1 帖）`);
  md.push('');
  md.push('## 1. 发布总览');
  md.push('');
  md.push('| 指标 | 数值 | 说明 |');
  md.push('|---|---|---|');
  md.push(`| 发布成功 | **${metrics.publishedOk} / ${DAILY_TARGET}** | 口径：\`publish_url\` 非空 |`);
  md.push(`| 发布失败 | ${metrics.publishedFail} | 有台账无 URL |`);
  md.push(`| 今日注入 | ${metrics.injectedToday} | 写入 content 池的 kk20 内容 |`);
  md.push(`| 待发布 | ${metrics.pendingToday} | 已注入但未出现在发布台账 |`);
  md.push(`| 账号分散度 | **${metrics.acctSpread} / ${metrics.acctTotal}** | 今日有成功发布的账号数 |`);
  md.push(`| 早批 | ${metrics.batches.morning.ok} / ${metrics.batches.morning.total} | |`);
  md.push(`| 晚批 | ${metrics.batches.evening.ok} / ${metrics.batches.evening.total} | |`);
  md.push('');
  md.push('### 内容池状态（今日注入）');
  md.push('');
  md.push('| status | 条数 |');
  md.push('|---|---|');
  for (const [k, v] of Object.entries(metrics.statusTally)) md.push(`| ${k} | ${v} |`);
  md.push('');
  if (metrics.pendingDetail.length) {
    md.push(`### 待发布原因分解（${metrics.pendingDetail.length} 条）`);
    md.push('');
    md.push(`- 等 ${metrics.minGapMin} 分钟发布窗口：**${metrics.pendingBlocked}** 条（同账号近期已发过，属正常节流）`);
    md.push(`- 窗口已开、排队中：**${metrics.pendingDetail.length - metrics.pendingBlocked}** 条`);
    md.push('');
    md.push('| 内容 | 账号 | status | 距该账号上次成功 | 归因 |');
    md.push('|---|---|---|---|---|');
    for (const d of metrics.pendingDetail) {
      md.push(`| \`${d.id}\` | ${d.account_id} | ${d.status} | ${d.lastMin === null ? '从未' : d.lastMin + ' 分钟'} | ${d.reason} |`);
    }
    md.push('');
    md.push(`> 发布器对每个账号有 ${metrics.minGapMin} 分钟最短发布间隔，` +
      `provider 通道（nostr 等）不占用该窗口。`);
    md.push('');
  }
  // 限流/退避状态：解释「为什么要等」的第二层原因（第一层是上面的 45 分钟窗口）
  if (metrics.quota && metrics.quota.ok) {
    const q = metrics.quota;
    const hasIssue = q.globalActive || q.acctBackoff.length > 0;
    md.push(`### 发布器限流状态${hasIssue ? '（⚠️ 存在限流退避）' : '（正常）'}`);
    md.push('');
    md.push(q.globalActive
      ? `- **全局限额暂停中**：至 ${new Date(q.globalUntil).toLocaleString('zh-CN')} — ${q.globalReason || '原因未记录'}`
      : '- 全局暂停：未触发');
    md.push(`- 账号级退避中：**${q.acctBackoff.length}** 个` +
      (q.acctBackoff.length ? `（${q.acctBackoff.map((a) => `${a.accountId} 剩 ${a.remainingMin}min`).join('、')}）` : ''));
    md.push(`- 近 10 分钟限流样本：${q.recentRateLimits}` +
      (q.thresholds ? ` | 升级阈值：${q.thresholds.escalateAccounts} 个不同账号 / ${q.thresholds.escalateWindowMin} 分钟 ⇒ 全局暂停 ${q.thresholds.globalPauseMin} 分钟` : ''));
    md.push('');
    md.push('> 账号级退避（默认 30 分钟）只冻**单个**账号，其余账号照常发布；只有**多个不同账号**在窗口内' +
      '先后限流才升级为全局暂停（那才是平台/出口级限流的特征）。以上为生成时刻的快照，非全天累计。');
    md.push('');
  } else if (metrics.quota) {
    md.push(`> 限流状态：读取失败（${metrics.quota.error}）— 不影响其余指标。`);
    md.push('');
  }
  md.push('## 2. 数据反馈（真实 note_count）');
  md.push('');
  md.push(`- 回收动作：${metrics.feedback.harvestResult}`);
  md.push(`- 追踪中的帖子：**${metrics.feedback.trackedPosts}** 条（20 账号在 MySQL \`matrix_posts_published\` 的记录）`);
  md.push(`- 累计 note_count：**${metrics.feedback.noteTotal}** · 本轮增长：**${metrics.feedback.growthTotal}**`);
  md.push(`- 有互动的帖子：**${metrics.feedback.engagedPosts}** 条`);
  md.push('');
  if (metrics.feedback.topPosts.length) {
    md.push('| 帖子 | note | 增长 |');
    md.push('|---|---|---|');
    for (const t of metrics.feedback.topPosts) md.push(`| ${esc(t.postUrl)} | ${t.noteCount} | ${t.growthAbs} |`);
    md.push('');
  } else {
    md.push('> 暂无带 note_count 的记录。');
    md.push('');
  }
  md.push('> ⚠️ 口径说明：`publish.json` 里的 `reach/likes/comments/shares` 字段**从未回收**，恒为 0，');
  md.push('> 因此本报告不据此判定"零互动"；真实互动一律以上表 `note_count` 为准。');
  md.push('');
  md.push('## 3. 账号明细');
  md.push('');
  md.push('| 账号 | blog | 今日发布 | 批次 | 结果 |');
  md.push('|---|---|---|---|---|');
  for (const [id, v] of Object.entries(metrics.perAcct)) {
    md.push(`| ${id} | ${esc(v.blog || '-')} | ${v.published} | ${v.batches.join('+') || '-'} | ${v.published > 0 ? '✅' : (v.published === 0 ? '—' : '')} |`);
  }
  md.push('');
  if (silentAccts.length) {
    md.push(`### ⚠️ 今日零发布账号（${silentAccts.length}）`);
    md.push('');
    md.push(silentAccts.map((a) => `\`${a}\``).join(' · '));
    md.push('');
  }
  md.push('## 4. 执行记录');
  md.push('');
  if (runs.length) {
    md.push('| 批次 | 条数 | 配图成功 | 注入成功 | 注入失败 | 完成时间 |');
    md.push('|---|---|---|---|---|---|');
    for (const r of runs) md.push(`| ${r.batch} | ${r.items} | ${r.art_ok} | ${r.injected} | ${r.inject_failed} | ${r.finishedAt || '-'} |`);
  } else {
    md.push('> 今日无批次执行记录。');
  }
  md.push('');

  const mdPath = path.join(OUTDIR, `${date}.md`);
  fs.writeFileSync(mdPath, md.join('\n'), 'utf8');

  // ── HTML ──
  const html = renderHTML(metrics);
  const htmlPath = path.join(OUTDIR, `${date}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  // ── 控制台摘要 ──
  console.log(`\n  发布成功   ${metrics.publishedOk} / ${DAILY_TARGET}`);
  console.log(`  账号分散度 ${metrics.acctSpread} / ${metrics.acctTotal}`);
  console.log(`  今日注入   ${metrics.injectedToday} 条（待发布 ${metrics.pendingToday}：等 ${metrics.minGapMin} 分钟窗口 ${metrics.pendingBlocked} · 排队 ${metrics.pendingDetail.length - metrics.pendingBlocked}）`);
  if (metrics.quota && metrics.quota.ok) {
    const q = metrics.quota;
    console.log(`  限流状态   全局暂停 ${q.globalActive ? `是（至 ${new Date(q.globalUntil).toLocaleTimeString('zh-CN')}）` : '否'}` +
      ` · 账号退避 ${q.acctBackoff.length} 个 · 近 10 分钟限流样本 ${q.recentRateLimits}`);
  } else if (metrics.quota) {
    console.log(`  限流状态   读取失败（${metrics.quota.error}）`);
  }
  console.log(`  真实互动   note 累计 ${metrics.feedback.noteTotal} · 增长 ${metrics.feedback.growthTotal} · 有互动帖 ${metrics.feedback.engagedPosts}`);
  if (silentAccts.length) console.log(`  ⚠️ 零发布账号 ${silentAccts.length} 个: ${silentAccts.slice(0, 6).join(', ')}${silentAccts.length > 6 ? ' …' : ''}`);
  console.log(`\n  报告: ${mdPath}`);
  console.log(`        ${htmlPath}`);

  if (has('--notify') && fs.existsSync(TG)) {
    const summary = [
      `KKMatch 投放日报 ${date}`,
      `发布成功 ${metrics.publishedOk}/${DAILY_TARGET} · 账号 ${metrics.acctSpread}/${metrics.acctTotal}`,
      `注入 ${metrics.injectedToday} · 待发 ${metrics.pendingToday}`,
      `note 累计 ${metrics.feedback.noteTotal}（增长 ${metrics.feedback.growthTotal}）`,
      silentAccts.length ? `⚠️ 零发布 ${silentAccts.length} 个账号` : '',
    ].filter(Boolean).join('\n');
    const r = spawnSync(process.execPath, [TG, '--text', summary], { stdio: 'inherit' });
    console.log(`  Telegram 推送退出码: ${r.status}`);
  }

  console.log(JSON.stringify({ ok: true, date, ...metrics }, null, 1).slice(0, 40) + ' …');
}

function renderHTML(m) {
  const pct = Math.round((m.publishedOk / m.target) * 100);
  const acctPct = Math.round((m.acctSpread / m.acctTotal) * 100);
  const rowsAcct = Object.entries(m.perAcct).map(([id, v]) => `
      <tr><td><code>${esc(id)}</code></td><td>${esc(v.blog || '-')}</td>
      <td class="n">${v.published}</td><td>${v.batches.join('+') || '-'}</td>
      <td>${v.published > 0 ? '<span class="ok">已发</span>' : '<span class="warn">未发</span>'}</td></tr>`).join('');

  const rowsTop = m.feedback.topPosts.length ? m.feedback.topPosts.map((t) => `
      <tr><td><a href="${esc(t.postUrl)}">${esc(t.postUrl).slice(0, 78)}</a></td>
      <td class="n">${t.noteCount}</td><td class="n">${t.growthAbs}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">暂无带 note_count 的记录</td></tr>';

  const rowsRuns = m.runs.length ? m.runs.map((r) => `
      <tr><td>${esc(r.batch)}</td><td class="n">${r.items}</td><td class="n">${r.art_ok}</td>
      <td class="n">${r.injected}</td><td class="n">${r.inject_failed}</td><td class="muted">${esc(r.finishedAt || '-')}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">今日无批次执行记录</td></tr>';

  const statusRows = Object.entries(m.statusTally).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('')
    || '<tr><td colspan="2" class="muted">无</td></tr>';

  // 限流/退避状态块（第二层「为什么没发出去」）
  let quotaNote = '';
  {
    const q = m.quota;
    if (q && q.ok) {
      const issue = q.globalActive || q.acctBackoff.length > 0;
      quotaNote = `<div class="note" style="${issue ? '' : 'background:#f2f8f3;border-color:#cfe6d5;border-left-color:var(--ok);color:#1d4a2b'}">
        <b>限流状态${issue ? '（⚠️ 存在限流退避）' : '（正常）'}：</b>
        ${q.globalActive
          ? `全局限额暂停中，至 <b>${esc(new Date(q.globalUntil).toLocaleString('zh-CN'))}</b> — ${esc(q.globalReason || '原因未记录')}。`
          : '未触发全局暂停。'}
        账号级退避中 <b>${q.acctBackoff.length}</b> 个${q.acctBackoff.length
          ? `（${q.acctBackoff.map((a) => `<code>${esc(a.accountId)}</code> 剩 ${a.remainingMin}min`).join('、')}）` : ''}。
        近 10 分钟限流样本 ${q.recentRateLimits}${q.thresholds
          ? ` · 升级阈值 ${q.thresholds.escalateAccounts} 个不同账号 / ${q.thresholds.escalateWindowMin} 分钟 ⇒ 全局暂停 ${q.thresholds.globalPauseMin} 分钟` : ''}。
        <br>账号级退避只冻<b>单个</b>账号、其余照常发布；只有<b>多个不同账号</b>在窗口内先后限流才升级为全局暂停。
        以上为生成时刻快照，非全天累计。</div>`;
    } else if (q) {
      quotaNote = `<div class="note">限流状态：读取失败（${esc(q.error)}）— 不影响其余指标。</div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KKMatch 投放日报 · ${esc(m.date)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14181f;--sub:#5b6673;--line:#e3e7ed;--ok:#0f9d58;--warn:#d93025;--accent:#1a73e8;--amber:#c77700}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px;background:var(--bg);color:var(--ink);
 font:14px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:1000px;margin:0 auto}
h1{font-size:24px;margin:0 0 6px;letter-spacing:-.3px}
.sub{color:var(--sub);font-size:13px;margin-bottom:22px}
h2{font-size:16px;margin:30px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:14px 16px}
.card .k{color:var(--sub);font-size:12px;margin-bottom:5px}
.card .v{font-size:23px;font-weight:650;letter-spacing:-.5px}
.card .s{color:var(--sub);font-size:11px;margin-top:3px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden;font-size:13px}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#fafbfc;font-weight:600;color:var(--sub);font-size:12px}
tr:last-child td{border-bottom:none}
td.n{text-align:right;font-variant-numeric:tabular-nums}
code{background:#eef1f5;padding:1px 5px;border-radius:4px;font-size:12px}
.ok{color:var(--ok);font-weight:600}.warn{color:var(--warn);font-weight:600}.muted{color:var(--sub)}
.note{background:#fff8e6;border:1px solid #f0dfae;border-left:3px solid var(--amber);border-radius:7px;padding:12px 15px;margin:14px 0;font-size:13px;color:#5c4a12}
.bar{height:7px;background:#e8ecf1;border-radius:4px;overflow:hidden;margin-top:8px}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:4px}
.foot{color:var(--sub);font-size:12px;margin-top:28px;padding-top:14px;border-top:1px solid var(--line)}
</style></head><body><div class="wrap">
<h1>KKMatch 投放日报 · ${esc(m.date)}</h1>
<div class="sub">20 账号 × 早晚各 1 帖 = 目标 ${m.target} 帖/天 · 生成于 ${esc(new Date().toLocaleString('zh-CN'))}</div>

<div class="cards">
  <div class="card"><div class="k">发布成功</div><div class="v">${m.publishedOk}<span class="muted" style="font-size:14px">/${m.target}</span></div>
    <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div><div class="s">${pct}% · 口径 publish_url 非空</div></div>
  <div class="card"><div class="k">账号分散度</div><div class="v">${m.acctSpread}<span class="muted" style="font-size:14px">/${m.acctTotal}</span></div>
    <div class="bar"><i style="width:${Math.min(100, acctPct)}%"></i></div><div class="s">${acctPct}% 账号今日有产出</div></div>
  <div class="card"><div class="k">今日注入</div><div class="v">${m.injectedToday}</div><div class="s">待发布 ${m.pendingToday} 条</div></div>
  <div class="card"><div class="k">真实 note 累计</div><div class="v">${m.feedback.noteTotal}</div>
    <div class="s">增长 ${m.feedback.growthTotal} · 有互动 ${m.feedback.engagedPosts} 帖</div></div>
</div>

<h2>1. 发布总览</h2>
<table><thead><tr><th>批次</th><th class="n">成功 / 总数</th></tr></thead><tbody>
<tr><td>早批 morning</td><td class="n">${m.batches.morning.ok} / ${m.batches.morning.total}</td></tr>
<tr><td>晚批 evening</td><td class="n">${m.batches.evening.ok} / ${m.batches.evening.total}</td></tr>
<tr><td>发布失败（有台账无 URL）</td><td class="n">${m.publishedFail}</td></tr>
</tbody></table>

<h2>2. 内容池状态与待发布原因（今日注入）</h2>
<table><thead><tr><th>status</th><th class="n">条数</th></tr></thead><tbody>${statusRows}</tbody></table>
<table style="margin-top:12px"><thead><tr><th>待发内容</th><th>账号</th><th>status</th><th class="n">距上次成功</th><th>归因</th></tr></thead><tbody>${
  m.pendingDetail.length
    ? m.pendingDetail.map((d) => `<tr><td><code>${esc(d.id)}</code></td><td><code>${esc(d.account_id)}</code></td>
      <td>${esc(d.status)}</td><td class="n">${d.lastMin === null ? '从未' : d.lastMin + ' 分'}</td>
      <td>${d.blocked ? `<span class="muted">${esc(d.reason)}</span>` : esc(d.reason)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">今日无待发条目</td></tr>'
}</tbody></table>
<div class="note"><b>节流说明：</b>发布器对每个账号有 <b>${m.minGapMin}</b> 分钟最短发布间隔，
同账号近期已发过时会被推迟重试 —— 属<b>正常节流，不是故障</b>；provider 通道（nostr 等）不占用该窗口。
当前：等窗口 <b>${m.pendingBlocked}</b> 条 / 窗口已开排队 <b>${m.pendingDetail.length - m.pendingBlocked}</b> 条。</div>
${quotaNote}

<h2>3. 数据反馈（真实 note_count）</h2>
<table><thead><tr><th>帖子</th><th class="n">note</th><th class="n">增长</th></tr></thead><tbody>${rowsTop}</tbody></table>
<div class="note"><b>口径说明：</b>回收动作 <code>${esc(m.feedback.harvestResult)}</code>，追踪中 ${m.feedback.trackedPosts} 条。
<code>publish.json</code> 的 <code>reach/likes/comments/shares</code> 字段<b>从未回收</b>、恒为 0，
故不据此判定「零互动」；真实互动以上表 <code>note_count</code> 为准。</div>

<h2>4. 账号明细</h2>
<table><thead><tr><th>账号</th><th>blog</th><th class="n">今日发布</th><th>批次</th><th>结果</th></tr></thead>
<tbody>${rowsAcct}</tbody></table>

<h2>5. 执行记录</h2>
<table><thead><tr><th>批次</th><th class="n">条数</th><th class="n">配图</th><th class="n">注入</th><th class="n">失败</th><th>完成时间</th></tr></thead>
<tbody>${rowsRuns}</tbody></table>

<div class="foot">MSCMS v14 · KKMatch 定向投放 · 数据源：publish.json / content.json / matrix_posts_published（MySQL）</div>
</div></body></html>`;
}

main().catch((e) => { console.error(`\n❌ 日报生成失败: ${e.message}`); process.exit(1); });
