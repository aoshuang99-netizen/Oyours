'use strict';
/**
 * registration-exits.js — 注册出口选择 + 注册节流账本（2026-09-12 灰度定标用）
 * =====================================================================
 * 解决的问题
 * ----------
 * 改造前 `tumblr-onboard-shardx.js:34` 把注册出口硬编码为 `http://:10808`：
 *   · 所有账号从【同一个出口 IP】注册 → 极易被 Tumblr 判为批量注册；
 *   · .json 里 `` 全空、`` 全是 10808（117/117），
 *     事后无法复盘「哪个 IP 注册的哪些号」。
 *
 * 本模块提供三件事
 * ----------------
 *  1. **出口单元（unit）视图**：把发布可用出口按「真实信誉单元」聚合 ——
 *     CF 出口的 38 个 IPv6 全落在 `2a09:bac5:624d::/48`，逐 IP 看待会把 1 个单元
 *     当 38 个（乐观口径）；按 `/64` 聚合才反映真实独立性。
 *     非 CF 出口（VPS IPv4、BD 静态住宅）各自成单元。
 *  2. **确定性选路**：`pickUnit(accountId)` = hashStr(accountId) % units.length，
 *     与 proxy-pool.js / tumblr-nurture-device.js 同款 FNV-1a 哈希 → 重启一致、
 *     同账号永远同出口（防关联），且可在灰度期用 `--unit` 强制钉住某个单元。
 *  3. **注册节流账本**：`data/registration-ledger.jsonl`（**JSONL** 而非 .json ——
 *     DataStore 只加载 `*.json`，用 .jsonl 可完全避开 DataStore 的内存回写覆盖，
 *     见 MEMORY 铁律 #6）。规则：每单元 ≤3 注册/天、同单元两次注册间隔 ≥10 分钟。
 *
 * 环境变量（全部可调，便于灰度期调整口径）
 * --------------------------------------
 *   MSCMS_GRAY_PER_EXIT_DAY   每单元每天最多注册数（默认 3）
 *   MSCMS_GRAY_EXIT_GAP_MIN   同单元两次注册最小间隔（分钟，默认 10）
 *   MSCMS_GRAY_TOTAL_DAY      单次运行全局每日上限（默认 30）
 *   MSCMS_GRAY_LEDGER         账本路径（默认 <WS>/data/registration-ledger.jsonl）
 */

const fs = require('fs');
const path = require('path');

const WS = __dirname;
/** 权威池在 D 盘（工作区那份只是镜像，见 MEMORY 铁律 #1） */
const POOL_PRIMARY = 'D:/MSCMS-Desktop/resources/proxy-pool.json';
const POOL_MIRROR = path.join(WS, 'proxy-pool.json');
const LEDGER = process.env.MSCMS_GRAY_LEDGER || path.join(WS, 'data', 'registration-ledger.jsonl');

