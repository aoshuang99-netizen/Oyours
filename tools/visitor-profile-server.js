'use strict';
/**
 * 访客画像服务（Aliens_eye 集成）— :3012
 *
 * 职责：
 *  1. collect  —— 用我们自己的 Tumblr token 拉「真实身份源」：
 *                 ① 各 blog 的 followers（关注者=浏览并认可我们的用户）
 *                 ② 近期帖子的 notes（点赞/转发的互动用户，notes_info=true）
 *                 零伪造：拉不到就记错误，绝不编造。
 *  2. scan     —— 对新出现的用户名，调用 Aliens_eye（D:\Aliens_eye，840+ 平台
 *                 OSINT 扫描）产出跨平台画像（bio/头像/站点命中）。
 *  3. analyze  —— 聚合 画像图谱（mermaid）+ 数据分析 HTML 报告 → reports/。
 *  4. schedule —— 每日 04:30 自动 run-all；启动后 5 分钟先跑一轮。
 *
 * 端点：
 *  GET  /api/status
 *  GET  /api/profiles
 *  GET  /api/report          —— 最新 HTML 报告
 *  POST /api/collect
 *  POST /api/scan            —— body: {limit}
 *  POST /api/analyze
 *  POST /api/run-all
 *
 * 数据目录（D 盘）：
 *  D:/Aliens_eye-mscms/interactions.json   —— 身份源（username → 来源/时间）
 *  D:/Aliens_eye-mscms/profiles.json       —— 画像库（username → 画像+来源）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.VISITOR_PROFILE_PORT || 3012);
const WS = 'C:\\Users\\AS\\WorkBuddy\\2026-06-13-19-42-19';
// 【2026-09-14】原为硬编码 `…\node\versions\22.22.2-2\node.exe`（该目录已不存在）。
// 本文件的 NODE 目前是死代码（声明后未使用），但保留正确语义防止后续被误用：
// 需要 node 解释器时一律用 process.execPath（正在运行本进程的那个 node），不要硬编码版本号。
const NODE = process.execPath;
const DATA_DIR = process.env.VISITOR_PROFILE_DATA || 'D:\\Aliens_eye-mscms';
const REPORT_DIR = path.join(WS, 'reports');
const INTERACTIONS = path.join(DATA_DIR, 'interactions.json');
const PROFILES = path.join(DATA_DIR, 'profiles.json');
const LOG = (process.env.LOG_DIR || 'D:/mscms-ws/logs') + '/visitor-profile.log';

const ALIENS_EXE = 'C:\\Users\\AS\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\aliens_eye.exe';
const ALIENS_OUT = 'D:\\Aliens_eye\\results';
const ALIENS_PROXY = process.env.ALIENS_PROXY || 'http://127.0.0.1:20777';

// 采集/扫描配额（防限流，防扫描耗时失控）
const CFG = {
  maxAccountsPerCollect: Number(process.env.VP_MAX_ACCOUNTS || 30),   // 每轮最多采多少个账号
  notesPerBlog: Number(process.env.VP_NOTES_PER_BLOG || 5),           // 每 blog 查多少条近期帖的 notes
  followersLimit: 20,
  maxScanPerRun: Number(process.env.VP_SCAN_LIMIT || 6),              // 每轮扫描多少个新用户名（约 2.5 分钟/个）
  scanTtlDays: Number(process.env.VP_SCAN_TTL_DAYS || 7),             // 同名重扫间隔
  dailyHour: 4, dailyMinute: 30,
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
  console.log(line);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ---------- 身份源采集 ----------
async function collectSources() {
  // 惰性 require：避免启动期 DataStore 的重 IO 阻塞端口监听
  const { TumblrPublisher } = require(path.join(WS, 'tumblr-publisher.js'));
  const { DataStore } = require(path.join(WS, 'data-store.js'));
  const ds = new DataStore(path.join(WS, 'data'));
  const pub = new TumblrPublisher(ds);
  // 出口兜底：与 tumblr-publisher 同序（服务模式下由 server 注入；独立运行用 10808）
  pub._proxyResolver = pub._proxyResolver || (() => 'http://127.0.0.1:10808');

  const interactions = loadJson(INTERACTIONS, {});
  const now = new Date().toISOString();

  // 1) 找出所有「自己 token + 自己 blog」的账号
  const store = pub._store || ds;
  let accounts = [];
  try {
    accounts = store.list('account').items || store.list('account') || [];
  } catch (_) { accounts = []; }
  if (!Array.isArray(accounts) || !accounts.length) {
    // 兜底：直接读 token 分库
    const tokens = loadJson(path.join(WS, 'data', 'tumblr_token.json'), {});
    accounts = Object.keys(tokens).map((id) => ({ id }));
  }

  const usable = [];
  for (const a of accounts) {
    const id = a.id || a.accountId;
    if (!id) continue;
    const blog = pub.ownBlogNameOf ? pub.ownBlogNameOf(id) : null;
    if (blog && pub.hasOwnToken && pub.hasOwnToken(id)) usable.push({ id, blog });
  }
  // 轮转：记录上次采到的位置
  const cursor = loadJson(path.join(DATA_DIR, 'collect-cursor.json'), { idx: 0 });
  const rotated = usable.slice(cursor.idx % Math.max(usable.length, 1)).concat(usable.slice(0, cursor.idx % Math.max(usable.length, 1)));
  const batch = rotated.slice(0, CFG.maxAccountsPerCollect);
  cursor.idx = (cursor.idx + batch.length) % Math.max(usable.length, 1);
  saveJson(path.join(DATA_DIR, 'collect-cursor.json'), cursor);

  const stats = { accountsChecked: batch.length, withFollowers: 0, followersFound: 0, postsChecked: 0, notesFound: 0, newUsers: 0, errors: [] };

  for (const { id, blog } of batch) {
    // 1a. followers
    try {
      const res = await pub._oauthRequest({ accountId: id, method: 'GET', path: `/blog/${blog}/followers`, params: { limit: String(CFG.followersLimit) } });
      const users = (res?.json?.response?.users) || [];
      if (users.length) stats.withFollowers++;
      for (const u of users) {
        const name = u && u.name;
        if (!name) continue;
        stats.followersFound++;
        if (!interactions[name]) { interactions[name] = { username: name, sources: [], firstSeen: now }; stats.newUsers++; }
        interactions[name].lastSeen = now;
        interactions[name].sources.push({ kind: 'follower', blog, accountId: id, at: now });
      }
    } catch (e) {
      stats.errors.push(`followers ${blog}: ${String(e.message).slice(0, 80)}`);
    }
    // 1b. 近期帖子的互动 notes（notes_info=true）
    try {
      const res = await pub._oauthRequest({ accountId: id, method: 'GET', path: `/blog/${blog}/posts`, params: { limit: String(CFG.notesPerBlog) } });
      const posts = (res?.json?.response?.posts) || [];
      for (const p of posts) {
        if (!p || !p.id || !(p.note_count > 0)) continue;
        try {
          const r2 = await pub._oauthRequest({ accountId: id, method: 'GET', path: `/blog/${blog}/posts/${p.id}`, params: { notes_info: 'true', reblog_info: 'false' } });
          const post = r2?.json?.response?.object_type === 'post' ? r2.json.response : (r2?.json?.response?.post || null);
          const notes = (post && Array.isArray(post.notes)) ? post.notes : [];
          stats.postsChecked++;
          for (const n of notes) {
            const name = n && (n.blog_name || (n.blog && n.blog.name));
            if (!name || !n.type || n.type === 'reply_without_blog') continue;
            stats.notesFound++;
            if (!interactions[name]) { interactions[name] = { username: name, sources: [], firstSeen: now }; stats.newUsers++; }
            interactions[name].lastSeen = now;
            interactions[name].sources.push({ kind: n.type, blog, postId: String(p.id), at: now });
          }
        } catch (_) { /* 单帖失败不阻断 */ }
      }
    } catch (e) {
      stats.errors.push(`posts ${blog}: ${String(e.message).slice(0, 80)}`);
    }
  }

  saveJson(INTERACTIONS, interactions);
  stats.totalKnownUsers = Object.keys(interactions).length;
  log(`[collect] 账号=${stats.accountsChecked} 有关注者=${stats.withFollowers} 关注者=${stats.followersFound} 互动notes=${stats.notesFound} 新用户=${stats.newUsers} 总量=${stats.totalKnownUsers}`);
  if (stats.errors.length) log(`[collect] 错误样本: ${stats.errors.slice(0, 3).join(' | ')}`);
  return stats;
}

