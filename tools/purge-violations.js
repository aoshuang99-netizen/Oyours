#!/usr/bin/env node
/**
 * purge-violations.js — 违规内容清理 + 孤儿账号对账（一次性修复脚本）
 * ════════════════════════════════════════════════════════════════════════
 * 【前置条件】必须已停 3002 与 3013（DataStore 内存优先，flush 会覆盖磁盘改动）。
 *
 * 口径（全部基于 tools/content-gate.js 的三条红线，与发布时同一判据）：
 *   · ready / ready_stale 且 BLOCK  → status 改 'quarantine_violation' + 写 content_quarantine.json
 *     （不物理删除：保留可追溯性，且 publish.json 里可能有引用）
 *   · published 且 BLOCK            → 打 violation_flag 标记，不再进入复用池
 *   · 硬红线（裸 CDN 直链等）       → 无论何种状态都标记，最高优先级
 *   · 空正文 / 纯 CJK 正文（发英文平台）→ 一并隔离
 *
 * 孤儿账号对账：
 *   publish.json 里出现但 accounts.json 无记录的 account_id → 补建账号档案。
 *
 * 用法：
 *   node tools/purge-violations.js --dry     # 只报告不落盘（默认）
 *   node tools/purge-violations.js --apply    # 真落盘
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { gate } = require('./content-gate.js');

const DATA_DIR = process.env.DATA_DIR || 'D:/mscms-ws/data';
const P = f => path.join(DATA_DIR, f);
const rd = f => { try { return JSON.parse(fs.readFileSync(P(f), 'utf8')); } catch (e) { throw new Error('读 ' + f + ' 失败: ' + e.message); } };
const S = v => v == null ? '' : String(v);
const APPLY = process.argv.includes('--apply');

function log(...a) { console.log(...a); }

/** title 是否被硬截断（无收尾标点且接近长度上限） */
function isTruncatedTitle(c) {
  const t = S(c.title).trim();
  return t.length >= 55 && !/[.!?:;)"'\]\u3002\uff01\uff1f)\uff09]\s*$/.test(t);
}

