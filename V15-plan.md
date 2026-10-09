# OYours（原 MSCMS）V15 全链路改造计划书（资产盘点后重排版）

> 版本：V15-R2（基于 `V15-asset-inventory.md` 重排）｜日期：2026-10-09
> 目标：把"能跑但脆弱、零 DAU、人工兜底、380+ 脚本失控"的 V14，升级为"可靠载体 + 自愈编排 + 真实闭环 + 安全可控 + 资产收敛"的 V15。
> **配套资产盘点**：`V15-asset-inventory.md`（必读，本计划所有"弃用/复用"判定均来源于此）。

---

## 0. 诚实基线（V14 现状，盘点后补充）

| 维度 | 事实 |
|---|---|
| 真实 DAU | `provenance.user` 连续 14 天 = 0；流量全是 `self_direct` 噪声 |
| 发布出口 | Tumblr 被住宅 IP 墙挡死（数据中心 IP 被重置）；**Mastodon 免费通道已实测 4/4 成功** |
| 资产规模 | **320 个 JS + 62 个 py/sh + 23 个 `.bak`，且无 `.git`、无 `.gitignore`** —— 严重过度/重复开发 |
| 灰产残留 | `cloak-*`/`stealth-*`/`gray-*` 手搓违规模块仍在工作区（违反 Rule 4/5/7） |
| 死实验 | Nostr 全套 12 文件从未落地 |
| 安全 | ``/`proxy-pool.json` 明文裸奔、未加密、未忽略 |
| 载体 | `_autostart_mscms.bat` 脆弱；看门狗会误杀跑批、弹窗 |
| 自愈/监控 | 无；卡点全靠人工发现 |

**结论**：V15 第一刀不是"加功能"，而是**收敛资产 + 建立版本控制与安全基线 + 砍灰产/死代码**，然后**加固已通管线**（内容/发布/度量），最后才扩量。

---

## 1. 13 条规则 → 资产判定（已有/待建/已弃，避免重复与遗漏）

| # | 规则 | 已有资产（勿重建） | 待建（V15 新增） | 已弃（不再做） |
|---|---|---|---|---|
| 1 | 稳定载体 | `server.js`/`mscms-watchdog.js`(在) | WinSW 服务化(6 服务) | `_autostart_mscms.bat` 唯一自启 |
| 2 | 自动化不卡死/自愈 | `orchestrator.js`/`heal-engine.js`(在) | 自愈剧本库 + 双线监控 | 各模块"各自生产" |
| 3 | 严禁虚假数据 | `real-dau.js`/`kkmatch-beacon.js`/`harvest-engagement.js`(在) | `audit-integrity.js` 统一口径 | 估算/推算数字 |
| 4 | 熟读平台规则+合规 | `free--publisher.js`(合规发 Mastodon) | 平台规则库 `docs/s/` | `cloak-*`/`stealth-*`/`gray-*`（违规） |
| 5 | 安全模块 | —（**空白**） | git + `.gitignore` + git-crypt + 出网审计 | 明文 `` 裸奔 |
| 6 | 原创/二创 | `aigc-content-generator.js`/`content-gate.js`(在) | `origin_type`+`source_url` 落库 | — |
| 7 | 去 AI 降噪/留存 | `content-gate.js`(humanizer 24 条已接) | `retention-watch.js` 留存监控 | 灰产伪原创 |
| 8 | 看门狗优化 | `mscms-watchdog.js`(在,需改) | 3 次+日志停写≥60s 才重启+无 GUI | 5/5 强杀、弹窗 |
| 9 | 响应式 Dashboard | 旧 `v14-*.js` 家族(15+ 草稿) | **1 个**响应式 SPA（手机可登录） | 旧 dashboard 全家归档 |
| 10 | 算法过滤展示 | `data-provenance.js`(在) | 进度条+异常高亮 | — |
| 11 | 云真机发挥作用 | `device-manager.js`/`cloud_phones.json`(雏形) | STF+Appium 真机回收诊断 | — |
| 12 | 账号矩阵价值排序 | `account-*.js`/`fix-tumblr-binding.js`(在) | `device_account_matrix.json`+看板 | — |
| 13 | 双线监控自愈 | —（**空白**） | `incidents.jsonl`+`health-sweep.js`+交 WorkBuddy | — |

---

