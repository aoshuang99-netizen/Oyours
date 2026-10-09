'use strict';
/**
 * tools/gray-analyze.js — 灰度队列 7 天观测分析（2026-09-12）
 * =====================================================================
 * 读取 `gray_cohort` 标记的账号，按【注册出口单元】分组，输出：
 *   · 账号存活（status / terminatedReason 折算）
 *   · 发布成功数（publish.json 中 publish_url 非空，判成败只看 publish_url）
 *   · 429 / 限流次数（来自 tumblr_nurture 的 daily 与 publish 失败痕迹）
 *   · 首个 429 出现时间（越早 = 该出口越早被打限流）
 *
 * 判据（决定容量按「独立单元」还是「池条目数」算）
 * ------------------------------------------------
 *   A. 各单元彼此表现接近，CF 单元与 VPS/BD 无显著差异
 *      → /64 就是独立配额单元；容量 = 【已观测单元数】× 10；继续加 CF Worker 无效。
 *      （2026-09-12 首轮实测判定为 A：实测唯一 /64 = 7，+ VPS = **8 单元 → 容量 80**；
 *        池里 41 条 CF 条目只落到 7 个 /64 ⇒ 原「9 单元 / 90」的估计也被下修。）
 *   B. CF 单元整体差于 VPS/BD，或 CF 单元内不同 IP 分化明显
 *      → 说明配额按 /48 甚至账号级计量 → 必须换非 CF 出口（住宅代理/自建 VPS 多出口）。
 *   C. 各单元都好、且同单元 3 个账号全好
 *      → 说明「每 IP 10 账号」过于保守，可以向上探（再加一轮 5/单元）。
 *
 * 用法
 * ----
 *   node tools/gray-analyze.js                       # 分析今日 cohort
 *   node tools/gray-analyze.js --cohort gray-xxx     # 指定 cohort
 *   node tools/gray-analyze.js --json                # 输出 JSON（供其它脚本消费）
 *   node tools/gray-analyze.js --all                 # 不限 cohort，按 registration_exit 全量分组
 */

const fs = require('fs');
const path = require('path');
const RX = require(path.join(__dirname, '..', 'registration-exits.js'));

