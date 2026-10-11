#!/usr/bin/env node
'use strict';
/**
 * kk20-plan-gen.js — KKMatch 20 账号投放排期骨架生成器（确定性，可复算）
 *
 * 目的：把「每天 40 帖、主题各不同」从口号变成**可验证的数学**。
 *   · 不许重复 → 用互质步长遍历 12 锚点 / 7 体裁，保证在 LCM 周期内组合不重复
 *   · 不许撞车 → 每账号固定自己的一早一晚时刻（错峰 5 分钟）
 *
 * 矩阵：6 栏目 × 12 功能锚点 × 7 体裁 = 504 组合
 *   锚点步长 7 mod 12（与 12 互质）⇒ 12 槽一轮不重复
 *   体裁步长 3 mod 7 （与 7 互质）⇒  7 槽一轮不重复
 *   二者联合周期 = lcm(12,7) = 84 槽 ⇒ 前 84 槽内 (锚点,体裁) 组合必然互不相同
 *   （84 槽 = 2.1 天；叠加栏目维度后完整空间 504 组合 ≈ 12.6 天）
 *
 * 用法：
 *   node tools/kk20-plan-gen.js              # 打印 Day1 排期 + 7 天分布统计
 *   node tools/kk20-plan-gen.js --json       # 输出完整 7 天排期 JSON
 *   node tools/kk20-plan-gen.js --check      # 仅跑唯一性断言（退出码非 0 即失败）
 */
const fs = require('fs');
const path = require('path');

const CATEGORIES = [
  { key: '话题性',   en: 'provocative',  quota: 8, style: 'editorial-minimal' },
  { key: '趣味性',   en: 'fun',          quota: 8, style: 'soft-gradient-ribbon' },
  { key: '科技潮流', en: 'tech-trends',  quota: 6, style: 'dark-data-viz' },
  { key: '人文',     en: 'humanities',   quota: 6, style: 'watercolor-humanities' },
  { key: '笑话',     en: 'humor',        quota: 6, style: 'flat-cartoon' },
  { key: '最新段子', en: 'memes',        quota: 6, style: 'meme-split' },
];

// ── 语言策略（2026-09-22 用户确认）────────────────────────────────────
// 发布物一律英文：Tumblr 主受众为英文，且英文标签池（#INFJ / #datingadvice）
// 才有真实流量；存量内容池亦为英文。
// CATEGORIES[].key 保留中文仅作**内部聚合标识**（combo_key / 断言口径），
// 不进入任何发布物；对外显示一律用 category_en。
const ANCHORS = [
  'A1 KKOS 11-dimension human model (one chat / <5min)',
  'A2 OMi matching engine (matches on model, not labels)',
  'A3 Personality Profile (MIND·CAPSULE)',
  'A4 Relationship Memory (TGN·TEMPORAL)',
  'A5 Causal Insight (NOTEARS++·CAUSAL)',
  'A6 Mutual Matching (DYADIC·ATTENTION)',
  'A7 Relationship Forecast (DSM·SURVIVAL)',
  'A8 OMi Chemistry Lab (real-conversation microscope)',
  'A9 4 Life Dimensions (social/career/health/finance × 9yr)',
  'A10 Explainability (11/11 with evidence · 0-1 prob · ±CI)',
  'A11 Enterprise validation (HUST / Allen Institute for AI / Merriam-Webster)',
  'A12 Free 7-day trial / no credit card',
];

// 体裁英文（对外显示）；并存一份中文供内部阅读
const GENRES = ['question', 'listicle', 'contrast', 'story', 'data', 'self-deprecating', 'dialogue'];
const GENRES_ZH = ['提问式', '清单式', '对比式', '故事式', '数据式', '自嘲式', '对话式'];

// CTA 必须短——它要压在配图底部一行（可用宽 ≈0.86×图宽）
const CTAS = [
  'Build your 11-D model in 5 min',
  'Free 7 days · no card',
  'Beta is open',
  'See your 11 dimensions',
];

const DAYS = 7;

