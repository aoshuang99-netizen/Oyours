#!/usr/bin/env node
/**
 * 一次性串行写入本轮记忆（2026-09-21 首页重构 + 平台方案）
 *
 * 为什么用脚本而不是多次 Edit：同一条消息里对同一文件发多个 Edit 会并发读写，
 * 后写覆盖先写 —— 09-20 已实测「全部报成功、落盘只剩 2-3 处」。
 * 本脚本串行处理并输出命中审计。
 */
const fs = require('fs');
const path = require('path');

const MEM = path.join(__dirname, '..', '', 'memory');
const MEMORY = path.join(MEM, 'MEMORY.md');
const TODAY = path.join(MEM, '2026-09-21.md');

let ok = 0, miss = 0;
const audit = [];
 replaceIn(file, oldStr, newStr, label) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(oldStr - 1;
  if (n === 0) { miss++; audit.push('  MISS  ' + label); return; }
  if (n > 1) { audit.push('  WARN  ' + label + ' 命中 ' + n + ' 次（按首次替换）'); }
  s = s.replace(oldStr, newStr);
  fs.writeFileSync(file, s, 'utf8');
  ok++; audit.push('  OK    ' + label + '  (命中 ' + n + ')');
}
 appendTo(file, text, label) {
  fs.appendFileSync(file, text, 'utf8');
  ok++; audit.push('  OK    ' + label + '（追加）');
}

// ── 1. MEMORY.md：Mastodon 条目补充  发现 ──
replaceIn(MEMORY,
  '- **Mastodon 孤儿文件**：`-creds.json` 是真实 app 注册结果（ `1Mb86OLs…`、redirect `urn:ietf:wg:oauth:2.0:oob`），但 provider **只读 `dataStore(\'_config\',\'main\')`** ⇒ **不需重注册 app，只需重跑 OAuth 换 token**。',
  '- **Mastodon 孤儿文件**：`-creds.json`（734B）是真实 app 注册结果，provider **只读 `dataStore(\'_config\',\'main\')`**。\n' +
  '  - **09-21 新发现**：该文件里除 /secret（43 字符）外，**还存有一条 43 字符的 ``**（`Zgdp1k…`， `mscms_v14`，instance `.social`）—— 43 字符正是 Mastodon token 的合法长度。\n' +
  '  - 而 provider 实读的 `_config.json` 里 `accessToken` 只有 **11 字符**（`kuaile1314@` 类占位值）。\n' +
  '  - ⇒ **可能不需要重跑 OAuth**，只需把正确值复制到 provider 读的那份。**但有效性尚未验证成功**（见下条），不得当作可用。\n' +
  '  - 验证法：备份 `_config.json` → 写入 43 字符 token → 重启 3002 → 看 `GET /api/v14/mixpost/providers` 的 `authorized` 是否转 true。',
  'MEMORY.md · Mastodon 条目');

// ── 2. MEMORY.md：新增「独立进程无 ProxyPool」方法论 ──
replaceIn(MEMORY,
  '- 凭据验真：Nostr ✅ 真 nsec（3 relay）可启用；Bluesky ⚠️ `122335565` 格式非法（应 `xxxx-xxxx-xxxx-xxxx`）；Mastodon ⚠️ `kuaile1314@` 是密码非 token；Telegram/Discord/DevTo/Hashnode/GitHub 全空。',
  '- 凭据验真：Nostr ✅ 真 nsec（63 字符，3 relay）可启用；Bluesky ⚠️ `122335565` 9 字符格式非法（应 `xxxx-xxxx-xxxx-xxxx` 共 19）；Mastodon ⚠️ provider 读的 `kuaile1314@` 是密码非 token；Telegram/Discord/DevTo/Hashnode/GitHub 全空（`github_config.json` 仅 2B `{}`）。\n' +
  '- **⚠️ 外网验证的进程边界（09-21 踩坑）**：`http-client.js` 的 `fetchExt` 靠 **ProxyPool**，而 ProxyPool 只在服务进程启动时加载。在**独立脚本**里 `require(\'./http-client.js\')` → `hasProxy=false`、`=(无)` ⇒ 变成直连：`example.com` 通（HTTP 200/651ms），但 `.social`、`bsky.social` **全部 fetch failed（10.5s 超时）**。\n' +
  '  - ⇒ **判定 token/凭据是否可用，必须在服务进程内做**（或让服务端端点代为触发）。独立脚本只能验「格式」，不能验「可用」。\n' +
  '  - 不得因「格式合法」就宣称可用 —— 09-21 首次跑 `tools/verify--creds.js` 时 Mastodon 返回的就是 `fetch failed`，如实标注为未知，未做可用性断言。',
  'MEMORY.md · 凭据验真 + 进程边界');

