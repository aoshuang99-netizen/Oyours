#!/usr/bin/env node
/**
 * MSCMS v14 全链路只读盘点 / 健康检查
 * 用法: node tools/mscms-audit.js [--json]
 *
 * 只读：不写任何数据文件、不写数据库。
 * 检查项：
 *   1) 服务探活   : 3002 主服务 / 3005 养号 / 3010 content-gen / 8080 MPT
 *   2) 主服务 API : 因果链状态、数据总览
 *   3) MySQL      : 各表行数、伪造 post_url、脏 preview_url、S3 backlog、媒体覆盖
 *   4) DataStore  : data/*.json 体积、记录数、测试残留 key、空字段率
 *   5) 磁盘       : 备份/残留文件占用
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || 'D:/mscms-ws/data';
const MYSQL = { host: '', port: 3307, user: 'root', : '', database: 'affiliate_system' };

// ---------- HTTP ----------
 httpGet(port, pathName, timeout = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host: '', port, path: pathName, timeout }, (res) => {
      let len = 0;
      res.on('data', (d) => { len += d.length; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, bytes: len, ms: Date.now() - started }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message, ms: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT', ms: timeout }); });
  });
}

async  httpGetJson(port, pathName, timeout = 15000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '', port, path: pathName, timeout }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks'utf8');
        try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(raw), raw }); }
        catch { resolve({ ok: true, status: res.statusCode, data: null, raw: raw.slice(0, 400) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

// ---------- MySQL ----------
async  withMysql(fn) {
  let mysql;
  try { mysql = require(path.join(process.cwd(), 'node_modules', 'mysql2', 'promise')); }
  catch (e) { return { error: 'mysql2 不可用: ' + e.message }; }
  let conn;
  try {
    conn = await mysql.createConnection(MYSQL);
    return await fn(conn);
  } catch (e) {
    return { error: e.code || e.message };
  } finally {
    if (conn) { try { await conn.end(); } catch {} }
  }
}

async  q(conn, sql, args) {
  try { const [rows] = await conn.query(sql, args || []); return { ok: true, rows }; }
  catch (e) { return { ok: false, error: e.code || e.message, rows: [] }; }
}

// ---------- DataStore ----------
 readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message.slice(0, 80) }; }
}

 countRecords(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    // DataStore 常见形态: { records: [] } / { items: [] } / 纯 map
    if (Array.isArray(data.records)) return data.records.length;
    if (Array.isArray(data.items)) return data.items.length;
    const keys = Object.keys(data);
    // 纯 id->obj 映射
    let mapLike = 0;
    for (const k of keys) if (data[k] && typeof data[k] === 'object') mapLike++;
    return mapLike === keys.length && keys.length > 0 ? keys.length : keys.length;
  }
  return 0;
}

 listKeys(data, limit = 12) {
  if (Array.isArray(data)) return [];
  if (data && typeof data === 'object') return Object.keys(data).slice(0, limit);
  return [];
}

// ---------- 主流程 ----------
(async () => {
  const out = {
    ts: new Date().toISOString(),
    services: {},
    api: {},
    mysql: {},
    datastore: { dir: DATA_DIR, files: [], testKeys: [], emptyFields: {} },
    disk: { backups: [], totalBackupBytes: 0 },
    issues: [],
  };

  // 1) 服务探活
  const probes = [
    ['main:3002', 3002, '/api/v14/causal-chain/status'],
    ['nurture:3005', 3005, '/api/status'],
    ['contentgen:3010', 3010, '/api/assets'],
    ['mpt:8080', 8080, '/docs'],
  ];
  for (const [name, port, p] of probes) {
    out.services[name] = await httpGet(port, p);
  }

  // 2) 主服务关键 API
  const chain = await httpGetJson(3002, '/api/v14/causal-chain/status');
  out.api.causalChain = chain.ok ? { status: chain.status, sample: chain.raw.slice(0, 300) } : chain;
  const ov = await httpGetJson(3002, '/api/v14/data/overview');
  out.api.overview = ov.ok ? { status: ov.status, sample: ov.raw.slice(0, 300) } : ov;

  // 3) MySQL
  out.mysql = await withMysql(async (conn) => {
    const r = {};
    const tables = await q(conn, 'SHOW TABLES');
    r.tableCount = tables.ok ? tables.rows.length : tables;
    const names = tables.ok ? tables.rows.map((x) => Object.values(x)[0]) : [];
    r.tables = names;

    r.rowCounts = {};
    for (const t of names) {
      const c = await q(conn, 'SELECT COUNT(*) AS n FROM `' + t + '`');
      if (c.ok) r.rowCounts[t] = c.rows[0].n;
    }

    // 伪造发布链接
    r.fakePostUrl = {};
    if (names.includes('matrix_posts_published')) {
      const a = await q(conn, "SELECT COUNT(*) AS n FROM matrix_posts_published WHERE post_url LIKE '%hlua.cc.cd/content%'");
      if (a.ok) r.fakePostUrl.hluaCC = a.rows[0].n;
      const b = await q(conn, "SELECT COUNT(*) AS n FROM matrix_posts_published WHERE post_url IS NULL OR post_url=''");
      if (b.ok) r.fakePostUrl.empty = b.rows[0].n;
      const c = await q(conn, "SELECT COUNT(*) AS n FROM matrix_posts_published WHERE post_url LIKE 'http%' AND post_url NOT LIKE '%tumblr%'");
      if (c.ok) r.fakePostUrl.nonTumblr = c.rows[0].n;
    }

    // 内容表脏数据
    r.content = {};
    if (names.includes('matrix_content_generated')) {
      const t = 'matrix_content_generated';
      const cols = await q(conn, 'SHOW COLUMNS FROM `' + t + '`');
      const colNames = cols.ok ? cols.rows.map((x) => x.Field) : [];
      r.content.columns = colNames;
      const total = await q(conn, 'SELECT COUNT(*) AS n FROM `' + t + '`');
      r.content.total = total.ok ? total.rows[0].n : null;
      if (colNames.includes('emitted_at')) {
        const b = await q(conn, 'SELECT COUNT(*) AS n FROM `' + t + '` WHERE emitted_at IS NULL');
        if (b.ok) r.content.backlogNotEmitted = b.rows[0].n;
      }
      if (colNames.includes('preview_url')) {
        const d = await q(conn, "SELECT COUNT(*) AS n FROM `" + t + "` WHERE preview_url IS NOT NULL AND preview_url LIKE '%.json'");
        if (d.ok) r.content.dirtyPreviewUrlJsonPath = d.rows[0].n;
        const e = await q(conn, "SELECT COUNT(*) AS n FROM `" + t + "` WHERE preview_url IS NOT NULL AND preview_url<>'' AND preview_url NOT LIKE '%.json'");
        if (e.ok) r.content.realPreviewUrl = e.rows[0].n;
      }
      if (colNames.includes('media_path')) {
        const f = await q(conn, "SELECT COUNT(*) AS n FROM `" + t + "` WHERE media_path IS NOT NULL AND media_path<>''");
        if (f.ok) r.content.withMediaPath = f.rows[0].n;
        const g = await q(conn, "SELECT COUNT(*) AS n FROM `" + t + "` WHERE media_status='pending'");
        if (g.ok) r.content.mediaPending = g.rows[0].n;
        const h = await q(conn, "SELECT COUNT(*) AS n FROM `" + t + "` WHERE media_status='failed'");
        if (h.ok) r.content.mediaFailed = h.rows[0].n;
      }
      const stale = await q(conn, 'SELECT COUNT(*) AS n FROM `' + t + '` WHERE status IS NULL OR status=\'\'');
      if (stale.ok) r.content.emptyStatus = stale.rows[0].n;
    }

    // 流量表伪造检测（2026-09-04 曾清理 53.5 万行伪造访问记录）
    // 伪造特征：landing_page 指向失效域名(hlua.cc.cd) 或 .com/post/<递增数字> 模板链接
    if (names.includes('matrix_visits_recorded')) {
      const vt = await q(conn, 'SELECT COUNT(*) AS n FROM matrix_visits_recorded');
      if (vt.ok) r.visitsTotal = vt.rows[0].n;
      const vf = await q(conn, "SELECT COUNT(*) AS n FROM matrix_visits_recorded WHERE landing_page LIKE '%hlua.cc.cd%' OR landing_page LIKE '%localhost%' OR landing_page LIKE '%%' OR landing_page REGEXP '^https?://[a-z]+\\.com/post/[0-9]+$'");
      if (vf.ok) r.visitsFake = vf.rows[0].n;
      const vr = await q(conn, 'SELECT MAX(recorded_at) AS last FROM matrix_visits_recorded');
      if (vr.ok) r.visitsLastAt = vr.rows[0].last;
    }

    // 近期产出（近 24h）
    if (names.includes('matrix_content_generated')) {
      const rec = await q(conn, 'SELECT COUNT(*) AS n FROM matrix_content_generated WHERE  >= NOW() - INTERVAL 24 HOUR');
      if (rec.ok) r.content.last24h = rec.rows[0].n;
    }
    if (names.includes('matrix_posts_published')) {
      // 注意：该表没有  列（只有 published_at）—— 用  查询会静默失败
      const rec = await q(conn, 'SELECT COUNT(*) AS n FROM matrix_posts_published WHERE published_at >= NOW() - INTERVAL 24 HOUR');
      if (rec.ok) r.published24h = rec.rows[0].n;
      const dup = await q(conn, `SELECT COUNT(*) AS n FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, content_id ORDER BY id) rn
        FROM matrix_posts_published WHERE published_at >= NOW() - INTERVAL 24 HOUR) x WHERE x.rn > 1`);
      if (dup.ok) r.dupPairs24h = dup.rows[0].n;
    }
    return r;
  });

  // 4) DataStore
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch (e) { out.datastore.error = e.message; }
  const testKeyPatterns = /^(_bg_|_perm_|test|tmp_|_tmp|__proto__|dummy|sample)/i;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(DATA_DIR, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const entry = { file: f, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString().slice(0, 19) };
    const parsed = readJsonSafe(full);
    if (parsed.ok) {
      entry.records = countRecords(parsed.data);
      const keys = listKeys(parsed.data, 200);
      entry.testKeys = keys.filter((k) => testKeyPatterns.test(k));
      if (entry.testKeys.length) out.datastore.testKeys.push({ file: f, keys: entry.testKeys });
      // 空字段率（对数组型抽样前 200 条）
      if (Array.isArray(parsed.data) && parsed.data.length) {
        const sample = parsed.data.slice(0, 200);
        const fieldEmpty = {};
        for (const rec of sample) {
          if (!rec || typeof rec !== 'object') continue;
          for (const [k, v] of Object.entries(rec)) {
            if (v === null || v === '' || (typeof v === 'number' && Number.isNaN(v))) {
              fieldEmpty[k] = (fieldEmpty[k] || 0) + 1;
            }
          }
        }
        entry.emptyFields = Object.entries(fieldEmpty)
          .filter(([, n]) => n >= sample.length * 0.5)
          .map(([k, n]) => k + ':' + Math.round((n / sample.length) * 100) + '%');
      }
    } else {
      entry.parseError = parsed.error;
    }
    out.datastore.files.push(entry);
  }
  out.datastore.files.sort((a, b) => b.bytes - a.bytes);
  out.datastore.totalBytes = out.datastore.files.reduce((s, f) => s + f.bytes, 0);

  // 5) 磁盘残留 / 备份
  for (const f of files) {
    if (/\.bak/i.test(f) || /_test|_tmp/i.test(f) || /^_vid_/.test(f) || f === '_junction_test.txt') {
      let st;
      try { st = fs.statSync(path.join(DATA_DIR, f)); } catch { continue; }
      out.disk.backups.push({ file: f, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString().slice(0, 10) });
      out.disk.totalBackupBytes += st.size;
    }
  }
  out.disk.backups.sort((a, b) => b.bytes - a.bytes);

  // 6) 问题汇总
  const push = (level, msg) => out.issues.push({ level, msg });
  for (const [name, s] of Object.entries(out.services)) {
    if (!s.ok) push(name.startsWith('nurture') ? 'WARN' : 'P0', '服务不可达 ' + name + ' (' + (s.error || s.status) + ')');
    else if (s.status >= 500) push('P1', name + ' 返回 ' + s.status);
  }
  if (out.mysql.error) push('P0', 'MySQL 连接失败: ' + out.mysql.error);
  else {
    const m = out.mysql;
    if (m.fakePostUrl && m.fakePostUrl.hluaCC > 0) push('P0', '伪造发布链接 ' + m.fakePostUrl.hluaCC + ' 条（matrix_posts_published.post_url LIKE %hlua.cc.cd/content%）');
    if (m.content && m.content.dirtyPreviewUrlJsonPath > 0) push('P1', 'preview_url 存档 JSON 路径脏数据 ' + m.content.dirtyPreviewUrlJsonPath + ' 条');
    if (m.content && m.content.backlogNotEmitted > 100000) push('P1', 'S3 事件 backlog ' + m.content.backlogNotEmitted + ' 条未 emit');
    if (m.dupPairs24h > 0) push('P0', '24h 内重复发布 ' + m.dupPairs24h + ' 条（同账号+同内容发了多次）');
    if (m.visitsFake > 0) push('P0', '伪造访问记录 ' + m.visitsFake + ' 条（landing_page 为失效域名或 .com/post/N 模板链接）');
    if (m.visitsLastAt) {
      const ageDays = (Date.now() - new Date(m.visitsLastAt).getTime()) / 86400000;
      if (ageDays > 2) push('P1', 'S5 流量记录已中断 ' + ageDays.toFixed(1) + ' 天（最后一条 ' + String(m.visitsLastAt).slice(0, 19) + '）');
    }
    if (m.content && m.content.emptyStatus > 0) push('P2', 'content 空 status ' + m.content.emptyStatus + ' 条');
  }
  for (const t of out.datastore.testKeys) push('P1', 'DataStore 测试残留: ' + t.file + ' → ' + t.keys.join(','));
  if (out.disk.totalBackupBytes > 5 * 1024 * 1024) push('P2', '备份/残留文件占用 ' + (out.disk.totalBackupBytes / 1048576).toFixed(1) + ' MB');
  for (const f of out.datastore.files) if (f.parseError) push('P0', 'JSON 解析失败: ' + f.file + ' → ' + f.parseError);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    // 人类可读
    const L = [];
    L.push('=== MSCMS v14 全链路盘点 ' + out.ts + ' ===');
    L.push('');
    L.push('--- 服务探活 ---');
    for (const [n, s] of Object.entries(out.services)) {
      L.push('  ' + n.padEnd(16) + (s.ok ? ('HTTP ' + s.status + '  ' + s.bytes + 'B  ' + s.ms + 'ms') : ('FAIL ' + s.error)));
    }
    L.push('');
    L.push('--- MySQL ---');
    if (out.mysql.error) L.push('  ERROR ' + out.mysql.error);
    else {
      L.push('  表数量: ' + out.mysql.tableCount);
      L.push('  内容表: 总 ' + (out.mysql.content.total ?? '?')
        + ' | 24h ' + (out.mysql.content.last24h ?? '?')
        + ' | backlog未emit ' + (out.mysql.content.backlogNotEmitted ?? '?')
        + ' | 空status ' + (out.mysql.content.emptyStatus ?? '?'));
      L.push('  媒体  : media_path ' + (out.mysql.content.withMediaPath ?? '-')
        + ' | pending ' + (out.mysql.content.mediaPending ?? '-')
        + ' | failed ' + (out.mysql.content.mediaFailed ?? '-'));
      L.push('  preview_url: 真实 ' + (out.mysql.content.realPreviewUrl ?? '-')
        + ' | 脏JSON路径 ' + (out.mysql.content.dirtyPreviewUrlJsonPath ?? '-'));
      L.push('  发布表: 24h ' + (out.mysql.published24h ?? '?')
        + ' | 重复(同账号同内容>1) ' + (out.mysql.dupPairs24h ?? '-')
        + ' | 伪造hlua.cc.cd ' + (out.mysql.fakePostUrl.hluaCC ?? '-')
        + ' | 空URL ' + (out.mysql.fakePostUrl.empty ?? '-')
        + ' | 非tumblr ' + (out.mysql.fakePostUrl.nonTumblr ?? '-'));
      L.push('  流量表: 总 ' + (out.mysql.visitsTotal ?? '?')
        + ' | 伪造landing_page ' + (out.mysql.visitsFake ?? '-')
        + ' | 最后记录 ' + String(out.mysql.visitsLastAt ?? '-').slice(0, 19));
      L.push('  Top 表行数: ' + Object.entries(out.mysql.rowCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => k + '=' + v).join(', '));
    }
    L.push('');
    L.push('--- DataStore (top 15 / ' + out.datastore.files.length + ' 文件, 共 ' + (out.datastore.totalBytes / 1048576).toFixed(1) + ' MB) ---');
    for (const f of out.datastore.files.slice(0, 15)) {
      L.push('  ' + f.file.padEnd(32) + String((f.bytes / 1024).toFixed(0) + 'KB').padStart(9)
        + '  records=' + String(f.records ?? '?').padStart(6)
        + (f.emptyFields && f.emptyFields.length ? '  空字段>50%: ' + f.emptyFields.slice(0, 4).join(',') : '')
        + (f.parseError ? '  PARSE_ERR: ' + f.parseError : ''));
    }
    L.push('');
    L.push('--- 测试残留 key ---');
    if (!out.datastore.testKeys.length) L.push('  (无)');
    for (const t of out.datastore.testKeys) L.push('  ' + t.file + ': ' + t.keys.join(', '));
    L.push('');
    L.push('--- 备份/残留文件 (共 ' + (out.disk.totalBackupBytes / 1048576).toFixed(1) + ' MB) ---');
    for (const b of out.disk.backups.slice(0, 12)) L.push('  ' + b.file.padEnd(45) + (b.bytes / 1048576).toFixed(2) + ' MB  ' + b.mtime);
    L.push('');
    L.push('--- 问题清单 ---');
    if (!out.issues.length) L.push('  (无)');
    for (const i of out.issues) L.push('  [' + i.level + '] ' + i.msg);
    console.log(L.join('\n'));
  }
})();