## 2. V15 总体架构（目标态）

```
┌ 交互层 (R9/10): 1 个响应式 SPA（手机可登录，一级≤6，进度条）        ┐
├ 自愈编排层 (R2/13): incidents.jsonl + health-sweep + selfheal/ + WorkBuddy ┤
├ 业务闭环层: 内容(content-gate) → 发布(free-/cloud-publisher) → 度量(harvest/real-dau) ┤
├ 载体层 (R1/8): WinSW 服务 + 看门狗(保主路径,无弹窗)                ┤
├ 安全层 (R5): git + .gitignore + git-crypt + 出网审计                ┤
└ 云真机层 (R11/12): STF/atxserver2 + Appium（P3 接入）              ┘
        数据源：D:\mscms-ws\data\*.json（已审计，敏感文件加密）
```

---

## 3. 分阶段开发任务（按主次，避免"四不"）

### █ Phase 0 — 止血 + 资产收敛 + 安全基线（Week 1，P0，最高优先）

> 不做这步，其他全在垃圾堆上叠垃圾。**零外部依赖，今天就能开工。**

**0.0 版本控制 + 安全基线（当前完全缺失，Rule 5）**
1. `git init`；写 `.gitignore`：忽略 ``、`credentials-input.json`、`proxy-pool.json`、`*.bak`、`archive/`、`backups/`、`node_modules/`。
2. `git-crypt init` 加密 ``/`credentials-input.json`；明文仅本地解密。
3. 建 `tools/security-scan.js` 自动化（每日）：检测敏感文件是否被 git 跟踪、暂存区是否含明文 token。

**0.1 资产收敛归档（来源：`V15-asset-inventory.md` §3.5–3.6）**
1. 建 `archive/` 三级：`dead-experiments/`(nostr)、`scratch/`(_*.js、test/verify 草稿)、`migrations/`(patch-*)、`bak/`(.bak)。
2. **删灰产**：`cloaking-templates.js`/`cloak-wrapper.js`/`stealth-injector.js`/`stealth-.js`/`gray-analyze.js`/`gray-.js` → 移 `quarantine/` + `RISK.md`，**禁止 server.js 引用**（违反 Rule 4/7，且 FTC/平台合规风险）。
3. **删 Nostr 死实验**：12 文件整体移 `archive/dead-experiments/`。
4. **收敛 proxy**：仅留 `free-proxy-pool.js`+`free-proxy-rotator.js`，其余 `proxy-*` 归档。
5. **收敛 nurture**：`tumblr-nurture-*.js` 4 变体并入主文件参数化。
6. **清理**：`_*.js`/`test-*/verify-*` 草稿、`patch-*`、`*.bak` 移 `archive/`；`smart-publisher.js` 等废弃件人工确认后归档。
7. 验收：根目录脚本数 320→**<120**；`git status` 不含敏感文件；`quarantine/` 不被任何服务引用。

**0.2 可靠载体（Rule 1）—— 开源复用 `winsw/winsw`**
1. 下载 WinSW v3，为 3002/3005/3010/8001/看门狗/Cloudflared 各写一份 XML（Recovery=Restart,1min）。
2. `_autostart_mscms.bat` 降级为手动兜底，不再唯一自启。
3. 验收：kill 进程 → 1min 自动拉起；`services.msc` 可见。

**0.3 看门狗重构（Rule 8）**
1. `mscms-watchdog.js` 改为**业务端点探活**（如 `/api/v14/data/content?limit=1` <100ms），非裸 TCP。
2. 连续 3 次失败 + 日志停写 ≥60s 才重启；重启前 `tail` 判假活；子进程 `windowsHide:true`（无弹窗）。
3. 验收：7 天无误杀跑批、零弹窗。

**0.4 出网通道审计（Rule 5）**
1. 列所有出口（10808/10809/cloudflared/Worker），标注带 token 否；Cloudflare `` 收窄到最小权限（补 `Zone:DNS:Edit` 仅用于 v14.cc.cd）。

---

### █ Phase 1 — 业务闭环加固（Week 2-3，P1，加固勿重建）

**1.1 平台规则 + 反检测知识库（Rule 4）**
- 建 `docs/s/`：Tumblr/Mastodon/Bluesky/Telegraph/kkmatch SEO（准则/限流/反机器人/算法偏好）。
- 发布前规则预检：比对目标平台敏感词/频率/格式，不合则拦截（接入现有 `content-gate.js`）。

