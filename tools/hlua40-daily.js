#!/usr/bin/env node
/**
 * hlua40 每日注入器（B2b · DAU 作战）
 * ============================================================================
 * 读 reports/hlua40-schedule-7d.json，把「当天」的 80 个槽注入 content 池为 ready，
 * 发布器（server.js 入队已改 B2 优先 hlua40-/kk20-）会优先把它们推到 Tumblr，
 * 正文含 hlua.cc.cd 链接 ⇒ 触达恢复后直接导 hlua DAU。
 *
 * 注入契约（与 kk20-daily.js 对齐，实测确证）：
 *   POST /api/v14/content
 *     { id, :'tumblr', content_type:'image_text', title, body, tags,
 *       images:[], status:'ready', account_id:<定向>, quality_score:92 }
 *   ⚠️ status 必须显式 ready（缺省 editing 不进管线）
 *   ⚠️  必须显式 'tumblr'（否则 image_text 默认推断 instagram）
 *   ⚠️ account_id 是发布器分配第 1 优先级（定向闭环）
 *
 * 幂等：content id = slot_id（hlua40-d1-morning-01…），注入前查 content.json，
 *       命中即跳过。--force 强制重注入（会覆盖，慎用）。
 *
 * 用法：
 *   node tools/hlua40-daily.js --day 1          # 注入第 1 天 80 槽
 *   node tools/hlua40-daily.js --day 1 --resume # 同上（默认即幂等，等价）
 *   node tools/hlua40-daily.js --day 1 --dry    # 只报计划不写盘
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { fetchExt } = require('../http-client');

const API = process.env.MSCMS_API || 'http://:3002';
const SCHEDULE = path.resolve(__dirname, '..', 'reports', 'hlua40-schedule-7d.json');
const CONTENT_JSON = 'D:/mscms-ws/data/content.json';
const ID_PREFIX = 'hlua40-';

 log(...a) { console.log(...a); }
 parseArgs(argv) {
  const o = { day: 1, resume: true, dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--day') o.day = Number(argv[++i]) || 1;
    else if (argv[i] === '--resume') o.resume = true;
    else if (argv[i] === '--dry') o.dry = true;
    else if (argv[i] === '--force') o.force = true;
  }
  return o;
}

 loadExistingIds() {
  try {
    const raw = fs.readFileSync(CONTENT_JSON, 'utf8');
    const arr = raw.match(/"id"\s*:\s*"([^"]+)"/g) || [];
    return new Set(arr.map(s => s.replace(/"id"\s*:\s*"/, '').replace(/"$/, '')));
  } catch (_) { return new Set(); }
}

 buildBody(slot) {
  // 【2026-10-09】落点统一改到活站 kkmatch.com（目标 DAU 站）。不论排期模板里写的是
  // hlua.cc.cd / www.hlua.cc.cd 还是裸域，全部归一为 kkmatch.com，保证对外发布帖
  // 100% 指向活站且链接可点击。原 hlua.cc.cd 虽已复活，但目标站是 kkmatch.com。
  const site = 'https://kkmatch.com';
  const parts = [slot.opener_en, slot.ref_line_en, slot.ask_en, slot.cta_en]
    .filter(Boolean).join('\n\n').trim();
  let body = parts || (slot.body_en || '');
  // 把模板/文案里残留的 hlua.cc.cd（含 www. 前缀、含/不含协议）全部替换为 kkmatch.com
  body = body.replace(/(https?:\/\/)?(www\.)?hlua\.cc\.cd/gi, 'https://kkmatch.com');
  // 若正文仍无 kkmatch 链接，追加一条可点击的
  if (!/https?:\/\/[^\s)]*kkmatch\.com/i.test(body)) body += `\n\n🔗 ${site}`;
  if (slot.social_ref && !new RegExp(slot.social_ref, 'i').test(body)) {
    body += `\n\n🎬 ${slot.social_ref}`;
  }
  const tags = Array.isArray(slot.tags) ? slot.tags : [];
  if (tags.length) body += '\n\n' + tags.map(t => '#' + String(t).replace(/\s+/g, '').replace(/^#/, '')).join(' ');
  return body.trim();
}

async  injectOne(slot) {
  const id = slot.slot_id;
  const bodyText = buildBody(slot);
  const titleText = slot.title_en || `${slot.creator_name || 'hlua'} · ${slot.angle_feature || ''}`;

  // ── 发布前门禁（2026-10-09 接入，与 kk20/free- 同一判据）──────
  // 重点盯两类历史问题：① 裸 CDN 视频直链（alua.com）被判垃圾外链
  // ② 模板化开头重复（库内实测同首段最多 139/196 次）。
  try {
    const { gate } = require('./content-gate.js');
    const g = gate({ id, title: titleText, body: bodyText });
    if (g.verdict === 'BLOCK') {
      const why = g.reasons.map(r => `${r.code}(${r.detail})`).join('; ') +
        ' | ' + g.ai_hits.slice(0, 3).map(h => h.id + ':' + h.why).join(' / ');
      log(`   🚫 门禁拦下 ${id}：${why}`);
      return { id, status: 'gate_blocked', reason: why };
    }
    if (g.ai_score >= 18) log(`   ℹ️ ${id} AI 味 ${g.ai_score}（低于阈值，留档）`);
  } catch (e) {
    log(`   ⚠️ 门禁异常（保守拒发）${id}：${e.message}`);
    return { id, status: 'gate_blocked', reason: 'gate error: ' + e.message };
  }

  const payload = {
    id,
    : 'tumblr',
    content_type: 'text',
    title: slot.title_en || `${slot.creator_name || 'hlua'} · ${slot.angle_feature || ''}`,
    body: buildBody(slot),
    tags: Array.isArray(slot.tags) ? slot.tags : [],
    images: slot.local_video ? [slot.local_video] : [],
    status: 'ready',
    account_id: slot.account_id,
    quality_score: 92,
    generated_at: new Date().toISOString(),
    campaign: 'hlua40',
  };
  const resp = await fetchExt(`${API}/api/v14/content`, {
    method: 'POST',
    headers: { '': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 30000,
  });
  const txt = await resp.text();
  let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 160)}`);
  const rec = j?.record || j?.item || j || {};
  const savedStatus = rec.status || '?';
  const savedAcct = rec.account_id || '?';
  if (savedStatus !== 'ready') log(`   ⚠️ ${id} status 未落成 ready（${savedStatus}）⇒ 不进管线！`);
  if (savedAcct !== slot.account_id) log(`   ⚠️ ${id} account 与定向不一致（期望 ${slot.account_id}）`);
  return { id, savedStatus, savedAcct };
}

async  main() {
  const args = parseArgs(process.argv.slice(2));
  log(`[hlua40-daily] day=${args.day} dry=${args.dry} force=${args.force}`);
  if (!fs.existsSync(SCHEDULE)) { console.error('排期文件缺失:', SCHEDULE); process.exit(1); }
  const sched = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const slots = (sched.slots || []).filter(s => Number(s.day) === args.day);
  if (!slots.length) { console.error(`day ${args.day} 无槽`); process.exit(1); }
  log(`[hlua40-daily] day ${args.day} 共 ${slots.length} 槽`);

  const existing = loadExistingIds();
  let ok = 0, skip = 0, fail = 0, gateBlocked = 0;
  for (const slot of slots) {
    const id = slot.slot_id;
    if (!args.force && existing.has(id)) { log(`   ⏭  ${id} 已存在`); skip++; continue; }
    if (args.dry) { log(`   🔍 ${id} -> ${slot.account_id}`); ok++; continue; }
    try {
      const r = await injectOne(slot);
      // 门禁拦下的返回体没有 savedStatus/savedAcct，必须先分流，
      // 否则会被误记成"注入成功但 status=undefined"（实测这类假成功会掩盖真实拒发数）
      if (r && r.status === 'gate_blocked') { gateBlocked++; continue; }
      log(`   ✅ ${id} → status=${r.savedStatus} account=${r.savedAcct}`);
      ok++;
    } catch (e) {
      log(`   ❌ ${id} 失败: ${e.message}`);
      fail++;
    }
  }
  log(`\n[hlua40-daily] 完成: injected=${ok} skipped=${skip} gate_blocked=${gateBlocked} failed=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
}
module.exports = { buildBody };
