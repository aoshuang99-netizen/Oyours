#!/usr/bin/env node
'use strict';
/*
 * OYours / MSCMS v14 — P1.4 统一完整性审计（自包含实现）
 * ----------------------------------------------------------------------------
 * V15-plan P1.4 要求：统一替代 gen-audit-report.js 等 8 份报告脚本；比对「脚本自报成功」
 * vs「权威落库」，差异>0 告警；日报/看板**禁估算**。
 *
 * 本模块是单一事实审计器，覆盖下列原 8 脚本的维度（supersedes 字段明示）：
 *   daily-report.js, gen-audit-report.js, gen-publish-audit-report.js,
 *   gen-recovery-report.js, kk20-daily-report.js, kkmatch-dau-report.js,
 *   md2html-report.js, patch-report-2026-09-20.js
 *
 * 核心原则（铁律）：
 *   - 只读取权威落库文件（D:/mscms-ws/data/*.json），绝不估算任何指标。
 *   - 「脚本自报成功」在缺少 manifest 时不可得，故提供 --manifest=<file> 可选对账；
 *     无 manifest 时明言「未对账」，不编造差异数字。
 *   - 真实 DAU 只从 analytics 权威去重真实 IP 计算，剔除 self_direct / 回环。
 *
 * 用法：
 *   node tools/audit-integrity.js                 # 计算 + 打印 + 写 reports/
 *   node tools/audit-integrity.js --no-write       # 只打印
 *   node tools/audit-integrity.js --manifest=X.json# 额外做自报 vs 落库对账
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const REPORTS_DIR = path.join(path.resolve(__dirname, '..'), 'reports');
const SUPERSEDES = [
  'daily-report.js', 'gen-audit-report.js', 'gen-publish-audit-report.js',
  'gen-recovery-report.js', 'kk20-daily-report.js', 'kkmatch-dau-report.js',
  'md2html-report.js', 'patch-report-2026-09-20.js',
];
const STALE_READY_DAYS = 7;

function loadJson(name) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { __parseError: e.message }; }
}

// ---------------------------------------------------------------------------
// 1. 孤儿 token：可发布性体检（active 账号 ∩ 有效 token）
// ---------------------------------------------------------------------------
function auditOrphanTokens(accounts, tokens) {
  const accArr = Array.isArray(accounts) ? accounts : [];
  const tokMap = tokens && typeof tokens === 'object' && !Array.isArray(tokens) ? tokens : {};
  let active = 0, publishable = 0, orphanAccount = 0, orphanToken = 0;
  const orphanAccounts = [], orphanTokens = [];
  const tokenIds = new Set(Object.keys(tokMap));
  for (const a of accArr) {
    if (a.status !== 'active') continue;
    active++;
    const t = tokMap[a.id];
    const ok = t && t.oauthToken && t.oauthTokenSecret && t.blogName &&
               t.blogName !== 'BLOG_NAME_UNKNOWN' && t.oauthToken !== 'NO_OAUTH_TOKEN';
    if (ok) publishable++;
    else { orphanAccount++; orphanAccounts.push(a.id); }
  }
  for (const id of tokenIds) {
    const a = accArr.find((x) => x.id === id);
    if (!a || a.status !== 'active') { orphanToken++; orphanTokens.push(id); }
  }
  return { active, publishable, orphanAccount, orphanToken, orphanAccounts: orphanAccounts.slice(0, 50), orphanTokens: orphanTokens.slice(0, 50) };
}

// ---------------------------------------------------------------------------
// 2. 不可能 reach：reach/likes>0 但从未回收
// ---------------------------------------------------------------------------
function auditImpossibleReach(publish) {
  const arr = Array.isArray(publish) ? publish : [];
  let impossible = 0;
  const samples = [];
  for (const e of arr) {
    const reach = Number(e.reach) || 0;
    const likes = Number(e.likes) || 0;
    const recycled = e.metrics_recycled_at && e.metrics_recycled_at !== null;
    if ((reach > 0 || likes > 0) && !recycled) {
      impossible++;
      if (samples.length < 20) samples.push({ id: e.id, reach, likes, platform: e.platform });
    }
  }
  return { total: arr.length, impossible, samples };
}

// ---------------------------------------------------------------------------
// 3. 重复 publish_url
// ---------------------------------------------------------------------------
function auditDuplicateUrls(publish) {
  const arr = Array.isArray(publish) ? publish : [];
  const seen = new Map();
  let dup = 0;
  for (const e of arr) {
    const u = e.publish_url;
    if (!u) continue;
    seen.set(u, (seen.get(u) || 0) + 1);
  }
  const dups = [];
  for (const [u, c] of seen) if (c > 1) { dup++; if (dups.length < 20) dups.push({ url: u, count: c }); }
  return { distinct: seen.size, duplicateUrls: dup, dups };
}

// ---------------------------------------------------------------------------
// 4. 陈旧 ready：content 状态 ready 但创建超 N 天
// ---------------------------------------------------------------------------
function auditStaleReady(content) {
  const arr = Array.isArray(content) ? content : [];
  const now = Date.now();
  let stale = 0;
  const samples = [];
  for (const e of arr) {
    if (e.status !== 'ready') continue;
    const created = e.createdAt ? Date.parse(e.createdAt) : NaN;
    if (isNaN(created)) continue;
    const days = (now - created) / 86400000;
    if (days > STALE_READY_DAYS) {
      stale++;
      if (samples.length < 20) samples.push({ id: e.id, days: Math.round(days), platform: e.platform });
    }
  }
  return { stale, thresholdDays: STALE_READY_DAYS, samples };
}

// ---------------------------------------------------------------------------
// 5. 真实 DAU（权威去重真实 IP，剔除 self_direct / 回环）—— 禁估算
// ---------------------------------------------------------------------------
function auditRealDau(analytics) {
  if (!analytics) return { available: false, note: 'analytics.json 缺失' };
  let records = [];
  if (Array.isArray(analytics)) records = analytics;
  else if (Array.isArray(analytics.records)) records = analytics.records;
  else if (Array.isArray(analytics.visits)) records = analytics.visits;
  else records = Object.values(analytics).filter((v) => v && typeof v === 'object');
  const realIps = new Set();
  let selfDirect = 0, loopback = 0;
  for (const r of records) {
    const ip = r.ip;
    const prov = r.provenance || r.source || '';
    if (prov === 'self_direct' || ip === 'self_direct') { selfDirect++; continue; }
    if (!ip || ip === '::ffff:127.0.0.1' || ip === '127.0.0.1' || ip.startsWith('::ffff:')) { loopback++; continue; }
    realIps.add(ip);
  }
  return { available: true, realDauDistinctIp: realIps.size, selfDirectRecords: selfDirect, loopbackRecords: loopback, scanned: records.length };
}

// ---------------------------------------------------------------------------
// 6. 战役落地对账（kk20 / hlua40 按 content_id 前缀）
// ---------------------------------------------------------------------------
function auditCampaignLanding(publish) {
  const arr = Array.isArray(publish) ? publish : [];
  const byPrefix = { kk20: 0, hlua40: 0, other: 0 };
  for (const e of arr) {
    const cid = String(e.content_id || '');
    if (cid.startsWith('kk20-')) byPrefix.kk20++;
    else if (cid.startsWith('hlua40-')) byPrefix.hlua40++;
    else byPrefix.other++;
  }
  return byPrefix;
}

// ---------------------------------------------------------------------------
// 7. （可选）自报 vs 落库对账
// ---------------------------------------------------------------------------
function reconcileManifest(manifestPath, publish) {
  if (!manifestPath) return { performed: false, note: '未提供 --manifest，跳过自报 vs 落库对账（不编造差异）' };
  if (!fs.existsSync(manifestPath)) return { performed: false, note: `manifest 不存在: ${manifestPath}` };
  let m;
  try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { return { performed: false, note: `manifest 解析失败: ${e.message}` }; }
  const claimed = m.injected != null ? Number(m.injected) : (m.count != null ? Number(m.count) : null);
  const landed = Array.isArray(publish) ? publish.length : 0;
  const diff = claimed != null ? claimed - landed : null;
  return { performed: true, claimed, landed, diff: diff == null ? 'n/a' : diff, alert: diff != null && diff !== 0 };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function run({ noWrite, manifest }) {
  const accounts = loadJson('accounts.json');
  const tokens = loadJson('tumblr_token.json');
  const publish = loadJson('publish.json');
  const content = loadJson('content.json');
  const analytics = loadJson('analytics.json');

  const checks = {};
  checks.orphanTokens = (accounts && tokens) ? auditOrphanTokens(accounts, tokens) : { skipped: true, note: 'accounts/tokens 缺失或解析失败' };
  checks.impossibleReach = auditImpossibleReach(publish);
  checks.duplicateUrls = auditDuplicateUrls(publish);
  checks.staleReady = auditStaleReady(content);
  checks.realDau = auditRealDau(analytics);
  checks.campaignLanding = auditCampaignLanding(publish);
  checks.reconcile = reconcileManifest(manifest, publish);

  // 告警汇总（差异>0 即告警）
  const alerts = [];
  if (checks.orphanTokens.orphanAccount > 0) alerts.push(`孤儿账号(active无有效token): ${checks.orphanTokens.orphanAccount}`);
  if (checks.orphanTokens.orphanToken > 0) alerts.push(`孤儿token(无active账号): ${checks.orphanTokens.orphanToken}`);
  if (checks.impossibleReach.impossible > 0) alerts.push(`不可能reach(>0但未回收): ${checks.impossibleReach.impossible}`);
  if (checks.duplicateUrls.duplicateUrls > 0) alerts.push(`重复publish_url: ${checks.duplicateUrls.duplicateUrls}`);
  if (checks.staleReady.stale > 0) alerts.push(`陈旧ready(>${STALE_READY_DAYS}天): ${checks.staleReady.stale}`);
  if (checks.reconcile.alert) alerts.push(`自报vs落库差异: ${checks.reconcile.diff}`);

  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'audit-integrity',
    policy: 'FORBID_ESTIMATION — 本审计仅统计权威落库，绝不估算任何指标（含 DAU）。',
    supersedes: SUPERSEDES,
    dataDir: DATA_DIR,
    checks,
    alerts,
    alertCount: alerts.length,
  };

  console.log('=== OYours 统一完整性审计 ===');
  console.log(JSON.stringify({
    orphanTokens: checks.orphanTokens,
    impossibleReach: checks.impossibleReach,
    duplicateUrls: { duplicateUrls: checks.duplicateUrls.duplicateUrls, distinct: checks.duplicateUrls.distinct },
    staleReady: checks.staleReady,
    realDau: checks.realDau,
    campaignLanding: checks.campaignLanding,
    reconcile: checks.reconcile,
    alertCount: report.alertCount,
  }, null, 2));
  if (alerts.length) console.log('⚠️ 告警:\n - ' + alerts.join('\n - '));
  else console.log('✅ 无差异告警（禁估算口径）');

  if (!noWrite) {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const out = path.join(REPORTS_DIR, `audit-integrity-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`[audit-integrity] 报告已写: ${out}`);
  }
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const noWrite = args.includes('--no-write');
  const mArg = args.find((a) => a.startsWith('--manifest='));
  run({ noWrite, manifest: mArg ? mArg.split('=')[1] : null });
}

module.exports = { run, auditOrphanTokens, auditImpossibleReach, auditDuplicateUrls, auditStaleReady, auditRealDau, auditCampaignLanding };
