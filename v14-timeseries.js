'use strict';

/**
 * v14-timeseries.js — B5 时间维度统一聚合内核（纯逻辑，零外部依赖，可脱网单测）
 * =========================================================================
 * 依据升级方案 §3.4「可视化与时间维度（全站统一）」：
 *   粒度自动映射 日→小时 · 周→日 · 月→日 · 年→月
 *   服务端分桶聚合（避免把 4 万条记录推给前端）
 *
 * 本模块【不持有数据、不产生数据】，只对调用方传入的真实记录做分桶统计。
 *
 * 五条零伪造硬约束：
 *   1. 不生成任何合成点：无外推、无平滑、无随机抖动、无「按比例补齐」。
 *   2. 空桶 ≠ 无数据。空桶是「该时段确实 0 条」（真实事实，可以画）；
 *      resolved === 0 才是「根本没有可用数据」→ meta.datasetEmpty=true，
 *      前端必须渲染「暂无数据」占位，不得画一条贴地直线冒充趋势。
 *   3. 记录缺时间字段 → 计入 meta.dropped 并如实暴露 coverage，绝不猜测时间。
 *   4. 【关键取舍】updatedAt 不参与自动解析。它是「被修改时间」而非「事件发生时间」，
 *      拿它兜底会把昨天创建的记录算进今天 —— 那是失真，不是补全。
 *      确需时必须显式指定，响应回显 field 供前端标注口径。
 *   5. 无法解析的时间值一律丢弃并计数，不做「兜底为 now」这类静默失真。
 *
 * 时间口径：按 UTC+8（Asia/Shanghai）本地日历切桶。存量数据是 UTC ISO 串，
 * 若按 UTC 切桶，「今日」会比用户认知偏移 8 小时（凌晨 0-8 点的数据算到前一天）。
 * =========================================================================
 */

/**
 * 自动解析候选字段（按语义优先级排序；updatedAt 刻意不在列，见约束 4）
 *
 * 顺序即优先级，也是「字段链归并」的顺序。实测依据（2026-09-20 全量普查）：
 *   · `` 123 条被两个互斥世代覆盖 —— 87 条老账号只有 createdAt，
 *     36 条 ShardX 新注册只有 ed_at，两者交集为 0。
 *     若按「命中率择优」只取一个字段，覆盖率永远卡在 70.7%；
 *     按链归并则 123/123 = 100%，且时间轴真实（两个字段语义都是「创建/注册时刻」）。
 *   · `trends` 928 条用 fetchedAt；system_audit / link_traffic 用 ts。
 * 注意：链归并只合并「语义同类」字段，顺序已编码语义优先级，绝不掺入 updatedAt 这类
 * 变更时间 —— 那会把老记录算进今天，是失真而非补全。
 */
const CANDIDATES = [
  'createdAt', '', 'ed_at', 'edAt',
  'published_at', 'publishedAt',
  'emitted_at', 'emittedAt', 'occurredAt', 'fetchedAt', 'collectedAt',
  'ts', 'timestamp', 'time', 'dateTime', 'datetime', 'date', 'at',
];
/** 自动模式下最多归并几个字段（防止弱语义字段稀释口径） */
const MAX_CHAIN = 5;

/**
 * 模块级字段覆盖：语义比自动链更准的模块在此钉死。
 *
 * 【教训 2026-09-20】这里只允许放【实测存在且可解析】的字段。B5 初版曾凭一次
 *   受污染的字段普查写入了 `account_tracker_cycles: ''`、
 *   `post_metrics: 'at'` 等 —— 结果把覆盖率从 100% 打成 0%。
 *   污染源：记录里其实没有 `at` 字段，`rec['at']` 沿原型链命中了
 *   `Array.prototype.at`，取值得到字符串 " at() { [native code] }"，
 *   于是被误判为「字段存在」。现已改为 hasOwnProperty 判定（见 pickOwn），
 *   并且覆盖项一律要求实测验证。
 */
const MODULE_FIELD_OVERRIDE = {
  publish: 'published_at',              // 实测 4873/4873 可解析；事件时间=发布时刻
  tumblr_daily_summary: 'date',         // date=统计归属日（createdAt 是写入时刻）
  link_traffic: 'ts',
  system_audit: 'ts',
};

const GRANULARITIES = ['hour', 'day', 'week', 'month', 'year'];
const RANGE_GRANULARITY_MAP = { today: 'hour', week: 'day', month: 'day', year: 'month' };

let _tzOffsetMin = Number.isFinite(Number(process.env.MSCMS_TZ_OFFSET_MIN))
  ? Number(process.env.MSCMS_TZ_OFFSET_MIN) : 480;