// ════════════════════════════════════════════════════════════════════
function main() {
  log(APPLY ? '🔴 APPLY 模式 —— 会真实改盘' : '🟡 DRY 模式 —— 只报告（加 --apply 才落盘）');

  const contentRaw = rd('content.json');
  const content = Array.isArray(contentRaw) ? contentRaw : Object.values(contentRaw);
  const accountsRaw = rd('accounts.json');
  const accounts = Array.isArray(accountsRaw) ? accountsRaw : Object.values(accountsRaw);
  const publish = (() => { const v = rd('publish.json'); return Array.isArray(v) ? v : Object.values(v); })();
  const tokenRaw = rd('tumblr_token.json');
  const token = typeof tokenRaw === 'object' && !Array.isArray(tokenRaw) ? tokenRaw : {};

  log(`载入: content=${content.length} accounts=${accounts.length} publish=${publish.length} token=${Object.keys(token).length}`);

  // ── 构建全库指纹图（重复检测用）────────────────────────────────────
  const { fingerprint, buildDupMap } = require('./content-gate.js');
  const dupMap = buildDupMap(content);

  // ── 1. 内容清理 ────────────────────────────────────────────────────
  const stats = {
    quarantine_new: 0, quarantine_from_ready: 0, quarantine_from_stale: 0,
    flagged_published: 0, hard_risk: 0, empty_body: 0, cjk_only: 0,
    passed_through: 0, backfilled: 0,
  };
  const quarantine = Array.isArray(rd('content_quarantine.json')) ? rd('content_quarantine.json') : [];
  const qIds = new Set(quarantine.map(x => S(x.id)));

  const report = [];
  for (const c of content) {
    const st = c.status || '';
    if (!['ready', 'ready_stale', 'published'].includes(st)) { stats.passed_through++; continue; }

    const g = gate(c, dupMap);
    const body = S(c.body);
    const isEmpty = !body.trim();
    const cjkRatio = (() => {
      if (!body.trim()) return 0;
      const cjk = (body.match(/[\u4e00-\u9fa5]/g) || []).length;
      const lat = (body.match(/[a-zA-Z]/g) || []).length;
      return cjk / Math.max(1, cjk + lat);
    })();

    let action = null, reason = [];

    // ── 特殊处理：body 空但title 有实质内容 ──────────────────────────
    // 【实测 2026-10-09】3887 条 content_type=text 的条目 body 为空，但 title 里装着
    // 被硬性截断到 60 字符的正文片段（1367 条恰好卡 60）。全部备份（09-15/16/22）
    // 的这些条目 body 同样为空 ⇒ 不是被覆盖丢失，而是【生成器从来没写过 body】。
    //   · title 有收尾标点（未被截断）→ 正文虽短但完整，回填 title 后继续用
    //   · title 硬截断（无收尾标点）→ 正文已永久丢失，隔离
    let backfilled = false;
    if (!body.trim() && c.status !== 'published') {
      const t = S(c.title).trim();
      const endedClean = t.length > 0 && /[.!?:;)"'\]\u3002\uff01\uff1f)\uff09]\s*$/.test(t);
      const looksTruncated = t.length >= 55 && !endedClean;
      if (t.length >= 30 && endedClean && !looksTruncated) {
        c.body = t;
        c.body_backfilled_from = 'title';
        backfilled = true;
        stats.backfilled++;
      }
    }

    if (g.verdict === 'BLOCK') {
      if (g.hard_risk > 0) { stats.hard_risk++; reason.push('平台硬红线'); }
      if (g.reasons.some(r => r.code === 'AI_SCORE')) { reason.push(`AI味${g.ai_score}`); }
      if (g.reasons.some(r => r.code === 'DUPLICATE')) { reason.push(`重复${g.dup}`); }
      action = 'quarantine';
    } else if (!S(c.body).trim()) {
      // 回填后仍为空 ⇒ body 和 title 都没有可用文本，或 title 也被截断
      stats.empty_body++;
      action = 'quarantine';
      reason.push(isTruncatedTitle(c) ? '正文丢失且标题被截断' : '空正文');
    } else if (cjkRatio > 0.85 && st !== 'published') { stats.cjk_only++; action = 'quarantine'; reason.push('纯中文正文'); }

    if (!action) { stats.passed_through++; continue; }

    if (st === 'published') {
      // 已发布：不改status（会破坏 publish↔content 的对应关系），只打标记
      c.violation_flag = {
        at: new Date().toISOString(),
        ai_score: g.ai_score, hard_risk: g.hard_risk, dup: g.dup,
        why: reason.join(' + '),
      };
      stats.flagged_published++;
      report.push({ id: c.id, status: st, action: 'flag', why: reason.join('+') });
    } else {
      c.status = 'quarantine_violation';
      c.quarantined_at = new Date().toISOString();
      c.quarantine_reason = reason.join(' + ');
      if (st === 'ready') stats.quarantine_from_ready++; else stats.quarantine_from_stale++;
      if (!qIds.has(S(c.id))) {
        quarantine.push({
          id: c.id, at: c.quarantined_at, from_status: st, reason: c.quarantine_reason,
          ai_score: g.ai_score, hard_risk: g.hard_risk, dup: g.dup,
          title: S(c.title).slice(0, 120),
        });
        qIds.add(S(c.id));
      }
      stats.quarantine_new++;
      report.push({ id: c.id, status: st, action: 'quarantine', why: reason.join('+') });
    }
  }

  // ── 2. 孤儿账号对账 ────────────────────────────────────────────────
  const accIds = new Set();
  for (const a of accounts) { if (a.id) accIds.add(S(a.id)); if (a.tumblr_id) accIds.add(S(a.tumblr_id)); }

  const perAcct = {};
  for (const p of publish) { const a = S(p.account_id); if (a) perAcct[a] = (perAcct[a] || 0) + 1; }

  const orphans = Object.entries(perAcct).filter(([a]) => !accIds.has(a));
  const orphanList = [];
  for (const [aid, n] of orphans) {
    const tok = token[aid] || {};
    const ot = tok.oauthToken || tok.oauth_token;
    const os = tok.oauthTokenSecret || tok.oauth_token_secret;
    const bn = tok.blogName || tok.blog_name;
    orphanList.push({
      id: aid,
      status: (ot && os && bn) ? 'active' : 'unverified',
      platform: 'tumblr',
      blog_name: bn || null,
      managed: true,
      status_reason: 'publish_orphan_reconcile',
      reconciled_at: new Date().toISOString(),
      publish_count: n,
      first_publish: null,
      has_token: !!(ot && os),
      has_blog: !!bn,
    });
  }

  // ── 3. 闲置 token（可用但从未发过帖）───────────────────────────────
  const tokOkIds = Object.keys(token).filter(k => {
    const o = token[k] || {};
    return (o.oauthToken || o.oauth_token) && (o.oauthTokenSecret || o.oauth_token_secret) && (o.blogName || o.blog_name);
  });
  const idle = tokOkIds.filter(k => !perAcct[k]);
  const idleList = idle.map(k => ({
    id: k, status: 'active', platform: 'tumblr', managed: true,
    blog_name: token[k].blogName || token[k].blog_name || null,
    status_reason: 'idle_token_promoted',
    reconciled_at: new Date().toISOString(),
  }));

  // ── 报告 ──────────────────────────────────────────────────────────
  log('\n═══ 清理计划 ═══');
  log(`内容隔离:新隔离 ${stats.quarantine_new}（ready ${stats.quarantine_from_ready} + ready_stale ${stats.quarantine_from_stale}）`);
  log(`  其中硬红线 ${stats.hard_risk} · 空正文 ${stats.empty_body} · 纯中文 ${stats.cjk_only}`);
  log(`已发布标记: ${stats.flagged_published}（打violation_flag，不改 status）`);
  log(`放行: ${stats.passed_through}`);
  log(`孤儿账号: ${orphanList.length}（其中 active ${orphanList.filter(o => o.status === 'active').length}）`);
  log(`闲置 token 提升为可用账号: ${idleList.length}`);

  const byStatus = {};
  for (const c of content) { byStatus[c.status || '?'] = (byStatus[c.status || '?'] || 0) + 1; }
  log('\n═══ 处置后 content 状态分布 ═══');
  Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log(`  ${k.padEnd(22)} ${v}`));
  log(`  合计 ${content.length}`);

  const reasonCount = {};
  for (const r of report) { const k = r.why.split('+')[0]; reasonCount[k] = (reasonCount[k] || 0) + 1; }
  log('\n═══ 隔离原因分布 ═══');
  Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log(`  ${v}× ${k}`));

  if (!APPLY) {
    log('\n🟡 DRY 结束，未写任何文件。确认无误后加 --apply 重跑。');
    return;
  }

  // ════════════════════════════════════════════════════════════════
  log('\n🔴 开始落盘…');
  const w = (f, o) => { fs.writeFileSync(P(f), JSON.stringify(o, null, 1), 'utf8'); log(`  写 ${f} (${Array.isArray(o) ? o.length + ' 条' : Object.keys(o).length + ' keys'})`); };
  w('content.json', content);
  w('content_quarantine.json', quarantine);
  const newAccounts = accounts.concat(orphanList, idleList.filter(x => !accIds.has(x.id)));
  w('accounts.json', newAccounts);
  log(`  accounts.json 追加 ${newAccounts.length - accounts.length} 个账号`);

  // 审计留痕
  const auditFile = path.join(__dirname, '..', 'reports', `purge-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(auditFile, JSON.stringify({
    at: new Date().toISOString(), stats, orphans: orphanList, idle: idleList,
    report_sample: report.slice(0, 200), report_total: report.length,
  }, null, 1), 'utf8');
  log(`  审计留痕: ${auditFile}`);
  log('\n✅落盘完成。请重启 3002 并复核。');
}

main();