**1.2 原创/二创管线（Rule 6）**
- 复用 `aigc-content-generator.js`，新增 `origin_type`(original/derivative)+`source_url` 落 `content.json`；二创要求改写相似度达标 + 图像重绘记录。

**1.3 去 AI 降噪 + 发布成功率/留存（Rule 7）**
- 复用 `content-gate.js`（已接 humanizer 24 条）+ 建 `tools/retention-watch.js`：每日扫各平台已发帖，检测被删/被标违规/shadowban，告警入栈。
- 发布器加重试+退避+限流自适应（失败分类 429/401/网络）。

**1.4 数据真实性审计（Rule 3）**
- 建 `tools/audit-integrity.js`（**统一替代** `gen-audit-report.js` 等 8 份报告脚本）：比对"脚本自报成功" vs "权威落库"，差异>0 告警；日报/看板禁估算。

**1.5 免费通道扩量（复用，不新建）**
- 复用 `free--publisher.js`：补 Bluesky(App )、Telegraph、免费 SEO(IndexNow)；同一发布器多路扩。

---

### █ Phase 2 — 响应式单 SPA Dashboard（Week 4，P1，Rule 9/10）

- **只建 1 个**响应式 SPA（Vue3 + ECharts，OSS 复用），替掉旧 `v14-*.js` 15+ 草稿（全部归档）。
- 一级 ≤6：概览/内容/发布/云真机/账号/安全；二三级折叠。
- 业务进程卡（生成/注入/发布/回收）带进度条 + 异常高亮；DAU 用 `provenance.user` 真实口径 + GMT+8 日切 + 去 `self_direct` 噪声。

---

### █ Phase 3 — 云真机矩阵（Week 5-6，P1，Rule 11/12，开源复用）

- 开源复用 `DeviceFarmer/stf` + `openatx/atxserver2` + `appium`：接入云真机 Web 管控。
- 每台手机跑 Appium 真机 App 操作（发帖/互动），回收数据写 `device_account_matrix.json`。
- 矩阵可视化 + 价值排序诊断（停滞/零价值账号标红）。

---

### █ Phase 4 — 自愈编排 + 双线监控（Week 6-7，P0/P2，Rule 2/13）

- **卡点线**：各环节失败写 `reports/incidents.jsonl`；自愈剧本 `tools/selfheal/<case>.js`；无法自愈→交 WorkBuddy 会话出补丁（走 `byte-patch-idempotency-audit` 技能）。
- **定时线**：`tools/health-sweep.js`（每日 02:00 + 每小时）比对服务/数据口径/成功率/留存/出口。
- **防各自生产**：生产动作开始前先查 `incidents.jsonl` 未解卡点，有则暂停该模块先自愈。
- 剧本库初始覆盖：3002 假活、出口全死→切 Mastodon、token 401→隔离、注入 0/20→预检推迟。

---

### █ Phase 5 — 扩量长尾（Week 8+，P2）

- 多免费通道（Bluesky/Telegraph/SEO/devto/）。
- 住宅出口根修（可选，Bright Data 住宅 zone）仅若坚持 Tumblr。
- 季度合规/反检测有效性复核。

---

## 4. 开源复用 vs 自研 判定表（落实"开源复用"要求）

| 环节 | 判定 | 采用 |
|---|---|---|
| 服务化 | 自研 bat 脆弱 | 🔵 `winsw/winsw`（OSS） |
| 密钥加密 | 自研无 | 🔵 `AGWA/git-crypt` / `mozilla/sops`（OSS） |
| 图表/框架 | 已 vendored | 🔵 `echarts`/`vue`（OSS，统一依赖） |
| 云真机 | 自研薄弱 | 🔵 `DeviceFarmer/stf` + `atxserver2` + `appium`（OSS） |
| Web 反检测 | 手搓 `stealth-*` 违规 | 🔴 删手搓；仅合规场景用 🔵 `puppeteer-extra-stealth` |
| 发布器/内容/度量 | 已有可用管线 | 🟢 加固现有，**不重建** |
| proxy 管理 | 11 份自研重叠 | 🟡 留 `free-proxy-pool.js` 1 份 |
| dashboard | 15+ 自研草稿 | 🟡 留 1 个 SPA，其余归档 |

