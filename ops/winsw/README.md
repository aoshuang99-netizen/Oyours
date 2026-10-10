# P0.2 — WinSW 服务化（可靠载体）

## 0. 设计决策（为什么只包 watchdog，不包每个服务）

`tools/mscms-watchdog.js` 是**唯一的服务编排器**：它用 `spawn(detached)` 拉起并
健康探活下面所有子服务，且用 `:3011` 单实例锁防止重复启动。如果在 WinSW 里**再**
给 3002/3005/3010/8001 各起一个服务，会出现：

- 与看门狗抢 `:3011` 单实例锁（看门狗启动即退出）；
- 或两股力量同时探活/重启同一端口，把子进程反复杀起重（杀-启死循环）。

**结论**：WinSW 只包 **看门狗** 一个服务，由看门狗自己承载整棵服务树。这样
整栈获得进程级自动恢复（Restart on failure），且零双启动冲突。

> Cloudflared 当前**不在**看门狗/自启脚本里启动（见 §4），单独给一个
> `cloudflared-tunnel.xml` 作为**参考**，启用前必须先停用既有的 cloudflared 启动路径。

---

## 1. 端口 → 入口脚本 → 环境变量 映射（从看门狗 SERVICES 数组逐字提取）

`WS = C:\Users\AS\WorkBuddy\2026-06-13-19-42-19`
`NODE = C:\Users\AS\\binaries\node\versions 下最新存在的 node.exe`（看门狗运行时解析）

所有子进程继承的共享 BASE_ENV：
`ELECTRON_RUN_AS_NODE=` · `NODE_TLS_REJECT_UNAUTHORIZED=0` · `NODE_PATH=%WS%\node_modules` ·
`MSCMS_STORAGE_ROOT=D:\mscms-ws` · `DATA_DIR=D:\mscms-ws\data` · `LOG_DIR=D:\mscms-ws\logs` ·
`MSCMS_TMP_DIR=D:\mscms-tmp` · `TEMP=D:\mscms-tmp` · `TMP=D:\mscms-tmp` ·
出口代理：`HTTP_PROXY/HTTPS_PROXY=http://:10808`（可达时；不可达则清空走直连）

| 服务 | 端口 | 入口 / 二进制 | CWD | 关键 env | 探活端点 |
|---|---|---|---|---|---|
| mysql | 3307 | `mysql-8.0.41-winx64/bin/mysqld.exe` `--basedir=... --datadir=D:/mscms-mysql-data --port=3307` | `mysql-8.0.41-winx64` | (tcpOnly，只做 TCP 探活) | TCP only |
| main | 3002 | `node server.js` | `D:\MSCMS-Desktop\resources` | `CLOUD_PHONE_COUNT=50` `CLOUD_PHONE_MODE=cloud` `PUBLIC_DOMAIN=mscms.lokfeel.com` `PORT=3002` `TUMBLR_API_RPM=25` `MSCMS_DATASTORE_WRITE_MODULES=*` `MSCMS_TUMBLR_POST_MAX_PER_DAY=12` `MSCMS_QUOTA_ESCALATE_ACCOUNTS=10` `MSCMS_QUOTA_GLOBAL_PAUSE_MIN=8` | `/api/v14/causal-chain/status` |
| nurture | 3005 | `node tumblr-nurture-server.js` | `WS` | `TUMBLR_NURTURE_PORT=3005` `TUMBLR_NURTURE_DEVICE=1` `TUMBLR_NURTURE_AUTO=1` `TUMBLR_PROXY=http://:10808` `TUMBLR_API_RPM=25` `MSCMS_DATASTORE_WRITE_MODULES=,tumblr_nurture,tumblr_persona,tumblr_device,tumblr_action_log,tumblr_daily_summary,nurture_logs,,,` | `/api/status` |
| contentgen | 3010 | `node content-gen/service.js` | `WS` | `CONTENT_GEN_PORT=3010` | `/api/assets` |
| exitguard | 20779 | `node tools/exit-guard.js` | `WS` | (无) | `/health` |
| visitor | 3012 | `node tools/visitor-profile-server.js` | `WS` | `MSCMS_DATASTORE_WRITE_MODULES=,,` | `/api/status` |
| sync | 3013 | `node tools/sync-desktop.js` | `WS` | `MSCMS_SYNC_PORT=3013` | `/health` |
| mpt | 8080 | `%PY_MPT% -m uvicorn app.asgi:app --app-dir . --host  --port 8080 --log-level warning`（`PY_MPT=C:\Users\AS\\binaries\python\envs\mpt\Scripts\python.exe`） | `D:\MoneyPrinterTurbo` | (无) | `/docs` |
| kkmatch | 8001 | `D:\kk-match-backend\.venv\Scripts\pythonw.exe _run.py` | `D:\kk-match-backend` | (无) | `/health` |

