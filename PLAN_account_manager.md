# MSCMS v14 — 账号管理模块详细计划 **v3**

> **状态：待确认（未执行任何代码改动）。** 相对 v2 的关键升级：复用既有成熟模块（而非重建）、新增「发布端口可选设备」、把 7 阶段因果链智能下沉到每一个末梢（账号/设备/帖子/内容/消息）、以 `event-bus` 为总线打通全闭环、并补齐产品与架构性能优化。
> 参考：DeviceFarmer/STF、Airtest/Appium、Nestbox（一机一号·独立指纹/出口 IP）、BrightBean（magic-link + 健康度）、CreatorHub（一号一环境隔离）、Appilot（健康监控+异常暂停）、clickfarm（注册→验证流水）、Cue（连接健康一等公民）。

---

## 一、现状盘点（基于真实代码，已建 / 缺口）

### 已建成的成熟模块（直接复用，不重建）
| 模块 | 现状 | 与账号管理的接口 |
|---|---|---|
| `device-manager.js` | **50 台云手机**，`EMULATOR`(LDPlayer) / `BROWSER`(Playwright) 双模式，ADB、分批启动、健康检查、指纹注入、代理绑定、截图 | `devices` Map 即设备注册表；`browserContexts` 即移动端 App 执行上下文 |
| `cloud-publisher.js` | 云手机智能发布引擎，`_getDevice(task)` **已支持 `task.deviceId` → `account.` → 选空闲设备**；含安全检查/模拟真人/失败重试/审计 | 设备选择能力已具备，只差「暴露到管理面板 + 自动内容编辑任务显式带 deviceId」 |
| `causal-chain-gate.js` | 7 阶段严格门控（S1→S7），`autoAdvance`、停滞守卫 120s、`incrementProgress/advanceTo` | 作为系统「神经系统」，进度需与账号/设备明细双向绑定 |
| `causal-chain-manager.js` | 30s 轮询 + 事件监听 + 链监控，自动触发 7 条因果事件 | 钩入账号/设备/帖子事件 |
| `event-bus.js` | 统一事件总线，7 因果事件 + `heal.error/recovered`，事件日志(500)、stats | 全闭环总线 |
| `decision-engine.js` | RL-LLM-AB 混合、Q-learning、Thompson/Epsilon-Greedy、Content DNA 进化、5 维自适应学习 | 每个决策点（发什么/何时/用哪台设备/养号强度）的动作源 |
| `content-pipeline.js` | AIGC + 去 AI 味 + A/B + 热点 + 内容日历 + 质量评分 | 内容生成/编辑 → 进入带 deviceId 的发布队列 |
| `tumblr-nurture.js` + `tumblr-nurture-device.js` | **ephemeral** 移动设备池（懒启动、会话后回收，空闲零占用） | 养号执行层，天然省内存 |
| `heal-engine.js` / `dag-orchestrator.js` / `dau-target-controller.js` / `channel-health.js` | 自愈 / DAG 编排 / DAU 目标 / 渠道健康 | 异常恢复与编排 |

### 仍存在的缺口（v3 要补）
1. **无中央 `AccountManager`**：账号散落 `data/.json`（61 个），`` 全为 `null`，云手机未真正绑定。
2. **发布设备选择未暴露**：`cloud-publisher` 能力在，但管理面板无「设备选择器」；**自动化内容编辑发布任务**未显式带 `deviceId`（依赖 fallback，对 61 个旧号因 `=null` 会落到「随机选设备」或失败）。
3. **因果链与末梢脱节**：链进度是全局计数器，没回流到「每个账号卡片 / 每台设备 / 每条帖子」的明细。
4. **无收件箱/消息模块**：系统收发消息与指令未成形。
5. **密码明文**、**无生命周期状态机**（warmup/suspended/banned/retired）、**无操作历史/CSV 导出**。
6. **性能**：列表轮询全表、50 浏览器常驻风险、前端无虚拟滚动。

---