// ---------- Aliens_eye 扫描 ----------
function runAliensScan(username) {
  return new Promise((resolve) => {
    const args = [
      username, '--profile', 'quick', '--level', 'basic', '--plain', '--no-nsfw',
      '--proxy', ALIENS_PROXY, '--output', ALIENS_OUT, '--format', 'json',
    ];
    const t0 = Date.now();
    const c = spawn(ALIENS_EXE, args, { cwd: 'D:\\Aliens_eye', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { c.kill(); } catch (_) {} }, 8 * 60 * 1000);
    c.on('exit', (code) => {
      clearTimeout(timer);
      // 找到输出文件（文件名含用户名与时间戳）
      try {
        const files = fs.readdirSync(ALIENS_OUT).filter(f => f.startsWith(`${username}_basic_`) && f.endsWith('.json')).sort();
        const file = files[files.length - 1];
        if (file) {
          const j = JSON.parse(fs.readFileSync(path.join(ALIENS_OUT, file), 'utf8'));
          return resolve({ ok: true, ms: Date.now() - t0, file: path.join(ALIENS_OUT, file), data: j });
        }
      } catch (_) {}
      resolve({ ok: false, ms: Date.now() - t0, code, err: (err || out).slice(-300) });
    });
  });
}

function extractProfiles(scanData, baseUsername) {
  // 实测 JSON 结构（v2.3.0）：{ scan_summary, variations: { <username>: { scan_info, sites: { <site>: row } } } }
  // 行字段：status(Found/Maybe/Not Found/Error/Timeout) / url / confidence(0-100) / ai_analysis
  const found = [];
  try {
    const vars = scanData && scanData.variations;
    const key = (vars && (vars[baseUsername] ? baseUsername : Object.keys(vars)[0])) || null;
    const sites = key ? vars[key].sites : null;
    if (sites && typeof sites === 'object' && !Array.isArray(sites)) {
      for (const [siteName, r] of Object.entries(sites)) {
        const status = String((r && r.status) || '').toLowerCase();
        if (status !== 'found') continue;
        const conf = Number(r.confidence || 0);
        const ai = r.ai_analysis || {};
        const prof = r.profile || {};
        found.push({
          site: siteName,
          url: r.url || r.final_url || null,
          displayName: prof.display_name || prof.name || null,
          bio: prof.bio || prof.description || null,
          avatar: prof.avatar || null,
          confidence: conf,
          tier: conf >= 85 ? 'high' : (conf >= 70 ? 'medium' : 'low'),
          probability: ai.probability != null ? ai.probability : null,
        });
      }
    }
  } catch (_) { /* 结构变化时如实返回空，绝不编造 */ }
  return found;
}

