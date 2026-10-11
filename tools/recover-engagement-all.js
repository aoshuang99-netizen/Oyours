#!/usr/bin/env node
/**
 * recover-engagement-all.js —— 真实互动回收「自愈触发器」（C 步骤交付物）
 * ============================================================================
 * 两类真实互动回收都依赖 Tumblr 出网（OAuth token + 账号出口代理）。当前出口层
 * 是已知 P0「出口层未根修」：proxy-pool.json 90 条 0 条可用，唯一启用的是被 Tumblr
 * 在网络层重置的数据中心 IP（10808 → 104.36.71.219），因此 /blog/{blog}/posts 全部
 * fetch failed。本脚本不伪造任何数字，只负责：
 *
 *   1) POST /api/v14/tumblr/post-metrics/harvest  {maxBlogs:200}
 *      → 写 post_metrics.json（那份 updated_at 冻结在 2026-09-08 的文件）
 *   2) POST /api/v14/tumblr/engagement/harvest    {maxPerRun:300}
 *      → 写 MySQL matrix_posts_published（note_count 时间序列）
 *
 * 两个端点都是【服务端长跑】，出口恢复后调用即生效。本脚本作为定时任务周期性触发，
 * 实现「出口一恢复就自动回采」，无需人工重跑。
 *
 * 用法：node tools/recover-engagement-all.js
 */

'use strict';

const API = process.env.MSCS_API || process.env.MSCMS_API || 'http://127.0.0.1:3002';

async function req(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 600000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: r.status, j };
  } catch (e) {
    return { status: 0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function snap() {
  try {
    const r = await fetch(`${API}/api/v14/tumblr/post-metrics`);
    return await r.json();
  } catch (e) { return {}; }
}

(async () => {
  const before = await snap();
  const bNotes = before.total_notes || 0;
  const bBlogs = before.harvested_blogs || 0;
  console.log(`[before] updated_at=${before.updated_at} harvested_blogs=${bBlogs} total_notes=${bNotes}`);

  // 1) post_metrics.json（冻结文件）回采
  const p1 = await req(`${API}/api/v14/tumblr/post-metrics/harvest`, { maxBlogs: 200 }, 600000);
  console.log('[post-metrics/harvest]', p1.status, JSON.stringify(p1.j || { error: p1.error }).slice(0, 320));

  // 2) MySQL 回采
  const p2 = await req(`${API}/api/v14/tumblr/engagement/harvest`, { maxPerRun: 300 }, 600000);
  console.log('[engagement/harvest]', p2.status, JSON.stringify(p2.j || { error: p2.error }).slice(0, 320));

  const after = await snap();
  const aNotes = after.total_notes || 0;
  const aBlogs = after.harvested_blogs || 0;
  console.log(`[after] updated_at=${after.updated_at} harvested_blogs=${aBlogs} total_notes=${aNotes}`);

  if (aNotes > bNotes || aBlogs > bBlogs || (after.updated_at && after.updated_at !== before.updated_at)) {
    console.log('✅ 真实互动已回采（出口层可用）');
  } else {
    console.log('⚠️ 未回采：出口层仍 fetch failed。待出口修复后本任务会自动重试（无需人工）。');
  }
})();