function buildSchedule() {
  // 栏目序列：按 quota 展开成 40 槽的固定序（交错排布，避免同类扎堆）
  const catSeq = [];
  const buckets = CATEGORIES.map((c) => Array.from({ length: c.quota }, () => c));
  let round = 0;
  while (catSeq.length < 40) {
    for (const b of buckets) if (b[round]) catSeq.push(b[round]);
    round++;
  }

  // ── 组合游走（v2，2026-09-22 修正）──────────────────────────────────────
  // ❌ v1 缺陷（实测暴露）：anchor=(k*7)%12、genre=(k*3)%7 的联合周期是
  //    lcm(12,7)=84 槽 —— 7 天 280 槽里只有 **84 个唯一组合**（去重率仅 30%），
  //    第 3 天就开始复读第 1 天的主题。这直接违背「每一篇主题不同」的硬要求。
  // ✅ v2：每个栏目在自己 12×7=84 的组合空间里按**与 84 互质的步长 5** 游走。
  //    · 84 = 2²×3×7，gcd(5,84)=1 ⇒ 连续 84 次抽样必不重复
  //    · 单栏目 7 天最多抽 8×7=56 次 < 84 ⇒ 全局 280 槽必然两两不同
  //    · 各栏目起点错开（c*13 mod 84），避免不同栏目走出同一条轨迹
  const STRIDE = 5;
  const SPACE = 12 * 7;                       // 84
  const cursor = CATEGORIES.map((_, ci) => (ci * 13) % SPACE);

  const days = [];
  for (let d = 0; d < DAYS; d++) {
    const slots = [];
    for (let i = 0; i < 40; i++) {
      const cat = catSeq[i];
      const ci = CATEGORIES.findIndex((c) => c.key === cat.key);
      const j = cursor[ci] % SPACE;
      cursor[ci] = (cursor[ci] + STRIDE) % SPACE;

      const anchorIdx = j % 12;
      const genreIdx = Math.floor(j / 12) % 7;

      const accountSeq = i % 20;                // 账号 0..19
      const isMorning = i < 20;
      const slotInWindow = i % 20;
      slots.push({
        slot: i + 1,
        global: d * 40 + i + 1,
        window: isMorning ? '早' : '晚',
        account_seq: accountSeq,
        // 账号 i：早 08:00 + i×5min / 晚 20:00 + i×5min ⇒ 窗口 08:00–09:40、20:00–21:40
        time: (isMorning ? '08:00' : '20:00'),
        offset_min: slotInWindow * 5,
        category: cat.key,
        category_en: cat.en,
        image_style: cat.style,
        anchor: ANCHORS[anchorIdx],
        anchor_idx: anchorIdx + 1,
        genre: GENRES[genreIdx],
        genre_zh: GENRES_ZH[genreIdx],
        cta: CTAS[(d * 40 + i) % 4],
        combo_key: `${cat.key}|A${anchorIdx + 1}|${GENRES[genreIdx]}`,
      });
    }
    days.push({ day: d + 1, slots });
  }
  return days;
}

