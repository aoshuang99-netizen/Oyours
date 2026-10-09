#!/usr/bin/env node
/**
 * 原子补丁：把「可注册/可激活的新平台」接入 v14 真实发布链路
 * 日期：2026-09-21
 *
 * 背景（全部为实测证据，非推断）：
 *   nostr provider configStatus() 返回 configured=true / authorized=true，
 *   但 publish.json 全 5040 条**只有 tumblr**，nostr 0 投放。
 *   三层根因：
 *     ① 网络层：providers/nostr-provider.js getWsDispatcher() 只读 HTTP_PROXY，
 *        而生产 env 该变量为空 ⇒ relay wss 直连被 GFW 拦。（已在本轮单独修复）
 *     ② 发布闸门层：cloud-publisher.js:1189 `if (!config)` 位于 provider 分支（:1530）**之前**，
 *        PlatformPublishConfig 无 nostr 条目 ⇒ 直接判 Unsupported 并 return ⇒ provider 分支不可达。
 *     ③ 生成侧：server.js allPlatforms 硬编码 7 平台（无 nostr）⇒ 永无 ='nostr' 的内容
 *        ⇒ S4 的 filter:{:'nostr'} 恒 0 条。
 *
 * 纪律：单脚本串行替换（避免并发 Edit 丢失更新）+ 幂等闸门 + 命中计数审计。
 */
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

const EDITS = [
  // ── P1：发布闸门放行 provider 通道平台 ────────────────────────────────
  {
    file: 'cloud-publisher.js',
    name: 'P1 发布闸门：provider 通道平台不受 PlatformPublishConfig 约束',
    from: '    if (!config) {\n      task.status = PublishStatus.FAILED;\n      task.error = `Unsupported : `;',
    to: '    // 【2026-09-21 P0】provider 通道平台（nostr/bluesky///discord/devto//github）\n'
      + '    // 在 PlatformPublishConfig 里**没有**条目 —— 那张表是**浏览器自动化选择器**配置，与 API provider 无关。\n'
      + '    // 旧逻辑在此直接判 Unsupported 并 return，而 provider 分支排在本行之后（约 :1530）\n'
      + '    // ⇒ **provider 分支永远不可达**。实证：nostr 凭据 authorized=true 却从未被调用过一次。\n'
      + '    // 修法：provider 通道平台跳过该校验，交给下游 _isProviderChannel 分支处理。\n'
      + '    if (!config && !this._isProviderChannel()) {\n'
      + '      task.status = PublishStatus.FAILED;\n'
      + '      task.error = `Unsupported : `;',
    marker: 'if (!config && !this._isProviderChannel())',
  },
  // ── P2：生成侧平台池接入真实可发布通道 ──────────────────────────────
  {
    file: 'server.js',
    name: 'P2 生成侧：30% 配额从「无通道平台」改为「真实 provider 通道」',
    from: "        const others = ['reddit', 'instagram', 'tiktok', 'x', 'discord', 'facebook'];",
    to: "        // 【2026-09-21】others 原为 6 个「无真实发布通道」的平台\n"
      + "        // （reddit/instagram/tiktok/x/discord/facebook —— 既无 provider 实现也无真实账号），\n"
      + "        // 那 30% 生成配额全部堆积在 ready 池（无通道可发，ready 池曾达 3035 条）。\n"
      + "        // 改为指向**真实可发布通道**，使新平台能真正进入生成→发布闭环。\n"
      + "        // env MSCMS_CONTENT_OTHERS 可覆盖（逗号分隔，如 'nostr,bluesky,'）。\n"
      + "        const others = String(process.env.MSCMS_CONTENT_OTHERS || 'nostr')\n"
      + "          .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);",
    marker: "MSCMS_CONTENT_OTHERS",
  },
  // ── P3：诊断用支持列表补齐 provider 通道平台 ─────────────────────────
  {
    file: 'server.js',
    name: 'P3 支持平台列表补 provider 通道平台（诊断/日志口径）',
    from: "    const SUPPORTED_PUBLISH_PLATFORMS = ['reddit', 'x', 'twitter', 'instagram', 'tiktok', 'facebook', 'discord', 'tumblr'];",
    to: "    // 【2026-09-21】补齐 provider 通道平台，使日志里的「支持列表」与实际可发布通道一致\n"
      + "    // （仅用于诊断打印，不参与闸门判定；真正的闸门是 REAL_CHANNELS ∩ _providerChannels）。\n"
      + "    const SUPPORTED_PUBLISH_PLATFORMS = ['reddit', 'x', 'twitter', 'instagram', 'tiktok', 'facebook', 'discord', 'tumblr',\n"
      + "      'nostr', 'bluesky', '', '', 'devto', '', 'github'];",
    marker: "'', 'devto', '', 'github'",
  },
  // ── P4：平台→账号映射补齐 provider 通道平台 ──────────────────────────
  {
    file: 'server.js',
    name: 'P4 PLATFORM_TO_ACCOUNT 补 provider 通道平台映射',
    from: "    const PLATFORM_TO_ACCOUNT = { 'x': 'twitter', 'twitter': 'twitter', 'reddit': 'reddit', 'instagram': 'instagram', 'tiktok': 'tiktok', 'discord': 'discord', 'facebook': 'facebook', 'tumblr': 'tumblr' };",
    to: "    // 【2026-09-21】补 provider 通道平台映射（缺失时兜底会落到 Arr[0]，\n"
      + "    // 固定绑定同一个 tumblr 账号 → 若该账号 token 失效则新平台内容永不入队）。\n"
      + "    const PLATFORM_TO_ACCOUNT = { 'x': 'twitter', 'twitter': 'twitter', 'reddit': 'reddit', 'instagram': 'instagram', 'tiktok': 'tiktok', 'discord': 'discord', 'facebook': 'facebook', 'tumblr': 'tumblr',\n"
      + "      'nostr': 'nostr', 'bluesky': 'bluesky', '': '' };",
    marker: "'nostr': 'nostr', 'bluesky': 'bluesky', '': ''",
  },
];