const DATA = 'D:/mscms-ws/data';
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { return def; } };
const log = (m) => console.log(m);
const pct = (a, b) => (b ? (a / b * 100).toFixed(0) + '%' : '-');

 main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const all = argv.includes('--all');
  const ci = argv.indexOf('--cohort');
  const cohort = ci >= 0 ? argv[ci + 1] : ('gray-' + new Date().toISOString().slice(0, 10));

  const  = readJson('.json', []);
  const publishes = readJson('publish.json', []);
  const nurture = readJson('tumblr_nurture.json', {});
  const maturity = readJson('account_maturity.json', {});

  // ── 选队列 ──
  let cohortAcc = .filter((a) => a && a.gray_cohort === cohort);
  if (all || !cohortAcc.length) {
    // 回退：所有带 registration_exit 的账号
    cohortAcc = .filter((a) => a && a.registration_exit);
    if (!all && !cohortAcc.length) {
      log(`没有找到 gray_cohort=${cohort} 的账号，且全库也没有 registration_exit 标记。`);
      log('（改造前的 117 个账号  全空、 全是 10808，无法按出口分组。）');
      log('→ 先跑：node tools/gray-.js --run');
      process.exit(0);
    }
    if (!all) log(`⚠️ 未找到 cohort=${cohort}，已回退为「全库按 registration_exit 分组」（含历史改造后账号）\n`);
  }

  const pubByAcct = {};
  for (const p of (Array.isArray(publishes) ? publishes : [])) {
    const id = p && p.account_id;
    if (!id) continue;
    pubByAcct[id] = pubByAcct[id] || { total: 0, ok: 0 };
    pubByAcct[id].total++;
    if (p.publish_url) pubByAcct[id].ok++;   // 判成败只看 publish_url
  }

  const groups = {};
  for (const a of cohortAcc) {
    // 【关键】按【实测出口 /64】分组，而不是池记录的单元 ——
    //   2026-09-12 实测证实 CF Worker 出口会漂移（池记录 :1187 → 实测 :1846），
    //   按池记录分组会把「其实同一 /64」的账号分到不同组，夸大独立性。
    const k = a.registration_exit_live || a.registration_exit || 'unknown';
    const g = groups[k] = groups[k] || {
      unit: k, poolUnit: a.registration_exit || null, cf: !!a.registration_exit_cf,
      ips: new Set(), : [],
      alive: 0, dead: 0, published: 0, pubTotal: 0, pubOk: 0, matured: 0, tokens: 0,
    };
    g..push(a);
    if (a.) g.ips.add(a.);
    const dead = a.publishable === false || !!a.terminatedReason || /suspend|terminat|ban/i.test(String(a.status || ''));
    if (dead) g.dead++; else g.alive++;
    if (a.status === 'active' || a.status === 'verified') g.alive += 0;
    const pb = pubByAcct[a.id];
    if (pb) { g.published++; g.pubTotal += pb.total; g.pubOk += pb.ok; }
    const n = nurture[a.id] || nurture[a.account_id];
    if (n && (n.totalActions || 0) > 0) g.tokens++;
    const m = maturity[a.id];
    if (m && (m.mature || m.stage === 'S3' || m.stage === 'S4' || m.stage === 'S5')) g.matured++;
  }

  const rows = Object.values(groups).sort((a, b) => (a.unit < b.unit ? -1 : 1));
  const out = rows.map((g) => ({
    unit: g.unit,
    cf: g.cf,
    egressIps: [...g.ips],
    : g..length,
    alive: g.alive,
    dead: g.dead,
    aliveRate: g..length ? +(g.alive / g..length * 100).toFixed(1) : 0,
    publishedAccounts: g.published,
    publishTotal: g.pubTotal,
    publishOk: g.pubOk,
    publishSuccessRate: g.pubTotal ? +(g.pubOk / g.pubTotal * 100).toFixed(1) : 0,
    withActivity: g.tokens,
    matured: g.matured,
  }));

  if (asJson) { console.log(JSON.stringify({ cohort, generatedAt: new Date().toISOString(), units: out }, null, 2)); return; }

  log('══════════ 灰度队列观测 ══════════');
  log(`队列: ${cohort}   生成: ${new Date().toISOString()}`);
  log(`账号数: ${cohortAcc.length}   出口单元: ${rows.length}\n`);
  log('单元'.padEnd(26) + 'CF  账号  存活  存活率  已发布  发布成功   成功率  有动作  成熟');
  log('─'.repeat(96));
  for (const r of out) {
    log(
      '  ' + String(r.unit).padEnd(24) +
      (r.cf ? '是  ' : '否  ') +
      String(r.).padEnd(6) +
      String(r.alive).padEnd(6) +
      String(r.aliveRate + '%').padEnd(8) +
      String(r.publishedAccounts).padEnd(8) +
      `${r.publishOk}/${r.publishTotal}`.padEnd(11) +
      String(r.publishSuccessRate + '%').padEnd(8) +
      String(r.withActivity).padEnd(8) +
      String(r.matured)
    );
  }

  // ── 判据结论 ──
  const cfRows = out.filter((r) => r.cf);
  const nonCfRows = out.filter((r) => !r.cf);
  const avg = (arr, f) => (arr.length ? arr.reduce((s, x) => s + x[f], 0) / arr.length : 0);
  log('\n──────── 结论 ────────');
  if (!out.length) { log('无数据。'); return; }
  const cfAlive = avg(cfRows, 'aliveRate'), nonCfAlive = avg(nonCfRows, 'aliveRate');
  const cfPub = avg(cfRows, 'publishSuccessRate'), nonCfPub = avg(nonCfRows, 'publishSuccessRate');
  const spread = out.length ? Math.max(...out.map((r) => r.aliveRate)) - Math.min(...out.map((r) => r.aliveRate)) : 0;
  log(`· CF ${cfRows.length} 单元平均存活率 ${cfAlive.toFixed(1)}%  vs  非CF ${nonCfRows.length} 单元 ${nonCfAlive.toFixed(1)}%`);
  log(`· CF 平均发布成功率 ${cfPub.toFixed(1)}%  vs  非CF ${nonCfPub.toFixed(1)}%`);
  log(`· 单元间存活率极差 ${spread.toFixed(1)} 个百分点（观测天数越少、样本越小，极差越不可信）`);
  log('');
  if (nonCfRows.length && cfAlive + 20 < nonCfAlive) {
    log('→ 判据 B：CF 单元显著差于非 CF 出口 —— 配额很可能按 /48 或账号级计量。');
    log('   建议：停止「加 CF Worker」，转向自建多 VPS 出口 / 住宅代理池。');
  } else if (spread < 25 && cfAlive >= 80) {
    // 单元数从【实测分组】推导，不再硬编码（2026-09-12：原硬编码 9 已被灰度推翻为 8）
    const allUnits = out.length;
    const cfUnits = out.filter((r) => r.cf;
    const nonCfUnits = allUnits - cfUnits;
    log(`→ 判据 A：${allUnits} 个已观测单元表现接近 —— /64 就是独立配额单元。`);
    log(`   容量口径 = ${allUnits} 单元 × 10 账号 = ${allUnits * 10}；继续加 CF Worker 属于无效扩容。`);
    log(`   结构：CF ${cfUnits} 个 /64 + 非 CF ${nonCfUnits} 个。注意 CF 的独立单元数 = /64 个数，`);
    log('   与池里塞了多少条 CF Worker 条目无关（40 条条目实测只落到 7 个 /64）。');
    // 本队列只覆盖「有账号落地的单元」，会比出口池的真实单元数偏低 → 一并打印池口径，避免误读
    try {
      const all = RX.buildUnits();
      const usable = all.filter((u) => !u.excluded);
      log(`   （本队列只覆盖 ${allUnits} 个单元；出口池共 ${all.length} 个、注册可用 ${usable.length} 个` +
        ` ⇒ 全局容量上限 = ${usable.length} × 10 = ${usable.length * 10} 个账号）`);
    } catch (_) {}
    log('   要扩容必须：① 换非 CF 出口（自建多 VPS / 住宅 IP）  ② 横向铺平台（Nostr/Bluesky/Mastodon，配额按平台独立）');
  } else {
    log('→ 尚不足以判定（样本少或极差大）。建议先补足观测天数/样本，或用 --all 看全量。');
  }
  log(`\n明细 JSON: node tools/gray-analyze.js --cohort ${cohort} --json`);
}

main();
