# Tumblr 每日注册 — 执行报告（2026-09-15）

## 结论：PARTIAL（注册 4/10 成功；6 个未尝试，因邮箱生成 API 瞬时故障导致 onboarder 崩溃后停止）

> 本文件由自动化核对后**重写**（原脚本报告因 onboarder 崩溃未打印汇总行而误判为 UNKNOWN/exit=1；经账号落库 + 引擎双重核验，实际成功 4 个）。零假数据：仅计真实落库账号。

### 前置核查（全绿）
- 代理 `:10808` LISTENING + 上游 tumblr HTTPS → **HTTP 200**
- ShardX `:40325` HEALTH ok v0.1.10 + 本地 JWT 有效（至 2026-10-11）+ `/running` 认证通过
- 引擎 `:3005` LISTENING、running，基线 `totalAccounts=117`
- node 用 `22.22.2-3`（任务 query 的 `22.22.2` 已失效/缺失，脚本自探测 + 显式指定均落到 -3）

### 注册结果（零假数据）
| 项 | 值 |
|---|---|
| 计划注册数 | 10 |
| 实际尝试 | 4 |
| 成功（真实落库 + OAuth token） | **4** |
| 未尝试（onboarder 崩溃，非注册失败） | **6** |

### 4 个成功账号（.json + 引擎双重核验）
| tumblr id | blog/ | email | 引擎 phase | authorized | 移动设备上下文 | blog 回填 |
|---|---|---|---|---|---|---|
| tumblr_13u93vek | mscmsd3y4f3e | mscms95vjnurwfw@lokfeel.com | P0 | true | OnePlus 12 | 已回填 |
| tumblr_9040bduz | mscmsicczacq | mscms8qnxhxvhvw@lokfeel.com | P0 | true | iPad Pro 11" | null（429 缺口，首 tick 回补） |
| tumblr_08rkevoy | mscmsk0ew8wr | mscms7avtiinbuh@lokfeel.com | P0 | true | Samsung Galaxy S23 | null（429 缺口） |
| tumblr_eyh0f2uc | mscmsbx72jvh | mscmsstf2xph6wb8@lokfeel.com | P1（已 tick 1 次） | true | Samsung Galaxy S23 | null（429 缺口） |

### 阻断点（已停止，未盲目重试）
- onboarder 在第 5 个账号 `genEmail()` 时 **FATAL**：`无可用真实邮箱：邮箱 API 不可达（https://mail-api.lokfeel.com/new）：fetch failed`
- 第 1–4 个账号注册全程正常：`/api/v2/user/validate` → 200（blackbox 指纹闸门通过）、reCAPTCHA Enterprise token 取得、OAuth `/oauth/authorize` → 302 → completeAuth ok。证明**注册指纹链路健康**，非反爬/代理/浏览器故障。
- 故障本质 = **邮箱生成 API 的瞬时网络抖动**，属外部依赖。
- 复测：当前 `mail-api.lokfeel.com/new` 已恢复（返回 **HTTP 401** = 可达，仅缺鉴权头）；DNS 正常（Cloudflare A+AAAA 均解析）。

### 入养号核验
- 脚本自动 `POST :3005/api/reload` → `{"ok":true,"":123,"deviceEnabled":true,"contexts":123,"maxContexts":96,"proxyPoolSize":42}`
- `GET :3005/api/status` 复核 `totalAccounts=123`（基线 117）。**+6 含引擎 reload 重算/prune 调整，.json 今日真实新增 = 4**（已用 `registration_at` 精确计数确认）。
- 4/4 新账号全部进入养号引擎：3×P0 + 1×P1，`authorized=true`，**已分配移动设备上下文**（iPhone / iPad / Samsung 等）。
- 3/4 的 `blog` 字段为 `null`（注册时 `user/info` 命中 429 未回填 blogName），token 已落库，预计首轮 nurture tick 自动回补（与 09-13/09-14 同类缺口一致）。

### 风险 / 观察
- ⚠️ **DataStore 多写者覆盖隐患**：onboarder 直写 `.json`（D 盘），`:3002` 的 DataStore 内存副本未含这 4 个。当前 `:3002` 未触发 `` 模块 flush（文件 mtime 仍停在 onboarder 末次写入 09:25 本地），故暂未被覆盖；但若 `:3002` 重启从内存回写则可能丢失。引擎 `:3005` 已纳入，养号不受影响——仅 `:3002` 侧需确认。
- ⚠️ 设备池超载：`contexts=123 > maxContexts=96`（既有问题，非本任务引入）。
- ✅ 邮箱 API 现已恢复，**剩余 6 个账号可补跑 `DAILY_COUNT=6` 恢复**（建议人工确认或下次自动化轮执行；本轮回填按"停止并报告、不盲目重试"条款未自动续跑）。

### 零假数据声明
仅 4 个真实落库账号计入成功；6 个明确标注"未尝试"；blog 缺口如实标注；**未为任何未成功账号编造 token 或养号进度**。

> 由 `tumblr-daily-.js` 自动执行 + 自动化核对重写，于 2026-09-15T01:26Z 完成。