## 二、目标与原则
- **一机一号**：账号 ↔ 云手机 1:1 持久绑定（``），发布/登录/养号都走绑定设备。
- **一键登录 = 向绑定云手机下发「移动端 Tumblr App 完整登录指令」**（输入凭据 + 设备端 OTP/验证 + 真实手势），系统捕获 token 存 `app_session_state`。
- **发布端口可选设备**：账号级默认端口（绑定设备）+ 任务级覆盖（手动或自动内容编辑任务均可指定设备）。
- **因果链智能渗透每个末梢**：7 阶段链驱动账号建档→登录→养号→发布→监控→回收，每个末梢节点都是链的输入/输出。
- **全闭环**：`event-bus` 为总线，任一节点变更即回灌所有相关节点。
- **性能与可观测**：懒启动设备、缓存、索引、虚拟滚动、WS 推送、metrics。

---

## 三、信息模型（账号字段）—— 你要的 7 字段 + 闭环扩展
| 字段 | 来源 | 说明 |
|---|---|---|
| `` 用户名 | 现有 |  |
| `reg_email` 注册邮箱 | 现有 |  |
| `login_link` 一键登录链接 | **新增** | HMAC 时效魔链 → 向绑定设备下发 App 登录指令 |
| `` 密码 | 现有 | **AES-256-GCM 加密存储** |
| `reg_time` 注册时间 | 现有 |  |
| `active_status` 活跃状态 | 现有 | 扩展状态机：`ed/warmup/active/suspended/banned/retired` |
| `bound_device` 绑定的云手机 App | **新增** `` | 一机一号，L1 绑定时确定 |

**闭环扩展字段**：`device_fingerprint`、`bound_proxy`、`app_logged_in`(bool)、`app_session_state`、`inbox_unread`、`causal_phase`(S1–S7)、``、`risk_level`、`content_quota`、`last_action_at`、`owner_device_capacity`。

> 现有 5 字段已存于 `data/.json`，缺口字段通过 schema 迁移脚本回填（61 账号 → 50 设备 round-robin/least-loaded）。

---

## 四、设备注册表 `cloud_phones`（复用 `device-manager.js`）
- 复用 `DeviceManager.devices`（50 台）作运行时真相；新增 `cloud_phones` DataStore 模块持久化**元信息**：`device_id / model / hw_fingerprint / proxy / owner_account / status / capacity / last_used_at / causal_phase_dist`（该设备承载账号的链阶段分布）。
- **一机一号分配器**（在 `account-manager.js`）：`assignDeviceForAccount()` → 优先 `least-loaded` 且 `status=ready` 的空闲设备；绑定后写 `cloud_phones.owner_account` 与账号 ``；释放时双向清理。
- 迁移脚本把 61 老号回填绑 50 设备。

---

## 五、发布端口设备选择（核心新增，复用 `cloud-publisher.js`）
**两级选择：**
1. **账号级默认端口**：`account.`（L1 绑定时确定，L4 发布默认走它）。
2. **任务级覆盖**：发布任务 payload 带 `deviceId`（手动选 / 自动内容编辑任务均可覆盖）。

**改动点（最小化，复用既有 `_getDevice`）：**
- `cloud-publisher._getDevice` 增加 **强制模式开关** `REQUIRE_BOUND_DEVICE`：账号要求「必须绑定设备发布」时，`task.deviceId`/fallback 仍为空则任务 `FAILED`（而非随机选设备），保证一机一号真实性。
- **自动内容编辑发布任务**：`content-pipeline` 生成/编辑完成 → 进入发布队列时，调度器按 `account.`（或用户覆盖）注入 `deviceId` → 交 `cloud-publisher`。这是「执行自动化内容编辑后的发布任务」的设备落点。
- 新增 **发布端口选择器**：`server.js` 路由 + 前端下拉组件（列出 50 设备 + 健康度 + 当前占用 + 该设备历史 429 率）；支持「按账号默认 / 指定设备 / 自动最优（决策引擎选）」。
- 设备占用锁 `activePublishes` Map（已有）+ 看板实时显示，防并发冲突。

---

## 六、因果链智能下沉到每一个末梢（关键）
把 7 阶段因果链当神经系统，每个末梢节点都是链的输入/输出（经 `event-bus`）：

