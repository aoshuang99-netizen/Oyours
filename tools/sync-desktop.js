#!/usr/bin/env node
/**
 * MSCMS v14 — 工作区 → 桌面应用 自动同步器（常驻）
 * ============================================================================
 * 背景（2026-09-11 立）：桌面应用 MSCMS.exe 的 Electron 外壳 main.js 会以
 *   D:\MSCMS-Desktop\resources 为 cwd 拉起 `node server.js`，即：
 *   桌面应用跑的是 **D 盘那份代码**，而日常开发/修复都在工作区。
 *   只改工作区 → 桌面应用看不到 → 出现"我明明改了怎么没生效"。
 *   本前已有多起事故源自于此：
 *     · tumblr-publisher.js 的 OAuth 代理修复未同步 → 桌面应用仍 fetch failed
 *     ·  不同步 → 密钥不一致，账号解密率 109/109 变 17/109
 *     · tumblr_apps.json 缺失 → 多 App 列表为空，单 app-key 直接吃 429
 *
 * 职责：
 *   1. 全量对账（启动即跑一次）：把工作区的新增/修改文件同步到桌面资源目录
 *   2. 实时监听（fs.watch 浅层监听各发布目录）→ 防抖后即时同步
 *   3. 每 10 分钟兜底全量对账（防止 watcher 丢事件）
 *   4. 分类记录"需重启才生效"的后端代码变更，暴露在 /status
 *   5. 依赖体检：工作区 package.json 里声明但桌面 node_modules 缺失的包
 *
 * 同步面（白名单，宁少勿多——绝不把运行时状态推给桌面）：
 *   根目录：*.js *.html *.htm *.css *.sql *.bat *.ps1
 *           + 配置白名单 tumblr_apps.json / trusted-exits.json /
 *             tumblr_email.json / -creds.json / telegraph-creds.json /
 *             credentials-input.json / n8n-mscms-fanout.final.json /
 *             package.json /  / 
 *   子目录：providers/  tools/          （递归浅层，按扩展名过滤）
 *
 * 明确排除（这些是 **D 盘权威** 或运行时产物，反向覆盖会造成数据丢失）：
 *   proxy-pool.json（权威池在 D 盘）、_working_proxies.json、data/、
 *   所有 _ 开头文件、*.bak*、*.log、node_modules/、chrome_profiles/ 等
 *
 * 用法：
 *   node tools/sync-desktop.js                # 常驻（默认）
 *   node tools/sync-desktop.js --once         # 只做一次全量对账后退出
 *   node tools/sync-desktop.js --dry          # 只报告差异，不写盘
 *   node tools/sync-desktop.js --report       # 打印现状表（差异+依赖+待重启）
 * 端口：3013  /health /status /sync /deps /ack-restart
 * 日志：D:/mscms-ws/logs/desktop-sync.log
 * 状态：D:/mscms-ws/state/desktop-sync.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SRC = path.resolve(__dirname, '..');
const DST = process.env.MSCMS_DESKTOP_RESOURCES || 'D:\\MSCMS-Desktop\\resources';
const STATE_DIR = process.env.MSCMS_STATE_DIR || 'D:\\mscms-ws\\state';
const LOG_DIR = process.env.LOG_DIR || 'D:\\mscms-ws\\logs';
const STATE_FILE = path.join(STATE_DIR, 'desktop-sync.json');
const LOG_FILE = path.join(LOG_DIR, 'desktop-sync.log');
const PORT = Number(process.env.MSCMS_SYNC_PORT || 3013);
const DEBOUNCE_MS = Number(process.env.MSCMS_SYNC_DEBOUNCE_MS || 800);
const RECONCILE_MS = Number(process.env.MSCMS_SYNC_RECONCILE_MS || 10 * 60 * 1000);
const AUTORESTART = process.env.MSCMS_SYNC_AUTORESTART === '1';
const RESTART_QUIET_MS = Number(process.env.MSCMS_SYNC_RESTART_QUIET_MS || 90000);

// ── 同步面规则 ───────────────────────────────────────────────────────────────
const ROOT_EXT = new Set(['.js', '.html', '.htm', '.css', '.sql', '.bat', '.cmd', '.ps1', '.mjs', '.cjs']);
const ROOT_NAMES = new Set([
  'tumblr_apps.json', 'trusted-exits.json', 'tumblr_email.json',
  '-creds.json', 'telegraph-creds.json', 'credentials-input.json',
  'n8n-mscms-fanout.final.json', 'package.json',
  '', '',
]);
// 目录级镜像：目录名 → 允许扩展名
const DIR_RULES = [
  { dir: 'providers', exts: new Set(['.js']) },
  { dir: 'tools', exts: new Set(['.js', '.mjs', '.cjs']) },
];
// 永不外发（D 盘权威 / 运行时状态 / 备份）
const NEVER = [
  /^_/,                        // _*.js / _*.json / _*.log 运行时产物
  /^proxy-pool\.json$/i,       // ⚠️ 权威池在 D 盘，工作区只是镜像
  /^_working_proxies\.json$/i,
  /\.bak([.\-]|$)/i,
  /~$/,
  /^data\//,
  /^node_modules\//,
];

 rel(p) { return p.split(path.sep).join('/'); }

/** 判定一个相对路径是否属于同步面，以及类别（决定要不要重启） */
 classify(relPath) {
  for (const re of NEVER) if (re.test(relPath)) return null;
  const seg = relPath.split('/');
  const base = seg[seg.length - 1];
  if (seg.length === 1) {
    if (ROOT_NAMES.has(base)) {
      // 凭据/配置均在启动时读取（如 tumblr_apps.json 由构造函数 reloadApps() 加载）→ 需重启
      return { kind: 'config', restart: true };
    }
    const ext = path.extname(base).toLowerCase();
    if (!ROOT_EXT.has(ext)) return null;
    if (ext === '.html' || ext === '.htm' || ext === '.css') return { kind: 'static', restart: false };
    // .bat/.ps1/.sql = 运维脚本与建表语句，不被 node 进程 require → 不触发重启
    if (ext === '.bat' || ext === '.cmd' || ext === '.ps1' || ext === '.sql') return { kind: 'script', restart: false };
    return { kind: 'backend', restart: true };   // 根 *.js = 3002 主程序
  }
  if (seg.length === 2) {
    const rule = DIR_RULES.find((r) => r.dir === seg[0]);
    if (!rule) return null;
    if (!rule.exts.has(path.extname(base).toLowerCase())) return null;
    if (seg[0] === 'providers') return { kind: 'backend', restart: true };
    return { kind: 'tool', restart: false };     // tools/ 多为独立进程，各自重启
  }
  return null;
}

