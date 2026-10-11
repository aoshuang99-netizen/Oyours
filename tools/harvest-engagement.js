#!/usr/bin/env node
/**
 * harvest-engagement.js —— Tumblr 真实互动（note_count）定时回收器
 *
 * 为什么需要它（2026-09-24 诊断）：
 *   post_metrics.json 的最后一次回收停在 2026-09-08，之后的 16 天里
 *   5721 条发布记录 → 仅 12 个 note。不是"没采到"，是【回收动作本身停了】。
 *   没有真实互动数据，"内容有没有用"这件事就无法被判定，增长只能靠猜。
 *
 * 动作（全部为真实接口，零估算）：
 *   1) POST /api/v14/tumblr/engagement/harvest  {maxPerRun: 300}
 *      → 走 Tumblr 官方 API 拉真实 note_count，写回 MySQL matrix_posts_published
 *   2) GET  /api/v14/tumblr/post-metrics
 *      → 汇总 total_publish / total_blogs / harvested_blogs / counts
 *
 * 用法:
 *   node tools/harvest-engagement.js            # 执行 + 打印摘要
 *   node tools/harvest-engagement.js --quiet    # 只写日志
 *   node tools/harvest-engagement.js --max 500  # 单轮上限
 *
 * 退出码: 0 成功 / 1 失败（便于计划任务与自动化判断）
 */
const fs = require('fs');
const path = require('path');

const API = process.env.MSCMS_API || 'http://127.0.0.1:3002';
const LOG = process.env.HARVEST_LOG || 'D:/mscms-ws/logs/engagement-harvest.log';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.includes('--' + n);

function logLine(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) { /* 日志失败不应中断回收 */ }
  if (!has('quiet')) console.log(line);
}

async function req(url, opts) {
  const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(300000) }, opts));
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { ok: r.ok, status: r.status, json, text: text.slice(0, 400) };
}

async function metrics() {
  const m = await req(`${API}/api/v14/tumblr/post-metrics`, { method: 'GET' });
  return { ok: m.ok, status: m.status, j: m.json || {} };
}

(async () => {
  const max = parseInt(arg('max', '300'), 10) || 300;
  let failed = false;

  // 0) 基线（回收前）
  let before = { ok: false, j: {} };
  try { before = await metrics(); } catch (e) { logLine(`[基线] 读取失败: ${e.message}`); }

  // 1) 触发回收
  //
  // ⚠️ 关键事实（2026-09-24 实测）：本端点是【服务端长跑】。第一轮请求会在服务端留下一个
  //    仍在跑的 run；此后所有请求立刻返回 `{"ok":true,"skipped":true,"reason":"already-running"}`
  //    （实测 0.5s 返回）。因此：
  //      · `skipped / already-running` 必须判为【成功】，否则脚本会把自己报成失败（假故障）；
  //      · 客户端超时【不会】终止服务端 run，所以超时后不要重试风暴，等下一轮即可。
  try {
    const h = await req(`${API}/api/v14/tumblr/engagement/harvest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPerRun: max }),
      signal: AbortSignal.timeout(1800000),
    });
    const d = h.json || {};
    const note = d.skipped ? `已在跑(${d.reason})` : '本轮已触发';
    logLine(`harvest -> HTTP ${h.status} · ${note} · ${JSON.stringify(d).slice(0, 240)}`);
    if (!h.ok) failed = true;
  } catch (e) {
    logLine(`harvest 请求异常（服务端可能仍在跑，不当故障）: ${e.message}`);
  }

  // 2) 汇总真实口径 + 与基线对比
  try {
    const after = await metrics();
    const counts = after.j.counts || {};
    const delta = (after.j.total_publish || 0) - (before.j.total_publish || 0);
    logLine(`post-metrics -> HTTP ${after.status} total_publish=${after.j.total_publish}(+${delta}) total_blogs=${after.j.total_blogs} harvested_blogs=${after.j.harvested_blogs} counts=${JSON.stringify(counts)}`);
    if (delta < 0 || !after.ok) failed = true;
  } catch (e) {
    logLine(`post-metrics FAILED: ${e.message}`);
    failed = true;
  }

  logLine(failed ? '=== 本轮存在失败项 ===' : '=== 本轮回收完成 ===');
  process.exit(failed ? 1 : 0);
})();
