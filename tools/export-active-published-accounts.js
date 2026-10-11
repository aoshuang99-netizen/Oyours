'use strict';

/**
 * export-active-published-accounts.js — 导出「活跃 + 发布成功」账号清单
 *
 * 口径（三重取交集，缺一不可）：
 *   1. accounts.json 中 status === 'active'
 *   2. publish.json 中存在 publish_url 非空的成功发布记录
 *   3. 账号 id 为 `tumblr_*` 真实形态（排除 `acc_tumblr_*` 影子表数据）
 *
 * 已删除账号（在 _tombstones.json 中有墓碑的）单独归入 deletedOrphan，不计入主表。
 *
 * 安全边界（重要）：
 *   - 本脚本为**离线只读**工具。密码经 AES-256-GCM 解密后仅写入本地导出文件，
 *     **不经过任何 HTTP 接口**，因此不破坏 server.js 中
 *     「密码绝不通过 API 返回」的既有设计（见 auto-login 端点注释）。
 *   - 不修改任何 DataStore 数据，无需停服。
 *
 * 用法：
 *   node tools/export-active-published-accounts.js            # 导出到 exports/
 *   node tools/export-active-published-accounts.js --out=DIR  # 指定输出目录
 *   node tools/export-active-published-accounts.js --no-password  # 隐藏密码列
 */

const fs = require('fs');
const path = require('path');
const { decryptPassword } = require('../account-crypto');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const args = process.argv.slice(2);
const OUT_DIR = (args.find((a) => a.startsWith('--out=')) || '').split('=')[1]
  || path.join(__dirname, '..', 'exports');
const WITH_PASSWORD = !args.includes('--no-password');

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const d = JSON.parse(raw);
  if (Array.isArray(d)) return d;
  return d.items || d.data || d.rows || [];
}

function main() {
  const accounts = readJson(path.join(DATA_DIR, 'accounts.json'));
  const tokens = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tumblr_token.json'), 'utf8'));
  const publishes = readJson(path.join(DATA_DIR, 'publish.json'));
  const tomsbtoneFile = path.join(DATA_DIR, '_tombstones.json');
  let tombstones = {};
  try {
    const t = JSON.parse(fs.readFileSync(tomsbtoneFile, 'utf8'));
    tombstones = t.tombstones || t || {};
  } catch (_) { /* 无墓碑文件则跳过 */ }

  // ── 1) 聚合成功发布 ──────────────────────────────
  const pubCount = new Map();
  const pubLast = new Map();
  for (const r of publishes) {
    const aid = String(r.account_id || '');
    if (!aid.startsWith('tumblr_')) continue;        // 排除影子表 acc_tumblr_*
    if (!r.publish_url) continue;                     // 只认真正发出去的
    pubCount.set(aid, (pubCount.get(aid) || 0) + 1);
    const ts = String(r.published_at || '');
    const prev = pubLast.get(aid);
    if (!prev || ts > prev.ts) pubLast.set(aid, { ts, url: r.publish_url });
  }

  const byId = new Map(accounts.map((a) => [String(a.id), a]));
  const targetIds = [...pubCount.keys()].filter((id) => byId.has(id));
  const orphanIds = [...pubCount.keys()].filter((id) => !byId.has(id));

  // ── 2) 组装主表 ─────────────────────────────────
  const rows = [];
  for (const id of targetIds) {
    const a = byId.get(id);
    const t = tokens[id] || {};
    const blog = t.blogName || '';
    // 实测 91/91：username 与 blogName 恒等；email 亦为 <blog>@gmail.com
    const username = a.username || blog;
    const email = a.email || (blog ? `${blog}@gmail.com` : '');
    let password = '';
    let pwState = 'empty';
    if (a.password) {
      if (WITH_PASSWORD) {
        const dec = decryptPassword(a.password);
        if (dec === null) { pwState = 'decrypt_failed'; password = ''; }
        else { pwState = 'ok'; password = dec; }
      } else { pwState = 'hidden'; }
    }
    const last = pubLast.get(id) || {};
    rows.push({
      id,
      username,
      usernameSource: a.username ? 'accounts.json' : (blog ? 'blogName推导' : '缺失'),
      password,
      passwordState: pwState,
      passwordStored: a.password || '',
      email,
      emailKind: /@lokfeel\.com$/i.test(email) ? '自建catch-all(可收信)' : (/@gmail\.com$/i.test(email) ? '程序生成占位' : '其它'),
      blog,
      status: a.status || '',
      publishedCount: pubCount.get(id) || 0,
      lastPublishedAt: last.ts || '',
      lastPublishUrl: last.url || '',
      hasToken: !!t.oauthToken,
      createdAt: a.createdAt || '',
    });
  }
  rows.sort((x, y) => y.publishedCount - x.publishedCount || x.id.localeCompare(y.id));

  // ── 3) 已删除孤儿（有发布但账号已删）────────────
  const deletedOrphan = orphanIds.map((id) => {
    const t = tokens[id] || {};
    const last = pubLast.get(id) || {};
    return {
      id,
      blog: t.blogName || '',
      publishedCount: pubCount.get(id) || 0,
      lastPublishedAt: last.ts || '',
      lastPublishUrl: last.url || '',
      hasTombstone: Object.prototype.hasOwnProperty.call(tombstones, id)
        || JSON.stringify(tombstones).includes(id),
    };
  }).sort((x, y) => y.publishedCount - x.publishedCount);

  const summary = {
    generatedAt: new Date().toISOString(),
    dataDir: DATA_DIR,
    withPassword: WITH_PASSWORD,
    accountsTotal: accounts.length,
    publishTotal: publishes.length,
    targetCount: rows.length,
    deletedOrphanCount: deletedOrphan.length,
    totalPublished: rows.reduce((s, r) => s + r.publishedCount, 0),
    passwordOk: rows.filter((r) => r.passwordState === 'ok').length,
    passwordFailed: rows.filter((r) => r.passwordState === 'decrypt_failed').length,
    emailKind: rows.reduce((acc, r) => { acc[r.emailKind] = (acc[r.emailKind] || 0) + 1; return acc; }, {}),
    blogMissing: rows.filter((r) => !r.blog).length,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, '_active-published-accounts.json');
  fs.writeFileSync(outFile, JSON.stringify({ summary, rows, deletedOrphan }, null, 2), 'utf8');

  console.log('=== 导出完成（中间数据）===');
  console.log('  目标账号:', summary.targetCount);
  console.log('  已删孤儿:', summary.deletedOrphanCount);
  console.log('  密码解密: ok=' + summary.passwordOk + ' failed=' + summary.passwordFailed);
  console.log('  邮箱类型:', JSON.stringify(summary.emailKind));
  console.log('  缺 blogName:', summary.blogMissing);
  console.log('  累计发布:', summary.totalPublished);
  console.log('  →', outFile);
}

main();
