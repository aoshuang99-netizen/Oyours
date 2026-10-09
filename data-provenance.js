/**
 * data-provenance.js — 数据来源归因判定（单一事实源）
 *
 * ── 为什么需要这个模块（2026-09-20 B0-D4 实测根因）──
 *
 * 因果链 S5→S6 的 `visit.recorded` 阶段由系统**主动发起真实 HTTP 请求**到自己的
 * 短链 `/r/:code` 来驱动（server.js:4023-4100）。为遵守零伪造原则，那段代码刻意
 * **不伪造源 IP**，而是把 ip/country 如实标注为 `'self_direct'`
 * （server.js:4037-4039，注释原文：「属于伪造流量来源…须如实标注」）。这个设计是**正确的**。
 *
 * 但下游 `website-analytics._generateVisitorId()` 以 `data.ip` 做 MD5 去重：
 *     crypto.createHash('md5').update(String(data.ip)).digest('hex')
 * ⇒ 当 ip 恒为 `'self_direct'` 时，**所有记录坍缩成同一个 visitorId**
 * ⇒ 实测 `/api/v14/analytics/stats` 返回 `totalVisits=351360` 但 `totalUniqueVisitors=2`。
 *
 * 两个各自正确的设计相撞，产生了错误统计。真正的缺陷是：
 *   **系统自生成流量没有被从大盘统计中隔离**（代码已打 `_system_generated:true`，
 *     但统计口径从未读取该标记）。
 *
 * ── 本模块的职责 ──
 * 把「这条流量是谁产生的」抽成**唯一判定**，供三处共用：
 *   1. website-analytics.js  — 分口径统计（user / system / unknown）
 *   2. server.js 写库前      — 打标与隔离
 *   3. 前端大盘              — 展示时区分「真实用户」与「系统自生成」
 * 避免同类判定再次漂移（P2-B5 的媒体判定曾出现过三处各写一份的漂移，已由
 * content-media-ref.js 收敛，本模块沿用同一哲学）。
 *
 * 用法：
 *   const { classifyTraffic, isUsableIp, summarizeProvenance } = require('./data-provenance.js');
 *   classifyTraffic({ ip: 'self_direct' })        → 'system'
 *   classifyTraffic({ ip: '203.0.113.5' })        → 'user'
 *   classifyTraffic({ ip: '' })                   → 'unknown'
 */

'use strict';

// ── 系统自生成流量的 IP 占位标记 ──────────────────────
// 注意：这些**不是**真实 IP，是「如实标注」用的哨兵值。
// 任何以 ip 做哈希/去重的逻辑都必须先经 isUsableIp() 过滤。
const SYSTEM_IP_MARKERS = new Set([
  'self_direct', 'system', 'internal', 'localhost', 'loopback',
  '', '::1', '::ffff:', '0.0.0.0', 'unknown', 'null', 'undefined',
]);

// ── 系统自生成流量的来源标记（出现在 source / _source 字段）──
const SYSTEM_SOURCE_MARKERS = new Set([
  'system-simulated', 'system', 'internal', 'self_direct', 'self-direct', 'system_simulated',
]);

