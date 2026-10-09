#!/usr/bin/env node
/**
 * tools/build-rename-map.js — 生成「有规则的用户名变更」映射表（只读，不改动任何东西）
 * ---------------------------------------------------------------------------
 * 目标：现有 152 个 blogName 全是 `mscms+3位数字+4位随机`，前缀 `mscms` 是极强的批量
 *   聚集指纹。本工具按规则生成新名，打散指纹。
 *
 * 命名规则（两层）：
 *   blogName（URL/用户名，必须小写）  = <family>-<name>[-<initial>]   如 kk-jane / lok-elle
 *   title  （对外显示名，可含大写）  = <FAMILY>-<Name>                如 KK-Jane  / lok-Elle
 *
 *   - <family> 取自家系池（**默认 8 个**：KK/lok/ovo/nami/sora/yuki/kiri/haru，
 *     定义在 account-naming.js，可用 --families 或 env MSCMS_NAME_FAMILIES 覆盖），
 *     按 accountId 哈希稳定分配（同一账号永远同一家系，不同账号散开）。
 *   - <name>  取自该账号自己的 persona.realName（208 条人设里的一手名），
 *     这样「用户名」与「人设」一致，不会出现人名与内容人格互斥。
 *   - 撞名时追加姓氏首字母（Kai U. → kk-kai-u）保证全局唯一。
 *
 * 安全：本工具**只生成文件**（JSON + 预览表），不调用任何写接口。
 *
 * 用法：
 *   node tools/build-rename-map.js                      # 前 40 个（按已发数降序）
 *   node tools/build-rename-map.js --limit 80
 *   node tools/build-rename-map.js --families KK,lok,ovo
 *   node tools/build-rename-map.js --ignore-existing    # 不与存量 152 名比对（仅压测用）
 *   node tools/build-rename-map.js --out D:/mscms-ws/exports/rename-map.json
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
// 【2026-09-16】命名规则收归 account-naming.js 唯一定义处（原先是本文件内联实现，
//   与注册链路各写一套，存在漂移风险）。此处只做「取候选 + 调 allocate + 落表」。
const NAMING = require(path.join(ROOT, 'account-naming.js'));

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
    args.set(k, v);
  }
}
const LIMIT = parseInt(args.get('limit') || '40', 10);
// 家系池：默认取 account-naming.js 的默认值（2026-09-16 用户确认 = 8 个前缀）
const FAMILIES = args.get('families')
  ? String(args.get('families')).split(',').map((s) => s.trim()).filter(Boolean)
  : NAMING.families();
const OUT = args.get('out') || path.join(ROOT, 'exports', 'rename-map.json');

 load(f) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  return Array.isArray(j) ? j : (j.items || Object.values(j));
}

const  = load('.json');
const personas = load('tumblr_persona.json');
const tokens = load('.json');
const publish = load('publish.json');

const P = {}; personas.forEach((p) => { if (p && p.id) P[String(p.id)] = p; });
const T = {}; tokens.forEach((t) => { if (t && t.id) T[String(t.id)] = t; });
const pubCount = {};
publish.filter((x) => x && x.publish_url).forEach((x) => {
  const a = String(x.account_id || ''); pubCount[a] = (pubCount[a] || 0) + 1;
});

// 候选：active ∩ 有 blogName ∩ 已成功发布，按已发数降序
const cand = 
  .filter((a) => a && a.status === 'active' && T[String(a.id)] && T[String(a.id)].blogName && pubCount[String(a.id)] > 0)
  .map((a) => {
    const id = String(a.id);
    const p = P[id] || {};
    const real = String(p.realName || '').trim();
    const m = real.match(/^([A-Za-z]+)\s*([A-Za-z])?\.?$/);
    return {
      id,
      oldName: T[id].blogName,
      oldTitle: null,
      posts: pubCount[id] || 0,
      realName: real,
      first: m ? m[1] : null,
      initial: m && m[2] ? m[2].toLowerCase() : null,
      voice: p.voice || null,
      interests: p.interests || [],
    };
  })
  // 加 id 兜底排序 → 结果可复现（同名分配依赖遍历顺序）
  .sort((x, y) => (y.posts - x.posts) || String(x.id).localeCompare(String(y.id)))
  .slice(0, LIMIT);

// 分配新名（走 account-naming.js 唯一定义处；全局唯一）
// used 先灌入存量已占用名，确保新名既不相撞、也不与存量重名
const used = args.get('ignore-existing') ? new Set() : NAMING.collectUsedNames(ROOT);
const rows = [];
for (const c of cand) {
  const r = NAMING.allocate({
    accountId: c.id,
    name: c.first || undefined,
    realName: c.realName || undefined,
    used,
  });
  used.add(r.blogName);
  rows.push({
    accountId: c.id,
    oldName: c.oldName,
    newName: r.blogName,
    newTitle: r.title,
    family: r.family,
    posts: c.posts,
    voice: c.voice,
    first: c.first,
  });
}

// 输出
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const map = {};
rows.forEach((r) => { map[r.accountId] = r.newName; });
fs.writeFileSync(OUT, JSON.stringify(map, null, 2), 'utf8');

console.log(`家系池: ${FAMILIES.join(' / ')}`);
console.log(`候选账号: ${cand.length}（active ∩ 有 blogName ∩ 已发布，按已发数降序）`);
console.log(`映射文件: ${OUT}\n`);
console.log('序号 | accountId        | 旧 blogName    | 新 blogName     | 新显示名   | 已发');
console.log('-'.repeat(88));
rows.forEach((r, i) => {
  console.log(
    String(i + 1).padStart(4) + ' | ' + r.accountId.padEnd(16) + ' | ' + String(r.oldName).padEnd(15) + ' | ' +
    r.newName.padEnd(16) + ' | ' + r.newTitle.padEnd(11) + ' | ' + String(r.posts).padStart(3)
  );
});
const famCount = {};
rows.forEach((r) => { famCount[r.family] = (famCount[r.family] || 0) + 1; });
console.log('\n家系分布:', JSON.stringify(famCount), '| 唯一名数量:', used.size);
console.log('⚠️ 未写入 Tumblr、未改本地文件（除映射 JSON）。执行需 --apply 并显式确认。');
