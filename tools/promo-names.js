#!/usr/bin/env node
/**
 * promo-names.js — 推广站点归属 + 账号展示名生成引擎
 * ---------------------------------------------------------------
 * 需求：账号名称 = 推广网站前缀 + 自定义名字（自动生成）
 *
 * 设计铁律（来自用户选择 + 数据实况）：
 *   1. 只新增字段，绝不修改 /email/
 *      —— publish_url 内嵌 （749 条已发布链接），改登录名 = 全量失效
 *   2. 幂等：已分配 display_name 的账号保持不变，只为缺失账号续号
 *   3. 零伪造：账号无真实站点归属数据时按策略分配，并在 promo_source 标注 "auto"
 *
 * 新增字段：
 *   display_name        string  hlua-001
 *   promo_site          string  hlua | molie
 *   promo_prefix        string  hlua
 *   promo_seq           number  1
 *   promo_url           string  https://hlua.cc.cd
 *   promo_source        string  auto | manual
 *   display_name_set_at string  ISO
 *
 * 用法：
 *   node tools/promo-names.js --dry-run          # 只预览，不写盘
 *   node tools/promo-names.js --apply            # 写盘（必须先停 3002 服务）
 *   node tools/promo-names.js --verify           # 校验现有数据完整性
 *   node tools/promo-names.js --apply --reassign # 强制重排全部（危险：会改变已有展示名）
 *
 * 手动指定（--apply 时同时生效）：
 *   --set tumblr_xxx=hlua-999
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const SITES_FILE = path.join(DATA_DIR, 'promo_sites.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, '.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const argv = process.argv.slice(2);
const MODE = argv.includes('--apply') ? 'apply' : argv.includes('--verify') ? 'verify' : 'dry-run';
const REASSIGN = argv.includes('--reassign');

const manualSet = new Map();
argv.forEach((a) => {
  if (a.startsWith('--set=')) {
    const [k, v] = a.slice(6).split('=');
    if (k && v) manualSet.set(k.trim(), v.trim());
  }
});

 fail(msg) { console.error('[FATAL] ' + msg); process.exit(1); }
 readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { fail(`读取失败 ${p}: ${e.message}`); }
}

// ---------- 载入配置 ----------
if (!fs.existsSync(SITES_FILE)) fail(`缺少推广站点配置 ${SITES_FILE}`);
const cfg = readJson(SITES_FILE);
const sites = (cfg.sites || []).filter((s) => s.enabled !== false && s.prefix);
if (!sites.length) fail('promo_sites.json 中没有启用的站点');
const siteByKey = new Map(sites.map((s) => [s.key, s]));
const prefixSet = new Set(sites.map((s) => s.prefix));

const naming = cfg.naming || {};
const seqWidth = naming.seqWidth || 3;
const seqStart = naming.seqStart || 1;
const fmt = naming.format || '{prefix}-{seq}';
const orderBy = (cfg.allocation && cfg.allocation.orderBy) || ['createdAt', 'id'];
const  = (cfg.allocation && cfg.allocation.) || 'balance_round_robin';

 makeName(prefix, seq) {
  return fmt
    .replace('{prefix}', prefix)
    .replace('{seq}', String(seq).padStart(seqWidth, '0'));
}

// ---------- 载入账号 ----------
const  = readJson(ACCOUNTS_FILE);
if (!Array.isArray()) fail('.json 不是数组，脚本需适配');

console.log('='.repeat(64));
console.log(`promo-names.js  模式=${MODE}  账号=${.length}  站点=${sites.map(s => s.key).join('/')}`);
console.log('='.repeat(64));

// ---------- verify ----------
if (MODE === 'verify') {
  const bad = [];
  const seen = new Map();
  .forEach((a, i) => {
    const dn = a.display_name;
    if (!dn) return bad.push(`#${i} ${a.id} 缺 display_name`);
    if (seen.has(dn)) bad.push(`#${i} ${a.id} display_name 重复: ${dn} 与 ${seen.get(dn)}`);
    seen.set(dn, a.id);
    if (!a.promo_site || !siteByKey.has(a.promo_site)) bad.push(`#${i} ${a.id} promo_site 非法: ${a.promo_site}`);
    if (typeof a.promo_seq !== 'number') bad.push(`#${i} ${a.id} promo_seq 非数字`);
    if (makeName(a.promo_prefix, a.promo_seq) !== dn) bad.push(`#${i} ${a.id} display_name 与序号不一致: ${dn}`);
    // 守卫：登录名必须未被污染
    if (prefixSet.has(a.)) bad.push(`#${i} ${a.id}  被写入了站点前缀（危险）`);
  });
  const withName = .filter((a) => a.display_name;
  console.log(`已有 display_name: ${withName}/${.length}`);
  const bySite = {};
  .forEach((a) => { if (a.promo_site) bySite[a.promo_site] = (bySite[a.promo_site] || 0) + 1; });
  console.log('站点分布:', JSON.stringify(bySite));
  if (bad.length) {
    console.log(`\n发现 ${bad.length} 处问题（前 20 条）:`);
    bad.slice(0, 20).forEach((b) => console.log('  - ' + b));
    process.exit(1);
  }
  console.log('\n✅ 校验通过');
  process.exit(0);
}

// ---------- 备份 ----------
 backup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = Date.now();
  const dest = path.join(BACKUP_DIR, `.before-promonames-${ts}.json`);
  fs.copyFileSync(ACCOUNTS_FILE, dest);
  console.log(`[备份] ${dest}`);
  return dest;
}

// ---------- 分配 ----------
const nowIso = new Date().toISOString();

// 1) 已有分配（非 reassign）→ 保留，并统计各站点当前最大序号
const siteSeq = new Map(sites.map((s) => [s.key, seqStart - 1]));
const siteMeta = new Map(sites.map((s) => [s.key, s]));
const kept = [];
const todo = [];

.forEach((a) => {
  if (!REASSIGN && a.display_name && a.promo_site && siteByKey.has(a.promo_site)) {
    const s = siteByKey.get(a.promo_site);
    if (typeof a.promo_seq === 'number' && a.promo_seq > (siteSeq.get(s.key) ?? 0)) {
      siteSeq.set(s.key, a.promo_seq);
    }
    kept.push(a);
  } else {
    todo.push(a);
  }
});

console.log(`\n[1/3] 保留已有命名: ${kept.length}   待分配: ${todo.length}`);
console.log('      当前各站点最大序号:', JSON.stringify(Object.fromEntries(siteSeq)));

// 2) 排序（稳定、可重复）
 sortVal(a, key) {
  const v = a[key];
  if (v === undefined || v === null) return '';
  return String(v);
}
todo.sort((x, y) => {
  for (const k of orderBy) {
    const c = sortVal(x, k).localeCompare(sortVal(y, k));
    if (c !== 0) return c;
  }
  return sortVal(x, 'id').localeCompare(sortVal(y, 'id'));
});

// 3) 轮转分配
let rr = 0;
const wheel = [];
sites.forEach((s) => { const w = Math.max(1, s.weight || 1); for (let i = 0; i < w; i++) wheel.push(s.key); });

// 手动指定优先：--set=id=hlua-999
const assigned = [];
todo.forEach((a) => {
  let siteKey, seq, source = 'auto';

  if (manualSet.has(a.id)) {
    const want = manualSet.get(a.id);           // e.g. hlua-999
    const m = /^([A-Za-z]+)-?(\d+)$/.exec(want);
    if (!m) fail(`--set 格式非法: ${a.id}=${want}（应为 前缀-序号）`);
    const p = m[1].toLowerCase();
    const s = sites.find((x) => x.prefix.toLowerCase() === p);
    if (!s) fail(`--set 前缀不在配置中: ${p}`);
    siteKey = s.key; seq = parseInt(m[2], 10); source = 'manual';
  } else {
    siteKey = wheel[rr % wheel.length]; rr++;
    seq = (siteSeq.get(siteKey) ?? 0) + 1;
    siteSeq.set(siteKey, seq);
  }

  const s = siteMeta.get(siteKey);
  const dn = makeName(s.prefix, seq);
  a.display_name = dn;
  a.promo_site = s.key;
  a.promo_prefix = s.prefix;
  a.promo_seq = seq;
  a.promo_url = s.url;
  a.promo_source = source;
  a.display_name_set_at = nowIso;
  assigned.push({ id: a.id, : a., display_name: dn, site: s.key });
});

console.log(`[2/3] 新分配: ${assigned.length}`);

// ---------- 统计 ----------
const bySite = {};
.forEach((a) => { if (a.promo_site) bySite[a.promo_site] = (bySite[a.promo_site] || 0) + 1; });
console.log('\n[3/3] 最终站点分布:');
sites.forEach((s) => {
  const n = bySite[s.key] || 0;
  const first = .find((a) => a.promo_site === s.key);
  const last = [...].filter((a) => a.promo_site === s.key).pop();
  console.log(`      ${s.key.padEnd(6)} ${String(n).padStart(4)} 个  ${s.url}   ${first ? first.display_name : '-'} ... ${last ? last.display_name : '-'}`);
});

// 发布覆盖情况（真实数据，不伪造）
let pubFile = null;
try { pubFile = readJson(path.join(DATA_DIR, 'publish.json')); } catch (e) { /* 忽略 */ }
if (Array.isArray(pubFile) && pubFile.length) {
  const id2name = new Map(.map((a) => [a.id, a.display_name]));
  const id2acc = new Map(.map((a) => [a.id, a.]));
  const hit = pubFile.filter((p) => id2name.has(p.account_id) || id2acc.has(p.account_id);
  console.log(`\n      发布记录 ${pubFile.length} 条，可映射到展示名的 ${hit} 条`);
}

console.log('\n样例（前 8 条新分配）:');
assigned.slice(0, 8).forEach((x) => console.log(`      ${x.display_name.padEnd(10)} ${x.}`));

// ---------- 写盘 / 预览 ----------
if (MODE === 'dry-run') {
  console.log('\n[DRY-RUN] 未写盘。确认无误后执行：');
  console.log('  1) 停 3002 主服务 + 3011 看门狗');
  console.log('  2) node tools/promo-names.js --apply');
  console.log('  3) 启动 3002');
  process.exit(0);
}

if (MODE === 'apply') {
  backup();
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNTS_FILE);
  console.log(`\n[写盘] ${ACCOUNTS_FILE}  (${.length} 条)`);
  console.log('[提示] 现在可启动 3002 主服务');
  process.exit(0);
}
