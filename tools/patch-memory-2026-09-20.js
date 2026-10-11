'use strict';
/**
 * 原子写入 F3-extension 的记忆条目（项目 MEMORY.md / 今日日志 / 用户级 MEMORY.md）。
 * 依「同一文件必须单一写者」原则：三个文件各一次写盘，不做并发 Edit。
 */
const fs = require('fs');

const P_MEM = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/.workbuddy/memory/MEMORY.md';
const P_LOG = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/.workbuddy/memory/2026-09-20.md';
const U_MEM = 'C:/Users/AS/.workbuddy/MEMORY.md';

function patch(file, pairs, label) {
  let s = fs.readFileSync(file, 'utf8');
  console.log('══════ ' + label + ' ══════');
  let applied = 0, skipped = 0, failed = 0;
  for (const [from, to] of pairs) {
    const cnt = s.split(from).length - 1;
    if (cnt === 0) {
      if (s.includes(to)) { console.log('  ⏭  幂等跳过: ' + from.slice(0, 50)); skipped++; }
      else { console.log('  ❌ 未命中: ' + from.slice(0, 50)); failed++; }
      continue;
    }
    s = s.split(from).join(to);
    console.log('  ✅ x' + cnt + '  ' + from.slice(0, 50));
    applied++;
  }
  fs.writeFileSync(file, s, 'utf8');
  return { applied, skipped, failed };
}

function append(file, block, marker, label) {
  let s = fs.readFileSync(file, 'utf8');
  console.log('══════ ' + label + ' ══════');
  if (s.includes(marker)) { console.log('  ⏭  幂等跳过（已含标记 ' + marker + '）'); return { applied: 0, skipped: 1, failed: 0 }; }
  s = s.replace(/\s*$/, '') + '\n\n' + block + '\n';
  fs.writeFileSync(file, s, 'utf8');
  console.log('  ✅ 追加完成');
  return { applied: 1, skipped: 0, failed: 0 };
}

// ── 1) 项目 MEMORY.md ──
const r1 = patch(P_MEM, [
  ['Provider 三态新增 `format` / `reachable` / `probeAt` / `reason`。',
   'Provider 四态新增 `format` / `reachable` / `probeAt` / `reason`。④ **`configStatus()` 全仓共 11 处实现**：F3 首轮只改 3 处 ⇒ **F3-extension 补修 5 处**（telegram/discord/github/devto/hashnode，其 `authorized` 原与 `configured` 完全冗余）。**豁免两处**：`social-provider-manager.js:94/:113`（基类 / Stub 恒 false）+ `tumblr-provider.js:27`（`authorized` 源自 `publisher.getStatus()` 真实 OAuth）。**余 8 个有凭据字段的 provider 必须含 `_checkCredFormat` + `format` 闸门**。'],

  ['真格式：Bluesky AppPassword `xxxx-xxxx-xxxx-xxxx`(19字符)、Mastodon token 43 字符。',
   '真格式：Bluesky AppPassword `xxxx-xxxx-xxxx-xxxx`(19字符)、Mastodon token 43 字符。**F3-extension 补记**：同批给 telegram/discord/github/devto/hashnode 补 `_checkCredFormat`；前三者判据把握度高（PAT 前缀 / `bot_id:key` / webhook URL），后两者用**保守判据**（平台未公开格式，只拦明显占位/截断值，注释已如实标注，**不编造**）。'],

  ['回归 `tools/verify-p0-fixes.js` **46 PASS / 0 FAIL**；详见 `reports/p0-fix-delivery-2026-09-20.md`。',
   '回归 `tools/verify-p0-fixes.js` **92 PASS / 0 FAIL**（含 F3-safety 3 + **F3-extension 43**）；详见 `reports/p0-fix-delivery-2026-09-20.md`。'],
], '项目 MEMORY.md');