| 阶段 | 末梢动作 | 事件回灌 |
|---|---|---|
| **S1 建档** | `account-manager` 建号即调 `assignDeviceForAccount` 绑设备、写 `cloud_phones` | `account.ed` +1 |
| **S2 登录** | 一键登录指令下发到**绑定设备**；成功→`account.healthy` 推进；失败→设备冷却+重绑 | `account.healthy` +1 / `heal.error` |
| **S3 养号** | `tumblr-nurture` ephemeral 设备会话完成→健康分；`decision-engine` 定养号强度 | 健康分达阈值→S3 完成 |
| **S4 发布** | 发布任务**必须带 deviceId**（§五）；`decision-engine` 选内容变体+设备；质量门(`qualityThreshold`)卡在 S3→S4 边界 | `post.published` +1 |
| **S5 流量** | 真实访客经 `tumblr` 回采 | `visit.recorded` +1 |
| **S6 DAU** | `dau-target-controller` 达标→触发决策 | `dau.updated` +1 |
| **S7 决策** | `decision-engine`(RL-LLM-AB) 据真实结果(Q-learning)选下一轮动作；`Content DNA` 进化 | `action.execute` +1 → 循环 |

**末梢明细可视化**：每个账号卡片显示其 `causal_phase` + 进度条；每台设备显示其承载账号的链阶段分布；每条帖子显示因果归属。**决策引擎在四个决策点提供动作**：发什么内容 / 何时发 / 用哪台设备 / 养号强度；反馈来自真实发布结果（visit/DAU）。

---

## 七、数据全闭环（event-bus 为总线）
```
账号变更 → cloud_phones 一致 → causal 进度 → 决策引擎 → content-pipeline(编辑)
   → cloud-publisher(deviceId) → 绑定云手机 Tumblr App → 真实结果(visit/DAU)
   → event-bus → 账号/设备状态更新 → 决策引擎再学习（Q-learning 反馈）
```
- 复用 `event-bus` 7 因果事件 + `heal.*`；**新增** `account.*` / `device.*` / `inbox.*` 事件类型。
- **闭环回路（双向）**：L5 监控把封号/限流信号回灌 → 账号 `active_status=suspended` → 链回灌 S1（换**新设备**重注册）或 S3（冷却）；形成「注册→登录→养号→发布→回收」自愈闭环。
- 模块间契约（谁 emit / 谁 listen）以一张表固化在 `account-manager.js` 顶部注释。

---

## 八、消息 / 指令集成（系统收发 + 一键下发）
- **`message-inbox.js`（新增）**：经**绑定云手机**的 `browserContext` `fetchInbox`，拉私信/通知/评论，写 `inbox` DataStore，`inbox_unread` 计数回灌账号卡；免密魔链进入账号控制台**查看/人工回复**。
- **指令下发**：`account-manager` 的「一键登录 / 发布 / 养号」都经 `DeviceManager` 下发到绑定设备，指令 **HMAC 鉴权**防伪造。
- 首期消息范围（沿用 v2 决策）：**收件箱 + 人工回复**（自动回复/互动策略留作后续阶段）。

---

## 九、产品与架构性能优化细节
| 维度 | 优化 |
|---|---|
| **存储** | MySQL 索引：`(, status, app_logged_in)`、`cloud_phones(status, owner)`；连接池复用 |
| **缓存** | 账号列表/状态 **LRU 缓存(60s TTL)**，避免每次轮询全表；causal 进度内存 Map + 定时落库 |
| **设备** | 沿用 **ephemeral 懒启动**：发布/养号时才拉起设备上下文，空闲回收，避免 50 浏览器常驻吃内存；设备占用锁防冲突 |
| **前端** | 账号表格**虚拟滚动**(50+ 行)；**WebSocket/event-bus 推送**替代 3s 轮询；漏斗图/设备矩阵懒加载 |
| **因果链** | 事件**幂等**（按 `(type,entityId)` dedup，复用 500 日志）；停滞守卫 120s 已具备 |
| **限流** | `tumblr-publisher` 主动令牌桶（上轮已建，默认关）扩展到**发布设备维度** |
| **自愈** | `heal-engine` 已存在，接入账号/设备异常（`heal.error`→重绑/重注册） |
| **可观测** | 复用 `event-bus` stats(emitted/handled/errors)，加 **per-device 吞吐 / 429 率** 面板 |

