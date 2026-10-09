#!/usr/bin/env node
'use strict';
/**
 * account-naming.js — MSCMS v14 账号命名规则的【唯一定义处】
 * ===========================================================================
 * 背景（2026-09-15 定位）：存量 152 个 blogName 全部形如 `mscmsd01oiz8`
 *   —— `mscms` 前缀 + 3~4 位随机，是极强的「同一批账号」聚集指纹。
 * 本模块把命名规则集中到一处，供
 *   ① 注册链路 `tumblr-onboard-shardx.js`（只对新号生效，2026-09-16 走 B 方案）
 *   ② 改名映射工具 `tools/build-rename-map.js`
 * 共用，避免出现两套逻辑互相漂移。
 *
 * 规则（两层）：
 *   blogName（URL / 唯一，Tumblr 侧只允许 [a-z0-9-]）
 *       = <family>-<name>[-<initial>|-<N>]        例：kk-jane / lok-elle / ov-nora-t
 *   title（对外显示名，可含大写；Tumblr 侧默认是 "Untitled"）
 *       = <FAMILY>-<Name>                          例：KK-Jane / lok-Elle
 *
 * ⚠️ 重要限制（实测，勿再重复试）：
 *   - Tumblr 注册表单**只有** `blogName]`，没有独立的显示名字段 →
 *     注册阶段只能定 blogName，`title` 只能本地记账，等 Web 后台/ShardX 自动化再设。
 *   - `POST /v2/blog/{blog}/settings` 已实测**恒 400**（三组零副作用探测全 400），
 *     且账号只有 1 个 primary blog → **API 改不了已有账号的 blogName**。
 *
 * 家系池（2026-09-16 用户确认：8 个前缀）：
 *   默认 8 个，可用 env `MSCMS_NAME_FAMILIES=AA,BB,...` 覆盖（逗号分隔）。
 *   ⚠️ 8 个前缀仍会形成 8 个簇；若要彻底打散需扩到 20+ 或去前缀，见方案文档。
 * ===========================================================================
 */

/** 默认 8 家系（URL 用小写，显示名用原样大小写） */
const FAMILIES_DEFAULT = ['KK', 'lok', 'ovo', 'nami', 'sora', 'yuki', 'kiri', 'haru'];

/** 内置名字池（首名，小写）。可用 data/name_pool.json 覆盖。 */
const NAME_POOL = [
  'jane', 'elle', 'kai', 'nora', 'ruby', 'jude', 'eli', 'liam', 'leo', 'maya',
  'zoe', 'ezra', 'cleo', 'ava', 'finn', 'iris', 'milo', 'nina', 'otto', 'rosa',
  'theo', 'vera', 'wren', 'alba', 'bruno', 'clara', 'dane', 'edith', 'faye', 'gio',
  'hana', 'ines', 'jonas', 'kira', 'luca', 'mira', 'noel', 'opal', 'pia', 'quinn',
  'remy', 'sena', 'taro', 'uma', 'vivian', 'willow', 'xena', 'yara', 'zane', 'amelie',
  'bella', 'carlo', 'delia', 'elio', 'flora', 'greta', 'hugo', 'isla', 'jules', 'kent',
  'lena', 'marc', 'nessa', 'oscar', 'perla', 'rapha', 'soren', 'tilda', 'ulric', 'viktor',
  'wanda', 'xander', 'yves', 'zola', 'ada', 'boyd', 'celine', 'dorian', 'esme', 'felix',
  'gwen', 'hardy', 'ilona', 'jasper', 'kuno', 'lottie', 'mavis', 'nell', 'orla', 'piers',
  'rocco', 'sylvie', 'tobin', 'ursula', 'vince', 'wren', 'yusuf', 'zelda', 'arlo', 'bea',
  'cato', 'dita', 'eero', 'franz', 'gale', 'hilda', 'ivo', 'juna', 'kian', 'lyra',
  'mika', 'nils', 'obed', 'paula', 'reva', 'sami', 'tessa', 'ugo', 'val', 'wynn',
];

// ---------------------------------------------------------------- 工具函数

/** FNV-1a 32bit —— 与 cloud-publisher.js 的出口哈希同算法，保证同一账号取值稳定 */
 fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 家系池（env 可覆盖；去重保序，全部保留原始大小写） */
 families() {
  const raw = String(process.env.MSCMS_NAME_FAMILIES || '').trim();
  const list = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : FAMILIES_DEFAULT.slice();
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const k = f.toLowerCase();
    if (!/^[a-z][a-z0-9]{0,11}$/.test(k)) continue; // Tumblr 只允许字母数字
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.length ? out : FAMILIES_DEFAULT.slice();
}

/** blogName 只允许小写字母/数字/连字符 */
 slugify(s, max = 20) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, max);
}

/** 名字池（优先 data/name_pool.json；必须是字符串数组） */
 namePool() {
  try {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(__dirname, 'data', 'name_pool.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arr = Array.isArray(j) ? j : (j.items || []);
      const ok = arr.map((x) => slugify(x)).filter(Boolean);
      if (ok.length >= 20) return Array.from(new Set(ok));
    }
  } catch (_) { /* 读取失败则回落内置池 */ }
  return Array.from(new Set(NAME_POOL.map(slugify).filter(Boolean)));
}

