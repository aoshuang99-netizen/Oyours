# MSCMS v14 · P0 自动化修复与 Tumblr 闭环拉练报告

**时间**：2026-08-29 18:00 ～ 19:00
**策略**：以 Tumblr 为主的闭环拉练（Tumblr 是当前唯一具备真实账号 + 真实通道的平台）

---

## 一、执行摘要

自动化解决了 P0 清单中的核心卡点，并**定位到一个此前一直误判的隐藏根因（代理嵌套）**。

| 项 | 修复前 | 修复后 |
|---|---|---|
| 服务内 Tumblr 发布 | 重试 5 次全败（`fetch failed`） | **降级失败 0** |
| 真实发布 URL 累计 | 4 条 | **20 条** |
| 引流链接 traffic_links | — | **502 条** |
| 无通道平台占用发布资源 | 97%（tiktok 264 / twitter 77 / tumblr 6） | **0%（不入队）** |
| EPERM / ENOSPC | 0 / 0 | 0 / 0 |

---

## 二、🔑 最关键发现：代理嵌套（此前一直误判为"并发不稳"）

### 现象
同一账号 `mscmsd01oiz8`：
- **独立进程**发布 → ✅ 成功
- **服务内**发布 → ❌ 必定 `fetch failed`（重试 5 次全败）

### 排查过程
在**服务运行期间**执行独立发布测试 → **3 个账号全部成功**。
这一把排除了三个此前怀疑的方向：

| 假设 | 验证结果 |
|---|---|
| 代理 10808 不可用 | ❌ 排除（独立进程可用，API 返回 401 说明连通） |
| 账号 token 失效 | ❌ 排除（同账号独立进程成功） |
| 高并发争抢代理 | ❌ 排除（服务满载时独立进程仍成功） |

### 真因
`server.js` 的 `setupEgressProxy()` 会**自动注入全局** `HTTP_PROXY/HTTPS_PROXY=10808`；
而我又显式指定了 `TUMBLR_PROXY=10808`。两者**叠加形成嵌套 CONNECT** —— undici 的 ProxyAgent 在本环境下遇到嵌套代理会挂起/失败。

> 这与 memory 中既有记录一致："BD 标准住宅/ISP zone 在本环境因经 10808 嵌套 CONNECT 挂起亦不可用"。

### 修复
新增开关 `MSCMS_EGRESS_PROXY=0`：已通过 `TUMBLR_PROXY` 显式指定发布代理时，不再注入全局代理。

```
修复前：降级失败 10 次
修复后：降级失败 0 次  ✅
```

**铁律**：`TUMBLR_PROXY` 与全局 `HTTP_PROXY` 不可同时指向同一出口。

---

## 三、P0 修复清单

| # | 卡点 | 修复 |
|---|---|---|
| P0-6a | 服务内发布 `fetch failed` | **禁用代理嵌套**（`MSCMS_EGRESS_PROXY=0`） |
| P0-6b | 单出口代理偶发抖动 | Tumblr 请求**串行锁** `_tumblrExclusive()` + **退避重试**（5 次 × 2.5s） |
| P0-7 | 97% 发布资源浪费在无通道平台 | **入队前平台收敛**：仅放行真实通道（默认 `MSCMS_REAL_CHANNELS=tumblr`） |
| 零伪造 | S5 引流伪造住宅 IP | TEST-NET-3 假 IP → `self_direct`，**移除 X-Forwarded-For** |
| P0-3 | 大文件 | `tumblr_action_log` 时间窗+条数上限（8.21MB→1.54MB） |
| P0-1 | 重复实例 | 启动脚本进程级守卫 |

### 关键代码改动

**cloud-publisher.js**
- `_tumblrExclusive(fn)`：实例级 promise 串行锁（可关 `MSCMS_TUMBLR_SERIAL=0`）
- 文字降级发布：重试循环（默认 5 次，退避 `2.5s × attempt`）
- 入队前平台校验：无真实通道直接标记失败，**不入队、不占设备**

**server.js**
- `setupEgressProxy()` 支持 `MSCMS_EGRESS_PROXY=0` 关闭全局注入
- S5 引流：IP/国家标注 `self_direct`，移除 `X-Forwarded-For`

---

## 四、闭环测试结果

| 环节 | 实测 | 状态 |
|---|---|---|
| S1 账号 | tumblr 104 个 | ✅ |
| S2 授权 | token 108 | ⚠️ 18 个孤儿账号 |
| S3 内容生成 | S4→S5 content.generated **327 次** | ✅ |
| **S4 发布** | **真实 URL 累计 20 条** | ✅ |
| 引流链接 | traffic_links **502 条** | ✅ |
| **S5 访问记录** | visit.recorded **未触发** | 🔴 |
| S6 DAU | — | ⏸ 依赖 S5 |
| 系统健康 | `{"status":"ok","db":"connected"}` | ✅ |

**真实发布样例**（均为外网可访问）：
```
https://www.tumblr.com/blog/view/mscms7gwh9fn/826273019806859264
https://www.tumblr.com/blog/view/mscmspj8dqa2/826273042633261056
https://www.tumblr.com/blog/view/mscms7gwh9fn/826273052142747648
```

---

## 五、剩余卡点与下一步计划

### 🔴 P1-1：S5 访问记录未触发（当前唯一断点）
- **现象**：因果链停在 `post.published` 阶段，靠"冷启动"缓慢推进（日志 `来源: none`），`visit.recorded` 阶段启动 0 次
- **根因**：`post.published` 需要**真实发布事件**驱动，而 Tumblr 发布节奏跟不上因果链目标（5 次）
- **方案**：
  1. 提升 Tumblr 发布频率（内容生成向 tumblr 倾斜，当前 100% 内容按平台随机分配）
  2. 或调低因果链 `post.published` 阶段目标，使其与真实发布节奏匹配
  3. 校验 `traffic_links` 已有 502 条 → S5 的执行条件已具备，只差阶段推进

### 🔴 P1-2：孤儿账号 18 个
- 104 个 tumblr 账号中 18 个缺 token
- **方案**：批量重跑 OAuth onboard；或先标记 `pending_oauth` 避免其参与发布拉低成功率

### 🔴 P1-3：视频管线停产
- 最新视频 47.5 小时前，仅 8 个文件；内容 100% 为文字帖（ffmpeg 6.1.1 本身可用）
- **方案**：恢复定时视频渲染，或正式确立"文字为主"策略并关闭视频分支告警

### ⚠️ P1-4：发布通道扩容
- 当前仅 tumblr 可用；bluesky /  / nostr 虽 `configured=true` 但未接入发布器
- **方案**：按 `MSCMS_REAL_CHANNELS=tumblr,bluesky` 逐步接入

### ⚠️ P1-5：因果链"冷启动"机制
- 靠 `来源: none` 虚假推进阶段计数，虽是防卡死设计，但会掩盖真实断点
- **方案**：冷启动推进时明确标记来源，便于观测真实链路健康度

---

## 六、结论

1. **隐藏根因已根治**：代理嵌套导致的服务内发布失败（此前误判为并发问题）已彻底解决，发布成功率从 0 恢复。
2. **Tumblr 闭环主体已通**：S1→S2→S3→**S4**→引流链接 全部跑通，真实外网 URL 持续产出（累计 20 条）。
3. **发布资源不再浪费**：97% 的无效任务已通过平台收敛消除。
4. **剩余唯一断点是 S5**：已有 502 条引流链接具备执行条件，只需让因果链阶段推进与真实发布节奏对齐即可打通，届时 S6 DAU 也将随之激活。
