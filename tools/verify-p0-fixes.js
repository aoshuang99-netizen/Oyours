#!/usr/bin/env node
/**
 * P0 修复验收脚本（F1–F5）
 * =====================================================================
 * 背景：2026-09-20 全链路体检发现三项 P0 ——
 *   P0-1 429 限流被误判为 401 token 失效（黑名单 49 条中 37 条是误杀）
 *   P0-2 configStatus() 只判空不验真（bluesky/ 假绿，实测均 401）
 *   P0-3 self_direct 自访问标 organic（546,712 条污染自然流量口径）
 *
 * 本脚本**不联网、不写数据**，纯静态 + 纯函数断言，可在重启前/后随时运行。
 * 用法：node tools/verify-p0-fixes.js
 * 退出码：0 = 全通；1 = 有 FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

 ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
 assert(cond, name, detail) { ok(!!cond, name, detail); }
 section(t) { console.log(`\n${t}`); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ══════════════════════════════════════════════════════════════
// F1 · detectTokenDeadError 的 429 误判修复
// ══════════════════════════════════════════════════════════════
section('【F1】429 限流不再被判为 token 失效');
let detectTokenDeadError, extractErrStatus;
try {
  ({ detectTokenDeadError, extractErrStatus } = require(path.join(ROOT, 'cloud-publisher.js')));
} catch (e) {
  console.log('  ❌ 无法加载 cloud-publisher.js：' + e.message);
  process.exit(1);
}
assert(typeof detectTokenDeadError === '', 'F1.0 detectTokenDeadError 已导出');
assert(typeof extractErrStatus === '', 'F1.0b extractErrStatus 已导出（新增，便于回归）');

const mk = (msg, status, extra) => {
  const e = new Error(msg);
  if (extra) Object.assign(e, extra);
  if (status !== undefined) e.status = status;
  return e;
};
const FLUB = '"detail":"Something flubbed. Try again."';

const f1cases = [
  ['429 带 status+isRateLimited（_oauthRequest 真实样本形态）',
    mk(`Tumblr /blog/mscmsfqzm1uc/posts 429: {"meta":{"status":429,"msg":"Limit Exceeded"},"errors":[{"title":"Limit Exceeded","code":0,${FLUB}}]}`, 429, { isRateLimited: true }), false],
  ['429 仅 message（body 含 Something flubbed —— 旧实现靠它误判）',
    mk(`Tumblr 发布失败 429: {"meta":{"status":429},"errors":[{"code":0,${FLUB}}]}`), false],
  ['429 只能从 body.meta.status 判',
    mk('Tumblr 出了点问题', undefined, { body: { meta: { status: 429 }, errors: [{ code: 0 }] } }), false],
  ['blog 名含 3 位数字不被误取为状态码',
    mk('Tumblr /blog/mscmsbtk920u/posts 429: {}', 429, { isRateLimited: true }), false],
  ['真 401（_oauthRequest 形态 + ）',
    mk('Tumblr /blog/mscmscoznkv8/posts 401: {"meta":{"status":401,"msg":"Unauthorized"},"errors":[{"title":"Unauthorized","code":1034}]}', 401), true],
  ['真 401 仅 message 前缀（postPhoto 形态，无 status 属性）',
    mk('Tumblr 发布失败 401: {"meta":{"status":401}}'), true],
  ['真 401 仅有 ',
    mk('Tumblr 出错了', undefined, { body: { meta: { status: 401 }, errors: [{ code: 1034 }] } }), true],
  ['网络错(status=0) 不判死',
    mk('Tumblr /blog/x/posts network-failed after 2 attempts', 0, { isNetworkError: true }), false],
  ['403 权限问题不判死',
    mk('Tumblr /blog/x/posts 403: {"meta":{"status":403}}', 403), false],
];
for (const [name, err, want] of f1cases) {
  const got = detectTokenDeadError(err);
  ok(got === want, `F1 ${name} → 判死=${got}（期望 ${want}，status=${extractErrStatus(err)}）`);
}

// 静态断言：自证文案已去除、429 前置放行存在
const cpSrc = read('cloud-publisher.js');
assert(/if \(err\.isRateLimited\) return false;/.test(cpSrc), 'F1.10 源码含 429/isRateLimited 前置放行');
assert(/something\\s\+flubbed/i.test(cpSrc) === false, 'F1.11 已移除 something flubbed 语义兜底（限流/撤销共用该文案）');
assert(/\b429\b/.test(cpSrc.split(' detectTokenDeadError')[1].split('\n').slice(0, 20).join('\n')), 'F1.12 429 显式排除出现在函数前段');

// ══════════════════════════════════════════════════════════════
// F2 · markTokenDead 用真实状态码，去除自证文案
// ══════════════════════════════════════════════════════════════
section('【F2】markTokenDead 不再硬编码「返回 401」');
assert(!/图文发布返回 401/.test(cpSrc), 'F2.1 已移除「图文发布返回 401」自证文案');
assert(!/文字发布返回 401/.test(cpSrc), 'F2.2 已移除「文字发布返回 401」自证文案');
assert(/图文发布失败\(HTTP \$\{deadSt\}\)/.test(cpSrc), 'F2.3 图文通道改用真实状态码 deadSt');
assert(/文字发布失败\(HTTP \$\{deadSt\}\)/.test(cpSrc), 'F2.4 文字通道改用真实状态码 deadSt');
const markCalls = cpSrc.match(/this\.markTokenDead\(accountId, `[^`]*`, 401, 'online-401'\)/g) || [];
ok(markCalls.length === 0, `F2.5 无残留「恒传 401」的调用点（实查 ${markCalls.length} 处）`);

// ══════════════════════════════════════════════════════════════
// F3 · 三 provider 的 configStatus 三态化（消除假绿）
// ══════════════════════════════════════════════════════════════
section('【F3】configStatus 只判空不验真 → 三态化（configured/format/reachable）');
const D = 'D:/mscms-ws/data';
const provSpec = [
  ['bluesky', 'providers/bluesky-provider.js', 'BlueskyProvider', 'bluesky_config'],
  ['', 'providers/-provider.js', 'MastodonProvider', '_config'],
  ['nostr', 'providers/nostr-provider.js', 'NostrProvider', 'nostr_config'],
];
for (const [key, file, cls, cfg] of provSpec) {
  const src = read(file);
  assert(/_checkCredFormat/.test(src), `F3.${key} 含 _checkCredFormat 格式校验`);
  assert(/async verifyCredentials/.test(src), `F3.${key} 含 verifyCredentials 真实探针`);
  assert(/reachable: probe \?/.test(src), `F3.${key} 暴露 reachable 三态`);

  // 运行时：用真实配置文件跑一次 configStatus，验证「假绿」已消失
  let row = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(D, cfg + '.json'), 'utf8'));
    row = Array.isArray(raw) ? (raw.find((r) => r && r.id === 'main') || raw[0]) : raw;
  } catch (e) { /* 文件缺失时跳过运行时断言 */ }
  if (!row) { console.log(`  ⚠️  F3.${key} 跳过运行时断言（${cfg}.json 不可读）`); continue; }
  try {
    const M = require(path.join(ROOT, file));
    const inst = new M[cls]({ dataStore: { get: () => row } });
    const st = inst.configStatus();
    console.log(`     ${key}: configured=${st.configured} format=${st.format} authorized=${st.authorized} reachable=${st.reachable}`);
    if (/secret|token|/i.test(JSON.stringify(row)) && String(row. || row.accessToken || '' < 20) {
      ok(st.authorized === false, `F3.${key} 短占位凭据被如实判为未授权（不再假绿）`, `authorized=${st.authorized}`);
      ok(!!st.reason, `F3.${key} 给出明确 reason 而非静默绿灯`);
    } else {
      ok(st.format === 'ok', `F3.${key} 真实凭据格式校验通过（format=ok）`, `format=${st.format}`);
    }
  } catch (e) {
    ok(false, `F3.${key} 运行时 configStatus 可执行`, e.message.slice(0, 120));
  }
}

