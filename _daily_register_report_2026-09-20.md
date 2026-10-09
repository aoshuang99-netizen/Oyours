# Tumblr 每日注册报告 — 2026-09-20（自动化轮 ~09:04 GMT+8）

## 结论：STOPPED（0/10，命中"ShardX 未就绪 + 上游出口不可用"停止条款，零假数据）

未启动 `tumblr-daily-.js`，未盲目重试。理由：注册链路的两道前置全部失败，强行启动必 0/10 且白烧 6–10 分钟。

---

## 前置核查（关键事实）

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| 本地代理 :10808 | ✅ LISTENING | pid 1436（本地端口正常） |
| **上游出口 → tumblr:443** | ❌ TIMEOUT | node connect www.tumblr.com:443 → `ETIMEDOUT`；代理本地在听但上游出口已断 |
| 养号引擎 :3005 | ✅ LISTENING | pid 15648，基线 totalAccounts=**123** |
| 养号引擎 :3003（任务 query 写的端口） | — 非引擎 | 真实引擎在 :3005（脚本已正确指向） |
| **ShardX Launcher API :40325** | ❌ 不可达 | 无 LISTENING 套接字；tasklist 无 shardx 进程；`curl /health` → HTTP 000（exit 7）；node connect → `ECONNREFUSED` |
| ShardX 可执行文件 | 存在未启动 | `D:\ShardX\ShardX-Launcher-portable-win-x64.exe` 存在但未运行 |
| node `22.22.2`（任务 query 写） | ❌ 缺失 | 不存在 |
| node `22.22.2-3` | ✅ 存在 | 脚本自探测将用此版本 |

## 决定性阻塞（两层，任一均足以停止）

1. **ShardX 指纹浏览器引擎离线**：`tumblr-onboard-shardx.js` 依赖 ShardX Launcher API :40325 提供真实指纹浏览器上下文。该 API 当前不可达 → 注册器三重自检未过 → 脚本会 `STOPPED: ShardX 未就绪`、退出码 2、**不 spawn、不 POST /api/reload**。与 09-16/17/18/19 同根因。
2. **上游出口到 Tumblr 网络层超时**：即便 ShardX 就位，本地代理(10808)虽在听，但其上游出口对 `www.tumblr.com:443` 连接超时（ETIMEDOUT），注册请求在 TLS 握手阶段即失败。引擎快照大量既有账号 `lastError: ...429 Limit Exceeded` 亦印证上游出口质量恶化。

## 注册结果

- 尝试：**0**
- 成功：**0**
- 失败：**0**
- reload：**未触发**
- totalAccounts：**123**（与 09-19 持平，无新增）
- 新账号进入 P0：**0**
- 移动设备上下文分配：**N/A**

## 零假数据

未编造任何 token / 养号进度 / blogName。本报告仅记录真实核查到的端口与进程状态。

## 待恢复（无需改代码，启动即续）

1. 在 `D:\ShardX` 启动 `ShardX-Launcher-portable-win-x64.exe`（Automation API :40325 监听）后，本链路下次自动化轮将自动继续。
2. 同时需修复上游出口：proxy-pool 出口 IP 当前对 `www.tumblr.com:443` 不可达（ETIMEDOUT / 429）。ShardX 就位但上游断流仍会 0/10。
3. 任务 query 中 node 路径 `22.22.2` 已失效，请用 `22.22.2-3` 或脚本自探测（脚本已具备自探测能力）。
4. 任务 query 中日志路径 `C:\...\2026-06-13-19-42-19\_onboard_daily.log` 为陈旧副本；脚本实际落 `D:\mscms-ws\logs\_onboard_daily.log`。

---
*本自动化轮遵循"chromium(ShardX 指纹引擎)不可用 / 上游出口失败 → 报告并停止，不盲目重试"铁律，零假数据。*
