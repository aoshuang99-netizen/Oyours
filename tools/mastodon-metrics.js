#!/usr/bin/env node
/**
 * mastodon-metrics.js -- Mastodon 互动回收（免费、可度量）
 * ──────────────────────────────────────────────────────────────────
 * 为什么需要它：kkmatch.com 目前【没有任何第一方 DAU 计量】（beacon 端点需公网 DNS，
 * 尚未打通）。Mastodon 是当前唯一真实在跑的引流通道，因此"帖子有没有被真人看到"
 * 是唯一可验证的信号 —— 而 Mastodon 公开 API 免费提供 favourites/reblogs/replies
 * 计数，无需任何付费、无需后端改造。
 *
 * 它做三件事：
 *   1) /api/v1/accounts/verify_credentials  → 确认 token 活着 + 拿到账号 id
 *   2) /api/v1/accounts/:id/statuses        → 拉最近 N 条帖子的互动计数
 *   3) 追加一份快照到 reports/mastodon-metrics.jsonl（按日期累积，可看趋势）
 *
 * 用法：
 *   node tools/mastodon-metrics.js                # 最近 20 条 + 汇总
 *   node tools/mastodon-metrics.js --json         # 只打原始 JSON
 *   node tools/mastodon-metrics.js --limit 50
 *   node tools/mastodon-metrics.js --ids 117409906912922779,117409906991639147
 *
 * 诚实铁律：拉不到就报真实错误（含 HTTP 码），绝不伪造计数。
 * 凭据自动从项目根 .n8n-env 读取（MASTODON_INSTANCE / MASTODON_TOKEN）。
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

const { loadN8nEnv } = require('./free-platform-publisher.js');

const TIMEOUT_MS = 15000;
const REPORT_DIR = path.join(__dirname, '..', 'reports');
const REPORT_FILE = path.join(REPORT_DIR, 'mastodon-metrics.jsonl');

function jget(url, token) {
  const args = ['-4', '-s', '-m', String(Math.round(TIMEOUT_MS / 1000)),
    '-H', 'Accept: application/json', '-w', '\n__HTTP__%{http_code}'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push(url);
  return execFileAsync('curl', args, { timeout: TIMEOUT_MS + 3000, maxBuffer: 16 * 1024 * 1024 })
    .then(({ stdout }) => {
      const m = stdout.match(/\n__HTTP__(\d+)$/);
      const code = m ? parseInt(m[1], 10) : 0;
      const body = stdout.replace(/\n__HTTP__\d+$/, '');
      return { code, body };
    });
}

function stripHtml(s) {
  return String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function fmt(n) { return String(n == null ? 0 : n).padStart(4, ' '); }

async function main() {
  const args = process.argv.slice(2);
  loadN8nEnv();

  const base = (process.env.MASTODON_INSTANCE || '').replace(/\/+$/, '');
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!base || !token) {
    console.error('❌ 缺 MASTODON_INSTANCE / MASTODON_ACCESS_TOKEN（应来自 .n8n-env）');
    console.error('   预期 .n8n-env 含: MASTODON_INSTANCE=https://mastodon.social 与 MASTODON_TOKEN=...');
    process.exit(2);
  }

  // 1) 确认 token + 账号
  const cred = await jget(`${base}/api/v1/accounts/verify_credentials`, token);
  if (cred.code !== 200) {
    console.error(`❌ verify_credentials HTTP ${cred.code}: ${cred.body.slice(0, 200)}`);
    console.error('   若 401 → token 失效需重新生成；若 000 → 本机无外网/被墙。');
    process.exit(1);
  }
  const acct = JSON.parse(cred.body);
  const handle = `@${acct.acct}@${new URL(base).host}`;
  console.log(`✅ 账号已确认: ${handle} (id=${acct.id})`);
  console.log(`   粉丝 ${acct.followers_count} · 关注 ${acct.following_count} · 发帖 ${acct.statuses_count}\n`);

  // 2) 拉最近帖子
  let posts = [];
  const idsArg = args.indexOf('--ids');
  if (idsArg >= 0) {
    const ids = String(args[idsArg + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      const r = await jget(`${base}/api/v1/statuses/${id}`, null);
      if (r.code !== 200) { console.error(`  ⚠️ status ${id} HTTP ${r.code}`); continue; }
      posts.push(JSON.parse(r.body));
    }
  } else {
    const li = args.indexOf('--limit');
    const limit = li >= 0 ? Math.max(1, Math.min(200, parseInt(args[li + 1], 10) || 20)) : 20;
    const r = await jget(`${base}/api/v1/accounts/${acct.id}/statuses?limit=${limit}&exclude_replies=true&exclude_reblogs=true`, token);
    if (r.code !== 200) { console.error(`❌ statuses HTTP ${r.code}: ${r.body.slice(0, 200)}`); process.exit(1); }
    posts = JSON.parse(r.body);
  }

  if (args.includes('--json')) { console.log(JSON.stringify(posts, null, 2)); return { posts }; }

  // 3) 汇总 + 落盘
  const snap = posts.map(p => ({
    id: p.id,
    url: p.url,
    created_at: p.created_at,
    favourites: p.favourites_count || 0,
    reblogs: p.reblogs_count || 0,
    replies: p.replies_count || 0,
    text: stripHtml(p.content).slice(0, 90),
  }));
  const tot = snap.reduce((a, x) => ({ f: a.f + x.favourites, r: a.r + x.reblogs, p: a.p + x.replies }), { f: 0, r: 0, p: 0 });

  console.log('  favs  boosts replies  created             url');
  console.log('  ' + '-'.repeat(88));
  for (const s of snap) {
    console.log(`  ${fmt(s.favourites)}  ${fmt(s.reblogs)}  ${fmt(s.replies)}   ${(s.created_at || '').slice(0, 16)}  ${s.url}`);
  }
  console.log('  ' + '-'.repeat(88));
  console.log(`  ${fmt(tot.f)}  ${fmt(tot.r)}  ${fmt(tot.p)}   << 合计（${snap.length} 条）`);
  console.log(`\n[summary] favorites=${tot.f} boosts=${tot.r} replies=${tot.p} posts=${snap.length}`);
  if (tot.f + tot.r + tot.p === 0) {
    console.log('提示：全部为 0 = 目前没有真人互动（Mastodon 上标签/内容/账号冷启动都会影响触达）。');
    console.log('      这不是"没采到"，是确实还没人互动 —— 不要据此判断失败，持续发+加 hashtag 再看趋势。');
  }

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.appendFileSync(REPORT_FILE, JSON.stringify({ at: new Date().toISOString(), handle, totals: { favorites: tot.f, boosts: tot.r, replies: tot.p }, posts: snap }) + '\n');
  console.log(`\n📒 快照已追加: ${path.relative(path.join(__dirname, '..'), REPORT_FILE)}`);
  return { snap, tot };
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
}
module.exports = { main };
