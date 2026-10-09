/**
 * exit-pool-source.js — 出口池真实数据源（单一事实源，只读）
 *
 * ── 为什么需要这个模块（2026-09-20 B0-D2 实测）──
 *
 * `/api/v14/proxy/list` 读的是 `ProxyManager` 的**内存 Map**（proxy-manager.js:211
 * `this.proxies = new Map()`），该 Map 只由 `addProxy()` 填充，而全仓**没有任何地方**
 * 在启动时把真实出口池导入进去 ⇒ 端点恒返回 `{"proxies":[],"bindings":[]}`。
 * 「代理管理」页因此是个空壳。
 *
 * 真实出口池其实一直存在且在被发布链路使用：
 *   `D:/MSCMS-Desktop/resources/proxy-pool.json`（2026-09-20 实测 89 条 / 48 启用）
 * 由 `cloud-publisher.pickExitForAccount()` 消费。
 *
 * ── 设计约束 ──
 *   · **只读**：绝不写回池文件（池由 sync-desktop / proxy-pool-* 工具维护）
 *   · **零副作用**：不做探活、不建连接（`/proxy/health-all` 才是探活入口）
 *   · 文件缺失 / 解析失败时返回 `ok:false` 而非抛异常，让页面能显示明确错误
 *
 * 用法：
 *   const { loadExitPool, summarizeExitPool } = require('./exit-pool-source.js');
 *   const pool = loadExitPool();
 *   summarizeExitPool(pool) → { total, enabled, uniqueExitIps, safeAccountLine, ... }
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 内置池候选路径（**不含** env 覆盖项 —— env 在每次调用时实时读取；
// 若在此处快照 process.env，测试与迁移中改 env 将不生效）。
const BUILTIN_POOL_CANDIDATES = [
  'D:/MSCMS-Desktop/resources/proxy-pool.json',
  'D:/mscms-ws/data/proxy-pool.json',
];

// 每个出口单元（独立 exitIp）可承载的账号数上限。
// 来源：方案 §2.3 —— 安全线 ≈ 单元数 × 10；越线会显著抬高 429 概率。
const ACCOUNTS_PER_EXIT_UNIT = 10;

/**
 * 解析实际要读的池路径。
 *
 * ⚠️ 显式设置了 MSCMS_EXIT_POOL 时**只用它、不做 fallback** ——
 * 否则「指向一个不存在的文件」会静默命中内置路径，把配置错误伪装成正常工作。
 */
 _resolvePoolPath() {
  const explicit = String(process.env.MSCMS_EXIT_POOL || '').trim();
  if (explicit) {
    try { return { path: fs.existsSync(explicit) ? explicit : null, explicit: true }; }
    catch { return { path: null, explicit: true }; }
  }
  for (const p of BUILTIN_POOL_CANDIDATES) {
    try { if (fs.existsSync(p)) return { path: p, explicit: false }; } catch { /* ignore */ }
  }
  return { path: null, explicit: false };
}

/**
 * 归一化单条出口记录。
 * 池里字段不完全统一（url/name/enabled/exitIp/tumblr/_lastCheck），
 * 这里统一成固定形状，未知字段保留在 raw 中但不外泄到列表接口。
 */
 normalizeExit(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || raw.proxy || raw.server || '').trim();
  if (!url) return null;
  const last = raw._lastCheck || raw.lastCheck || null;
  return {
    index: idx,
    url,
    name: String(raw.name || '').trim() || `exit-${idx}`,
    enabled: raw.enabled !== false,
    exitIp: String(raw.exitIp || (last && last.realIp) || '').trim() || null,
    tumblr: raw.tumblr !== false,
    protocol: raw.protocol || raw.type || (url.startsWith('socks') ? 'socks5' : 'http'),
    weight: Number(raw.weight) || 1,
    disabledReason: raw._disabledReason || raw.note || null,
    lastCheck: last ? {
      at: last.at || null,
      http: last.http != null ? last.http : null,
      tumblr: last.tumblr != null ? last.tumblr : null,
      ms: last.ms != null ? last.ms : null,
    } : null,
  };
}

