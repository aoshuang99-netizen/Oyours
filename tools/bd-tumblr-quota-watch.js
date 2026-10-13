#!/usr/bin/env node
'use strict';
/**
 * BD Tumblr 配额看护（2026-10-11 立 · 2026-10-13 重大修正）
 * ============================================================================
 * 与 tools/bd-tls-forwarder.js 的「出网闸门」配对：
 *   转发器负责【执行】闸门（cooldown 硬静默 / throttle 令牌桶），
 *   本脚本负责【决策】—— 探测 key[0] 的真实配额状态，改写控制文件。
 *
 * 🔴 2026-10-13 修正（旧版 45min 固定退避是错的，会把一次配额耗尽放大成 8h+ 停摆）
 *   Tumblr 的限流是【按 consumer key】，且响应头给出精确窗口（200 与 429 都带）：
 *     x-ratelimit-perhour-limit = 1000 / -remaining / -reset(秒)
 *     x-ratelimit-perday-limit  = 5000 / -remaining / -reset(秒)
 *   实测（同刻同 IP、经 BD TLS 直连，绕开本机闸门）：
 *     key[0] MSCMS Auto Poster → 429，perday-remaining = 0，perday-reset ≈ 22442s
 *     key[1] Explore API       → 200 / 401（签名不匹配时），perday-remaining = 3851
 *   ⇒ 出口链路、IP、GFW 全部无辜；**日配额耗尽**才是 429 的唯一原因。
 *   ⇒ 旧版退避 45min ≪ 日窗口 6.2h ⇒ 冷却到期探测必然仍 429 ⇒ 再 45min ⇒
 *     **自持死循环**（bd-relay-control.json version 已累到 36）。
 *   ⇒ 现改为：退避时长由 reset 头驱动（smartBackoff），且**绝不允许被缩短**。
 *
 * 状态机（冷却剩余 >30min 时跳过探测，避免探测风暴）：
 *   200 + cooldown            → throttle（按小时余量收紧速率）
 *   429 + throttle            → 回 cooldown
 *   429 + cooldown(未到期)     → 现存冷却短于按 reset 算出的目标 ⇒ 升级；否则保持
 *   429 + 冷却已到期           → cooldown = now + smartBackoff
 *   网络错误                   → 不改状态（上游抖动不该误判配额）
 *
 * ⚠️ 探测必须【直连 BD TLS 33335】，不能走本地转发器 —— 否则会被自己的
 *    闸门拦（闸门回「200 Connection established 后立刻关闭」，表现为 fetch failed）。
 *
 * 用法：
 *   node tools/bd-tumblr-quota-watch.js                 # 常驻自适应
 *   node tools/bd-tumblr-quota-watch.js --once          # 单次探测（不改状态）
 *   node tools/bd-tumblr-quota-watch.js --rl            # 只打印配额快照（人读）
 *   node tools/bd-tumblr-quota-watch.js --status        # 打印控制文件
 *   node tools/bd-tumblr-quota-watch.js --cooldown 380  # 手动设冷却 N 分钟
 *   node tools/bd-tumblr-quota-watch.js --throttle 6 120# 手动设限速
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const { ProxyAgent, fetch: ufetch } = require('undici');

const WS = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || 'D:/mscms-ws/data';
const LOG_DIR = process.env.LOG_DIR || 'D:/mscms-ws/logs';
const CONTROL_FILE = process.env.BD_RELAY_CONTROL || path.join(DATA_DIR, 'bd-relay-control.json');
const WATCH_LOG = path.join(LOG_DIR, 'tumblr-quota-watch.log');
const RULE_HOST = 'api.tumblr.com';

// ── BD TLS（与转发器同源凭据）；TLS-in-TLS 已实测 undici 可处理，curl 不行 ──
const BD_CUSTOMER = process.env.BD_CUSTOMER || 'hl_ac0f9818';
const BD_ZONE = process.env.BD_ZONE || 'isp_proxy1';
const BD_PASSWORD = process.env.BD_PASSWORD || 'd2ream9zn4am';
const BD_HOST = process.env.BD_HOST || 'brd.superproxy.io';
const BD_TLS_PORT = process.env.BD_TLS_PORT || '33335';

// ── 策略参数 ──
const PROBE_MS = Number(process.env.QUOTA_PROBE_MS || 10 * 60 * 1000);
const BACKOFF_MIN = Number(process.env.QUOTA_BACKOFF_MIN || 45);          // 仅在无 reset 头时兜底
const MAX_COOLDOWN_MIN = Number(process.env.QUOTA_MAX_COOLDOWN_MIN || 1440);
const THROTTLE_PER_MIN = Number(process.env.QUOTA_THROTTLE_PER_MIN || 6);
const THROTTLE_PER_HOUR = Number(process.env.QUOTA_THROTTLE_PER_HOUR || 120);
const KEY_INDEX = Number(process.env.QUOTA_KEY_INDEX || 0);   // 0 = MSCMS Auto Poster（发布 App）
// 对照 key：主探针非 ok 时自动补探，用于区分「本 key 配额耗尽」与「线路/IP 故障」。
// 教训来源（2026-10-13）：只测 key[0] 的 429 就推及「*.tumblr.com 全域不可达 / 出口失效」，
//   而 key[1] 同刻同 IP 返回 200 ⇒ 原结论完全错误（差点去买新住宅 IP，纯属无效功）。
//   铁律：单探针不下结论，必须带对照组。
const CROSS_KEY_INDEX = Number(process.env.QUOTA_CROSS_KEY_INDEX || (KEY_INDEX === 0 ? 1 : 0));

function log(...a) {
  const line = `[${new Date().toISOString()}] [quota-watch] ${a.join(' ')}`;
  try { fs.appendFileSync(WATCH_LOG, line + '\n'); } catch (_) {}
  console.log(line);
}
function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return dflt; }
}
function localTs(ms) { return new Date(ms + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' GMT+8'; }

function loadControl() {
  return readJson(CONTROL_FILE, { default: { mode: 'off' }, rules: [] });
}
/** 原子写：先写 tmp 再 rename（避免转发器读到半截 JSON）*/
function writeControl(obj) {
  obj.version = (obj.version || 0) + 1;
  obj.updatedAt = new Date().toISOString();
  obj.updatedBy = 'bd-tumblr-quota-watch';
  const tmp = CONTROL_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, CONTROL_FILE);
    return true;
  } catch (e) {
    log('❌ 写控制文件失败: ' + e.message);
    return false;
  }
}
function upsertRule(ctl, rule) {
  ctl.rules = Array.isArray(ctl.rules) ? ctl.rules.filter((r) => !(r && (r.match || []).includes(RULE_HOST))) : [];
  ctl.rules.unshift(rule);
  ctl.default = ctl.default || { mode: 'off' };
  return ctl;
}

