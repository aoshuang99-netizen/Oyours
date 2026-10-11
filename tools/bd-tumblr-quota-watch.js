#!/usr/bin/env node
'use strict';
/**
 * BD Tumblr 配额看护 (2026-10-11 · P0-2) —— key[0] 自适应冷却状态机
 * ============================================================================
 * 与 tools/bd-tls-forwarder.js 的「出网闸门」配对：
 *   转发器负责【执行】闸门（cooldown 硬静默 / throttle 令牌桶），
 *   本脚本负责【决策】—— 探测 key[0] 的真实配额状态，改写控制文件。
 *
 * 为什么需要它：Tumblr 429 是【按 consumer key】限流（实测同 IP 同刻
 *   key[1] → 200，key[0] "MSCMS Auto Poster" → 429）。全部 50 账号的 OAuth
 *   token 都绑 key[0]，发布器持续退避重试 ⇒ 配额窗口从未滑过 ⇒ 自持 429
 *   （连续 30.7h 零成功）。发布器自带的「≥3 账号/10min 升级全局暂停」只有
 *   约 8 分钟，**远短于配额窗口**，因此必须由外部提供足够长的硬静默。
 *
 * 状态机（每 PROBE_MS 探一次，只读端点，单次 1 请求，开销可忽略）：
 *   cooldown + 探测 200  → 切 throttle（放行但限速，防止再次洪峰）
 *   cooldown + 探测 429  → 冷却延长 BACKOFF_MIN（上限 MAX_COOLDOWN_MIN）
 *   throttle + 探测 429  → 回 cooldown（说明限速仍偏高）
 *   throttle + 探测 200  → 保持（不放宽，观察发布侧真实结果）
 *   探测网络错误        → 不改状态（上游抖动不该误判配额）
 *
 * ⚠️ 探测必须【直连 BD TLS 33335】，不能走本地转发器 —— 否则会被自己的
 *    闸门 429 拦截，永远测不出真状态。
 *
 * 用法：
 *   node tools/bd-tumblr-quota-watch.js                 # 常驻自适应
 *   node tools/bd-tumblr-quota-watch.js --once          # 单次探测（不改状态）
 *   node tools/bd-tumblr-quota-watch.js --status        # 打印控制文件
 *   node tools/bd-tumblr-quota-watch.js --cooldown 60   # 手动设冷却 60 分钟
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
const BACKOFF_MIN = Number(process.env.QUOTA_BACKOFF_MIN || 45);
const MAX_COOLDOWN_MIN = Number(process.env.QUOTA_MAX_COOLDOWN_MIN || 240);
const THROTTLE_PER_MIN = Number(process.env.QUOTA_THROTTLE_PER_MIN || 6);
const THROTTLE_PER_HOUR = Number(process.env.QUOTA_THROTTLE_PER_HOUR || 120);
const KEY_INDEX = Number(process.env.QUOTA_KEY_INDEX || 0);   // 0 = MSCMS Auto Poster

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

// ── 探测素材 ──
function tumblrConsumerKey() {
  const apps = readJson(path.join(WS, 'tumblr_apps.json'), null) || readJson(path.join(DATA_DIR, 'tumblr_apps.json'), []);
  const arr = Array.isArray(apps) ? apps : (apps.apps || []);
  const a = arr[KEY_INDEX];
  if (!a) return null;
  return { key: a.consumerKey || a.consumer_key, label: a.label || a.name || ('app#' + KEY_INDEX) };
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
/** 只读探测：返回 { kind:'ok'|'limited'|'net', status, ms, detail } */
async function probe() {
  const k = tumblrConsumerKey();
  const blog = sampleBlog();
  if (!k || !blog) return { kind: 'net', detail: '缺少 consumerKey 或 blog 样本', ms: 0 };
  const url = `https://api.tumblr.com/v2/blog/${blog}.tumblr.com/info?api_key=${encodeURIComponent(k.key)}`;
  const t0 = Date.now();
  try {
    const r = await ufetch(url, { dispatcher: makeAgent(), signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    const ms = Date.now() - t0;
    if (r.status === 200) return { kind: 'ok', status: 200, ms, detail: 'key 配额正常', key: k.label, blog };
    if (r.status === 429) return { kind: 'limited', status: 429, ms, detail: body.slice(0, 120).replace(/\s+/g, ' '), key: k.label, blog };
    return { kind: 'net', status: r.status, ms, detail: 'HTTP ' + r.status + ' ' + body.slice(0, 100).replace(/\s+/g, ' '), key: k.label, blog };
  } catch (e) {
    return { kind: 'net', detail: (e.cause && e.cause.message) || e.message, ms: Date.now() - t0, key: k.label, blog };
  }
}

function currentRule() {
  const ctl = loadControl();
  const r = (ctl.rules || []).find((x) => x && (x.match || []).includes(RULE_HOST));
  return r || { match: [RULE_HOST], mode: 'off' };
}
function applyCooldown(minutes, reason) {
  const ctl = loadControl();
  const until = new Date(Date.now() + minutes * 60000).toISOString();
  upsertRule(ctl, { match: [RULE_HOST], mode: 'cooldown', cooldownUntil: until, reason: reason || 'key[0] 配额恢复中' });
  if (writeControl(ctl)) log(`🛑 闸门=cooldown ${minutes}min → 解禁 ${localTs(Date.parse(until))}（${reason || ''}）`);
}
function applyThrottle(reason) {
  const ctl = loadControl();
  upsertRule(ctl, { match: [RULE_HOST], mode: 'throttle', maxPerMin: THROTTLE_PER_MIN, maxPerHour: THROTTLE_PER_HOUR, reason: reason || '配额已恢复，限速放行' });
  if (writeControl(ctl)) log(`🚦 闸门=throttle ${THROTTLE_PER_MIN}/min · ${THROTTLE_PER_HOUR}/h（${reason || ''}）`);
}

async function step() {
  const rule = currentRule();
  const p = await probe();
  const tag = `mode=${rule.mode}`;
  log(`探测 key=${p.key || '?'} blog=${p.blog || '?'} → ${p.kind}${p.status ? '(' + p.status + ')' : ''} ${p.ms}ms · ${p.detail || ''} · ${tag}`);

  if (p.kind === 'ok') {
    if (rule.mode === 'cooldown') {
      applyThrottle('key[0] 只读端点已恢复 200 → 转限速放行');
    }
    return p;
  }
  if (p.kind === 'limited') {
    if (rule.mode === 'throttle') {
      applyCooldown(BACKOFF_MIN, '限速期内仍 429 → 回硬静默');
    } else {
      // cooldown 内继续 429：在原截止基础上再延 BACKOFF_MIN，上限 MAX_COOLDOWN_MIN
      const cur = rule.cooldownUntil ? Date.parse(rule.cooldownUntil) : 0;
      const base = Math.max(cur, Date.now());
      const ext = Math.min(BACKOFF_MIN, Math.round((base + MAX_COOLDOWN_MIN * 60000 - base) / 60000));
      const until = new Date(Math.min(base + ext * 60000, Date.now() + MAX_COOLDOWN_MIN * 60000)).toISOString();
      const ctl = loadControl();
      upsertRule(ctl, { match: [RULE_HOST], mode: 'cooldown', cooldownUntil: until, reason: '仍 429，冷却延长' });
      if (writeControl(ctl)) log(`⏳ 仍 429 → 冷却延长至 ${localTs(Date.parse(until))}`);
    }
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
  if (has('--cooldown')) {
    applyCooldown(Number(val('--cooldown') || 60), '手动设定');
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
  log(`配额看护启动: 探测间隔 ${PROBE_MS / 60000}min · 退避 ${BACKOFF_MIN}min · 上限 ${MAX_COOLDOWN_MIN}min · 探测 key[${KEY_INDEX}]`);
  const first = currentRule();
  if (!first.cooldownUntil && first.mode !== 'throttle') {
    log('控制文件无 tumblr 规则 → 按「疑似受限」起步：先设 45min 硬静默');
    applyCooldown(BACKOFF_MIN, '启动初始化（保守起见先静默）');
  }
  await step();
  setInterval(() => { step().catch((e) => log('step 异常: ' + (e && e.message))); }, PROBE_MS);
})().catch((e) => { log('fatal: ' + (e && e.stack || e)); process.exit(1); });