const audit = [];
for (const e of EDITS) {
  const fp = path.join(WS, e.file);
  const src = fs.readFileSync(fp, 'utf8');

  // 幂等闸门
  if (src.includes(e.marker)) {
    audit.push({ file: e.file, name: e.name, status: 'SKIP(已存在)', hits: (src.split(e.marker - 1) });
    continue;
  }
  const hits = src.split(e.from - 1;
  if (hits !== 1) {
    audit.push({ file: e.file, name: e.name, status: `FAIL(锚点命中 ${hits} 次，期望 1)`, hits });
    continue;
  }
  if (DRY) { audit.push({ file: e.file, name: e.name, status: 'DRY-OK', hits }); continue; }

  const next = src.replace(e.from, e.to);
  // 落盘前校验：替换后必须包含 marker，且长度增加
  if (!next.includes(e.marker) || next.length <= src.length) {
    audit.push({ file: e.file, name: e.name, status: 'FAIL(替换后校验未通过)', hits });
    continue;
  }
  fs.writeFileSync(fp + '.bak-20260921', src, 'utf8');   // 备份
  fs.writeFileSync(fp, next, 'utf8');
  audit.push({ file: e.file, name: e.name, status: 'APPLIED', hits });
}

console.log('=== 补丁审计 ===');
for (const a of audit) console.log(` [${a.status}] ${a.file} :: ${a.name}`);
const failed = audit.filter((a) => a.status.startsWith('FAIL'));
console.log(`\n应用 ${audit.filter((a) => a.status === 'APPLIED'} / 跳过 ${audit.filter((a) => a.status.startsWith('SKIP')} / 失败 ${failed.length}`);

// ── 复核：全仓出现点必须同源（防「同一变量的 N 处只改 1 处」的老坑）──
console.log('\n=== 落盘复核（grep 计数）===');
const checks = [
  ['cloud-publisher.js', 'if (!config && !this._isProviderChannel())', 1],
  ['server.js', 'MSCMS_CONTENT_OTHERS', 1],
  ['server.js', "'nostr', 'bluesky', ''", 2],   // P3 与 P4 各一处
];
let okAll = true;
for (const [f, pat, expect] of checks) {
  const s = fs.readFileSync(path.join(WS, f), 'utf8');
  const n = s.split(pat - 1;
  const ok = n >= expect;
  if (!ok) okAll = false;
  console.log(` ${ok ? '✅' : '❌'} ${f} «${pat}» = ${n} (期望 ≥${expect})`);
}
console.log(okAll ? '\n全部复核通过' : '\n⚠️ 有复核项未通过');
process.exit(failed.length ? 1 : 0);