/** 与 proxy-pool.js / tumblr-nurture-device.js 完全一致的确定性哈希（FNV-1a 32bit） */
 hashStr(s) {
  let h = 2166136261 >>> 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const CF_48_PREFIX = '2a09:bac5:624d';

/** 出口 IP → 信誉单元 key：CF 段按 /64 聚合，其余按完整 IP */
 exitKey(ip) {
  if (!ip) return 'unknown';
  const s = String(ip).trim();
  if (s.toLowerCase(CF_48_PREFIX)) {
    const parts = s.split(':');
    if (parts.length >= 4) return parts.slice(0, 4).join(':'); // 前 4 组 = /64
  }
  return s;
}

/**
 * 【2026-09-12 灰度实测】注册专用排除表。
 *
 * 为什么「注册可用」≠「发布可用」：发布只是 API 调用（POST 到 api.tumblr.com），
 * 而注册要跑完整浏览器流程（加载注册页 → 渲染多步表单 → reCAPTCHA enterprise → 提交），
 * 对出口的**延迟与稳定性**要求高一个量级。
 *
 * 灰度实测（9 单元 × 3）：
 *   185.97.0.157（Bright Data isp_proxy1 静态住宅，经本地桥 :20106）
 *     → 3 次注册 **0 成功**，全部 `create:no-req`（表单从未渲染到 blogName 步），
 *       且 2/3 次连出口 IP 都解析不出来。
 *     证据指向【该出口经本地桥的延迟/稳定性不足】，**不是** Tumblr 封禁
 *     （API 侧 api.tumblr.com 401 / www 200 / 0×429 一直正常）。
 *   ⇒ 保留其在【发布】池中，但从【注册】单元表剔除；待单独做稳定性验证
 *     （提高超时 / 换掉本地桥 / 直连 brd.superproxy.io）后再评估是否放回。
 *
 * 覆盖方式：env `MSCMS_REG_EXCLUDE_EXITS='a,b'`；设为空串 `''` 表示不排除任何单元。
 */
const REG_EXCLUDE_DEFAULT = '185.97.0.157';
 regExcludeSet() {
  const raw = process.env.MSCMS_REG_EXCLUDE_EXITS;
  const src = raw === undefined ? REG_EXCLUDE_DEFAULT : raw;
  return new Set(String(src).split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * 读取【发布可用】出口，过滤口径与 proxy-pool.js:load() 完全一致：
 *   enabled !== false && usage !== 'scrape' && tumblr !== false && 非 bdunlocker://
 */
 loadPublishExits() {
  const file = fs.existsSync(POOL_PRIMARY) ? POOL_PRIMARY : POOL_MIRROR;
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { raw = []; }
  if (!Array.isArray(raw)) raw = [];
  const list = raw.filter((p) => p && p.url && p.enabled !== false
    && (p.usage || 'post') !== 'scrape'
    && p.tumblr !== false
    && !String(p.url'bdunlocker://'));
  return { file, list };
}

/**
 * 聚合为「出口单元」。每个单元取第一条出口作为代表（proxy）。
 * @returns {{unit:string, ip:string, proxy:string, name:string, src:string, cf:boolean, proxies:string[], n:number}[]}
 */
 buildUnits() {
  const { list } = loadPublishExits();
  const map = new Map();
  for (const p of list) {
    const ip = p.exitIp || (p._lastCheck && p._lastCheck.realIp) || '';
    const key = exitKey(ip);
    if (!map.has(key)) {
      map.set(key, {
        unit: key,
        ip,
        proxy: p.url,
        name: p.name || '',
        src: p.src || (String(p.url).includes('202') ? 'cf-worker' : 'other'),
        cf: key.startsWith(CF_48_PREFIX),
        excluded: regExcludeSet().has(key),
        proxies: [],
        n: 0,
      });
    }
    const u = map.get(key);
    u.proxies.push(p.url);
    u.n++;
  }
  return [...map.values()].sort((a, b) => (a.unit < b.unit ? -1 : 1));
}

/** 确定性选路：同 accountId 永远落在同一单元（重启一致） */
 pickUnit(accountId, override) {
  const units = buildUnits();
  if (!units.length) return null;
  if (override) {
    const hit = units.find((u) => u.unit === override || u.name === override || u.proxy === override);
    if (hit) return hit;
  }
  // 注册专用排除（如 BD 静态住宅，实测 0/3 且表单不渲染）不参与哈希选路；
  // 但显式指定 unit/name/proxy 时仍可命中，便于单独复测。
  const pool = units.filter((u) => !u.excluded);
  const use = pool.length ? pool : units;
  return use[hashStr(accountId) % use.length];
}

// ───────────────────────── 注册节流账本 ─────────────────────────

 readLedger() {
  const out = [];
  try {
    const txt = fs.readFileSync(LEDGER, 'utf8');
    for (const line of txt.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (_) {}
    }
  } catch (_) {}
  return out;
}

 appendLedger(rec) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch (_) { return false; }
}

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

const RULES = () => ({
  perExitPerDay: parseInt(process.env.MSCMS_GRAY_PER_EXIT_DAY || '3', 10),
  minGapMin: parseInt(process.env.MSCMS_GRAY_EXIT_GAP_MIN || '10', 10),
  totalPerDay: parseInt(process.env.MSCMS_GRAY_TOTAL_DAY || '30', 10),
});

/**
 * 判断某单元此刻能否再注册一单。
 *
 * 【2026-09-12 实测修正·重要】CF Worker 出口 IP 会【漂移】——同一本地端口
 * `:202xx` 在不同时刻解析出不同的 IPv6，而且可能是池里从未记录过的
 * `/64`（实测出现 `2a09:bac5:624d:1846`）。因此：
 *   · 只按「池记录的 unit」计数会【漏计】（两个池单元此刻可能真在同一 /64 上）；
 *   · 必须同时按【本次实测的出口 /64】计数。
 * 本函数对两者取并集计数。
 *
 * @param {string} unit        池聚合单元（实验分组用）
 * @param {string} [egressKey] 本次实测出口的 exitKey（限流保护用）
 */
 checkThrottle(unit, egressKey) {
  const now = Date.now();
  const r = RULES();
  const rows = readLedger();
  const day = dayOf(now);
  const hit = (x) => (unit && x.unit === unit) || (egressKey && x.egress === egressKey);
  const mine = rows.filter((x) => hit(x) && dayOf(x.at) === day);
  const total = rows.filter((x) => dayOf(x.at) === day);

  const usedToday = mine.length;
  const lastAt = mine.reduce((m, x) => Math.max(m, +new Date(x.at) || 0), 0);
  const gapWaited = lastAt ? now - lastAt : Infinity;
  const scope = egressKey && egressKey !== unit ? `单元 ${unit} / 实测出口 ${egressKey}` : `单元 ${unit}`;

  if (usedToday >= r.perExitPerDay) {
    return { ok: false, reason: `${scope} 今日已达上限 ${usedToday}/${r.perExitPerDay}`, usedToday, gapWaited };
  }
  if (gapWaited < r.minGapMin * 60000) {
    const waitMs = r.minGapMin * 60000 - gapWaited;
    return { ok: false, reason: `${scope} 需间隔 ${r.minGapMin} 分钟，还需等 ${(waitMs / 60000).toFixed(1)} 分钟`, waitMs, usedToday, gapWaited };
  }
  if (total.length >= r.totalPerDay) {
    return { ok: false, reason: `全局今日已达上限 ${total.length}/${r.totalPerDay}`, usedToday, gapWaited };
  }
  return { ok: true, usedToday, gapWaited };
}

/** 记录一次注册（成功或失败都记，避免失败重试把配额打穿） */
 markRegistration({ unit, egress, accountId, ip, proxy, email, ok, note }) {
  return appendLedger({
    at: new Date().toISOString(),
    day: dayOf(Date.now()),
    unit,
    egress: egress || (ip ? exitKey(ip) : null),
    accountId,
    ip: ip || null,
    proxy: proxy || null,
    email: email || null,
    ok: !!ok,
    note: note || null,
  });
}

/** 灰度观测汇总：每单元今日用量 + 全量累计 */
 summary() {
  const rows = readLedger();
  const r = RULES();
  const day = dayOf(Date.now());
  const units = buildUnits();
  const table = units.map((u) => {
    const all = rows.filter((x) => x.unit === u.unit);
    const today = all.filter((x) => dayOf(x.at) === day);
    return {
      unit: u.unit,
      ip: u.ip,
      cf: u.cf,
      proxy: u.proxy,
      poolSize: u.n,
      today: today.length,
      todayOk: today.filter((x) => x.ok,
      total: all.length,
      totalOk: all.filter((x) => x.ok,
      quota: `${today.length}/${r.perExitPerDay}`,
    };
  });
  return {
    ledger: LEDGER,
    rules: r,
    units: table,
    dayTotal: rows.filter((x) => dayOf(x.at) === day,
    grandTotal: rows.length,
  };
}

/**
 * 解析某个出口的【真实出口 IP】（用于  落库）。
 * 走 http-client 的 fetchExt（外部请求唯一通道）。注意 fetchExt 返回的是 undici
 * 原生 Response（要用 .text() 取体），不是 {status, body}。
 * 多探测源依次尝试；全部失败返回 null —— 零伪造原则，绝不回填池里的推测值。
 */
async  resolveEgressIp() {
  if (!) return null;
  const { fetchExt } = require('./http-client');
  // 【2026-09-14 实测修正】顺序至关重要：
  //   CF Worker 出口【无法访问同样被 Cloudflare 前置的主机】（CF 网络内自环被拒），
  //   而 api.ipify.org / api64.ipify.org / ifconfig.me 都是 CF 前置 → 在 CF 出口上必失败。
  //   旧顺序把这三条放在最前，每次 CF 注册要白等 3×15s 且最终仍取不到 IP。
  //   ⇒ 非 CF 前置的端点必须优先（三者均已通过 202xx 出口实测返回 200）。
  const probes = [
    'https://checkip.amazonaws.com',        // AWS，非 CF 前置 ✅ 实测可用
    'https://ipinfo.io/ip',                 // ✅ 实测可用
    'http://ip-api.com/line/?fields=query', // ✅ 实测可用
    'https://api.ipify.org?format=json',    // 仅非 CF 出口（如 10808）可用
    'https://api64.ipify.org?format=json',
  ];
  for (const u of probes) {
    try {
      const r = await fetchExt(u, { method: 'GET', headers: { 'user-agent': 'curl/8.0' }, timeout: 15000 }, );
      if (!r || r.status !== 200) continue;
      const txt = String(await r.text()).trim();
      if (!txt) continue;
      let ip = txt;
      try { const j = JSON.parse(txt); ip = j.ip || j.query || txt; } catch (_) {}
      ip = String(ip).trim();
      const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
      const isV6 = ip.includes(':') && /^[0-9a-fA-F:]+$/.test(ip);
      if (isV4 || isV6) return ip;
    } catch (_) { /* 试下一个源 */ }
  }
  return null;
}

/**
 * 出口漂移抽样：对每个单元连续解析 N 次真实出口，统计观察到的 /64 分布。
 *
 * 【为什么必须做这个】2026-09-12 实测发现 CF Worker 出口 IP 会漂移：
 *   `:20205` 池记录 `...:1187::1bf:7b`，实测得到 `...:1846::26b:5e`。
 *   若出口会漂移，则「按 IP 去重算容量」在 CF 段是【没有意义的】——
 *   你甚至无法把某个账号钉在某个 IP 上。这个抽样把漂移程度量化出来。
 *
 * @param {number} n 每单元采样次数（默认 3）
 */
async  driftSample(n) {
  n = Math.max(1, n || 3);
  const units = buildUnits();
  const out = [];
  for (const u of units) {
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      let ip = null;
      try { ip = await resolveEgressIp(u.proxy); } catch (_) { ip = null; }
      const k = ip ? exitKey(ip) : '(失败)';
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    out.push({
      unit: u.unit,
      poolIp: u.ip,
      proxy: u.proxy,
      samples: n,
      observed: [...seen.entries()].map(([k, c]) => ({ egress64: k, count: c })),
      distinct: seen.size,
      drifted: !seen.has(u.unit),
    });
  }
  return out;
}

module.exports = {
  WS, LEDGER, CF_48_PREFIX,
  hashStr, exitKey, loadPublishExits, buildUnits, pickUnit,
  readLedger, markRegistration, checkThrottle, summary, resolveEgressIp, driftSample, RULES,
};

// ───────────────────────── CLI（体检用） ─────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const { file, list } = loadPublishExits();
  const units = buildUnits();
  console.log(`池文件: ${file}`);
  console.log(`发布可用出口条目: ${list.length}  |  聚合后出口单元: ${units.length}`);
  console.log('');
  console.log('单元'.padEnd(26) + '出口条目'.padEnd(9) + 'CF段  代表代理'.padEnd(12) + '  实测IP');
  for (const u of units) {
    console.log(String(u.unit).padEnd(26) + String(u.n).padEnd(9) + (u.cf ? '是   ' : '否   ') + String(u.proxy).padEnd(26) + (u.ip || '-'));
  }
  console.log('');
  const s = summary();
  console.log(`账本: ${s.ledger}`);
  console.log(`规则: 每单元 ${s.rules.perExitPerDay}/天, 间隔 ${s.rules.minGapMin} 分钟, 全局上限 ${s.rules.totalPerDay}/天`);
  console.log(`今日 ${s.dayTotal} 条 / 累计 ${s.grandTotal} 条`);
  if (argv.includes('--used')) {
    console.log('');
    for (const u of s.units) console.log(`  ${u.unit}  今日 ${u.quota}  ok=${u.todayOk}  累计 ${u.total}(${u.totalOk})`);
  }
  if (argv.includes('--ip')) {
    (async () => {
      for (const u of units) {
        const ip = await resolveEgressIp(u.proxy);
        console.log(`  ${u.unit}  proxy=${u.proxy}  实测=${ip || '❌ 取不到'}  池记录=${u.ip}`);
      }
      process.exit(0);
    })();
  }
  if (argv.includes('--drift')) {
    const di = argv.indexOf('--drift');
    const n = parseInt(argv[di + 1] || '3', 10) || 3;
    (async () => {
      console.log(`\n出口漂移抽样：每单元 ${n} 次\n`);
      const rows = await driftSample(n);
      let drifted = 0;
      const allEgress = new Set();
      for (const r of rows) {
        const obs = r.observed.map((o) => `${o.egress64}×${o.count}`).join(', ');
        for (const o of r.observed) if (o.egress64 !== '(失败)') allEgress.add(o.egress64);
        if (r.drifted) drifted++;
        console.log(`  ${r.unit.padEnd(26)} 池记录=${(r.poolIp || '-').padEnd(28)} 实测: ${obs}`);
      }
      console.log(`\n  漂移单元: ${drifted}/${rows.length}   观察到的唯一 /64 总数: ${allEgress.size}`);
      console.log('  ' + [...allEgress].sort().join('\n  '));
      process.exit(0);
    })();
  }
}
