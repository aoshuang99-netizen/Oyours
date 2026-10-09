#!/usr/bin/env node
/**
 * ready-purity-apply.js — ACCEL-2026-09-22 · P1-1 弹药提纯「执行器」
 * ---------------------------------------------------------------
 * 把 ready 池中的僵尸条目 status 改为 `ready_stale`（**改名不删除**，可整体回滚）。
 *
 * ⚠️ 前置铁律（否则改动会被静默回滚）：
 *   必须**先停 3002**（DataStore 内存优先 + 5s flush 覆盖磁盘），
 *   等端口释放 ≥8s 后执行，改完复核再启动。
 *
 * 用法：
 *   node tools/ready-purity-apply.js                 # dry-run，只打印将改动的条数
 *   node tools/ready-purity-apply.js --apply         # 真正写盘（自动备份）
 *   node tools/ready-purity-apply.js --apply --only nochannel
 *   node tools/ready-purity-apply.js --rollback      # 回滚 ready_stale → ready
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const CONTENT = path.join(DATA_DIR, 'content.json');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ROLLBACK = argv.includes('--rollback');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;

const rd = (n, f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, n), 'utf8')); } catch (e) { return f; } };
const arr = (v) => Array.isArray(v) ? v : ((v && Array.isArray(v.items)) ? v.items : []);

if (!fs.existsSync(CONTENT)) { console.error(`❌ 找不到 ${CONTENT}`); process.exit(1); }
const raw = fs.readFileSync(CONTENT, 'utf8');
const doc = JSON.parse(raw);
const isWrapped = doc && !Array.isArray(doc) && Array.isArray(doc.items);
const list = isWrapped ? doc.items : doc;

// ── 回滚模式 ────────────────────────────────────────────────
if (ROLLBACK) {
  let n = 0;
  for (const c of list) {
    if (String(c.status || '').toLowerCase() === 'ready_stale') { c.status = 'ready'; n++; }
  }
  console.log(`将回滚 ${n} 条 ready_stale → ready`);
  if (!APPLY) { console.log('（dry-run，未写盘；加 --apply 执行）'); process.exit(0); }
  const bk = `${CONTENT}.bak-rollback-${Date.now()}`;
  fs.copyFileSync(CONTENT, bk);
  fs.writeFileSync(CONTENT, JSON.stringify(isWrapped ? { ...doc, items: list } : list, null, 2), 'utf8');
  console.log(`✅ 已回滚 ${n} 条；备份 ${bk}`);
  process.exit(0);
}

// ── 复用审计脚本的分类逻辑（独立实现，避免依赖其输出文件）─────
const MIN_BODY = Math.max(1, Number(process.env.MSCMS_READY_MIN_BODY || 100));
const REAL_CHANNELS = new Set(String(process.env.MSCMS_REAL_CHANNELS || 'tumblr,nostr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const PROVIDER_CHANNELS = new Set(String(process.env.MSCMS_PROVIDER_CHANNELS || 'nostr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
let mediaRef = null;
try { mediaRef = require(path.join(__dirname, '..', 'content-media-ref.js')); } catch (_) { mediaRef = null; }
const hasRealMedia = (c) => mediaRef ? !!mediaRef.contentHasRealMedia(c) : !!(c && (c.media_path || c.mediaPath));
const normBody = (c) => String(c.body || c.text || c.caption || '')
  .replace(/https?:\/\/\S+/gi, ' ').replace(/[#@]\S+/g, ' ')
  .replace(/[\s\u3000]+/g, '').toLowerCase().trim();

const publish = arr(rd('publish.json', []));
const byId = new Map();
for (const c of list) if (c && c.id != null) byId.set(String(c.id), c);
const publishedNorm = new Set();
for (const p of publish) {
  if (!p.publish_url) continue;
  const src = byId.get(String(p.content_id || ''));
  if (src) { const n = normBody(src); if (n) publishedNorm.add(n); }
}

const targets = { nochannel: [], headerless: [], duplicate: [] };
for (const c of list) {
  if (String(c.status || '').toLowerCase() !== 'ready') continue;
  const plat = String(c. || 'unknown').toLowerCase();
  const body = String(c.body || c.text || c.caption || '').trim();
  const hasCh = REAL_CHANNELS.has(plat) || PROVIDER_CHANNELS.has(plat);
  const nb = normBody(c);
  let cls = null;
  // CJK 信息密度折算：中文单字信息量远高于拉丁字母，直接用「字符数」阈值会**误杀**
  //   完整的中文短帖（实测 68 字中文正文被误判 headerless，其实语义完整可发布）。
  //   折算后：68 字中文 ≈ 170，不再误判；纯英文 20 字符 ≈ 20，仍正确判空。
  const _cjk = (body.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff]/g) || [];
  const _effLen = body.length + _cjk * 1.5;
  if (!hasCh) cls = 'nochannel';
  else if (_effLen < MIN_BODY && !hasRealMedia(c)) cls = 'headerless';
  else if (nb && publishedNorm.has(nb)) cls = 'duplicate';
  if (cls && (!ONLY || ONLY.includes(cls))) targets[cls].push(c);
}

const total = Object.values(targets).reduce((s, a) => s + a.length, 0);
console.log('═'.repeat(64));
console.log(`P1-1 弹药提纯 ${APPLY ? '【APPLY】' : '【dry-run】'}  ${ONLY ? 'only=' + ONLY.join(',') : 'all'}`);
console.log('═'.repeat(64));
for (const [k, a] of Object.entries(targets)) console.log(`  ${k.padEnd(12)} ${a.length}`);
console.log(`  合计         ${total}`);

if (total === 0) { console.log('\n无需改动。'); process.exit(0); }
if (!APPLY) { console.log('\n（dry-run，未写盘；加 --apply 执行）'); process.exit(0); }

// ── 写盘（自动备份 + 零填充校验）──────────────────────────────
const bk = `${CONTENT}.bak-purity-${Date.now()}`;
fs.copyFileSync(CONTENT, bk);
const bkBuf = fs.readFileSync(bk);
const zeros = bkBuf.filter(b => b === 0;
if (zeros > 0) { console.error(`❌ 备份疑似损坏（含 ${zeros} 个 0x00），中止`); process.exit(1); }

const ts = new Date().toISOString();
let changed = 0;
for (const [cls, a] of Object.entries(targets)) {
  for (const c of a) {
    c.status = 'ready_stale';
    c._stale_reason = cls;          // 保留判定依据，便于审计与回滚
    c._stale_at = ts;
    changed++;
  }
}
fs.writeFileSync(CONTENT, JSON.stringify(isWrapped ? { ...doc, items: list } : list, null, 2), 'utf8');

// ── 落盘复核 ────────────────────────────────────────────────
const after = JSON.parse(fs.readFileSync(CONTENT, 'utf8'));
const aList = isWrapped ? after.items : after;
const cnt = {};
for (const c of aList) { const s = String(c.status || 'unknown'); cnt[s] = (cnt[s] || 0) + 1; }
console.log(`\n✅ 已改 ${changed} 条 ready → ready_stale`);
console.log(`备份: ${bk}`);
console.log(`复核 status 分布: ${JSON.stringify(cnt)}`);