// ── 基础设施 ─────────────────────────────────────────────────────────────────
 log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  console.log(line);
}

const md5Cache = new Map();
 md5(file) {
  try {
    const st = fs.statSync(file);
    const key = file;
    const hit = md5Cache.get(key);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.hash;
    const h = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    md5Cache.set(key, { size: st.size, mtime: st.mtimeMs, hash: h });
    return h;
  } catch (_) { return null; }
}

 copyRetry(src, dst) {
  for (let i = 0; i < 4; i++) {
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      return true;
    } catch (e) {
      if (i === 3) { log(`   ✗ 复制失败 ${rel(path.relative(SRC, src))}: ${e.code || e.message}`); return false; }
      const t = Date.now() + 120; while (Date.now() < t); // 短自旋，避开 EBUSY/EPERM
    }
  }
  return false;
}

/** 枚举同步面内的全部源文件 */
 enumerateSources() {
  const out = [];
  const pushIf = (abs) => {
    const r = rel(path.relative(SRC, abs));
    const c = classify(r);
    if (c) out.push({ abs, rel: r, cls: c });
  };
  let ents = [];
  try { ents = fs.readdirSync(SRC, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (e.isFile()) pushIf(path.join(SRC, e.name));
    else if (e.isDirectory() && DIR_RULES.some((r) => r.dir === e.name)) {
      const dir = path.join(SRC, e.name);
      let subs = [];
      try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) {}
      for (const s of subs) if (s.isFile()) pushIf(path.join(dir, s.name));
    }
  }
  return out;
}

