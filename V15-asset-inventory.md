# OYours（原 MSCMS）V15 资产盘点报告

> 版本：V15 资产基线 ｜ 日期：2026-10-09 ｜ 目的：执行 V15 开发前先做资产盘点，避免**重复开发 / 过度开发 / 遗漏开发 / 主次不分开发**。

---

## 0. 盘点范围与方法

- **盘点对象**：工作区根目录 `C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\` 及 `tools/`、`providers/`、`D:\mscms-ws\data\`。
- **方法**：按文件名模式 + 既有记忆（已落地的管线、死实验、灰产模块）逐类归并，不做逐文件逆向（380+ 文件不可能逐一审计）。
- **处置四色**：
  - 🟢 **保留并升级**（核心 IP，V15 继续用）
  - 🔵 **开源复用**（应用层优先用成熟 OSS，不自研轮子）
  - 🟡 **合并收敛**（多份功能重叠，选 1 份为正、其余归档）
  - 🔴 **弃用/清理**（死实验、调试草稿、`.bak`、灰产/违规风险）

---

## 1. 资产总览（规模即问题）

| 类别 | 数量 | 说明 |
|---|---:|---|
| 根目录 `.js` | **177** | 含核心服务 + 大量草稿/调试/死实验 |
| `tools/*.js` | **143** | 运维/发布/体检/爬坡脚本，重叠严重 |
| 根 `.py/.sh` | 49 | QtScrcpy/Python 工具、hw 脚本 |
| `tools/*.py/.sh` | 13 | 同上 |
| `providers/*.js` | 10 | 第三方平台发布器 |
| `data/*.json` | ~60+ | 业务数据 + 大量 `.bak` |
| **合计脚本** | **≈382** | 一个"自动营销系统"不应有这么多顶层脚本 |
| `.git` / `.gitignore` | **0 / 0** | ⚠️ 无任何版本控制、无敏感文件忽略——严重安全与混乱隐患 |
| `.bak` 备份文件 | **23+** | 散落各处，污染工作区 |

**结论**：规模本身证明已存在**严重过度开发 + 重复开发**。V15 第一步不是"加功能"，而是**收敛资产、建立版本控制、砍掉死代码与灰产**，否则新开发必然在垃圾堆上叠垃圾。

---

## 2. 分类处置矩阵（速览）

| 处置 | 数量估 | 代表 |
|---|---:|---|
| 🟢 保留并升级 | ~80 | `server.js`、`data-store.js`、`account-*.js`、`content-gate.js`、`cloud-publisher.js`、`free--publisher.js`、`harvest-engagement.js`、`causal-chain-gate.js`、`real-dau.js` |
| 🔵 开源复用 | ~4（库） | `echarts.min.js`、`vue.global.prod.js`（已 vendored）；待引入 `winsw`、`git-crypt`、`DeviceFarmer/stf` |
| 🟡 合并收敛 | ~80 | proxy 家族(11)、dashboard 家族(15+)、-setup 家族(8)、audit 家族(8)、nurture 变体(5) |
| 🔴 弃用/清理 | ~120+ | nostr 全套(12)、cloak/stealth/gray 灰产(6)、`_*.js` 草稿(29)、`test/verify-*` 草稿(29)、`patch-*` 一次性(6)、`.bak`(23) |

---

## 3. 逐层明细

### 3.1 🟢 核心服务与基础设施（保留并升级）

| 文件 | 角色 | V15 动作 |
|---|---|---|
| `server.js` | 主服务 :3002 | 保留；端口/路由不动 |
| `data-store.js` | DataStore 内存优先+flush | 保留；是"改 C 盘再同步"铁律根因，V15 评估是否改 flush 策略 |
| `event-bus.js` / `services-registry.js` / `server-logger.js` | 基础设施 | 保留 |
| `http-client.js` | `fetchExt` 出网唯一通道（已修代理污染+熔断） | **保留且列为不可绕过通道**，V15 所有外发必须走它 |
| `session-manager.js` / `auth-manager.js` | 鉴权 | 保留；接安全模块 |
| `storage-paths.js` | 路径配置 | 保留；统一迁移到 D 盘 |

### 3.2 🟢 业务闭环（账号 / 内容 / 发布 / 度量）—— 这是真 IP，保留并加固

**账号矩阵（Rule 12）**
- `account-factory.js`、`account-manager.js`、`account-naming.js`、`account-nurturing.js`、`account-tracker.js`、`account-validator.js`、`auto-.js`、`migrate__phase0.js`、`fix-tumblr-binding.js`、`inspect_.js`、`create-tumblr-.js`
- 养号：`tumblr-nurture.js`（**唯一正选**）、`tumblr-nurture-device.js` / `-dryrun.js` / `-debug.js` / `-server.js`（🟡 收敛为调试模式，不独立存在）
- OAuth/绑定：`tumblr-onboard.js` / `-shardx.js` / `-single.js`、`tumblr-reauth.js`、`tumblr-oauth2.js`、`tumblr-recover-token.js`、`tumblr_apps_verify.js`
- 邮箱/短信：`gmail-.js`、`outlook-email.js`、`email-provider.js`、`5sim-sms.js`、`captcha-solver.js`、`registration-exits.js`、`reg-factory-helper.js`

**内容生产（Rule 6/7）**
- `aigc-content-generator.js`（Agnes LLM+生图接线）—— **保留，勿重建**
- `content-intelligence.js`、`content-media-bridge.js`、`content-media-ref.js`、`content-pipeline.js`、`content-pool.js`、`content--decider.js`、`content-tagger.js`
- `content-gate.js`（**2026-10-09 新建的发布前门禁，已接入 3 条外发路径**）—— **核心保留**
- `agnes-media.js`（生图）、`video-render.js`/`video-quality.js`/`video-scheduler.js`/`ffmpeg-processor.js`（视频管线）

**发布（Rule 4）**
- `cloud-publisher.js`（Tumblr 主发布器，live-lock 已修）、`tumblr-publisher.js`、`tumblr-batch-publish.js`
- `free--publisher.js`（**Mastodon 已实测 4/4 成功，加载 ``**）—— **V15 免费通道正选，勿重建**
- `free-proxy-pool.js`（**免费代理聚合+实测，正选**）、`free-proxy-rotator.js`（熔断器已修）
- `kk20-daily.js`、`hlua40-daily.js`（百日投放，已注入 hlua→kkmatch 改写）
- `social-publishing.js` / `social-bridge.js` / `social-provider-manager.js`（社交层）

**度量 / 真实 DAU（Rule 3）**
- `harvest-engagement.js`（互动回收，停摆 31 天已修复并挂定时器）、`engagement-harvester.js`、`reclaim-stale-queued.js`、`recover-engagement-all.js`
- `-metrics.js`（**新建，真实互动回收**）
- `real-dau.js`、`kkmatch-beacon.js`、`kkmatch-dau-report.js`、`data-provenance.js`、`website-analytics.js`
- `attribution-engine.js`、`conversion-engine.js`、`traffic-monitor-agg.js`、`traffic-router.js`、`dau-target-controller.js`、`visitor-profile-server.js`

**因果链（不同iator，必须保留）**
- `causal-chain-gate.js`、`causal-chain-manager.js`（7 阶段因果链，V15 核心卖点）

**编排 / 决策**
- `orchestrator.js`、`dag-orchestrator.js`、`decision-engine.js`、`decision-bridge.js`、`heal-engine.js`、`experiment-engine.js`、`proactive-marketing.js`、`trend-intel.js`、`loop-quality.js`、`watch_.js`

### 3.3 🟢 / 🔴 第三方 Provider（`providers/`）

| 文件 | 处置 | 理由 |
|---|---|---|
| `tumblr-provider.js` | 🟢 保留 | 主平台 |
| `-provider.js` | 🟢 保留 | 免费通道已通 |
| `bluesky-provider.js` | 🟢 保留（差 App ） | 待补凭据 |
| `-provider.js` / `discord-provider.js` | 🟢 保留 | 通知/引流 |
| `devto-provider.js` / `-provider.js` / `github-provider.js` | 🟡 待评估 | 开发者 SEO 通道，低成本，可留作 P2 扩量 |
| `nostr-provider.js` | 🔴 **弃用** | Nostr 是未落地的死实验，根/工具共 12 个文件，V15 计划无此平台 |

### 3.4 🔵 前端资产（开源复用）

- `echarts.min.js`（Apache ECharts）—— **OSS，保留**，统一从 npm/CDN 引入，勿手改 vendored 副本。
- `vue.global.prod.js`（Vue 3）—— **OSS，保留**，统一依赖管理。
- `v14-dash.html` / `v14-*.js` 等 dashboard 家族 —— 🟡 收敛（见 3.5）。

### 3.5 🟡 合并收敛集群（重点——重复开发的重灾区）

**A. Proxy 家族（11 份，留 1 弃 10）**
- ✅ 正选：`free-proxy-pool.js` + `free-proxy-rotator.js`（免费聚合+熔断，已修）
- ❌ 弃/归档：`proxy-pool.js`、`proxy-checker.js`、`proxy-creator.js`、`proxy-manager.js`、`proxy-pool-activator.js`、`proxy-pool-github-sync.js`、`proxy-pool-trusted-sync.js`、`proxy-socks-server.js`、`proxy-v2ray-manager.js`、`_working_proxies.json`、`_proxy_probe_result.json`
- 理由：v2ray/socks 是死方案；github-sync/trusted-sync 已被 `free-proxy-pool.js` 取代；creator 付费且坏。

**B. Dashboard 家族（15+ 份，留 1 弃余）**
- ✅ 正选：**V15 新建 1 个响应式 SPA（Rule 9/10）**
- ❌ 归档：`v14-chart.js`、`v14-realtime.js`、`v14-timeseries.js`、`v14-metrics-cache.js`、`check-dashboard.js`、`chaos-test-dash.js`、`b2-live-page-acceptance.js`、`b4-console-acceptance.js`、`b5-dash-acceptance.js`、`e2e-dash-verify.js`、`scan-dash.js`/`scan-dash-entry.js`/`scan-dash-panels.js`、`refactor-dash-menu.js`/`v2.js`、`verify-dash-v2.js`、`shot-dash*.js`、`analyze-v14-console.js`/`nav.js`/`pages.js`、`diag-subpages.js`、`sweep-pages.js`、`probe-dash-panels.js`、`nav-availability-probe.js`
- 理由：这些都是"给旧 dashboard 打补丁/截图/验证"的草稿，V15 直接重写一个 SPA 替代全部。

**C. Mastodon 接入家族（8 份，留 2 弃余）**
- ✅ 正选：`free--publisher.js`（加载 ``）+ `-metrics.js`
- ❌ 归档：`setup--auto.js`、`setup--credentials.js`、`setup--full.js`、`setup--credentials.js`、`-onboard.js`、`-oauth.js`、`-token-flow.js`、`-signup-recon.js`、`-instance-probe.js`、`verify--token.js`、`tools/-*.js`
- 理由：一次性的接入脚本，凭据已落 ``，无需再留 N 份 setup。

**D. Audit / 报告家族（8 份，留 1 弃余）**
- ✅ 正选：V15 新建 `tools/audit-integrity.js`（Rule 3 真实性审计，统一口径）
- ❌ 归档：`gen-audit-report.js`、`gen-publish-audit-report.js`、`gen-recovery-report.js`、`audit-real-publish.js`、`mscms-audit.js`、`mscms-dup-check.js`、`mscms-db-inspect.js`、`warehouse_audit.js`、`_audit2/3/4.js`、`_audit_s.js`、`_audit_real_publish.json`

**E. Nurture 变体（5 份 → 1）**
- ✅ 正选：`tumblr-nurture.js`（含 `--device/--dryrun/--debug` 参数化）
- ❌ 合并：`tumblr-nurture-device.js`、`tumblr-nurture-dryrun.js`、`tumblr-nurture-debug.js`、`tumblr-nurture-server.js` 入主文件

### 3.6 🔴 弃用 / 清理（必须砍——重复+风险+草稿）

**(a) 灰产 / 合规风险（直接违反 Rule 4/5/7，必须删除或隔离）**
- `cloaking-templates.js`、`cloak-wrapper.js` —— **cloak（隐匿/欺诈跳转）在 FTC 等司法辖区属违法，且触发平台封号，与留存目标(99%)根本冲突**
- `stealth-injector.js`、`stealth-.js` —— 规避检测注册，违反平台 ToS → 团灭风险
- `gray-analyze.js`、`gray-.js` —— "灰"注册/分析，同上
- `sensor-simulator.js`、`gps-trajectory.js`、`mobile-emulator.js` —— 设备指纹伪造（除非仅用于合规"真机环境模拟"，否则高风险；当前无合规用途说明 → 隔离待审）
- **处置**：移入 `quarantine/` 目录加 `RISK.md` 说明，禁止被 server.js 引用；V15 不开发任何灰产模块。

**(b) Nostr 死实验（12 文件，V15 无此平台）**
- `nostr-provider.js`（providers）、`nostr-e2e-test.js`、`nostr-provider-test.js`、`b1-nostr-probe.js`、`b1-nostr-publish.js`、`diagnose-nostr-gen.js`、`seed-nostr-content.js`、`test-nostr-proxy.js`、`verify-nostr-event.js`、`verify-nostr-publish.js`、`watch-nostr-closure.js`、`nostr_config.json`
- 处置：整体删除或归档到 `archive/dead-experiments/`。

**(c) 调试草稿 `_*.js / _*.json`（29+）**
- 例：`_audit2/3/4.js`、`_dau_daily_calc2.js`、`_e2e_verify.js`、`_kk20_verify.js`、`_parse_device_2026-09-14.js`、`_reconcile_a.js`、`_accel*.js`、`_ready_purity.json`、`_server300输入2.log`、`_status_after_2026-09-14.json`、`_tumblthree_src/`
- 处置：移入 `archive/scratch/`（保留可追溯，不污染主目录）。

**(d) 一次性迁移脚本 `patch-*`（6）**
- `patch-memory-2026-09-20.js`、`-21.js`、`-21b.js`、`patch-report-2026-09-20.js`、`patch-new-s-2026-09-21.js`、`patch-new-gen-2026-09-21.js`
- 处置：已执行完，归档到 `archive/migrations/`。

**(e) `.bak` 备份（23+）**
- 处置：移入 `archive/bak/` 或确认无用后删除；主目录零 `.bak`。

**(f) 冗余 test/verify 草稿（29）**
- 保留 E2E 级少量（`e2e-fullchain-test.js`、`diagnose-v14-system.js`、`_e2e_verify.js` 已归档）；其余 `test-*.js`/`verify-*.js`/`test_*.js`/`test.js`/`test_dash*.js`/`test_dau_pipeline.js` 归 `archive/scratch/`。

**(g) 疑似废弃**
- `smart-publisher.js`（被 `cloud-publisher`+`free-` 取代）、`merge_v3.js`、`delete_fake_db.js`、`purge_fake_.js`（清理已完）、`scrm-intercept.js`（用途不明）、`lok-dialogue.js`（LokAI 项目，超 OYours 范围）、`message-inbox.js`、`nav-config.js`
- 处置：逐个人工确认后归档。

### 3.7 数据资产（`D:\mscms-ws\data\`）

| 状态 | 文件 | 说明 |
|---|---|---|
| 🟢 活 | `.json`、`content.json`、`publish.json`、`analytics.json`、`post_metrics.json`、`nurture.json`、`.json`、`_config.json`、`bluesky_config.json`、`device_jobs.json`、`cloud_phones.json`、`dau_log.json`、`traffic*.json`、`campaign_logs.json` | 业务权威数据 |
| 🔴 死/实验 | `nostr_config.json`、`mixpost_*.json`（被弃的 mixpost 替代）、`experiments.json`、`github_config.json`（provider 未启用）、`_tombstones.json`、`__deadlist.json`、`registration-ledger.jsonl`、`promo_sites.json` | 清理或归档 |
| ⚠️ 敏感 | ``（根）、`proxy-pool.json`（含代理）、`credentials-input.json` | **必须进 `.gitignore` + git-crypt 加密**（当前裸奔） |
| 🔴 备份 | `*.bak-*`、`content.bak-*`、`.json.bak_*` | 归档到 `backups/` 或删除 |

---

## 4. 开源复用清单（明确"哪些是 OSS、怎么用"）

| 资产 | 类型 | 当前状态 | V15 用法 |
|---|---|---|---|
| `echarts.min.js` | 图表 OSS | 已 vendored | 统一 npm/CDN 引入，SPA 图表层 |
| `vue.global.prod.js` | 框架 OSS | 已 vendored | 统一依赖管理（或改用构建版） |
| `winsw/winsw` | 服务化 OSS | **未引入** | P0 替代 `_autostart_mscms.bat`，做 Windows 服务 |
| `AGWA/git-crypt` | 密钥加密 OSS | **未引入** | P0 加密 `` 等敏感文件 |
| `DeviceFarmer/stf` + `openatx/atxserver2` | 云真机管控 OSS | 未引入 | P2 云手机矩阵（Rule 11/12） |
| `appium/appium` | 移动自动化 OSS | 规划中 | P2 真机 App 操作 |
| `berstend/puppeteer-extra` + `stealth` | Web 反检测 OSS | 未引入（有手搓 stealth-* 灰产，应删） | 仅合规 Web 注册场景，且删掉手搓 stealth |
| `mozilla/sops`（备选） | 密钥加密 OSS | 未引入 | git-crypt 备选 |

**原则**：凡有成熟 OSS 的环节（服务化、加密、云真机、图表、框架）一律复用，不自己造；手搓的 `stealth-*`/`cloak-*` 不仅重复且**违规**，直接删。

---

## 5. 需要"优化掉"的动作清单（落地即用）

1. **建版本控制 + 安全基线（P0 第一刀）**：`git init` → 写 `.gitignore`（忽略 ``、`credentials-input.json`、`proxy-pool.json`、`*.bak`、`archive/`）→ `git-crypt init` 加密敏感文件。
2. **建 `archive/` 三级目录**：`archive/dead-experiments/`（nostr）、`archive/scratch/`（_*.js、test/verify 草稿）、`archive/migrations/`（patch-*）、`archive/bak/`。
3. **删灰产**：`cloaking-*`、`cloak-wrapper.js`、`stealth-injector.js`、`stealth-.js`、`gray-*.js` 移 `quarantine/`，加 `RISK.md`，禁止 server.js 引用。
4. **收敛 proxy**：仅留 `free-proxy-pool.js` + `free-proxy-rotator.js`，其余 proxy-* 归档。
5. **收敛 dashboard**：旧 dashboard 全家族归档，V15 只建 1 个响应式 SPA。
6. **收敛 /audit/nurture**：各留正选，其余归档。
7. **清理 `.bak` 与 `_*` 草稿**：移 `archive/`。

---

## 6. 对 V15 开发任务的影响（直接回应"四不"）

- **不重复开发**：已有 `free--publisher.js`（Mastodon 实测通）、`content-gate.js`（门禁通 3 路）、`harvest-engagement.js`（回收通）、`real-dau.js`/`kkmatch-beacon.js`（DAU 口径）—— **V15 加固这些，不重建。**
- **不过度开发**：
  - 灰产（`cloak/stealth/gray`）、Nostr 死实验 → **直接删除，不做**。
  - 不写第 6 套 dashboard → 只写 1 个 SPA。
  - 不重复造 proxy 管理器 → 只留 1 个。
- **不遗漏开发**：V15 真正缺的（盘点暴露）：**版本控制/密钥加密（当前 0）、看门狗不误杀、响应式单 SPA、自愈编排、双线监控、云真机矩阵接入**——这些才是 P0/P1 重点。
- **主次分明**：先止血（安全+收敛+看门狗），再加固已通管线（内容/发布/度量），最后扩量（免费通道+云真机）。不在地基没稳时上新平台。

---

> 配套文档：`V15-plan.md`（基于本盘点重排的开发任务）。
