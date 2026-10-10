'use strict';

/**
 * migrate_accounts_phase0.js — MSCMS v14 账号管理模块 Phase 0 数据迁移
 *
 * 职责：
 *  1. 备份 data/accounts.json
 *  2. 为 61 个账号补齐闭环字段（device_fingerprint / bound_proxy / app_logged_in /
 *     app_session_state / inbox_unread / causal_phase / health_score / risk_level /
 *     content_quota / last_action_at / owner_device_capacity / login_link / reg_email / reg_time / active_status）
 *  3. 密码 AES-256-GCM 加密（加密后原地写回 password 字段，落盘无明文）
 *  4. 一机一号回填：61 账号 → 50 云手机（least-loaded 分配，保留既有绑定）
 *  5. 新建 DataStore 模块文件：cloud_phones（设备注册表）/ device_jobs / inbox
 *
 * 注意：迁移只改磁盘文件。运行中的服务应在迁移前停止、迁移后重启，
 *       避免内存态脏写把旧（明文/未绑定）记录刷回磁盘。
 */

const fs = require('fs');
const path = require('path');
const { encryptPassword } = require('./account-crypto');

const DATA = path.join(__dirname, 'data');
const ACC = path.join(DATA, 'accounts.json');
const TOK = path.join(DATA, 'tumblr_token.json');
const DEV_COUNT = 50;

// ── 0. 备份 ──
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = path.join(DATA, `accounts.json.bak_${stamp}`);
fs.copyFileSync(ACC, bak);
console.log(`[migrate] 已备份: ${bak}`);

// ── 1. 加载 ──
let accounts = JSON.parse(fs.readFileSync(ACC, 'utf8'));
if (!Array.isArray(accounts)) accounts = Object.values(accounts);

// Tumblr OAuth token 集合（判定账号是否已登录 App）
let tokenIds = new Set();
try {
  const t = JSON.parse(fs.readFileSync(TOK, 'utf8'));
  const arr = Array.isArray(t) ? t : Object.values(t);
  tokenIds = new Set(arr.filter(x => x && x.id).map(x => String(x.id)));
} catch (_) { /* 无 token 文件则全部视为未登录 */ }

// ── 2. 设备分配（least-loaded，保留既有绑定） ──
const devLoad = {};
for (let i = 1; i <= DEV_COUNT; i++) devLoad[i] = 0;
for (const a of accounts) {
  if (a.bound_device_id) devLoad[a.bound_device_id] = (devLoad[a.bound_device_id] || 0) + 1;
}
function assignDevice() {
  let best = 1, min = Infinity;
  for (let i = 1; i <= DEV_COUNT; i++) {
    if (devLoad[i] < min) { min = devLoad[i]; best = i; }
  }
  devLoad[best] = (devLoad[best] || 0) + 1;
  return best;
}

const STATUS_MAP = {
  active: 'active', warming: 'warmup', warmup: 'warmup',
  registered: 'registered', suspended: 'suspended',
  banned: 'banned', retired: 'retired',
};

// ── 3. 逐账号迁移 ──
let encrypted = 0, bound = 0;
for (const a of accounts) {
  const id = a.id || a.bot_id || a.account_id;
  if (!id) continue;

  // 邮箱 / 注册时间
  if (a.email && !a.reg_email) a.reg_email = a.email;
  if (!a.reg_time) a.reg_time = a.createdAt || a._ts || null;

  // 密码加密（原地）
  if (typeof a.password === 'string' && !a.password.startsWith('v1:')) {
    a.password = encryptPassword(a.password);
    encrypted++;
  }

  // 一机一号绑定
  if (!a.bound_device_id) { a.bound_device_id = assignDevice(); bound++; }

  // 闭环扩展字段
  if (a.device_fingerprint === undefined) a.device_fingerprint = null;
  if (a.bound_proxy === undefined) a.bound_proxy = a.proxy_used || null;
  const hasToken = tokenIds.has(String(id));
  a.app_logged_in = !!hasToken;
  if (a.app_session_state === undefined) a.app_session_state = null;
  if (a.inbox_unread === undefined) a.inbox_unread = 0;
  if (!a.causal_phase) a.causal_phase = hasToken ? 'S2' : 'S1';
  const er = typeof a.engagement_rate === 'number' ? a.engagement_rate : 0;
  a.health_score = er > 0 ? er : (typeof a.health_score === 'number' ? a.health_score : 50);
  if (!a.risk_level) a.risk_level = 'low';
  if (!a.content_quota) a.content_quota = 5;
  if (!a.last_action_at) a.last_action_at = a.last_active_at || null;
  if (a.owner_device_capacity === undefined) a.owner_device_capacity = null;
  if (!a.active_status) a.active_status = STATUS_MAP[a.status] || (a.status || 'active');
  if (a.login_link === undefined) a.login_link = null;
}

fs.writeFileSync(ACC, JSON.stringify(accounts, null, 2), 'utf8');
console.log(`[migrate] accounts.json 已迁移：${accounts.length} 账号，加密密码 ${encrypted}，新绑定设备 ${bound}`);

// ── 4. 新建 DataStore 模块文件 ──
const cloudPhones = [];
for (let i = 1; i <= DEV_COUNT; i++) {
  const owners = accounts.filter(a => a.bound_device_id === i).map(a => a.id);
  cloudPhones.push({
    id: i,
    model: null,
    hw_fingerprint: null,
    proxy: null,
    owner_account: owners,
    status: 'ready',
    capacity: 1,
    last_used_at: null,
    causal_phase_dist: {},
  });
}
fs.writeFileSync(path.join(DATA, 'cloud_phones.json'), JSON.stringify(cloudPhones, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA, 'device_jobs.json'), '[]', 'utf8');
fs.writeFileSync(path.join(DATA, 'inbox.json'), '[]', 'utf8');
console.log(`[migrate] 新建模块：cloud_phones(${DEV_COUNT}) / device_jobs / inbox`);

// ── 5. 摘要 ──
const devDist = {};
for (const a of accounts) {
  const d = a.bound_device_id || 0;
  devDist[d] = (devDist[d] || 0) + 1;
}
const multi = Object.entries(devDist).filter(([d, c]) => d && c > 1);
console.log(`[migrate] 设备分布：单账号设备 ${Object.keys(devDist).filter(d => d && devDist[d] === 1).length} 台，双账号设备 ${multi.length} 台`);
console.log('[migrate] Phase 0 迁移完成 ✓');
