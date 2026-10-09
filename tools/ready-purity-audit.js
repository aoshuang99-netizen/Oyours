#!/usr/bin/env node
/**
 * ready-purity-audit.js — ACCEL-2026-09-22 · P1-1 弹药提纯「只读判定单」
 * ---------------------------------------------------------------
 * 铁律：本脚本**只读**，绝不写 data/*.json。只产出清单供人工/后续脚本执行。
 *   （3002 的 DataStore 内存优先 + 5s flush 会覆盖磁盘，运行时改盘必然丢失）
 *
 * 判定类别：
 *   headerless  — 正文 < MIN_BODY 字符且无真实媒体（发布出去也是空帖）
 *   duplicate   — 规范化正文与「已发布(published)」集合命中（重复刷屏）
 *   nochannel   — 平台无真实发布通道（产出 100% 变僵尸，白耗生成配额）
 *   healthy     — 真弹药（可立即发布）
 *
 * 用法：
 *   node tools/ready-purity-audit.js                # 出清单 + 统计
 *   node tools/ready-purity-audit.js --json out.json
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const MIN_BODY = Math.max(1, Number(process.env.MSCMS_READY_MIN_BODY || 100));
const argv = process.argv.slice(2);
const jsonOut = (() => { const i = argv.indexOf('--json'); return i >= 0 ? argv[i + 1] : null; })();

const rd = (n, f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, n), 'utf8')); } catch (e) { return f; } };
const arr = (v) => Array.isArray(v) ? v : ((v && Array.isArray(v.items)) ? v.items : []);

// 真实通道（与 server.js REAL_CHANNELS / cloud-publisher realChannels 同源）
const REAL_CHANNELS = new Set(
  String(process.env.MSCMS_REAL_CHANNELS || 'tumblr,nostr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
// 有发布能力但需 provider 凭据的通道也一并视为「有通道」（避免误伤将来接通的）
const PROVIDER_CHANNELS = new Set(
  String(process.env.MSCMS_PROVIDER_CHANNELS || 'nostr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

let mediaRef = null;
try { mediaRef = require(path.join(__dirname, '..', 'content-media-ref.js')); } catch (_) { mediaRef = null; }
const hasRealMedia = (c) => mediaRef ? !!mediaRef.contentHasRealMedia(c) : !!(c && (c.media_path || c.mediaPath));
const mediaRank = (c) => mediaRef ? mediaRef.mediaTypeRank(c) : (hasRealMedia(c) ? 1 : 2);

/** 正文规范化：去空白/去 URL/去话题标签/转小写，用于重复判定 */
 normBody(c) {
  return String(c.body || c.text || c.caption || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[#@]\S+/g, ' ')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
    .trim();
}

const content = arr(rd('content.json', []));
const publish = arr(rd('publish.json', []));

// ── 已发布正文指纹集合 ────────────────────────────────────────
// publish 记录只带 content_id，需回 content.json 取正文；content 可能已被清出库，
// 故同时用 content_id 集合与正文指纹集合两条判据。
const publishedContentIds = new Set(publish.map(p => String(p.content_id || '')).filter(Boolean));
const byId = new Map();
for (const c of content) if (c && c.id != null) byId.set(String(c.id), c);
const publishedNorm = new Set();
for (const p of publish) {
  if (!p.publish_url) continue;                       // 只认真实成功发布
  const cid = String(p.content_id || '');
  if (!cid) continue;
  const src = byId.get(cid);
  if (src) { const n = normBody(src); if (n) publishedNorm.add(n); }
}

const ready = content.filter(c => String(c.status || '').toLowerCase() === 'ready');

const buckets = { headerless: [], duplicate: [], nochannel: [], healthy: [] };
const byPlatform = {};

for (const c of ready) {
  const plat = String(c. || 'unknown').toLowerCase();
  byPlatform[plat] = byPlatform[plat] || { total: 0, headerless: 0, duplicate: 0, nochannel: 0, healthy: 0 };
  byPlatform[plat].total++;

  const body = String(c.body || c.text || c.caption || '').trim();
  const hasCh = REAL_CHANNELS.has(plat) || PROVIDER_CHANNELS.has(plat);
  const nb = normBody(c);

  let cls;
  // CJK 信息密度折算（与 ready-purity-apply.js 保持同源判定）：
  //   直接用「字符数」阈值会误杀完整的中文短帖（实测 68 字中文正文被判 headerless）。
  const _cjk = (body.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff]/g) || [];
  const _effLen = body.length + _cjk * 1.5;
  if (!hasCh) cls = 'nochannel';
  else if (_effLen < MIN_BODY && !hasRealMedia(c)) cls = 'headerless';
  else if (nb && publishedNorm.has(nb)) cls = 'duplicate';
  else cls = 'healthy';

  byPlatform[plat][cls]++;
  buckets[cls].push({ id: c.id, : plat, bodyLen: body.length, hasMedia: hasRealMedia(c), mediaRank: mediaRank(c), createdAt: c.createdAt || c. || null });
}

// ── 输出 ─────────────────────────────────────────────────────
const totalReady = ready.length;
const zombie = buckets.headerless.length + buckets.duplicate.length + buckets.nochannel.length;
console.log('═'.repeat(72));
console.log(`ready 池弹药纯度判定（只读）  MIN_BODY=${MIN_BODY}  真实通道=${[...REAL_CHANNELS].join(',')}`);
console.log('═'.repeat(72));
console.log(`ready 总数            : ${totalReady}`);
console.log(`  ├ healthy (真弹药)  : ${buckets.healthy.length}  (${(buckets.healthy.length / (totalReady || 1) * 100).toFixed(1)}%)`);
console.log(`  ├ headerless        : ${buckets.headerless.length}`);
console.log(`  ├ duplicate         : ${buckets.duplicate.length}`);
console.log(`  └ nochannel         : ${buckets.nochannel.length}`);
console.log(`僵尸合计              : ${zombie}  (${(zombie / (totalReady || 1) * 100).toFixed(1)}%)`);
console.log('');
console.log('按平台：');
const rows = Object.entries(byPlatform).sort((a, b) => b[1].total - a[1].total);
console.log('  平台'.padEnd(16) + 'total'.padStart(8) + 'healthy'.padStart(9) + 'headerless'.padStart(12) + 'dup'.padStart(7) + 'nochan'.padStart(8) + '  有通道');
for (const [p, s] of rows) {
  const ch = (REAL_CHANNELS.has(p) || PROVIDER_CHANNELS.has(p)) ? 'YES' : 'no';
  console.log('  ' + p.padEnd(14) + String(s.total).padStart(8) + String(s.healthy).padStart(9)
    + String(s.headerless).padStart(12) + String(s.duplicate).padStart(7) + String(s.nochannel).padStart(8) + '  ' + ch);
}
console.log('');
console.log('真弹药按通道（可发布）：');
const healthyByCh = {};
for (const h of buckets.healthy) healthyByCh[h.] = (healthyByCh[h.] || 0) + 1;
for (const [p, n] of Object.entries(healthyByCh).sort((a, b) => b[1] - a[1])) console.log(`  ${p.padEnd(14)} ${n}`);
console.log('');
const mediaOk = buckets.healthy.filter(h => h.mediaRank < 2;
console.log(`真弹药中含真实媒体: ${mediaOk} / ${buckets.healthy.length}`);

if (jsonOut) {
  const payload = {
    generatedAt: new Date().toISOString(),
    minBody: MIN_BODY,
    realChannels: [...REAL_CHANNELS],
    totalReady,
    counts: { healthy: buckets.healthy.length, headerless: buckets.headerless.length, duplicate: buckets.duplicate.length, nochannel: buckets.nochannel.length, zombie },
    byPlatform,
    healthyByChannel: healthyByCh,
    lists: {
      headerless: buckets.headerless.map(x => x.id),
      duplicate: buckets.duplicate.map(x => x.id),
      nochannel: buckets.nochannel.map(x => x.id),
    },
    healthyIds: buckets.healthy.map(x => x.id),
    healthyDetail: buckets.healthy,
  };
  fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n[清单] ${jsonOut}`);
}
console.log('\n⚠️ 本脚本只读，未修改任何数据。');