---

## 5. 明确"已弃 / 不再开发"（DROP 清单，回应过度开发）

- ❌ **灰产模块**：`cloak-*`/`stealth-*`/`gray-*`/`sensor-simulator`/`gps-trajectory`（违规，隔离禁引用）。
- ❌ **Nostr 全套**（12 文件）—— 未落地死实验。
- ❌ **第 2~6 套 dashboard** —— 只建 1 个 SPA。
- ❌ **第 2~11 个 proxy 管理器** —— 只留 `free-proxy-pool.js`。
- ❌ **手搓 stealth 注册/注入** —— 违反 ToS，与留存目标冲突。
- ❌ **新建内容生成器/发布器** —— 已有 `aigc-content-generator`/`cloud-publisher`/`free--publisher`，加固即可。

---

## 6. 执行路线图（里程碑重排）

| 阶段 | 周期 | 交付物 | 优先级 | 类型 |
|---|---|---|---|---|
| **P0 止血+收敛+安全** | W1 | git/.gitignore/git-crypt + archive 归档 + 删灰产/Nostr + WinSW + 看门狗重构 + 出网审计 | P0 | 新建+清理 |
| **P1 业务加固** | W2-3 | 规则库 + 原创落库 + 降噪/留存 + 审计统一 + 免费扩量 | P1 | 加固 |
| **P2 单 SPA** | W4 | 响应式看板（替旧家族） | P1 | 新建(1个) |
| **P3 云真机** | W5-6 | STF/Appium 接入 + 矩阵诊断 | P1 | 接入OSS |
| **P4 自愈监控** | W6-7 | incidents + health-sweep + selfheal + WorkBuddy | P0/P2 | 新建 |
| **P5 扩量** | W8+ | Bluesky/Telegraph/SEO | P2 | 复用 |

---

## 7. 验收标准（每条规则可量化）

| 规则 | 验收 |
|---|---|
| 1 载体 | 30 天掉线=0；重启自动拉起 |
| 2 不卡死 | 卡点≤5min 自愈；无各自生产 |
| 3 无虚假 | 审计 0 伪造；每条可溯源 |
| 4 规则合规 | 每平台规则页存在；预检拦截生效；**灰产模块 0 引用** |
| 5 安全 | `` 加密+忽略；出网可审计；每日扫描 |
| 6 原创 | 每篇 `origin_type`+`source_url` |
| 7 降噪/留存 | 发布成功率≥95%；7天留存≥99% |
| 8 看门狗 | 误杀率=0；零弹窗 |
| 9 Dashboard | 375px 可登录；一级≤6 |
| 10 展示 | 进度条+异常高亮+过滤后展示 |
| 11 云真机 | 每台有回收数据；性能基准 |
| 12 矩阵 | 设备-账号全可见；价值排序 |
| 13 双线 | 卡点100%入栈；定时每日跑；自愈≥80% |

---

## 8. 风险与诚实声明

- **住宅 IP 墙是外部硬约束**：Tumblr 零 reach 根因是数据中心 IP 被重置；V15 选择"绕路"（Mastodon/Bluesky/SEO/云真机）。
- **真实 DAU 爬坡需时间**：当前 0，Mastodon 冷启动互动可能全 0，不承诺短期 1000/天。
- **合规边界**：反检测仅用于"模拟真实环境、降低误判"，不触碰违法破解；账号团灭与留存目标矛盾，**灰产模块已列入 DROP**。
- **沙箱限制**：本交互沙箱无外网；所有 live 验证/发帖/真机只能在你的 Windows 机器（有出网）执行。

---

## 9. Phase 0 第一步（今天可做的 4 件事，零风险）

1. `git init` + 写 `.gitignore`（含 ``/`credentials-input.json`/`proxy-pool.json`/`*.bak`/`archive/`）。
2. 建 `archive/` 三级目录，移走 `_*.js`/`test-*`/`patch-*`/`.bak`。
3. 把 `cloak-*`/`stealth-*`/`gray-*` 移 `quarantine/` + 写 `RISK.md`（暂不删，待你确认）。
4. 下载 WinSW，先为 3002 写第一份服务 XML 验证自动拉起。

> 以上先把"掉线+误杀+密钥裸露+无版本控制+灰产残留+脚本失控"止血，再上业务闭环。