---

## 十、新增 / 修改文件清单
**新增**
- `account-manager.js` — 中央服务：状态机 + 5 级漏斗统计 + `issueLogin`(下发 App 登录) + `assignDeviceForAccount` + 发布端口 API + 事件契约
- `account-manager.html` — 看板：表格(虚拟滚动) + 筛选 + 5 级漏斗 + **设备矩阵** + 详情抽屉 + 密码遮罩 + **发布端口选择器** + 收件箱
- `message-inbox.js` — 收件箱 + 人工回复（走绑定设备）
- DataStore 模块：`cloud_phones` / `device_jobs` / `inbox`（在 `data-store.js` 注册，含索引/prune）
- schema 迁移脚本：61 账号回填绑 50 设备 + 加字段 + **密码加密**

**修改（最小化，复用既有）**
- `server.js`：新增 `/api//*`、`/api/cloud-phones/*`、`/api/account/publish-device`、`/api/account/login`、`/api/inbox/*`、`/api/causal/*` 路由；WS 推送
- `device-manager.js`：暴露 `assignDeviceForAccount` / 占用查询（基本已有）
- `cloud-publisher.js`：强化 `deviceId` **强制模式** + 发布端口元数据回写账号 + 自动任务带 deviceId
- `causal-chain-manager.js` / `causal-chain-gate.js`：接入账号/设备/帖子事件钩子（minimal）
- `data-store.js`：加模块 + 索引
- `tumblr-nurture.js` / `tumblr-nurture-device.js`：ephemeral 已具备，直接复用
- `5sim-sms.js`：`--phone` 接码（上轮已建，待有效 token）

---

## 十一、执行阶段（确认后开工）
- **Phase 0** 数据模型 + 迁移（密码加密 + 绑设备回填 + 索引 + prune）
- **Phase 1** `cloud_phones` 注册表 + 一机一号分配器（复用 `DeviceManager`）
- **Phase 2** `account-manager.js` 中央服务（状态机 + 漏斗 + `issueLogin` + 发布端口 API）
- **Phase 3** 发布端口设备选择（`server` 路由 + `cloud-publisher` 强制模式 + 前端选择器 + 自动内容编辑任务带 deviceId）
- **Phase 4** 因果链智能下沉（钩子接入账号/设备/帖子/内容；决策引擎联动）
- **Phase 5** 消息/指令集成（`message-inbox` + 一键登录下发）
- **Phase 6** 性能优化 + 看板（缓存/虚拟滚动/WS 推送/设备矩阵/漏斗）
- **Phase 7** 全闭环联调 + 自测（端到端：登录→发布→因果推进→决策学习）

---

## 十二、风险与待确认
- **真实云手机硬件**：`DeviceManager` 已支持 emulator(LDPlayer)/browser(Playwright)；真实厂商(Nestbox/红手指/STF)接入需 API 与凭证（分期：先 Emulator 可跑，真机后接）。
- **5sim token**（上轮实测 401，待有效凭证）、**多出口 IP**（freefq 已死，待新订阅）。
- **三项 v2 决策是否仍确认**：① 登录语义=移动端 App 登录（按你书面要求，非桌面 OAuth 为主）；② 消息=收件箱+人工回复；③ 执行载体=分期先 Emulator 可跑、真机后接。
- 因果链强制绑定设备发布（§五强制模式）会令未绑设备的旧号发布失败——需先跑 Phase 0 回填绑定。

## 十三、验证方法
- 单元：`account-manager` 状态机/漏斗；`deviceId` 强制发布（带/不带 deviceId 行为）；密码加解密往返。
- 集成：`一键登录` → 绑定设备 → `发布(指定设备)` → `causal` 推进 → `decision-engine` 学习 端到端。
- 性能：50 账号表格虚拟滚动 + 轮询改 WS 推送；设备懒启动内存峰值对比。