// ── 状态 ─────────────────────────────────────────────────────────────────────
let STATE = {
  startedAt: new Date().toISOString(),
  lastReconcileAt: null,
  lastChangeAt: null,
  lastChangeFile: null,
  syncedTotal: 0,
  pendingRestart: [],      // 自上次 ack 起，改了需要重启才生效的文件
  history: [],             // 最近 50 条变更
  depsMissing: [],
};
 saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2));
  } catch (_) {}
}
 loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    STATE = Object.assign(STATE, j, { startedAt: new Date().toISOString() });
  } catch (_) {}
  // 自清理：仅保留"确实需要重启才生效"的条目（避免 .bat/.sql 等误计）
  const before = (STATE.pendingRestart || [];
  STATE.pendingRestart = (STATE.pendingRestart || []).filter((f) => {
    const c = classify(f);
    return !!(c && c.restart);
  });
  if (STATE.pendingRestart.length !== before) saveState();
}

// ── 核心：单个文件同步 ───────────────────────────────────────────────────────
 syncOne(item, { dry = false } = {}) {
  const dst = path.join(DST, item.rel.split('/').join(path.sep));
  const a = md5(item.abs);
  if (a === null) return { action: 'skip', reason: 'unreadable' };
  const b = md5(dst);
  if (a === b) return { action: 'same' };
  if (dry) return { action: b === null ? 'create' : 'update' };
  if (!copyRetry(item.abs, dst)) return { action: 'error' };
  const c = md5(dst);
  if (c !== a) return { action: 'error', reason: 'md5 mismatch after copy' };
  return { action: b === null ? 'create' : 'update' };
}

/** 全量对账：返回本次处理过的变更明细 */
 reconcile({ dry = false, quiet = false } = {}) {
  const items = enumerateSources();
  const changed = [];
  for (const it of items) {
    const r = syncOne(it, { dry });
    if (r.action === 'create' || r.action === 'update') {
      changed.push({ file: it.rel, action: r.action, kind: it.cls.kind, restart: it.cls.restart });
      if (r.action === 'update' || r.action === 'create') {
        if (!dry) {
          STATE.syncedTotal++;
          if (it.cls.restart && !STATE.pendingRestart.includes(it.rel)) STATE.pendingRestart.push(it.rel);
        }
      }
    } else if (r.action === 'error') {
      changed.push({ file: it.rel, action: 'error', kind: it.cls.kind });
    }
  }
  if (!dry) {
    STATE.lastReconcileAt = new Date().toISOString();
    if (changed.length) {
      STATE.lastChangeAt = new Date().toISOString();
      STATE.lastChangeFile = changed[changed.length - 1].file;
      STATE.history = STATE.history.concat(changed).slice(-50);
      saveState();
    }
  }
  const created = changed.filter((c) => c.action === 'create');
  const updated = changed.filter((c) => c.action === 'update');
  const errs = changed.filter((c) => c.action === 'error');
  if (!quiet || changed.length) {
    log(`对账完成：扫描 ${items.length} 个源文件 → 新增 ${created.length} / 更新 ${updated.length} / 失败 ${errs.length}`);
    for (const c of created) log(`   ➕ ${c.file}  (${c.kind}${c.restart ? ', 需重启' : ''})`);
    for (const c of updated) log(`   ✎  ${c.file}  (${c.kind}${c.restart ? ', 需重启' : ''})`);
    for (const c of errs) log(`   ✗  ${c.file}  (失败)`);
    if (!dry && STATE.pendingRestart.length) {
      log(`   ⚠️ 待重启才生效（${STATE.pendingRestart.length}）：${STATE.pendingRestart.slice(0, 8).join(', ')}${STATE.pendingRestart.length > 8 ? ' …' : ''}`);
    }
  }
  return { scanned: items.length, created, updated, errors: errs };
}