// ══════════════════════════════════════════════════════════════
// F3-extension · 其余已实现 provider 的同类缺口（假绿预防性加固）
//
//   背景：全仓 configStatus() 共 **11 处**实现，F3 首轮只覆盖 3 处
//   （bluesky//nostr）—— 与 F5 首轮只查 1 处属**同一类漏点**。
//   余下 8 处中：3 处是基类 / StubProvider（模板与占位，恒 configured=false，
//   结构上无假绿可能）；另 5 处（/discord/github/devto/）
//   此前 `authorized: hasCreds` 与 `configured` 完全冗余，一旦填入占位凭据
//   即产生「绿灯但发不出去」的假绿。此处补齐格式闸门（仅收紧 authorized）。
// ══════════════════════════════════════════════════════════════
section('【F3-extension】5 处未覆盖 provider 补格式闸门（authorized 不再冗余等于 configured）');
const provExt = [
  ['', 'providers/-provider.js', '', { : 'test', chatId: '123' }],
  ['discord', 'providers/discord-provider.js', 'DiscordProvider', { webhookUrl: 'https://example.com/not-a-discord-hook' }],
  ['github', 'providers/github-provider.js', '', { token: '' }],
  ['devto', 'providers/devto-provider.js', '', { apiKey: 'short' }],
  ['', 'providers/-provider.js', '', { token: 'short', publicationId: 'y' }],
];
for (const [key, file, cls, fakeRow] of provExt) {
  const src = read(file);
  assert(/_checkCredFormat/.test(src), `F3E.${key} 含 _checkCredFormat 格式校验`);
  assert(/format: fmt\.ok \? 'ok' : 'invalid'/.test(src), `F3E.${key} configStatus 暴露 format 字段`);
  assert(/authorized: hasCreds && fmt\.ok/.test(src), `F3E.${key} authorized 收紧为「非空 && 格式合法」`);
  assert(/configured: hasCreds,/.test(src), `F3E.${key} configured 语义保持不变（发布路径判据）`);

  try {
    const M = require(path.join(ROOT, file));
    const inst = new M[cls]({ dataStore: { get: () => fakeRow } });
    const st = inst.configStatus();
    console.log(`     ${key}: configured=${st.configured} format=${st.format} authorized=${st.authorized} | ${String(st.reason || '').slice(0, 40)}`);
    ok(st.configured === true, `F3E.${key} 占位凭据下 configured 仍 true（「字段非空」语义未变）`);
    ok(st.format === 'invalid', `F3E.${key} 占位凭据被判 format=invalid`);
    ok(st.authorized === false, `F3E.${key} 占位凭据不再假绿（authorized=false）`);
    ok(!!st.reason, `F3E.${key} 给出明确 reason 而非静默绿灯`);
  } catch (e) {
    ok(false, `F3E.${key} 运行时 configStatus 可执行`, e.message.slice(0, 120));
  }
}
const implProviders = [
  'providers/bluesky-provider.js', 'providers/-provider.js', 'providers/nostr-provider.js',
  'providers/-provider.js', 'providers/discord-provider.js', 'providers/github-provider.js',
  'providers/devto-provider.js', 'providers/-provider.js',
];
const missFmt = implProviders.filter((f) => !/format:/.test(read(f)));
assert(missFmt.length === 0, `F3E.all 8 个有凭据字段的 provider 均含 format 闸门（缺失：${missFmt.join(',') || '无'}）`);
const tumblrSrc = read('providers/tumblr-provider.js');
assert(/this\.tumblrPublisher\.getStatus\(\)/.test(tumblrSrc) && /if \(!s\.authorized\)/.test(tumblrSrc),
  'F3E.tumblr 例外成立：authorized 源自 publisher 真实 OAuth 状态，非「字段非空」冗余');