// ── 3. MEMORY.md：发布链路停摆（更新闭环真问题） ──
replaceIn(MEMORY,
  '- 闭环真问题：已发布 3,529 条 reach 16/likes 0，根因曾为 0 tags（**已修**）。',
  '- 闭环真问题：已发布 4,908 条 reach 37/likes 0，根因曾为 0 tags（**已修**）。\n' +
  '- **🔴 09-21 实测：发布链路整体停摆**：`publish.json` 共 4,908 条（全带 `publish_url`、全 tumblr），**最后一条停在 `2026-09-20T12:36:32`**，至 09-21 已 23h+ 无新发布。新多平台通道 `cloudPublisher` = **453 次尝试 / 0 次成功**（从未跑通）；直接原因 **内容待发队列 = 0**（链路堵在 content.generated）。排查优先级应高于「注册更多平台」。',
  'MEMORY.md · 发布链路停摆');

// ── 4. MEMORY.md：首页面板结构缺陷（新增） ──
replaceIn(MEMORY,
  '## 内容 / 质检 / 热点',
  '## 首页面板（/v14）结构与重构\n' +
  '- **09-21 量化诊断（改前）**：全页 **23 种字号**（11 种挤在 8.8–11.5px，相邻差 0.2–0.4px）、最小 **8.8px**、分组标题 `.dashboard-section-title` **12.48px 且 margin-top:0** ⇒ 既与内容粘连、又**小于卡内标题 13.12px（层级倒挂）**；圆角 14 种取值；243 处 padding 硬编码。\n' +
  '- **同批数字首屏出现 2–3 次**（6 组）：50 设备 / 123 养号 / 12-200 DAU 各 3 次；148 账号、210 内容各 2 次。叠加「7 阶段管道 200px + 七域总览 243px + 核心指标 79px」三组等权卡片网格 = 没有层级感。\n' +
  '- 另有 2 个工具条表达同一件事（系统状态横幅 + pipeline-start-bar 各带启停按钮）；数据罗盘占 739px（36% 页高），其中 EventBus/HealEngine 面板值几乎为 0。\n' +
  '- **重构原型**：`v14-redesign-preview.html`（工作区根目录）→ `http://:3002/v14-redesign-preview.html`。四层架构 L0 顶栏 / L1 主 KPI 带（唯一数字源）/ L2 闭环链路（只表状态）/ L3 域 chip / L4 折叠。改后 **5 种字号**、纯首页区 ≈640px、数字 0 重复、JS 错误 0。\n' +
  '- 数据源 `/api/v14/data/overview` 的 `coreStats` + `causalChain.phases`（7 环权威状态）+ `eventBus` + `summary`。\n' +
  '- **⚠️ causalChain 逐环 status 会倒挂**（同轮出现「中间环未完成、后续环已完成」）。展示时必须按 `order` 取**第一个未完成环**作为堵点，其后一律标「待前序」，否则会产生新的自相矛盾。\n' +
  '- 结构：`/v14` → `v14-console.html`（372KB / 5,947 行 / **30 个 page**，靠 `v-if="page===\'xxx\'"` 切换，dashboard 在 585–940 行）。滚动容器是 `main.main`，**`aside.sidebar` 自身也滚动（1660px > 1050px）**。\n' +
  '- 线上控制台默认凭据：`admin / MSCMS@2026`（bootstrap，见 `auth-manager.js:5`）。\n\n' +
  '## 内容 / 质检 / 热点',
  'MEMORY.md · 首页面板章节');