let _scanBusy = false;
async function scanNewUsers(limit = CFG.maxScanPerRun) {
  if (_scanBusy) { log('[scan] 已有扫描在进行，跳过并发触发'); return { skipped: true, reason: 'ALREADY_RUNNING' }; }
  _scanBusy = true;
  try {
    return await _scanNewUsersInner(limit);
  } finally { _scanBusy = false; }
}

async function _scanNewUsersInner(limit) {
  const interactions = loadJson(INTERACTIONS, {});
  const profiles = loadJson(PROFILES, {});
  const ttlMs = CFG.scanTtlDays * 24 * 3600 * 1000;
  const now = Date.now();
  const pending = Object.keys(interactions)
    .filter(u => {
      const p = profiles[u];
      if (!p || !p.lastScanned) return true;
      return now - Date.parse(p.lastScanned) > ttlMs;
    })
    .sort((a, b) => String(interactions[b].firstSeen || '').localeCompare(String(interactions[a].firstSeen || '')))
    .slice(0, limit);

  const stats = { scanned: 0, ok: 0, profilesFound: 0, results: [] };
  for (const u of pending) {
    log(`[scan] 开始扫描 ${u} …`);
    const r = await runAliensScan(u);
    stats.scanned++;
    if (!r.ok) {
      log(`[scan] ${u} 失败: ${String(r.err || ('exit ' + r.code)).slice(0, 160)}`);
      stats.results.push({ username: u, ok: false, err: String(r.err || r.code).slice(0, 120) });
      continue;
    }
    const found = extractProfiles(r.data, u);
    profiles[u] = {
      username: u,
      lastScanned: new Date().toISOString(),
      scanMs: r.ms,
      resultFile: r.file,
      foundCount: found.length,
      highConfidence: found.filter(f => f.tier === 'high').length,
      profiles: found,
      sources: interactions[u].sources ? interactions[u].sources.slice(-20) : [],
    };
    stats.ok++;
    stats.profilesFound += found.length;
    stats.results.push({ username: u, ok: true, found: found.length });
    saveJson(PROFILES, profiles); // 逐个落盘，中断不丢
    log(`[scan] ${u} 完成: 命中 ${found.length} 个平台画像（${(r.ms / 1000).toFixed(0)}s）`);
  }
  return stats;
}