// ── 依赖体检 ─────────────────────────────────────────────────────────────────
 checkDeps() {
  const missing = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
    const deps = Object.keys(Object.assign({}, pkg.dependencies, pkg.optionalDependencies));
    const nm = path.join(DST, 'node_modules');
    for (const d of deps) {
      if (!fs.existsSync(path.join(nm, d))) missing.push(d);
    }
  } catch (e) { return { error: e.message, missing: [] }; }
  STATE.depsMissing = missing;
  saveState();
  return { checked: true, missing };
}

// ── 监听 ─────────────────────────────────────────────────────────────────────
const timers = new Map();
 schedulePush(relCandidateFile, absHint) {
  const key = absHint || '__full__';
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    if (!absHint) { reconcile({ quiet: true }); return; }
    const r = rel(path.relative(SRC, absHint));
    const c = classify(r);
    if (!c) return;
    const res = syncOne({ abs: absHint, rel: r, cls: c });
    if (res.action === 'create' || res.action === 'update') {
      STATE.syncedTotal++;
      STATE.lastChangeAt = new Date().toISOString();
      STATE.lastChangeFile = r;
      STATE.history = STATE.history.concat([{ file: r, action: res.action, kind: c.kind, restart: c.restart }]).slice(-50);
      if (c.restart && !STATE.pendingRestart.includes(r)) STATE.pendingRestart.push(r);
      saveState();
      log(`⟳ 实时同步 ${res.action === 'create' ? '➕' : '✎'} ${r} (${c.kind}${c.restart ? ', 需重启' : ''})`);
    }
  }, DEBOUNCE_MS));
}

 startWatchers() {
  const dirs = [SRC].concat(DIR_RULES.map((r) => path.join(SRC, r.dir)));
  for (const d of dirs) {
    try {
      fs.watch(d, { persistent: true }, (evt, fname) => {
        if (!fname) { schedulePush(null, null); return; }
        const abs = path.join(d, fname);
        if (d === SRC) {
          if (DIR_RULES.some((r) => r.dir === fname)) return; // 目录级由各自 watcher 处理
          schedulePush(null, abs);
        } else {
          schedulePush(null, abs);
        }
      });
      log(`👁  监听 ${d}`);
    } catch (e) { log(`监听失败 ${d}: ${e.message}`); }
  }
}

// ── 待重启自动重启（默认关闭，需显式 MSCMS_SYNC_AUTORESTART=1） ──────────────
let lastPendingAt = 0;
 autoRestartTick() {
  if (!AUTORESTART) return;
  if (!STATE.pendingRestart.length) { lastPendingAt = 0; return; }
  if (!lastPendingAt) { lastPendingAt = Date.now(); return; }
  if (Date.now() - lastPendingAt < RESTART_QUIET_MS) return;
  log(`🔄 [auto-restart] 变更静默 ${RESTART_QUIET_MS / 1000}s，重启 3002 使后端代码生效`);
  try {
    const { execSync } = require('child_process');
    const out = execSync('netstat -ano -p TCP | findstr ":3002" | findstr LISTENING', { shell: 'cmd.exe' });
    const pid = (out.trim().split(/\s+/).pop() || '').trim();
    if (/^\d+$/.test(pid)) { execSync(`taskkill.exe /F /T /PID ${pid}`, { shell: 'cmd.exe', stdio: 'ignore' }); log(`   已终止 3002 (PID ${pid})，看门狗将于 60s 内拉起`); }
  } catch (e) { log(`   重启失败: ${e.message.split('\n')[0]}`); }
  STATE.pendingRestart = [];
  lastPendingAt = 0;
  saveState();
}