// ── 配额快照（Tumblr 在 200 与 429 上都给）──
function rlOf(r) {
  const num = (n) => { const v = r.headers.get(n); return (v === null || v === undefined) ? null : Number(v); };
  const rl = {
    hourLimit: num('x-ratelimit-perhour-limit'), hourRemain: num('x-ratelimit-perhour-remaining'), hourReset: num('x-ratelimit-perhour-reset'),
    dayLimit: num('x-ratelimit-perday-limit'), dayRemain: num('x-ratelimit-perday-remaining'), dayReset: num('x-ratelimit-perday-reset'),
  };
  return (rl.hourLimit === null && rl.dayLimit === null) ? null : rl;
}
function rlText(rl) {
  if (!rl) return '无配额头';
  const mm = (s) => (s === null ? '?' : Math.round(s / 60) + 'min');
  return `h ${rl.hourRemain}/${rl.hourLimit} (reset ${mm(rl.hourReset)}) · d ${rl.dayRemain}/${rl.dayLimit} (reset ${mm(rl.dayReset)})`;
}
/** 退避时长：由 Tumblr 的 reset 头驱动，而不是拍脑袋的固定值（加 120s 缓冲防擦边 429）*/
function smartBackoff(rl) {
  const BUF = 120 * 1000;
  if (rl && rl.dayRemain !== null && rl.dayRemain <= 0 && rl.dayReset > 0) {
    return { ms: Math.min(rl.dayReset * 1000 + BUF, 24 * 3600e3), why: '日配额耗尽' };
  }
  if (rl && rl.hourRemain !== null && rl.hourRemain <= 0 && rl.hourReset > 0) {
    return { ms: Math.min(rl.hourReset * 1000 + BUF, 3600e3), why: '小时配额耗尽' };
  }
  return { ms: BACKOFF_MIN * 60000, why: '无 reset 头 ⇒ 固定退避' };
}