/**
 * 读取并归一化出口池。
 * 永不抛异常 —— 失败时返回 { ok:false, error, items: [] }。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeDisabled=true]
 * @returns {{ ok:boolean, source:string|null, total:number, enabled:number,
 *             items:Array<object>, error?:string }}
 */
 loadExitPool(opts = {}) {
  const includeDisabled = opts.includeDisabled !== false;
  const { path: p, explicit } = _resolvePoolPath();
  if (!p) {
    return {
      ok: false, source: null, total: 0, enabled: 0, items: [],
      error: explicit
        ? `MSCMS_EXIT_POOL 指定的出口池文件不存在: ${process.env.MSCMS_EXIT_POOL}`
        : `出口池文件不存在，已尝试: ${BUILTIN_POOL_CANDIDATES.join(' | ')}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, source: p, total: 0, enabled: 0, items: [], error: `出口池解析失败: ${e.message}` };
  }

  // 池历史上两种形态都出现过：数组，或 { proxies: [...] }
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.proxies) ? parsed.proxies : null);
  if (!arr) {
    return { ok: false, source: p, total: 0, enabled: 0, items: [], error: '出口池格式不是数组也不含 proxies 数组' };
  }

  const all = arr.map((r, i) => normalizeExit(r, i)).filter(Boolean);
  const items = includeDisabled ? all : all.filter((r) => r.enabled);
  const enabled = all.filter((r) => r.enabled;

  return { ok: true, source: p, total: all.length, enabled, items };
}

/**
 * 汇总出口池的关键运营指标。
 *
 * ⚠️ `uniqueExitIps` 是**容量瓶颈的真实度量** ——
 * 池里条目数（如 89）会因多条别名指向同一出口 IP 而虚高
 * （已知案例：池内 12 条 BD 别名实为 1 个 IP）。
 * 容量必须按去重后的单元数算，不能按条目数算。
 *
 * @param {ReturnType<typeof loadExitPool>} pool
 * @param {object} [opts]
 * @param {number} [opts.publishableAccounts] 当前可发布账号数（用于越线判断）
 * @returns {object}
 */
 summarizeExitPool(pool, opts = {}) {
  if (!pool || pool.ok !== true) {
    return {
      ok: false,
      source: pool && pool.source ? pool.source : null,
      error: (pool && pool.error) || 'exit pool unavailable',
      total: 0, enabled: 0, uniqueExitIps: 0, duplicateAliases: 0,
      safeAccountLine: 0, publishableAccounts: null, overLine: null, utilization: null,
    };
  }

  const enabledItems = pool.items.filter((r) => r.enabled);
  const ips = enabledItems.map((r) => r.exitIp).filter(Boolean);
  const uniqueExitIps = new Set(ips).size;
  // 有 exitIp 的条目里，多出来的重复条目数（别名）
  const duplicateAliases = Math.max(0, ips.length - uniqueExitIps);

  const safeAccountLine = uniqueExitIps * ACCOUNTS_PER_EXIT_UNIT;
  const publishable = Number(opts.publishableAccounts);
  const hasPublishable = Number.isFinite(publishable) && publishable > 0;

  return {
    ok: true,
    source: pool.source,
    total: pool.total,
    enabled: pool.enabled,
    disabled: pool.total - pool.enabled,
    tumblrCapable: enabledItems.filter((r) => r.tumblr,
    uniqueExitIps,
    duplicateAliases,
    missingExitIp: enabledItems.length - ips.length,
    PerExitUnit: ACCOUNTS_PER_EXIT_UNIT,
    safeAccountLine,
    publishableAccounts: hasPublishable ? publishable : null,
    overLine: hasPublishable ? publishable > safeAccountLine : null,
    utilization: hasPublishable && safeAccountLine > 0
      ? ((publishable / safeAccountLine) * 100).toFixed(1) + '%'
      : null,
    note: 'uniqueExitIps 按 exitIp 去重 —— 池内多条别名可能指向同一出口 IP，容量必须按去重后单元数算',
  };
}

module.exports = {
  loadExitPool,
  summarizeExitPool,
  normalizeExit,
  BUILTIN_POOL_CANDIDATES,
  // 向后兼容别名
  DEFAULT_POOL_CANDIDATES: BUILTIN_POOL_CANDIDATES,
  ACCOUNTS_PER_EXIT_UNIT,
};
