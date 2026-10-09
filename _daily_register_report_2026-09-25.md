# Tumblr 每日注册 — 执行报告（2026-09-25）

## 结论：STOPPED（0/10，命中 ShardX 未就绪 + 上游出口超时双停止条款，零假数据）

| 项 | 值 |
|---|---|
| 计划注册数 | 10 |
| 实际尝试 | 0 |
| 成功 | 0 |
| 失败 | 0 |
| 阻塞原因 | ① ShardX Launcher API :40325 不可达（真实指纹浏览器引擎离线）② 上游出口 → tumblr:443 HTTP 000 TIMEOUT（代理本地在听但上游断流） |
| node | `22.22.2` 缺失，`22.22.2-3` 可用（脚本自探测已用 -3） |
| 代理 10808 | LISTENING ✓（pid 18656，本地在听） |
| 引擎 :3005 | LISTENING ✓（pid 17196，totalAccounts=**123**，与 09-22 持平） |
| 恢复前提 | ① 在 `D:\ShardX` 启动 `ShardX-Launcher-portable-win-x64.exe`（Automation API :40325）② 修复代理上游出口（proxy-pool 出口 IP 对 tumblr:443 超时）③ node 用 `22.22.2-3`，日志落 `D:\mscms-ws\logs\_onboard_daily.log` |

### 前置核查（未启动注册脚本，未白烧 6–10 分钟）

- **proxy 10808**：`netstat` 显示 `TCP :10808 LISTENING 18656` + 多条 ESTABLISHED → 本地代理存活 ✓
- **上游 tumblr 出口**：`curl -x http://:10808 https://www.tumblr.com/` → **HTTP 000 time=20.0s**（两次实测均超时）→ 上游断流 ✗
- **ShardX :40325**：`netstat` 无 LISTENING；`tasklist | grep shardx/launcher` 无进程；`fetch('http://:40325/health')` → **fetch failed（连接被拒）** ✗
- **引擎 :3005**：`GET /api/status` → `totalAccounts=123`、`proxyPoolSize=43`、`running=true`（快照既有账号 P4/P1/P0 分布正常，无今日新增）

### 判定

两级决定性阻塞同时存在：
1. **ShardX 指纹引擎离线** → 注册器 `tumblr-onboard-shardx.js` 无法取得真实浏览器指纹，`tumblr-daily-.js` 三重自检（/health 免认证 + /running 带 Bearer 认证 + JWT 自签）会 `STOPPED` 退出码 2、不 spawn、不 reload。与 09-16→09-22 连续同根因（至今日已连续第 10 天）。
2. **上游出口超时** → 即便 ShardX 就位，注册请求也到不了 Tumblr。

按任务"chromium(ShardX)/代理不可用即停 / 不要盲目重试 / 零假数据"铁律，**未启动注册脚本**。

### 结果

- 0 尝试 / 0 成功 / 0 失败
- reload 未触发（脚本未运行）
- totalAccounts=**123**（不变，非今日新增）
- 0 新账号、0 进入 P0、移动设备上下文 N/A

### 零假数据

未编造任何 token / 养号进度；本日无任何账号落库。

> 由自动化任务于 2026-09-25T09:03+08:00 自动生成。零假数据：未执行的步骤不做任何成功声称。