let _maxBuckets = Number(process.env.MSCMS_TS_MAX_BUCKETS) > 0
  ? Number(process.env.MSCMS_TS_MAX_BUCKETS) : 1200;

 setTzOffset(min) { _tzOffsetMin = Number(min); return _tzOffsetMin; }
 getTzOffset() { return _tzOffsetMin; }
 setMaxBuckets(n) { _maxBuckets = Number(n) > 0 ? Number(n) : 1200; return _maxBuckets; }
 getMaxBuckets() { return _maxBuckets; }
 timezoneLabel() {
  const h = _tzOffsetMin / 60;
  return 'UTC' + (h >= 0 ? '+' : '') + (Number.isInteger(h) ? h : h.toFixed(2));
}

// ─────────────────────────────────────────────────────────────────────────
// 取值（防原型链污染）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 取记录的自有属性值，**绝不沿原型链取值**。
 *
 * 必要性（实测）：候选表含 `at`，而 `Array.prototype.at` 是原生方法。
 * 若记录本身是数组（历史上 promo_sites / post_metrics 里混入过），
 * `rec['at']` 会返回函数，`String()` 后变成 " at() { [native code] }"，
 * 被误判为「字段存在」→ 字段普查与自动选字段双双出错。
 * @returns {*} 值；不存在或为 null/undefined/空串时返回 undefined
 */
 pickOwn(rec, field) {
  if (!rec || typeof rec !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(rec, field)) return undefined;
  const v = rec[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === '' || typeof v === 'object') {
    // 对象/函数不是合法时间值；Date 已在 parseTime 内专门处理，此处放行 Date
    if (!(v instanceof Date)) return undefined;
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────
// 时间解析
// ─────────────────────────────────────────────────────────────────────────

/**
 * 时间值 → epoch ms。**无法解析必须返回 null**（绝不返回「猜的」时间）。
 * 支持：Date / epoch 秒·毫秒·微秒 / ISO 带时区 / 无时区串（按本地 UTC+8 解释）/ 纯日期
 * @param {*} v
 * @returns {number|null}
 */
 parseTime(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) { const t = v.getTime(); return isNaN(t) ? null : t; }
  if (typeof v === 'number') {
    if (!isFinite(v) || v <= 0) return null;
    if (v < 1e11) return v * 1000;            // 秒（1e11 秒 ≈ 5138 年，安全分界）
    if (v < 1e14) return v;                   // 毫秒
    return Math.floor(v / 1000);              // 微秒
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10}$|^\d{13}$/.test(s)) return parseTime(Number(s));
  // 无时区标记的 `[ HH:mm[:ss[.SSS]]]` → 按本地(UTC+8)解释。
  // 正则末尾锚定 ⇒ 带 Z / ±HH:MM 的串不会命中，交给 Date.parse 走标准路径。
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if (m) {
    const y = +m[1], mo = +m[2], da = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0);
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 23 || mi > 59) return null;
    const ms = Date.UTC(y, mo - 1, da, hh, mi, +(m[6] || 0), +(m[7] || 0));
    return ms - _tzOffsetMin * 60000;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

// ─────────────────────────────────────────────────────────────────────────
// 本地日历切桶
// ─────────────────────────────────────────────────────────────────────────

 toLocal(ms) { return ms + _tzOffsetMin * 60000; }
 fromLocal(ms) { return ms - _tzOffsetMin * 60000; }

/** 取所在桶的起点（本地日历） */
 floorBucket(ms, gran) {
  const d = new Date(toLocal(ms));
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), da = d.getUTCDate(), h = d.getUTCHours();
  if (gran === 'hour') return fromLocal(Date.UTC(y, mo, da, h));
  if (gran === 'day') return fromLocal(Date.UTC(y, mo, da));
  // 周起点 = 周一（中国习惯，非周日）
  if (gran === 'week') { const dow = (d.getUTCDay() + 6) % 7; return fromLocal(Date.UTC(y, mo, da - dow)); }
  if (gran === 'month') return fromLocal(Date.UTC(y, mo, 1));
  if (gran === 'year') return fromLocal(Date.UTC(y, 0, 1));
  return fromLocal(Date.UTC(y, mo, da));
}

/** 下一个桶起点（Date.UTC 自动进位，跨月/跨年/闰年安全） */
 nextBucket(ms, gran) {
  const d = new Date(toLocal(ms));
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), da = d.getUTCDate(), h = d.getUTCHours();
  if (gran === 'hour') return fromLocal(Date.UTC(y, mo, da, h + 1));
  if (gran === 'day') return fromLocal(Date.UTC(y, mo, da + 1));
  if (gran === 'week') return fromLocal(Date.UTC(y, mo, da + 7));
  if (gran === 'month') return fromLocal(Date.UTC(y, mo + 1, 1));
  if (gran === 'year') return fromLocal(Date.UTC(y + 1, 0, 1));
  return fromLocal(Date.UTC(y, mo, da + 1));
}