// ── 系统自生成流量的 UA 标记 ──
// server.js 驱动访问时会轮换一批真实浏览器 UA，因此 UA **不能**用于判定；
// 仅在明显是脚本 UA 时才辅助归类。
const SYSTEM_UA_MARKERS = [
  'curl/', 'wget/', 'node-fetch', 'axios/', 'python-requests', 'okhttp', 'go-http-client',
  'headlesschrome', 'phantomjs', 'puppeteer',
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;

// ── RFC 5737 文档/测试保留段 ──
// 本系统用它来「模拟住宅 IP」（server.js:4099-4102 residentialIPs 数组，
// 供因果链 S5 在无云手机时以 HTTP 直连方式驱动访问）。
// ⚠️ 这些**不是**真实用户 IP。若不识别，classifyTraffic 会因其格式合法
// 而误判为 'user'，把系统自生成流量算进真实访客口径 —— 正是零伪造原则要防的。
// server.js:4243 已有等价判定 isTestNetIP，此处作为跨模块兜底保持一致。
const TEST_NET_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.'];

 isTestNetIp(ip) {
  if (typeof ip !== 'string') return false;
  const s = ip.trim();
  return TEST_NET_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * 判断一个 ip 字段值是否**真的**是可用的 IP 地址。
 * 哨兵值（self_direct 等）、TEST-NET 保留段与空值一律返回 false ——
 * 调用方在需要哈希去重时必须据此回退到其它熵源，否则会发生 ID 坍缩。
 *
 * @param {*} ip
 * @returns {boolean}
 */
 isUsableIp(ip) {
  if (typeof ip !== 'string') return false;
  const s = ip.trim();
  if (!s) return false;
  if (SYSTEM_IP_MARKERS.has(s.toLowerCase())) return false;
  // TEST-NET 是模拟用保留段，格式合法但不是真实访客，不可用于去重
  if (isTestNetIp(s)) return false;

  const m4 = IPV4_RE.exec(s);
  if (m4) {
    for (let i = 1; i <= 4; i++) {
      const n = Number(m4[i]);
      if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    }
    return true;
  }
  if (s.includes(':') && IPV6_RE.test(s)) return true;
  // 域名/主机名不算 IP（例如采集端误把来源标记塞进 ip 字段）
  return false;
}

 looksLikeScriptUa(ua) {
  if (typeof ua !== 'string' || !ua) return false;
  const lower = ua.toLowerCase();
  return SYSTEM_UA_MARKERS.some((m) => lower.includes(m));
}

/**
 * 归类一条流量记录。
 *
 * 判定优先级（从强到弱）：
 *   1. 显式标记 `_system_generated` / `_systemGenerated` 为 true  → system
 *   2. `source` 命中系统来源标记                                  → system
 *   3. `ip` 命中哨兵标记（如 self_direct）                        → system
 *   4. 可用的真实 IP                                              → user
 *   5. 其余（空 ip、脚本 UA 等）                                  → unknown
 *
 * ⚠️ 'unknown' 不等于假数据。它表示「现有字段不足以判定」，
 *     大盘必须单列展示，**不得**并入 user 口径（否则又会造出好看的假象）。
 *
 * @param {object} rec 任意含 ip / source / _system_generated / ua 的记录
 * @returns {'system'|'user'|'unknown'}
 */
 classifyTraffic(rec) {
  if (!rec || typeof rec !== 'object') return 'unknown';

  if (rec._system_generated === true || rec._systemGenerated === true) return 'system';

  // 采集端显式声明的流量模式：http_direct = 无云手机时的 HTTP 直连驱动（系统自生成）
  const mode = String(rec._traffic_mode || rec.traffic_mode || '').trim().toLowerCase();
  if (mode === 'http_direct') return 'system';

  const src = String(rec.source || rec._source || '').trim().toLowerCase();
  if (src && SYSTEM_SOURCE_MARKERS.has(src)) return 'system';
  // 采集端曾把 'self_direct' 写进 source 之外的字段，这里一并兜住
  if (src === 'self_direct' || src === 'self-direct') return 'system';

  const ip = rec.ip || rec.visitorIp || rec.visitor_ip || '';
  if (typeof ip === 'string') {
    const sip = ip.trim().toLowerCase();
    if (sip && SYSTEM_IP_MARKERS.has(sip)) return 'system';
    // 【补】TEST-NET 保留段 = 系统模拟住宅 IP，格式合法但不是真实访客
    if (sip && isTestNetIp(sip)) return 'system';
  }

  if (isUsableIp(ip)) return 'user';

  const ua = rec.ua || rec.userAgent || rec.user_agent || '';
  if (looksLikeScriptUa(ua)) return 'system';

  return 'unknown';
}

/**
 * 生成一段「可用于哈希去重」的稳定熵源。
 *
 * 当 ip 不可用时（哨兵值/空），退回到 ua + referrer +  的组合 hash。
 * 这不会凭空造出访客 —— 组合相同的请求仍会归为同一访客，
 * 这是**有意为之**（去重口径必须稳定，否则 DAU 会虚高）。
 *
 * @param {object} rec
 * @returns {{ key: string, basis: 'ip'|'composite'|'none' }}
 */
 visitorFingerprint(rec) {
  if (!rec || typeof rec !== 'object') return { key: '', basis: 'none' };

  const ip = rec.ip || rec.visitorIp || rec.visitor_ip || '';
  if (isUsableIp(ip)) return { key: `ip:${String(ip).trim()}`, basis: 'ip' };

  const parts = [
    String(rec.ua || rec.userAgent || rec.user_agent || '').trim(),
    String(rec.referrer || rec.referrerUrl || '').trim(),
    String(rec. || '').trim(),
    String(rec.source || '').trim(),
  ].filter(Boolean);

  if (!parts.length) return { key: '', basis: 'none' };
  return { key: `fp:${parts.join('|')}`, basis: 'composite' };
}

/**
 * 汇总一组记录的口径分布。
 *
 * @param {Array<object>} records
 * @returns {{ total:number, user:number, system:number, unknown:number, systemRatio:string }}
 */
 summarizeProvenance(records) {
  const arr = Array.isArray(records) ? records : [];
  const out = { total: arr.length, user: 0, system: 0, unknown: 0 };
  for (const r of arr) {
    const k = classifyTraffic(r);
    out[k] = (out[k] || 0) + 1;
  }
  out.systemRatio = out.total ? ((out.system / out.total) * 100).toFixed(1) + '%' : '0.0%';
  return out;
}

module.exports = {
  classifyTraffic,
  isUsableIp,
  isTestNetIp,
  visitorFingerprint,
  summarizeProvenance,
  looksLikeScriptUa,
  SYSTEM_IP_MARKERS,
  SYSTEM_SOURCE_MARKERS,
  TEST_NET_PREFIXES,
};