// ── 2) 今日工作日志（append）──
const logBlock = [
  '### 补充：F3-extension（22:00–22:10，全量复核后补修 5 处同类缺口）',
  '',
  '**与 F5(2) 完全同类的错误** —— F3 首轮只改 3 个 provider，但全仓 `configStatus()` 实为 **11 处实现**：',
  '- `social-provider-manager.js:94`（基类）/ `:113`（StubProvider 硬编码 `configured:false`）→ 无假绿可能',
  '- `providers/tumblr-provider.js:27` → **设计例外**（`authorized` 源自 `publisher.getStatus()` 真实 OAuth 状态，非「字段非空」）',
  '- bluesky / mastodon / nostr → 首轮已修 ✅',
  '- **telegram / discord / github / devto / hashnode → 首轮漏** ⇒ 这 5 处 `authorized: hasCreds` 与 `configured` **完全冗余**，填入占位值即假绿',
  '',
  '**修法**：各加 `_checkCredFormat()`；`configStatus()` 二态 → 四态（`configured` 语义不变，`authorized: hasCreds && fmt.ok`，新增 `format` / `reachable` / `probeAt`）。',
  '- 格式判据把握度：github(PAT 前缀) / telegram(`bot_id:key`) / discord(webhook URL) **高**；devto / hashnode **保守**（平台未公开格式，只拦明显占位/截断值，注释如实标注，不编造）',
  '- **未加网络探针**（`reachable` 恒 `\'unknown\'`）：当前无凭据，探针无对象；格式闸门已消除主因',
  '',
  '**验收**：回归 **92 PASS / 0 FAIL**（新增 F3-extension 组 43 条）；线上 `/api/v14/mixpost/providers` 实测 5 个 provider 均暴露 `format=invalid` + `reachable=unknown`；3002 重启**第 4 次**（22460 → 9656，60s，看门狗拉起，单一 LISTENING，**ERROR=0**）。',
  '**当前行为影响：无**（这 5 个线上全部 `configured=false`）—— 预防性加固，与 F5 同级，**不夸大收益**。',
  '',
  '### ⚠️ 工具级踩坑：多 Edit 并发写同一文件 → 丢失更新（必记）',
  '',
  '改报告时在**一条消息里发 8 个 Edit**（同一文件不同位置），**全部返回 `Successfully edited`**，但落盘后 grep 显示**只有部分生效**（`92 PASS` / `重启四次` 等改动消失）。',
  '- **根因**：同消息内多 Edit 并发读写同一文件 → 后写覆盖先写（lost update）',
  '- **判据**：Edit 报成功 **≠** 落盘成功。**必须落盘后 grep 计数复核**',
  '- **解法**：同一文件的多处改动 → 用**一个脚本**串行精确替换（`split(from).length-1` 计命中 → 替换 → 写盘 → 审计期望计数），一次写盘零竞争。本轮落盘审计：**MD 6/6、HTML 9/9 全命中**',
  '- 不同文件可并发，**同一文件必须单一写者**',
  '',
  '### 如实记录的语义瑕疵（未修，留待决策）',
  '`hasCreds=false` 时 `format` 显示 `\'invalid\'` 而非 `null` —— 「无值可校」严格说不等于「格式无效」。这是 F3 首轮既有设计，为保持 8 个 provider 一致而沿用；修它需同时动已验收的 bluesky/mastodon/nostr，故本轮不改。',
].join('\n');
const r2 = append(P_LOG, logBlock, '### 补充：F3-extension', '今日工作日志');

// ── 3) 用户级 MEMORY.md（跨项目工具教训）──
const uBlock = [
  '## 技术教训：多个 Edit 并发改同一文件会「丢失更新」(2026-09-20)',
  '',
  '在**一条消息里发多个 Edit** 改**同一个文件**的不同位置 → 全部返回 `Successfully edited`，',
  '但**落盘后只有部分生效**（后写覆盖先写）。实测：8 个 Edit 仅 2–3 个存活。',
  '',
  '**判据**：Edit 报成功 **≠** 落盘成功 —— **必须改完 grep 计数复核**。',
  '',
  '**解法**：同一文件的多处改动改为**一个脚本**串行精确替换，一次写盘：',
  '`s.split(from).length - 1` 计命中 → 全量替换 → 写盘 → 落盘后 grep 审计期望计数。',
  '**不同文件可并发；同一文件必须单一写者。**',
].join('\n');
const r3 = append(U_MEM, uBlock, '多个 Edit 并发改同一文件会「丢失更新」', '用户级 MEMORY.md');

console.log('\n══════ 汇总 ══════');
for (const [n, r] of [['项目 MEMORY.md', r1], ['今日日志', r2], ['用户级 MEMORY.md', r3]]) {
  console.log(`  ${n}: 应用 ${r.applied} / 幂等跳过 ${r.skipped} / 未命中 ${r.failed}`);
}