// ---------- 图谱与分析报告 ----------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function buildReport() {
  const profiles = loadJson(PROFILES, {});
  const interactions = loadJson(INTERACTIONS, {});
  const users = Object.values(profiles);
  const now = new Date();

  // 平台分布
  const siteDist = {};
  for (const u of users) for (const p of (u.profiles || [])) {
    const s = p.site || 'unknown';
    if (!siteDist[s]) siteDist[s] = { count: 0, users: [] };
    siteDist[s].count++; if (siteDist[s].users.length < 6) siteDist[s].users.push(u.username);
  }
  const siteRows = Object.entries(siteDist).sort((a, b) => b[1].count - a[1].count);

  // 活跃度来源分布（follower vs like vs reblog）
  const kindDist = {};
  for (const it of Object.values(interactions)) for (const s of (it.sources || [])) kindDist[s.kind] = (kindDist[s.kind] || 0) + 1;

  // mermaid 图谱：最多 12 个用户 × 其 top6 平台 + 我们的 blog
  const picked = users.filter(u => (u.profiles || []).length).sort((a, b) => (b.foundCount || 0) - (a.foundCount || 0)).slice(0, 12);
  const lines = ['graph LR'];
  const added = new Set();
  for (const u of picked) {
    const un = 'U_' + u.username.replace(/[^a-zA-Z0-9]/g, '_');
    if (!added.has(un)) { lines.push(`  ${un}["👤 ${esc(u.username)}"]`); added.add(un); }
    const blogs = new Set((u.sources || []).map(s => s.blog).filter(Boolean));
    for (const b of [...blogs].slice(0, 2)) {
      const bn = 'B_' + String(b).replace(/[^a-zA-Z0-9]/g, '_');
      if (!added.has(bn)) { lines.push(`  ${bn}["📱 ${esc(b)}"]`); added.add(bn); }
      lines.push(`  ${un} -->|互动| ${bn}`);
    }
    for (const p of (u.profiles || []).slice(0, 6)) {
      const pn = 'P_' + un + '_' + String(p.site || 'x').replace(/[^a-zA-Z0-9]/g, '_');
      if (!added.has(pn)) { lines.push(`  ${pn}["🌐 ${esc(p.site || '?')}"]`); added.add(pn); }
      lines.push(`  ${un} --- ${pn}`);
    }
  }
  const mermaid = lines.join('\n');

  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>访客画像图谱报告 ${now.toISOString().slice(0, 10)}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#f6f7fb;color:#1a1a2e}