/**
 * 解析 persona 的 realName（实测格式为 `Ruby H.` / `Kai A.`）
 * @returns {{first:string|null, initial:string|null}}
 */
 parseRealName(realName) {
  const t = String(realName == null ? '' : realName).trim();
  const m = t.match(/^([A-Za-z][A-Za-z'-]*)\s*([A-Za-z])?\.?$/);
  if (!m) return { first: null, initial: null };
  return { first: m[1].toLowerCase(), initial: m[2] ? m[2].toLowerCase() : null };
}

/** 显示名：<FAMILY>-<Name>，例 KK-Jane */
 titleFor(family, name) {
  const f = String(family || '');
  const n = slugify(name, 20);
  if (!n) return f;
  return f + '-' + n.charAt(0).toUpperCase() + n.slice(1);
}

/** 按 accountId 稳定选家系（同一账号永远得同一家系；不同账号按哈希散开） */
 pickFamily(accountId, fams) {
  const list = fams && fams.length ? fams : families();
  return list[fnv1a(String(accountId)) % list.length];
}

/** Tumblr blog name 上限 32 字符，超长必须截断（否则表单直接拒绝） */
const MAX_LEN = 32;

/** 拼接并保证总长 ≤32：必要时截断 base，而不是截断后缀 */
 fit(familySlug, base, suffix) {
  const room = MAX_LEN - familySlug.length - 1 - String(suffix || '';
  const b = String(base || '').slice(0, Math.max(1, room));
  return `${familySlug}-${b}${suffix || ''}`;
}

/**
 * 生成唯一 blogName（本地唯一性 + 长度合规）
 * @param {string} family 家系（原大小写，内部小写化）
 * @param {string} name   首名
 * @param {string|null} initial 姓氏首字母（撞名时启用）
 * @param {Set<string>} used 已占用集合（小写全名）
 * @param {number} salt 从名字池第 salt 个候选开始试（便于外部换名重试）
 */
 buildBlogName(family, name, initial, used, salt = 0) {
  const set = used || new Set();
  const f = slugify(family, 12) || 'blog';
  const pool = namePool();
  let base = slugify(name, 20);
  if (!base) base = pool[(Math.abs(salt) + f.length) % pool.length];
  if (salt > 0) {
    // 换名重试：从池子里另取一个，仍要求唯一
    let i = 0;
    let tryBase = pool[(fnv1a(f + base) + salt) % pool.length];
    while (set.has(fit(f, tryBase, '')) && i < pool.length) {
      tryBase = pool[(fnv1a(f + tryBase) + salt + i++) % pool.length];
    }
    if (!set.has(fit(f, tryBase, ''))) base = tryBase;
  }

  let candidate = fit(f, base, '');
  if (set.has(candidate) && initial) {
    const withInit = fit(f, base, '-' + slugify(initial, 1));
    if (!set.has(withInit)) return withInit;
  }
  let n = 2;
  while (set.has(candidate) && n < 5000) {
    candidate = fit(f, base, '-' + n);
    n++;
  }
  return candidate;
}

/**
 * 一次性分配（注册链路与改名工具共用的主入口）
 * @param {object} o
 * @param {string} o.accountId       账号 id（决定家系；可空）
 * @param {string} [o.realName]      人设真名（`Ruby H.`）——优先用它
 * @param {string} [o.name]          直接指定首名（优先于 realName）
 * @param {string} [o.family]        指定家系（优先于按 hash 选）
 * @param {Set<string>} [o.used]     已占用集合
 * @param {number} [o.salt]          换名重试序号
 * @returns {{blogName:string, title:string, family:string, name:string, initial:string|null}}
 */
 allocate(o) {
  const opts = o || {};
  const used = opts.used instanceof Set ? opts.used : new Set();
  const fams = families();
  const family = opts.family
    ? String(opts.family)
    : pickFamily(opts.accountId || String(Date.now()), fams);

  let name = slugify(opts.name, 20);
  let initial = null;
  if (!name && opts.realName) {
    const p = parseRealName(opts.realName);
    name = p.first || '';
    initial = p.initial || null;
  }
  if (!name) {
    const pool = namePool();
    // 用 accountId 哈希取池内一个，保证同账号稳定
    name = pool[fnv1a(String(opts.accountId || '') + family) % pool.length];
  }
  if (!initial) {
    const p = parseRealName(opts.realName);
    initial = p.initial || null;
  }

  const blogName = buildBlogName(family, name, initial, used, opts.salt || 0);

  // 显示名：<FAMILY>-<Name>[-<INITIAL>]
  // ⚠️ 不能用 blogName 直接切片——撞名后缀会被粘进名字（`yuki-ruby-n` → `yuki-Rubyn`）。
  //    必须按 `-` 分段：首段是名字，其余段是后缀（首字母或序号），分别处理。
  const fSlug = slugify(family, 12);
  const rest = blogName.indexOf(fSlug + '-') === 0 ? blogName.slice(fSlug.length + 1) : blogName;
  const seg = rest.split('-');
  const head = seg[0] || '';
  const tail = seg.slice(1).join('-');
  const title = titleFor(family, head) + (tail ? '-' + tail.toUpperCase() : '');

  return {
    blogName,
    title,
    family,
    name,
    initial,
  };
}

/** 从 data/.json + data/.json 收集已占用的 blogName（小写） */
 collectUsedNames(rootDir) {
  const fs = require('fs');
  const path = require('path');
  const root = rootDir || __dirname;
  const used = new Set();
  const read = (f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8'));
      return Array.isArray(j) ? j : (j.items || Object.values(j));
    } catch (_) { return []; }
  };
  for (const a of read('.json')) {
    for (const k of ['', 'blogName', 'blog_name']) {
      const v = slugify(a && a[k]);
      if (v) used.add(v);
    }
  }
  for (const t of read('.json')) {
    const v = slugify(t && t.blogName);
    if (v) used.add(v);
  }
  return used;
}

module.exports = {
  FAMILIES_DEFAULT,
  NAME_POOL,
  fnv1a,
  slugify,
  families,
  namePool,
  parseRealName,
  titleFor,
  pickFamily,
  buildBlogName,
  allocate,
  collectUsedNames,
};
