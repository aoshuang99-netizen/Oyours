#!/usr/bin/env node
/**
 * _tmp_audit_real_publish.js — 真实外发内容全量盘点（只读）
 * 输出 JSON 到 _audit_real_publish.json，供报告渲染使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DATA = 'D:/mscms-ws/data';
function load(p) { const o = JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8')); return Array.isArray(o) ? o : (o.items || []); }

const pubs = load('publish.json');
const contents = load('content.json');
const accounts = load('accounts.json');
const tokens = JSON.parse(fs.readFileSync(path.join(DATA, 'tumblr_token.json'), 'utf8'));

const blogOf = (u) => { const m = String(u || '').match(/blog\/view\/([^\/]+)\//); return m ? m[1] : null; };
const dayOf = (s) => String(s || '').slice(0, 10);
const accMap = new Map(accounts.map((a) => [String(a.id), a]));
const isSimulated = (a) => a && (String(a.email || '').match(/@mscms\.mail$/i) || (a.tags || []).includes('preinstall'));

// ── 1. 基础计数 ──────────────────────────────────────────────
const withUrl = pubs.filter((p) => p.publish_url);
const noUrl = pubs.filter((p) => !p.publish_url);
const out = {};
out.generated_at = new Date().toISOString();
out.total_publish_records = pubs.length;
out.with_url = withUrl.length;
out.without_url = noUrl.length;

// ── 2. 真伪判定：URL 指向的 blog 是否等于该记录 account_id 自己的 blog ──
let ownBlog = 0, crossBlog = 0, unknownOwner = 0, simAccount = 0, fakeUrl = 0;
const crossDetail = {};
const simIds = new Set();
for (const p of withUrl) {
  const accId = String(p.account_id || '');
  const acc = accMap.get(accId);
  if (acc && isSimulated(acc)) { simAccount++; simIds.add(accId); }
  const t = tokens[accId];
  const b = blogOf(p.publish_url);
  if (!t || !t.blogName) { unknownOwner++; continue; }
  if (t.blogName === b) ownBlog++; else { crossBlog++; crossDetail[accId] = (crossDetail[accId] || 0) + 1; }
}

// ── 3. 按平台 / 来源 ─────────────────────────────────────────
const byPlatform = {};
for (const p of withUrl) byPlatform[p.platform || '(空)'] = (byPlatform[p.platform || '(空)'] || 0) + 1;

// ── 4. 按日期 ────────────────────────────────────────────────
const byDay = {};
for (const p of withUrl) { const d = dayOf(p.published_at); if (d) byDay[d] = (byDay[d] || 0) + 1; }
const weekDays = Object.keys(byDay).sort();

// ── 5. 按账号 Top ────────────────────────────────────────────
const byAccount = {};
for (const p of withUrl) { const k = String(p.account_id || '(空)'); byAccount[k] = (byAccount[k] || 0) + 1; }
const topAccounts = Object.entries(byAccount).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([id, n]) => {
  const t = tokens[id];
  return { id, posts: n, blog: t ? t.blogName : '(无token)', simulated: simIds.has(id) };
});

// ── 6. 唯一内容数（去重）─────────────────────────────────────
const uniqContent = new Set(withUrl.map((p) => String(p.content_id || '')));
out.uniq_content = uniqContent.size;
out.avg_reuse = out.uniq_content ? +(withUrl.length / out.uniq_content).toFixed(2) : 0;

// ── 7. blog 收帖分布 ─────────────────────────────────────────
const byBlog = {};
for (const p of withUrl) { const b = blogOf(p.publish_url) || '(无)'; byBlog[b] = (byBlog[b] || 0) + 1; }
const topBlogs = Object.entries(byBlog).sort((a, b) => b[1] - a[1]).slice(0, 12);
const multiWriter = {};
for (const p of withUrl) { const b = blogOf(p.publish_url); if (!b) continue; (multiWriter[b] = multiWriter[b] || new Set()).add(String(p.account_id)); }
const contestedBlogs = Object.entries(multiWriter).filter(([, s]) => s.size > 1).map(([b, s]) => ({ blog: b, writers: s.size })).sort((a, b) => b.writers - a.writers);

// ── 8. 时间窗 ────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
out.today = today;
out.today_posts = withUrl.filter((p) => dayOf(p.published_at) === today).length;

// ── 9. 待发存量 ──────────────────────────────────────────────
const ready = contents.filter((c) => c.status === 'ready');
const queued = contents.filter((c) => c.status === 'queued');
const published = contents.filter((c) => c.status === 'published');
out.content_status = contents.reduce((m, c) => { const k = c.status || '(空)'; m[k] = (m[k] || 0) + 1; return m; }, {});
out.ready = ready.length;
out.queued = queued.length;
out.published_status = published.length;
out.ready_tumblr = ready.filter((c) => String(c.platform || '').toLowerCase() === 'tumblr').length;

// ── 10. 账号池 ──────────────────────────────────────────────
const tAcc = accounts.filter((a) => a.platform === 'tumblr');
const realT = tAcc.filter((a) => !isSimulated(a));
const tokenHolders = Object.keys(tokens).filter((k) => accMap.has(k));
const publishable = tokenHolders.filter((k) => { const t = tokens[k]; return t.oauthToken && t.oauthTokenSecret && t.blogName; });
out.accounts_total = accounts.length;
out.accounts_tumblr = tAcc.length;
out.accounts_tumblr_real = realT.length;
out.accounts_simulated = accounts.filter(isSimulated).length;
out.tokens_total = Object.keys(tokens).length;
out.tokens_with_blog = Object.values(tokens).filter((t) => t.blogName).length;
out.publishable_accounts = publishable.length;

out.verify = { own_blog: ownBlog, cross_blog: crossBlog, unknown_owner: unknownOwner, simulated_account: simAccount };
out.cross_detail = crossDetail;
out.by_platform = byPlatform;
out.by_day = byDay;
out.days = weekDays;
out.top_accounts = topAccounts;
out.top_blogs = topBlogs;
out.contested_blogs = contestedBlogs;

// ── 11. 无 token 账号的发布明细（历史兜底污染） ──────────────
const noTokPubs = withUrl.filter((p) => { const t = tokens[String(p.account_id || '')]; return !t || !t.blogName; });
const noTokByAcc = {};
for (const p of noTokPubs) { const k = String(p.account_id || ''); noTokByAcc[k] = (noTokByAcc[k] || 0) + 1; }
out.no_token_posts = noTokPubs.length;
out.no_token_accounts = Object.entries(noTokByAcc).sort((a, b) => b[1] - a[1]).map(([id, n]) => {
  const a = accMap.get(id);
  return { id, posts: n, simulated: isSimulated(a), status: a ? a.status : '(账号表无记录)', terminatedReason: a ? !!a.terminatedReason : false };
});
const noTokBlog = {};
for (const p of noTokPubs) { const b = blogOf(p.publish_url) || '(无)'; noTokBlog[b] = (noTokBlog[b] || 0) + 1; }
out.no_token_blogs = Object.entries(noTokBlog).sort((a, b) => b[1] - a[1]).slice(0, 8);

// ── 12. 净土：持 token 且发到自己 blog（可信外发口径） ───────
const trusted = withUrl.filter((p) => { const t = tokens[String(p.account_id || '')]; return t && t.blogName && t.blogName === blogOf(p.publish_url); });
out.trusted_posts = trusted.length;
const trustedByDay = {};
for (const p of trusted) { const d = dayOf(p.published_at); if (d) trustedByDay[d] = (trustedByDay[d] || 0) + 1; }
out.trusted_by_day = trustedByDay;

// ── 13. 每日明细（发布数 / 唯一账号 / 唯一 blog） ────────────
out.daily_detail = weekDays.map((d) => {
  const rows = withUrl.filter((p) => dayOf(p.published_at) === d);
  const tRows = trusted.filter((p) => dayOf(p.published_at) === d);
  return {
    day: d,
    posts: rows.length,
    trusted: tRows.length,
    accounts: new Set(rows.map((p) => String(p.account_id))).size,
    blogs: new Set(rows.map((p) => blogOf(p.publish_url))).size,
  };
});

// ── 14. 最近发布样本（供预览） ───────────────────────────────
out.recent = withUrl.slice().sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''))).slice(0, 40).map((p) => {
  const accId = String(p.account_id || '');
  const t = tokens[accId];
  const b = blogOf(p.publish_url);
  return {
    at: String(p.published_at || '').replace('T', ' ').slice(0, 19),
    account: accId,
    blog: b,
    expected: t ? t.blogName : '(无token)',
    own: !!(t && t.blogName === b),
    title: String(p.content_title || p.title || '(无标题)').slice(0, 70),
    url: String(p.publish_url || ''),
  };
});

// ── 15. 标题质量抽检 ────────────────────────────────────────
const badTitle = { '400 Bad Request': 0, '': 0 };
for (const p of withUrl) { const t = String(p.content_title || ''); if (t === '400 Bad Request') badTitle['400 Bad Request']++; else if (!t) badTitle['']++; }
out.bad_titles = badTitle;

fs.writeFileSync(path.join(__dirname, '..', '_audit_real_publish.json'), JSON.stringify(out, null, 2), 'utf8');

// 控制台摘要
console.log('=== 真实外发盘点 ===');
console.log('publish 记录总数:', out.total_publish_records, '| 带 URL:', out.with_url, '| 无 URL:', out.without_url);
console.log('唯一内容数:', out.uniq_content, '| 平均复用:', out.avg_reuse, '帖/内容');
console.log('发到自己 blog:', ownBlog, '| 跨账号错发:', crossBlog, '| 无法判定归属:', unknownOwner, '| 模拟账号直发:', simAccount);
console.log('今日发布:', out.today_posts);
console.log('日期范围:', weekDays[0], '→', weekDays[weekDays.length - 1], '共', weekDays.length, '天');
console.log('按平台:', JSON.stringify(byPlatform));
console.log('可发布账号(有token+blog):', out.publishable_accounts, '| 账号表:', out.accounts_total, '| tumblr:', out.accounts_tumblr, '(真实', out.accounts_tumblr_real, '/ 模拟', out.accounts_simulated, ')');
console.log('待发 ready:', out.ready, '(tumblr', out.ready_tumblr, ') | queued:', out.queued);
console.log('Top 投稿账号:', topAccounts.slice(0, 5).map((a) => `${a.id}(${a.posts})`).join(', '));
console.log('Top 收帖 blog:', topBlogs.slice(0, 5).map((b) => `${b[0]}(${b[1]})`).join(', '));
console.log('被多账号写入的 blog:', contestedBlogs.slice(0, 5).map((c) => `${c.blog}(${c.writers})`).join(', '));
console.log('');
console.log('--- 净化口径 ---');
console.log('可信外发(持token+发到自己blog):', out.trusted_posts);
console.log('无 token 账号发布(历史兜底):', out.no_token_posts, '涉及账号', out.no_token_accounts.length, '个');
console.log('  明细:', out.no_token_accounts.slice(0, 8).map((a) => `${a.id}(${a.posts}${a.simulated ? ',模拟' : ''})`).join(', '));
console.log('  落点 blog:', out.no_token_blogs.slice(0, 5).map((b) => `${b[0]}(${b[1]})`).join(', '));
console.log('标题异常:', JSON.stringify(out.bad_titles));
console.log('');
console.log('--- 逐日明细 ---');
out.daily_detail.forEach((d) => console.log(`  ${d.day} | 记录 ${d.posts} | 可信 ${d.trusted} | 账号 ${d.accounts} | blog ${d.blogs}`));