/** 桶标签（本地时间） */
 labelFor(ms, gran) {
  const d = new Date(toLocal(ms));
  const p2 = (n) => String(n).padStart(2, '0');
  const Y = d.getUTCFullYear(), M = p2(d.getUTCMonth() + 1), D = p2(d.getUTCDate()), H = p2(d.getUTCHours());
  if (gran === 'hour') return `${M}-${D} ${H}:00`;
  if (gran === 'day') return `${M}-${D}`;
  if (gran === 'week') return `${M}-${D} 周`;
  if (gran === 'month') return `${Y}-${M}`;
  if (gran === 'year') return `${Y}`;
  return `${M}-${D}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 窗口解析
// ─────────────────────────────────────────────────────────────────────────

/**
 * range → { from, to, gran }，失败返回 { error }
 * @param {{range:string, from?:string, to?:string, now:number}} q
 */
 resolveRange(q) {
  const range = q.range || 'week';
  const now = q.now;
  if (range === 'custom') {
    const f = parseTime(q.from), t = parseTime(q.to);
    if (f === null) return { error: 'range=custom 需要合法的 from（ISO 时间或 ）' };
    if (t === null) return { error: 'range=custom 需要合法的 to（ISO 时间或 ）' };
    if (f >= t) return { error: 'from 必须早于 to' };
    const spanD = (t - f) / 86400000;
    const gran = spanD <= 1.5 ? 'hour' : spanD <= 92 ? 'day' : spanD <= 800 ? 'week' : 'month';
    return { from: floorBucket(f, gran), to: t, gran };
  }
  if (!Object.prototype.hasOwnProperty.call(RANGE_GRANULARITY_MAP, range)) {
    return { error: 'range 仅支持 today|week|month|year|custom' };
  }
  const gran = RANGE_GRANULARITY_MAP[range];
  if (range === 'today') return { from: floorBucket(now, 'day'), to: now + 1, gran };
  if (range === 'week') return { from: floorBucket(now, 'week'), to: now + 1, gran };
  if (range === 'month') return { from: floorBucket(now, 'month'), to: now + 1, gran };
  return { from: floorBucket(now, 'year'), to: now + 1, gran };
}

/** 逐级粗化：hour→day→week→month；已到 month 返回 null */
 coarsen(gran) {
  if (gran === 'hour') return 'day';
  if (gran === 'day') return 'week';
  if (gran === 'week') return 'month';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// 字段解析
// ─────────────────────────────────────────────────────────────────────────

/**
 * 解析用哪个字段做时间轴。
 * 优先级：显式覆盖 > 模块覆盖（两者都只取单字段，不归并）> 候选链归并。
 * @returns {{field:string, chain:string[], fieldAuto:boolean, candidates:Object}}
 */
 resolveField(records, moduleName, fieldOverride, sampleSize) {
  const n = Number(sampleSize) > 0 ? Number(sampleSize) : 400;
  const candidates = {};
  const sample = records.slice(0, n);
  for (const c of CANDIDATES) {
    let hit = 0;
    for (const rec of sample) if (pickOwn(rec, c) !== undefined) hit++;
    if (hit > 0) candidates[c] = hit;
  }
  // 显式/模块覆盖：语义由人工钉死，只用单一字段
  const pinned = fieldOverride || MODULE_FIELD_OVERRIDE[moduleName] || null;
  if (pinned) return { field: String(pinned), chain: [String(pinned)], fieldAuto: false, candidates };
  // 自动：按候选表优先级归并所有真实存在的字段（最多 MAX_CHAIN 个）
  const chain = CANDIDATES.filter((c) => candidates[c] > 0).slice(0, MAX_CHAIN);
  if (!chain.length) return { field: 'createdAt', chain: ['createdAt'], fieldAuto: true, candidates };
  return { field: chain[0], chain, fieldAuto: true, candidates };
}

/**
 * 统计字段链在真实记录上的可解析覆盖率（不建桶，供「模块体检」用）。
 * @returns {{scanned:number, resolved:number, dropped:number, coverage:number|null, fieldsUsed:Object}}
 */
 resolveCoverage(records, chain) {
  const ch = (Array.isArray(chain) && chain.length) ? chain : ['createdAt'];
  let scanned = 0, resolved = 0;
  const fieldsUsed = {};
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    scanned++;
    for (const f of ch) {
      const v = pickOwn(r, f);
      if (v === undefined) continue;
      if (parseTime(v) === null) continue;
      resolved++;
      fieldsUsed[f] = (fieldsUsed[f] || 0) + 1;
      break;
    }
  }
  return {
    scanned, resolved, dropped: scanned - resolved,
    coverage: scanned > 0 ? +((resolved / scanned) * 100).toFixed(1) : null,
    fieldsUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 聚合
// ─────────────────────────────────────────────────────────────────────────

/**
 * 对真实记录做分桶聚合。
 * @param {Array<object>} records 真实记录（调用方从 DataStore 取）
 * @param {{field:string, fieldAuto?:boolean, metricMode?:'sum'|'avg'|null, metricField?:string,
 *          from:number, to:number, gran:string}} opts
 * @returns {{buckets:Array, labels:string[], series:Object, total:number, meta:Object}}
 */
 aggregate(records, opts) {
  const { field, fieldAuto, metricMode, metricField, from, to } = opts;
  // 字段链：按语义优先级逐条尝试，取第一个「存在且可解析」的值。
  // 语义同类字段的归并 ≠ 猜测：每个值都真实存在，且用哪个字段会被如实计入 fieldsUsed。
  const chain = (Array.isArray(opts.chain) && opts.chain.length) ? opts.chain.slice() : [field];
  let gran = opts.gran;
  let coarsened = false;

  // 桶数超上限 → 逐级粗化（保护内存与响应体，而不是悄悄截断数据）
  for (let guard = 0; guard < 5; guard++) {
    let n = 0, cur = floorBucket(from, gran);
    while (cur < to && n <= _maxBuckets) { cur = nextBucket(cur, gran); n++; }
    if (n <= _maxBuckets) break;
    const nx = coarsen(gran);
    if (!nx) throw new Error(`时间跨度过长：请缩小范围或改用更粗粒度（${gran} 已超 ${_maxBuckets} 桶上限）`);
    gran = nx; coarsened = true;
  }

  // 建桶（含零桶：零桶 = 该时段确实 0 条，是真实事实，不是伪造）
  const buckets = [];
  const index = new Map();
  let cur = floorBucket(from, gran);
  let guard = 0;
  while (cur < to && guard++ <= _maxBuckets) {
    const end = nextBucket(cur, gran);
    index.set(cur, buckets.length);
    buckets.push({ label: labelFor(cur, gran), from: new Date(cur).toISOString(), to: new Date(end).toISOString(), count: 0, _sum: 0, _num: 0 });
    cur = end;
  }

  let scanned = 0, resolved = 0, inRange = 0;
  const fieldsUsed = {};

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    scanned++;
    let t = null, usedField = null;
    for (const f of chain) {
      const v = pickOwn(r, f);
      if (v === undefined) continue;
      const tt = parseTime(v);
      if (tt !== null) { t = tt; usedField = f; break; }
    }
    if (t === null) continue;                 // 解析不了就丢弃并计数，绝不兜底为 now
    resolved++;
    fieldsUsed[usedField] = (fieldsUsed[usedField] || 0) + 1;
    const bi = index.get(floorBucket(t, gran));
    if (bi === undefined) continue;           // 在窗口外
    inRange++;
    buckets[bi].count++;
    if (metricMode) {
      const nv = Number(pickOwn(r, metricField));
      if (Number.isFinite(nv)) { buckets[bi]._sum += nv; buckets[bi]._num++; }
    }
  }

  const labels = buckets.map((b) => b.label);
  const count = buckets.map((b) => b.count);
  let value = null;
  if (metricMode) {
    value = buckets.map((b) => (b._num > 0 ? +(metricMode === 'avg' ? b._sum / b._num : b._sum).toFixed(4) : null));
  }
  for (const b of buckets) { delete b._sum; delete b._num; }

  const series = { count };
  if (value) series.value = value;

  return {
    buckets, labels, series,
    total: inRange,
    meta: {
      field, fieldAuto: !!fieldAuto,
      fieldChain: chain,
      fieldsUsed,                        // 如实暴露「每条记录实际用了哪个字段」
      granularity: gran, coarsened,
      scanned, resolved, dropped: scanned - resolved,
      coverage: scanned > 0 ? +((resolved / scanned) * 100).toFixed(2) : null,
      outOfRange: resolved - inRange,
      datasetEmpty: resolved === 0,
      bucketCount: buckets.length,
      metric: metricMode ? `${metricMode}:${metricField}` : 'count',
      timezone: timezoneLabel(),
    },
  };
}

module.exports = {
  CANDIDATES,
  MODULE_FIELD_OVERRIDE,
  GRANULARITIES,
  RANGE_GRANULARITY_MAP,
  MAX_CHAIN,
  setTzOffset, getTzOffset, timezoneLabel,
  setMaxBuckets, getMaxBuckets,
  parseTime, pickOwn,
  floorBucket, nextBucket, labelFor,
  resolveRange, coarsen,
  resolveField, resolveCoverage,
  aggregate,
};
