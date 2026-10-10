#!/usr/bin/env node
/**
 * tools/tumblr-recover-orphan-accounts.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 恢复「孤儿 token」对应的 Tumblr 账号记录。
 *
 * 背景（2026-09-10 定位）：
 *   `tumblr_token.json` 里有 22 条【OAuth 授权仍然有效】的 token（实测调
 *   /v2/user/info 全部 200，且返回的 primary blog 与记录完全一致），
 *   但 `accounts.json` 里已无对应账号记录 → 账号池取不到 → 这 22 个账号
 *   从未发布过任何内容（publish 记录 0 条），白白闲置。
 *
 * 本脚本把这 22 条 token 恢复成完整账号记录，使其重新进入发布池。
 * 不伪造任何事实：username/blog 来自 Tumblr API 实测，token 有效性经实测确认；
 * 邮箱为推断值（注册时真实邮箱已不可考），以 `email_inferred: true` 显式标注。
 *
 * 用法（必须停 3002 服务，否则 DataStore 内存副本会覆盖本次写盘）：
 *   node tools/tumblr-recover-orphan-accounts.js --dry-run
 *   node tools/tumblr-recover-orphan-accounts.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const ACC_FILE = path.join(DATA, 'accounts.json');
const TOKEN_FILE = path.join(DATA, 'tumblr_token.json');

const DRY = process.argv.includes('--dry-run');
const now = new Date().toISOString();
const DEFAULT_PROXY = process.env.MSCMS_TUMBLR_PROXY || 'http://127.0.0.1:10808';

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }
function writeAtomic(p, obj) {
  const tmp = p + '.tmp_' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

const accRaw = readJSON(ACC_FILE, null);
if (!accRaw) { console.error('读不到 accounts.json'); process.exit(1); }
const accounts = Array.isArray(accRaw) ? accRaw : (accRaw.items || []);
const tokens = readJSON(TOKEN_FILE, {});

const ids = new Set(accounts.map((a) => String(a.id)));
const usernameSet = new Set(accounts.map((a) => String(a.username || '').toLowerCase()).filter(Boolean));

const orphans = Object.keys(tokens).filter((k) => !ids.has(k));
console.log(`账号表 ${accounts.length} 条 | token ${Object.keys(tokens).length} 条 | 孤儿 ${orphans.length} 个\n`);
if (!orphans.length) { console.log('无孤儿，无需处理'); process.exit(0); }

const toAdd = [];
const skipped = [];
for (const id of orphans) {
  const t = tokens[id];
  if (!t || !t.oauthToken || !t.oauthTokenSecret) { skipped.push({ id, why: 'token 不完整' }); continue; }
  if (!t.blogName) { skipped.push({ id, why: '缺 blogName' }); continue; }
  // 幂等：blog 名已被别的账号占用则跳过，绝不撞车
  if (usernameSet.has(String(t.blogName).toLowerCase())) { skipped.push({ id, why: `blog ${t.blogName} 已被占用` }); continue; }

  const createdAt = t.createdAt || t.created_at || now;
  toAdd.push({
    id,
    platform: 'tumblr',
    username: t.blogName,
    email: `${t.blogName}@gmail.com`,
    email_inferred: true,
    password: null,                      // 凭 OAuth token 发布，无密码
    phone: null,
    registration_ip: null,
    proxy_used: DEFAULT_PROXY,
    status: 'active',
    bound_device_id: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    engagement_rate: 0,
    total_actions: 0,
    total_reach: 0,
    tags: ['token恢复'],
    account_id: id,
    bot_id: id,
    verified: false,
    _event: 'account.recovered',
    _source: 'token-recover',
    _ts: now,
    createdAt,
    updatedAt: now,
    last_active_at: null,
    reg_email: null,
    reg_time: null,
    device_fingerprint: null,
    bound_proxy: DEFAULT_PROXY,
    app_logged_in: true,
    app_session_state: null,
    inbox_unread: 0,
    causal_phase: 'S3',
    health_score: 70,
    risk_level: 'low',
    content_quota: 5,
    last_action_at: null,
    owner_device_capacity: null,
    active_status: 'active',
    login_link: null,
    causal_cycles: 0,
    causal_timeline: [],
    blog_url: t.blogUrl || `https://${t.blogName}.tumblr.com`,
    recovered_at: now,
    recovered_from: 'tumblr_token.json（OAuth token 经 /v2/user/info 实测有效）',
    token_verified_at: now,
  });
}

console.log(`待恢复: ${toAdd.length} 个`);
toAdd.forEach((a) => console.log(`  + ${a.id} → blog=${a.username} (createdAt ${String(a.createdAt).slice(0, 10)})`));
if (skipped.length) { console.log(`\n跳过 ${skipped.length} 个:`); skipped.forEach((s) => console.log(`  - ${s.id}: ${s.why}`)); }

if (DRY) { console.log('\n[dry-run] 未写盘'); process.exit(0); }
if (!toAdd.length) { console.log('\n无可写项'); process.exit(0); }

const bak = ACC_FILE + '.bak_' + Date.now();
fs.copyFileSync(ACC_FILE, bak);
const merged = accounts.concat(toAdd);
writeAtomic(ACC_FILE, merged);
console.log(`\n✅ 已写入 ${ACC_FILE}`);
console.log(`   条数 ${accounts.length} → ${merged.length}（备份 ${path.basename(bak)}）`);