// ── 探测素材 ──
function tumblrConsumerKey(idx = KEY_INDEX) {
  const apps = readJson(path.join(WS, 'tumblr_apps.json'), null) || readJson(path.join(DATA_DIR, 'tumblr_apps.json'), []);
  const arr = Array.isArray(apps) ? apps : (apps.apps || []);
  const a = arr[idx];
  if (!a) return null;
  return { key: a.consumerKey || a.consumer_key, label: a.label || a.name || ('app#' + idx), idx };
}
function sampleBlog() {
  const accts = readJson(path.join(DATA_DIR, 'accounts.json'), null) || readJson(path.join(WS, 'accounts.json'), []);
  const arr = Array.isArray(accts) ? accts : (accts.items || []);
  const hit = arr.find((x) => (x.status === 'active' || x.status === 'healthy') && (x.blogName || x.blog_name));
  if (!hit) return null;
  let b = hit.blogName || hit.blog_name;
  b = String(b).replace(/\.tumblr\.com$/i, '');
  return b;
}
function makeAgent() {
  const user = `brd-customer-${BD_CUSTOMER}-zone-${BD_ZONE}`;
  return new ProxyAgent(`https://${encodeURIComponent(user)}:${encodeURIComponent(BD_PASSWORD)}@${BD_HOST}:${BD_TLS_PORT}`);
}
/** 单次只读探测（无重试）：返回 { kind:'ok'|'limited'|'net', status, ms, rl, detail, key, blog, probeIdx } */
async function probeOnce(idx = KEY_INDEX) {
  const k = tumblrConsumerKey(idx);
  const blog = sampleBlog();
  if (!k || !blog) return { kind: 'net', detail: '缺少 consumerKey 或 blog 样本', ms: 0, probeIdx: idx };
  const url = `https://api.tumblr.com/v2/blog/${blog}.tumblr.com/info?api_key=${encodeURIComponent(k.key)}`;
  const t0 = Date.now();
  try {
    const r = await ufetch(url, { dispatcher: makeAgent(), signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    const ms = Date.now() - t0;
    const rl = rlOf(r);
    const base = { ms, rl, key: k.label, blog, probeIdx: idx };
    if (r.status === 200) return Object.assign(base, { kind: 'ok', status: 200, detail: 'key 配额正常' });
    if (r.status === 429) return Object.assign(base, { kind: 'limited', status: 429, detail: body.slice(0, 120).replace(/\s+/g, ' ') });
    return Object.assign(base, { kind: 'net', status: r.status, detail: 'HTTP ' + r.status + ' ' + body.slice(0, 100).replace(/\s+/g, ' ') });
  } catch (e) {
    return { kind: 'net', detail: (e.cause && e.cause.message) || e.message, ms: Date.now() - t0, key: k.label, blog, probeIdx: idx };
  }
}

/**
 * 抗抖动重试包装（2026-10-13）：纯网络抖动（无 HTTP 状态码）时重试一次。
 * 依据：BD TLS 隧道实测会出现 10s+ 的偶发失败（同刻同端点重测即 429 / <5s），
 *   单次 `net` 就下「探测失败」结论属于**探测器局限**，不是被测对象行为。
 */
async function probe(idx = KEY_INDEX) {
  let r = await probeOnce(idx);
  if (r.kind === 'net' && !r.status) {
    await new Promise((res) => setTimeout(res, 1500));
    const r2 = await probeOnce(idx);
    r2.retried = true;
    return r2;
  }
  return r;
}

/**
 * 交叉探针（2026-10-13 新增）：主 key 非 ok 时自动补探对照 key，据此判别归因。
 *   verdict='key-quota'  主 key 受限 + 对照 key 200  ⇒ 本 key 配额耗尽；线路/IP/GFW 全部无辜
 *   verdict='line-wide'  两个 key 同时 429          ⇒ 疑似线路/IP 层（须另查，不可直接下「封禁」结论）
 *   verdict='probe-net'  对照也报网络错             ⇒ 探测器局限，禁止据此下配额结论
 *   verdict='healthy'    主 key 200                 ⇒ 不发对照探针（省配额）
 */
async function probeCross() {
  const main = await probe(KEY_INDEX);
  if (main.kind === 'ok') return { main, cross: null, verdict: 'healthy' };
  if (!tumblrConsumerKey(CROSS_KEY_INDEX)) return { main, cross: null, verdict: 'probe-net' };
  const cross = await probe(CROSS_KEY_INDEX);
  let verdict;
  if (cross.kind === 'ok') verdict = 'key-quota';
  else if (cross.kind === 'limited') verdict = 'line-wide';
  else verdict = 'probe-net';
  return { main, cross, verdict };
}
const VERDICT_TEXT = {
  healthy: '主 key 正常',
  'key-quota': '本 key 配额耗尽（对照 key 健康 ⇒ 线路/IP/GFW 无辜）',
  'line-wide': '两个 key 同时受限 ⇒ 疑似线路/IP 层，须另查',
  'probe-net': '对照探针也报网络错 ⇒ 探测器局限，不下配额结论',
};
function crossText(pc) {
  if (!pc.cross) return VERDICT_TEXT[pc.verdict] || pc.verdict;
  const c = pc.cross;
  return `对照 key=${c.key} → ${c.kind}${c.status ? '(' + c.status + ')' : ''}${c.rl ? ' · ' + rlText(c.rl) : ''}` +
    ` ⇒ ${VERDICT_TEXT[pc.verdict] || pc.verdict}`;
}

function currentRule() {
  const ctl = loadControl();
  const r = (ctl.rules || []).find((x) => x && (x.match || []).includes(RULE_HOST));
  return r || { match: [RULE_HOST], mode: 'off' };
}
function applyCooldownMs(ms, reason) {
  const ctl = loadControl();
  const until = new Date(Date.now() + ms).toISOString();
  upsertRule(ctl, { match: [RULE_HOST], mode: 'cooldown', cooldownUntil: until, reason: reason || '配额受限' });
  if (writeControl(ctl)) log(`🛑 闸门=cooldown ${Math.round(ms / 60000)}min → 解禁 ${localTs(Date.parse(until))}（${reason || ''}）`);
  return until;
}
function applyThrottle(reason, perMin, perHour) {
  const ctl = loadControl();
  upsertRule(ctl, { match: [RULE_HOST], mode: 'throttle', maxPerMin: perMin || THROTTLE_PER_MIN, maxPerHour: perHour || THROTTLE_PER_HOUR, reason: reason || '配额已恢复，限速放行' });
  if (writeControl(ctl)) log(`🚦 闸门=throttle ${perMin || THROTTLE_PER_MIN}/min · ${perHour || THROTTLE_PER_HOUR}/h（${reason || ''}）`);
}

async function step() {
  const rule = currentRule();
  if (rule.mode === 'cooldown' && rule.cooldownUntil) {
    const left = Date.parse(rule.cooldownUntil) - Date.now();
    if (left > 30 * 60 * 1000) { log(`💤 冷却剩余 ${Math.round(left / 60000)}min（>30min）→ 本轮跳过探测`); return null; }
  }
  const pc = await probeCross();
  const p = pc.main;
  const tag = `mode=${rule.mode}`;
  log(`探测 key=${p.key || '?'} blog=${p.blog || '?'} → ${p.kind}${p.status ? '(' + p.status + ')' : ''} ${p.ms}ms · ${p.rl ? rlText(p.rl) : '无配额头'} · ${p.detail || ''} · ${tag}`);
  if (pc.verdict !== 'healthy') log(`   ↳ 归因: ${crossText(pc)}`);

  if (p.kind === 'ok') {
    const rm = p.rl && p.rl.hourRemain !== null ? p.rl.hourRemain : null;
    const perMin = rm === null ? THROTTLE_PER_MIN : (rm < 100 ? 1 : (rm < 300 ? 2 : THROTTLE_PER_MIN));
    const perHour = rm === null ? THROTTLE_PER_HOUR : (rm < 100 ? 20 : (rm < 300 ? 60 : THROTTLE_PER_HOUR));
    const dayLow = !!(p.rl && p.rl.dayRemain !== null && p.rl.dayRemain < 500);
    if (rule.mode !== 'throttle' || rule.maxPerMin !== perMin) {
      applyThrottle(`配额恢复 200（${rlText(p.rl)}）${dayLow ? ' · ⚠️日余量<500' : ''}`, perMin, perHour);
    }
    return p;
  }
  if (p.kind === 'limited') {
    const bk = smartBackoff(p.rl);
    const cur = rule.cooldownUntil ? Date.parse(rule.cooldownUntil) : 0;
    if (cur > Date.now() && (cur - Date.now()) >= bk.ms) {
      log(`⏳ 冷却中（${Math.round((cur - Date.now()) / 60000)}min 后到期，已 ≥ 目标 ${Math.round(bk.ms / 60000)}min），不延长`);
      return p;
    }
    applyCooldownMs(bk.ms, `429(${rlText(p.rl)}) → 硬静默 ${Math.round(bk.ms / 60000)}min（${bk.why} · ${VERDICT_TEXT[pc.verdict] || pc.verdict}）`);
    return p;
  }
  log('⚠️ 探测网络错误，不改状态（避免误判配额）');
  return p;
}

(async () => {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

  if (has('--status')) {
    log('--- 控制文件 ' + CONTROL_FILE + ' ---');
    console.log(JSON.stringify(loadControl(), null, 2));
    const r = currentRule();
    if (r.cooldownUntil) log(`当前闸门 ${r.mode} → 解禁 ${localTs(Date.parse(r.cooldownUntil))}（剩余 ${Math.round((Date.parse(r.cooldownUntil) - Date.now()) / 60000)}min）`);
    else log(`当前闸门 ${r.mode}`);
    return;
  }
  if (has('--rl')) {
    const pc = await probeCross();
    const p = pc.main;
    console.log('key      :', p.key);
    console.log('blog     :', p.blog);
    console.log('结果     :', p.kind, p.status ? '(' + p.status + ')' : '', p.ms + 'ms');
    console.log('配额     :', rlText(p.rl));
    if (p.rl) {
      console.log('小时窗口 : 剩余 ' + p.rl.hourRemain + '/' + p.rl.hourLimit + '，重置于 ' + localTs(Date.now() + (p.rl.hourReset || 0) * 1000));
      console.log('日窗口   : 剩余 ' + p.rl.dayRemain + '/' + p.rl.dayLimit + '，重置于 ' + localTs(Date.now() + (p.rl.dayReset || 0) * 1000));
    }
    if (p.kind === 'net' && !p.rl) {
      // ⚠️ 防误导：探测没取到响应 ⇒ 语义是「不改状态」，不是「退避 45min」。
      //    若这里照旧打印 45min，会让人以为系统又落回「固定 45min 退避」的老病。
      console.log('建议退避 : —（探测未取到响应 ⇒ 不改状态；绝不落下 45min 固定退避的自持死循环）');
    } else {
      const bk = smartBackoff(p.rl);
      console.log('建议退避 :', Math.round(bk.ms / 60000) + 'min （' + bk.why + '）');
    }
    console.log('---- 对照组（单探针不下结论）----');
    console.log('归因     :', VERDICT_TEXT[pc.verdict] || pc.verdict);
    if (pc.cross) {
      console.log('对照 key :', pc.cross.key, '→', pc.cross.kind, pc.cross.status ? '(' + pc.cross.status + ')' : '');
      console.log('对照配额 :', rlText(pc.cross.rl));
    }
    return;
  }
  if (has('--cooldown')) {
    applyCooldownMs(Number(val('--cooldown') || 60) * 60000, '手动设定');
    return;
  }
  if (has('--throttle')) {
    applyThrottle('手动设定');
    return;
  }
  if (has('--once')) {
    const p = await probe();
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  // 常驻
  log(`配额看护启动: 探测间隔 ${PROBE_MS / 60000}min · 兜底退避 ${BACKOFF_MIN}min · 上限 ${MAX_COOLDOWN_MIN}min · 探测 key[${KEY_INDEX}]`);
  const first = currentRule();
  if (!first.cooldownUntil && first.mode !== 'throttle') {
    log('控制文件无 tumblr 规则 → 按「疑似受限」起步：先探一次再决定（不再盲目先静默 45min）');
  }
  await step();
  setInterval(() => { step().catch((e) => log('step 异常: ' + (e && e.message))); }, PROBE_MS);
})().catch((e) => { log('fatal: ' + (e && e.stack || e)); process.exit(1); });