> 以上映射是**只读参考**。实际启动仍由看门狗完成；改启动参数请改 `tools/mscms-watchdog.js`
> 的 `SERVICES` 数组，不要在这里另起炉灶。

---

## 2. WinSW 二进制（已内嵌 v2.12.0 自包含版）

`mscms-watchdog.exe` 已随本目录提交，为 **WinSW v2.12.0 自包含单文件版（内嵌 .NET 运行时，无需再装 .NET）**。
> 注：v3.0.0 目前仅 alpha 发布，`/releases/latest` 指向 v2.12.0 稳定版；自包含 `WinSW-x64.exe` 约 3.9MB。

- 官方发布：https://github.com/winsw/winsw/releases/tag/v2.12.0 （资产 `WinSW-x64.exe`）
- 二进制与 `mscms-watchdog.xml` 同目录、同名（WinSW 按同名匹配 config），无需重命名。
- 如需更新：下载同名的 `WinSW-x64.exe` 覆盖即可（注意保持同名）。

---

## 3. 安装看门狗服务（推荐载体）

```bat
cd C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\ops\winsw

rem 1) 安装（需管理员权限）
mscms-watchdog.exe install

rem 2) 设置登录账户为当前交互用户（关键！否则拿不到 :10808 代理与 C:\Users\AS 资源）
rem    方式 A（GUI）：services.msc -> MSCMS v14 Watchdog -> 登录 -> 此账户 -> .\AS -> 输密码
rem    方式 B（命令行，密码会留在命令历史，慎用）：
rem    sc config mscms-watchdog obj= ".\AS" = "***"

rem 3) 启动
mscms-watchdog.exe start

rem 4) 查看状态 / 日志
mscms-watchdog.exe status
type D:\mscms-ws\logs\winsw\mscms-watchdog.out.log
```

**迁移须知（避免与现有自启冲突）**：当前 `_autostart_mscms.bat` 和计划任务
`MSCMS_Autostart`（每 5 分钟）都会启动看门狗，并与 `:3011` 单实例锁互斥。启用
WinSW 后必须：

1. **禁用计划任务** `MSCMS_Autostart`
   （`schtasks /Change /TN "MSCMS_Autostart" /DISABLE`，确认名后执行）。
2. **注释掉 `_autostart_mscms.bat` 的第 4~5 步（看门狗启动块）**，只保留 MySQL 启动
   作为手动兜底（MySQL 启动是幂等的：先 `isup 3307` 检查，已监听就跳过）。

这样看门狗只剩 WinSW 一个父级，`:3011` 锁归属清晰，重启/恢复路径单一。

---

## 4. Cloudflared（参考 / 按需启用）

- 现况：cloudflared **不在** `_autostart_mscms.bat`、也不在 `exit-guard.js` /
  `cf-tunnel.js` / `cf-worker-exit.js` 里被 spawn（这些脚本只读取
  `C:\Users\AS\.cloudflared\*.json` 里的凭证推断账户 ID）。
- 既有的 cloudflared 启动路径（独立计划任务 / .bat / 交互会话）**必须先确认并停用**，
  才能 `cloudflared-tunnel.exe install && start`，否则双启动抢隧道租约。
- 启用前，把 `cloudflared-tunnel.xml` 里的
  `<arguments>tunnel run &lt;YOUR_TUNNEL_UUID&gt;</arguments>` 改成真实隧道 UUID
  （从 `C:\Users\AS\.cloudflared\*.json` 中确认哪个服务 `mscms.lokfeel.com`），
  **严禁伪造**。

---

## 5. 回滚

```bat
cd C:\Users\AS\WorkBuddy\2026-06-13-19-42-19\ops\winsw
mscms-watchdog.exe stop
mscms-watchdog.exe uninstall
rem 恢复：启用 MSCMS_Autostart 计划任务 + 取消 _autostart_mscms.bat 注释
```