/** 唯一性断言（可证伪：任一断言失败即以非 0 退出码暴露） */
function check(days) {
  const fails = [];
  const all = days.flatMap((d) => d.slots);

  // 1) 【核心硬要求】全部 280 槽的 (栏目,锚点,体裁) 三元组必须两两不同
  //    —— 用户要求「每一篇内容的主题要不同」；v1 在此断言下失败（仅 84 唯一）
  const keys = all.map((s) => s.combo_key);
  const dupAll = keys.length - new Set(keys).size;
  if (dupAll !== 0) fails.push(`全 7 天 ${keys.length} 槽出现 ${dupAll} 次主题重复（应为 0）`);

  // 2) 单日内组合不得重复
  for (const d of days) {
    const ks = d.slots.map((s) => s.combo_key);
    const dup = ks.length - new Set(ks).size;
    if (dup !== 0) fails.push(`Day${d.day} 日内组合重复 ${dup} 次`);
  }

  // 3) 每日 40 槽、账号各 2 次（一早一晚）
  for (const d of days) {
    if (d.slots.length !== 40) fails.push(`Day${d.day} 槽数 ${d.slots.length} ≠ 40`);
    const byAcc = {};
    for (const s of d.slots) {
      byAcc[s.account_seq] = byAcc[s.account_seq] || { 早: 0, 晚: 0 };
      byAcc[s.account_seq][s.window]++;
    }
    if (Object.keys(byAcc).length !== 20) fails.push(`Day${d.day} 参与账号数 ${Object.keys(byAcc).length} ≠ 20`);
    for (const [a, c] of Object.entries(byAcc)) {
      if (c.早 !== 1 || c.晚 !== 1) fails.push(`Day${d.day} 账号#${a} 早${c.早}/晚${c.晚} ≠ 1/1`);
    }
  }

  // 4) 栏目配比等于配额
  for (const d of days) {
    const tally = {};
    d.slots.forEach((s) => { tally[s.category] = (tally[s.category] || 0) + 1; });
    for (const c of CATEGORIES) {
      if (tally[c.key] !== c.quota) fails.push(`Day${d.day} 栏目「${c.key}」${tally[c.key]} ≠ ${c.quota}`);
    }
  }

  // 5) 7 天窗口内锚点/体裁必须全覆盖（逐日全覆盖与全局唯一性不可兼得，故按窗口断言）
  const aAll = new Set(all.map((s) => s.anchor_idx));
  const gAll = new Set(all.map((s) => s.genre));
  if (aAll.size !== 12) fails.push(`7 天锚点覆盖 ${aAll.size}/12`);
  if (gAll.size !== 7) fails.push(`7 天体裁覆盖 ${gAll.size}/7`);

  // 6) 每个栏目的主题必须「高频不重样」：单栏目 7 天抽 8×7=56 次，组合空间 84 ⇒ 唯一率应为 100%
  for (const c of CATEGORIES) {
    const ks = all.filter((s) => s.category === c.key).map((s) => `${s.anchor_idx}|${s.genre}`);
    if (new Set(ks).size !== ks.length) {
      fails.push(`栏目「${c.key}」存在 ${ks.length - new Set(ks).size} 次组合重复（空间 84，抽样 ${ks.length}）`);
    }
  }

  return fails;
}

function main() {
  const days = buildSchedule();
  const fails = check(days);

  if (process.argv.includes('--check')) {
    if (fails.length) { console.error('❌ 断言失败：\n  - ' + fails.join('\n  - ')); process.exit(1); }
    console.log('✅ 全部唯一性/配额/节律断言通过（7 天 / 280 槽）');
    return;
  }

  if (process.argv.includes('--json')) {
    const out = path.join(__dirname, '..', 'reports', 'kk20-schedule-7d.json');
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), days }, null, 1));
    console.log('已写出 ' + out);
    return;
  }

  console.log('=== 唯一性/配额/节律断言 ===');
  console.log(fails.length ? '❌ ' + fails.join(' | ') : '✅ 全部通过');
  console.log('');
  console.log('=== Day 1 排期（40 槽）===');
  console.log('槽  窗  账号  时刻    栏目        锚点                                        体裁');
  for (const s of days[0].slots) {
    const t = s.time;
    console.log(
      String(s.slot).padStart(2) + '  ' + s.window + '  #' + String(s.account_seq).padStart(2) +
      '   ' + t + '+' + String(s.offset_min).padStart(3) + "'" +
      '  ' + s.category.padEnd(9) +
      ' ' + s.anchor.slice(0, 42).padEnd(43) + s.genre
    );
  }
  console.log('');
  console.log('=== 7 天分布 ===');
  const aSet = new Set(), cSet = new Set(), gSet = new Set();
  days.flatMap((d) => d.slots).forEach((s) => { aSet.add(s.anchor_idx); cSet.add(s.combo_key); gSet.add(s.genre); });
  console.log('总槽数      : ' + (days.length * 40));
  console.log('锚点覆盖    : ' + aSet.size + '/12');
  console.log('体裁覆盖    : ' + gSet.size + '/7');
  console.log('唯一组合数  : ' + cSet.size + '  (矩阵空间 6×12×7=504)');
  console.log('组合去重率  : ' + (100 - (cSet.size / (days.length * 40)) * 100).toFixed(1) + '%');
  console.log('理论不重复期: 84 槽（lcm(12,7)）= 2.1 天；含栏目维度完整空间 504 组合 ≈ 12.6 天');
}

main();