assert(/configured: false,\s*\n\s*reason: `尚未移植实现/.test(read('social-provider-manager.js')),
  'F3E.stub StubProvider 恒 configured=false（结构上无假绿可能，无需格式闸门）');

// ══════════════════════════════════════════════════════════════
// F4 · self_direct 自访问不再标 organic
// ══════════════════════════════════════════════════════════════
section('【F4】matrix_visits_recorded 的 visitor_type 走单一事实源');
const srvSrc = read('server.js');
const insIdx = srvSrc.indexOf('INSERT INTO matrix_visits_recorded');
const insBlock = srvSrc.slice(insIdx, insIdx + 900);
assert(!/\[data\.post_id \|\| null, data\.account_id \|\| null, 'organic',/.test(insBlock), 'F4.1 INSERT 不再硬编码 organic');
assert(/visitorType/.test(insBlock), 'F4.2 INSERT 使用 visitorType 变量');
assert(/classifyTraffic\(\{ ip: data\.ip/.test(srvSrc), 'F4.3 走 data-provenance.classifyTraffic 单一事实源');
assert(/require\('\.\/data-provenance\.js'\)/.test(srvSrc), 'F4.4 已 require data-provenance.js');

// 运行时：用 data-provenance 验证哨兵值判定
try {
  const { classifyTraffic } = require(path.join(ROOT, 'data-provenance.js'));
  const t1 = classifyTraffic({ ip: 'self_direct' });
  const t2 = classifyTraffic({ ip: '203.0.113.42' });
  ok(t1 !== 'user', `F4.5 classifyTraffic(self_direct) = ${t1}（非 user ⇒ 将写 system）`);
  ok(t2 !== 'user', `F4.6 classifyTraffic(203.0.113.42) = ${t2}（TEST-NET ⇒ 将写 system）`);
} catch (e) {
  ok(false, 'F4.5-6 data-provenance.classifyTraffic 可加载', e.message.slice(0, 120));
}

// ══════════════════════════════════════════════════════════════
// F3 安全性复核 · 收紧 authorized 不得破坏任何活代码消费方
// ══════════════════════════════════════════════════════════════
section('【F3-safety】authorized 收紧无副作用（消费方全量复核）');
// 精确匹配：任何 provider.configStatus() 调用后 60 字符内出现 .authorized。
// 注意 server.js:4761 的 tp.getStatus().authorized 是 tumblrPublisher 自有状态（合法闸门），不属此列。
const cfgAuthHits = [...srvSrc.matchAll(/configStatus\(\)[\s\S]{0,60}/g)]
  .filter((m) => /\.authorized/.test(m[0]));
assert(cfgAuthHits.length === 0,
  `F3S.1 server.js 无 configStatus().authorized 消费方（实查 ${cfgAuthHits.length}）`);
assert(/if \(!st\.configured\)/.test(cpSrc),
  'F3S.2 发布前置检查仅用 configured（cloud-publisher.js:1097）');
// 唯一合法例外：server.js:4761 的 tp.getStatus().authorized（tumblrPublisher 自有状态）必须仍存在，
// 否则说明误删了 tumblr OAuth 闸门。
assert(/tp\.getStatus\(\)\.authorized/.test(srvSrc),
  'F3S.3 tumblrPublisher 授权闸门未被误删（server.js:4761 仍在）');

// ══════════════════════════════════════════════════════════════
// F5 · 全部通道默认值同源（4 处 MSCMS_REAL_CHANNELS + 1 处 PROVIDER_CHANNELS）
// ══════════════════════════════════════════════════════════════
section('【F5】MSCMS_REAL_CHANNELS 全部出现点默认值同源（env 未设时即真实生效值）');
const loopSrc = read('v14-account-loop.js');
// 【关键】必须 /g 全局采集 —— 非全局 match 只取第一处，
// 正是这处盲点导致 F5 首轮漏掉 server.js:3285 与 v14-account-loop.js:22。
const collect = (src, varName) => [...src.matchAll(
  new RegExp(`process\\.env\\.${varName} \\|\\| '([^']*)'`, 'g')
)].map((m) => m[1]);