header{background:#101828;color:#fff;padding:28px 36px}h1{margin:0;font-size:22px}
.sub{color:#94a3b8;font-size:13px;margin-top:6px}
main{padding:24px 36px;max-width:1200px;margin:0 auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:24px}
.kpi{background:#fff;border-radius:12px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.kpi .v{font-size:26px;font-weight:700;color:#4f46e5}.kpi .t{font-size:12px;color:#64748b;margin-top:4px}
section{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h2{font-size:16px;margin:0 0 12px;border-left:4px solid #4f46e5;padding-left:10px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#64748b;border-bottom:1px solid #e2e8f0;padding:8px}td{padding:8px;border-bottom:1px solid #f1f5f9}
.tag{display:inline-block;background:#eef2ff;color:#4f46e5;border-radius:6px;padding:2px 8px;font-size:12px;margin:2px}
.muted{color:#94a3b8;font-size:12px}.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h3{margin:0 0 8px;font-size:14px}.bio{color:#475569;font-size:12px;margin:4px 0}
a{color:#4f46e5;text-decoration:none}</style></head><body>
<header><h1>👁 访客画像图谱 · Aliens_eye 自动化分析</h1>
<div class="sub">生成时间 ${esc(now.toISOString())} ｜ 身份源：我们自己的 Tumblr blog 的关注者与互动用户 ｜ 扫描引擎：Aliens_eye v2（840+ 平台）</div></header>
<main>
<div class="kpis">
<div class="kpi"><div class="v">${Object.keys(interactions).length}</div><div class="t">已知真实访客身份</div></div>
<div class="kpi"><div class="v">${users.length}</div><div class="t">已完成画像扫描</div></div>
<div class="kpi"><div class="v">${siteRows.length}</div><div class="t">覆盖外部平台数</div></div>
<div class="kpi"><div class="v">${users.reduce((s, u) => s + (u.highConfidence || 0), 0)}</div><div class="t">高置信跨平台画像（≥85）</div></div>
</div>
<section><h2>互动来源分布</h2><div>${Object.entries(kindDist).map(([k, v]) => `<span class="tag">${esc(k)}: ${v}</span>`).join('') || '<span class="muted">暂无互动记录</span>'}</div></section>
<section><h2>用户画像图谱（关注者/互动者 ↔ 我们 ↔ 其外部身份）</h2>
${picked.length ? '<div class="mermaid">' + esc(mermaid) + '</div>' : '<p class="muted">暂无已扫描画像 —— 等待互动数据累积后自动扫描。</p>'}</section>
<section><h2>平台分布 Top 20</h2>
${siteRows.length ? '<table><tr><th>平台</th><th>命中用户数</th><th>用户样本</th></tr>' + siteRows.slice(0, 20).map(([s, d]) => `<tr><td><b>${esc(s)}</b></td><td>${d.count}</td><td>${d.users.map(esc).join(', ')}</td></tr>`).join('') + '</table>' : '<p class="muted">暂无数据</p>'}</section>
<section><h2>画像明细（每人外部身份）</h2>
${users.length ? users.map(u => `<div class="card"><h3>👤 ${esc(u.username)} <span class="muted">· 扫描于 ${esc(String(u.lastScanned).slice(0, 16))} · 命中 ${u.foundCount}</span></h3>
<div class="muted">来源: ${(u.sources || []).map(s => esc(s.kind) + '@' + esc(s.blog)).join(', ') || '—'}</div>
${(u.profiles || []).map(p => `<div class="bio">🌐 <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.site)}</a> ${esc(p.displayName || '')} <span class="tag">${p.tier === 'high' ? '高置信' : (p.tier === 'medium' ? '中置信' : '低置信')} ${p.confidence != null ? p.confidence : ''}</span> ${p.bio ? '— ' + esc(String(p.bio).slice(0, 120)) : ''}</div>`).join('') || '<div class="muted">该用户名下未发现外部平台画像</div>'}</div>`).join('') : '<p class="muted">暂无画像数据</p>'}</section>
</main>
<script>mermaid.initialize({startOnLoad:true,theme:'neutral'});</script></body></html>`;

  const file = path.join(REPORT_DIR, `visitor-profiles-${now.toISOString().slice(0, 10)}.html`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  log(`[analyze] 报告已生成 ${file}`);
  return { ok: true, file, users: users.length, sites: siteRows.length };
}

// ---------- HTTP 服务 ----------
let running = { collect: false, scan: false, analyze: false };

async function runAll() {
  const c = await collectSources();
  const s = await scanNewUsers();
  const a = buildReport();
  return { collect: c, scan: s, analyze: a };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(b); };

  if (p === '/api/status' && req.method === 'GET') {
    const interactions = loadJson(INTERACTIONS, {});
    const profiles = loadJson(PROFILES, {});
    return send(200, {
      ok: true, port: PORT,
      knownUsers: Object.keys(interactions).length,
      scannedUsers: Object.keys(profiles).length,
      config: CFG,
      running: { ...running },
      aliensExe: fs.existsSync(ALIENS_EXE),
    });
  }
  if (p === '/api/profiles' && req.method === 'GET') {
    return send(200, loadJson(PROFILES, {}));
  }
  if (p === '/api/report' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(REPORT_DIR).filter(f => f.startsWith('visitor-profiles-')).sort();
      const file = files[files.length - 1];
      if (!file) return send(404, { ok: false, error: 'NO_REPORT' });
      const html = fs.readFileSync(path.join(REPORT_DIR, file), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) { return send(500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && (p === '/api/collect' || p === '/api/scan' || p === '/api/analyze' || p === '/api/run-all')) {
    const key = p.replace('/api/', '');
    if (p !== '/api/analyze' && running[key]) return send(409, { ok: false, error: 'ALREADY_RUNNING' });
    if (p === '/api/collect') {
      running.collect = true;
      try { return send(200, { ok: true, stats: await collectSources() }); }
      catch (e) { return send(500, { ok: false, error: e.message }); }
      finally { running.collect = false; }
    }
    if (p === '/api/scan') {
      let body = {};
      try { body = JSON.parse(await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d || '{}')); })); } catch (_) {}
      running.scan = true;
      try { return send(200, { ok: true, stats: await scanNewUsers(Number(body.limit) || CFG.maxScanPerRun) }); }
      catch (e) { return send(500, { ok: false, error: e.message }); }
      finally { running.scan = false; }
    }
    if (p === '/api/analyze') { try { return send(200, buildReport()); } catch (e) { return send(500, { ok: false, error: e.message }); } }
    // run-all
    running.collect = running.scan = true;
    try { return send(200, { ok: true, result: await runAll() }); }
    catch (e) { return send(500, { ok: false, error: e.message }); }
    finally { running.collect = running.scan = false; }
  }
  send(404, { ok: false, error: 'NOT_FOUND' });
});

// ---------- 每日定时 ----------
function scheduleDaily() {
  const check = () => {
    const d = new Date();
    if (d.getHours() === CFG.dailyHour && d.getMinutes() === CFG.dailyMinute) {
      const dayKey = d.toISOString().slice(0, 10);
      const flag = path.join(DATA_DIR, `lastrun-${dayKey}`);
      if (!fs.existsSync(flag)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(flag, new Date().toISOString());
        log('[schedule] 触发每日 run-all');
        runAll().catch(e => log('[schedule] ERR ' + e.message));
      }
    }
  };
  setInterval(check, 60 * 1000);
}

server.listen(PORT, () => {
  log(`[visitor-profile] listening on http://127.0.0.1:${PORT} (aliens=${fs.existsSync(ALIENS_EXE) ? 'OK' : 'MISSING'})`);
  scheduleDaily();
  // 启动 5 分钟后先跑一轮（错开主服务启动高峰）
  setTimeout(() => { log('[boot] 启动预热 run-all'); runAll().catch(e => log('[boot] ERR ' + e.message)); }, 5 * 60 * 1000);
});