// ── HTTP 控制面 ──────────────────────────────────────────────────────────────
 json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { '': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
 startHttp() {
  const srv = http.createServer((req, res) => {
    const u = (req.url || '/').split('?')[0];
    if (u === '/health') return json(res, 200, { ok: true, lastReconcileAt: STATE.lastReconcileAt, syncedTotal: STATE.syncedTotal });
    if (u === '/status') return json(res, 200, {
      src: SRC, dst: DST,
      lastReconcileAt: STATE.lastReconcileAt,
      lastChangeAt: STATE.lastChangeAt,
      lastChangeFile: STATE.lastChangeFile,
      syncedTotal: STATE.syncedTotal,
      needsRestart: STATE.pendingRestart.length > 0,
      pendingRestart: STATE.pendingRestart,
      depsMissing: STATE.depsMissing,
      recent: STATE.history.slice(-15),
    });
    if (u === '/sync') {
      const r = reconcile({});
      return json(res, 200, { ok: true, scanned: r.scanned, created: r.created.length, updated: r.updated.length, errors: r.errors.length, detail: r.updated.concat(r.created).slice(0, 30) });
    }
    if (u === '/deps') return json(res, 200, checkDeps());
    if (u === '/ack-restart') { STATE.pendingRestart = []; saveState(); log('✅ 已确认重启完成，清空待重启清单'); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'not found' });
  });
  srv.on('error', (e) => { log(`HTTP 端口 ${PORT} 异常: ${e.message}`); process.exit(1); });
  srv.listen(PORT, '', () => log(`控制面监听 http://:${PORT}  (/status /sync /deps /ack-restart)`));
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv.includes('--once') ? 'once' : argv.includes('--dry') ? 'dry' : argv.includes('--report') ? 'report' : 'watch';

if (!fs.existsSync(DST)) {
  console.error(`✗ 桌面资源目录不存在: ${DST}`);
  process.exit(2);
}

loadState();

if (mode === 'report') {
  const items = enumerateSources();
  let drift = 0;
  const rows = [];
  for (const it of items) {
    const dst = path.join(DST, it.rel.split('/').join(path.sep));
    const a = md5(it.abs); const b = md5(dst);
    if (a !== b) { drift++; rows.push(`${b === null ? 'MISSING' : 'DIFF   '}  ${it.rel}`); }
  }
  console.log(`源文件 ${items.length} 个，与桌面不一致 ${drift} 个`);
  rows.slice(0, 40).forEach((r) => console.log('  ' + r));
  if (rows.length > 40) console.log(`  …其余 ${rows.length - 40} 条`);
  const d = checkDeps();
  console.log(`依赖缺失: ${d.missing.length ? d.missing.join(', ') : '无'}`);
  console.log(`待重启生效: ${STATE.pendingRestart.length ? STATE.pendingRestart.join(', ') : '无'}`);
  process.exit(0);
}

if (mode === 'dry' || mode === 'once') {
  const r = reconcile({ dry: mode === 'dry' });
  checkDeps();
  if (mode === 'once') {
    log(`一次性对账结束：新增 ${r.created.length} / 更新 ${r.updated.length} / 失败 ${r.errors.length}`);
    if (STATE.pendingRestart.length) log(`⚠️ 以下后端文件已更新，需重启 3002 才生效：${STATE.pendingRestart.join(', ')}`);
  }
  process.exit(0);
}

// watch 模式
log('=== 桌面同步器启动 ===');
log(`  源: ${SRC}`);
log(`  目标: ${DST}`);
reconcile({});
checkDeps();
startWatchers();
startHttp();
if (AUTORESTART) log('  ⚙️ auto-restart 已开启');
setInterval(() => { try { reconcile({ quiet: true }); } catch (e) { log('兜底对账异常: ' + e.message); } }, RECONCILE_MS);
setInterval(() => { try { autoRestartTick(); } catch (_) {} }, 15000);
setInterval(() => { try { if (STATE.depsMissing.length === 0) checkDeps(); } catch (_) {} }, 30 * 60 * 1000);

process.on('uncaughtException', (e) => log('uncaughtException: ' + e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.message)));