const srvChAll  = collect(srvSrc,  'MSCMS_REAL_CHANNELS');
const cpChAll   = collect(cpSrc,   'MSCMS_REAL_CHANNELS');
const loopChAll = collect(loopSrc, 'MSCMS_REAL_CHANNELS');
const cpProvAll = collect(cpSrc,   'MSCMS_PROVIDER_CHANNELS');
const allReal   = [...srvChAll, ...cpChAll, ...loopChAll];
console.log(`     server.js            (${srvChAll.length} 处) = [${srvChAll.join(', ')}]`);
console.log(`     cloud-publisher.js   (${cpChAll.length} 处) = [${cpChAll.join(', ')}]`);
console.log(`     v14-account-loop.js  (${loopChAll.length} 处) = [${loopChAll.join(', ')}]`);
console.log(`     _providerChannels    (${cpProvAll.length} 处) = [${cpProvAll.join(', ')}]  ← 另一变量，语义独立`);

assert(srvChAll.length === 2, `F5.1 server.js 两处均被采集（实查 ${srvChAll.length}）`);
assert(loopChAll.length === 1, `F5.2 v14-account-loop.js 出现点被采集（实查 ${loopChAll.length}）`);
assert(allReal.length === 4, `F5.3 运行时文件共 4 处 MSCMS_REAL_CHANNELS（实查 ${allReal.length}）`);
const uniqReal = [...new Set(allReal)];
assert(uniqReal.length === 1, `F5.4 四处默认值完全同源（实查 ${uniqReal.length} 种：${uniqReal.join(' / ')}）`);
assert(uniqReal[0] && uniqReal[0].includes('tumblr'), 'F5.5 默认含 tumblr（不破坏既有闭环）');
assert(uniqReal[0] && uniqReal[0].includes('nostr'), 'F5.6 默认含 nostr（B1 已验收通道）');
assert(cpProvAll.length === 1 && !cpProvAll[0].includes('tumblr'), 'F5.7 providerChannels 不含 tumblr（tumblr 走原生通道，语义正确）');

// ══════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(64));
console.log(`P0 修复验收：${pass} PASS / ${fail} FAIL`);
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('全部通过。');