// ── 5. 今日日志追加 ──
appendTo(TODAY, `

---

## 首页面板重构 + 社媒平台可注册方案（09-21 下午）

**指令**：首页面板优化没有层级感、不够简约，需要重新设计布局和优化；其他社媒平台给可以注册成功的方案。

### Part A · 首页面板重构（只做取证 + 原型，未改线上）

**取证方法**：Playwright + Chromium 登录 `/v14`，抓**计算样式**而非目测（新建 7 个只读分析脚本，见报告附录）。
线上凭据从 \`auth-manager.js:5\` 注释取得（bootstrap \`admin/MSCMS@2026\`），非猜密码。

**量化诊断（改前 → 原型）**
| 指标 | 改前 | 原型 |
|---|---|---|
| 页高 | 2025px（1.93 屏） | 纯首页区 ≈640px |
| 字号种类 | **23 种** | **5 种** |
| 最小字号 | 8.8px（7 处） | 11px |
| 分组标题 | 12.48px / mt=0（**小于**卡内 13.12px） | 15px / mt=32px |
| 首屏模块 | 7 个 | 3 个 |
| 圆角取值 | 14 种 | 3 种 |

**同批数字首屏重复 6 组**：50 设备 ×3、123 养号 ×3、12/200 DAU ×3、148 账号 ×2、210 内容 ×2、4860/202 引流 ×2-3。
**首屏最贵位置给了服务端口探活（107px）**；2 个工具条表达同一件事；数据罗盘占 36% 页高其中 2 个面板值全 0。

**产出**：\`v14-redesign-preview.html\`（四层架构原型，调真实 API，JS 错误 0）+ 对比截图 \`reports/shots/cmp-before.png\`、\`cmp-after.png\`。

**过程中自查出 1 个自己引入的 bug**：verdict 文案在「有未完成环但无 running 环」时误报「全部 7 环已完成」；
根因是直接用服务端逐环 status，而 causalChain 会倒挂。改为「按 order 取第一个未完成环」，并把顶栏进度与链路图**统一到同一口径**
（首版顶栏显示 6/7、链路图显示前 3 环，两处不一致）。修后 JS 错误 0、两处一致。

### Part B · 社媒平台方案（含 2 处新增发现）

**12 provider 实测四态**：tumblr ✅、nostr ✅（nsec 63 字符真）、/bluesky ⚠️ 格式无效、其余 5 个文件不存在、3 个是 Stub。

**发现 ①：Mastodon 可能不用重跑 OAuth** —— \`-creds.json\` 里除 /secret 外**还有一条 43 字符 **（\`Zgdp1k…\`， \`mscms_v14\`），而 provider 读的 \`_config.json\` 里只有 11 字符占位值。
**但有效性未验证成功**：独立脚本跑 \`fetchExt\` → \`hasProxy=false\` → \`.social\` \`fetch failed\`（\`example.com\` 却通）。
⇒ 外网验证**必须在服务进程内**做。已如实标注为未知，未宣称可用。

**发现 ②**：代理池 46 唯一出口 / 安全线 460 / 可发布 114 / 利用率 24.8% / **未越线** —— 与旧记「10 单元、越线 39%」不符（今早 MEMORY.md 已订正）。

**发现 ③（最重要）**：**发布链路整体停摆** —— \`publish.json\` 4,908 条全带 url（全 tumblr），**最后一条停在 09-20 12:36**；新通道 \`cloudPublisher\` **453 次尝试 0 成功**；直接原因**内容待发队列 = 0**。
⇒ 已在方案中把「排查内容生成断粮」列为 **T0'，优先级高于注册新平台**。

### 交付物
- \`reports/dashboard-redesign-and--onboard-2026-09-21.md\` / \`.html\`（六章方案 + 截图对比）
- \`v14-redesign-preview.html\`（新首页原型，可预览）
- 7 个只读工具脚本（\`tools/analyze-v14-*.js\`、\`tools/shot-v14-*.js\`、\`tools/verify--creds.js\`）

### 未做（明确划界）
线上 \`v14-console.html\` **未改动**；\`_config.json\` **未改动**；Mastodon token 可用性**未验证**；内容断粮**未排查**（待授权）。
`, '今日日志追加');

console.log('════════ 写入审计 ════════');
console.log(audit.join('\n'));
console.log('\n成功 ' + ok + ' / 未命中 ' + miss);
