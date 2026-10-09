# CF Workers 多开 —— 完整操作指引（MSCMS v14）

> 适用对象：MSCMS v14 出口运维
> 版本：v2，2026-09-11 **实盘执行后修订**（26 → 40 个 Worker 已上线）
> 一句话：**每多开 1 个 Worker = 该 Worker 独立的 CF 边缘出口 IP，零成本。** 全流程 6 步，约 10~20 分钟。

---

## 0. 先决约定（照抄，避免踩坑）

```bash
cd "C:/Users/AS/WorkBuddy/2026-06-13-19-42-19"
NODE="C:/Users/AS//binaries/node/versions/22.22.2-2/node.exe"
```

| # | 铁律 | 违反后果 |
|---|---|---|
| 1 | 改任何 `.js` 后**必须双写 `D:/MSCMS-Desktop/resources/`** 再重启 | 看门狗接管后回退旧逻辑 |
| 2 | `cf-tunnel.js` **只在启动时读一次配置** → 加了 Worker 必须重启隧道 | 新出口端口不监听，探测全失败、白部署 |
| 3 | 判断出口 IP **绝不能用 `--ip`** | 它恒返回 `2a06:98c0:3600::103`，会让你误判「多开无效」而放弃 |
| 4 | **代理池的权威文件是 D 盘那份**（`D:/MSCMS-Desktop/resources/proxy-pool.json`） | `server.js` 里 `EXIT_POOL_FILE = __dirname/proxy-pool.json`，3002 从 D 盘启动；只改工作区 = 服务看不到 |
| 5 | **IP 探测源不能用 CF 自家服务** | `api.ipify.org` / `cloudflare.com` / `icanhazip.com` 经 CF 出口全被拒 → 出口被误判不可达、一条都进不了池 |

---

## 1. 原理：为什么多开就是多 IP

```
发布账号 → proxy-pool.json 里的 http://:202xx（直连隧道端口）
          ↓
      cf-tunnel.js（本地 CONNECT → wss://mscms-exit-N.xxx.workers.dev）
          ↓
      Cloudflare 边缘
          ↓  worker 内 cloudflare:sockets.connect() 直连目标
      目标站点看到的出口 IP = 该 Worker 的边缘 IPv6（2a09:bac5:…）
```

关键机制：**`fetch()` 与 `sockets.connect()` 出网走两个不同的 IP 池**。Worker 的 `/ip` 端点是 `fetch()`（出口恒为 CF 共享 IP `2a06:98c0:3600::103`），真正的隧道走 `sockets.connect()`（**每 Worker 一个独立 IPv6**）。这就是「`--ip` 看起来无效、实际有效」的原因。

**2026-09-11 实测（40 个 Worker）**：

| 指标 | 数值 |
|---|---|
| 隧道端口可达 | **40 / 40** |
| 唯一 IPv6（`2a09:bac5:…`，目标站实际所见） | **37 ~ 38** |
| 唯一 IPv4（`104.28.x.x`） | 22 ~ 30 |
| Tumblr 可达（HTTP 200） | **40 / 40** |

> 结论：**多开确实增加出口 IP 多样性**（≈ 1:1）。同一 CF 边缘节点会复用 IP，所以唯一数略低于 Worker 数，属正常。

端口命名规则：

| 用途 | 公式 | 2026-09-11 实测 |
|---|---|---|
| cf-tunnel 转发（Worker 序号 n） | `20201 + n - 1` | **20201 ~ 20240** |
| cf-tunnel 健康端点 | `20880` | `/health` 返回 `exits=N` |
| mihomo 节点监听（全局节点序号 i） | `20101 + i` | 50 个节点 → 20101 ~ 20150 |
| └ 其中 CF 节点 | 受「非 CF 节点数」影响，**会漂移** | 20111 ~ 20150 |

> ⚠️ **代理池里的 CF 条目一律用「隧道端口 20201+」，不要用 mihomo 端口**。mihomo 端口是全局节点序号派生的，节点数一变就整体错位（本次实测：CF-1 从 20112 漂到 20111）。

---

## 2. 现状体检（扩容前必跑）

### 2.1 凭证与权限

```bash
"$NODE" tools/cf-worker-exit.js --diag
```

判定只这一行：`结论: ✅ 可用于部署` → 继续；否则按提示修复（`no_resources` 要在 Token 创建时把 Account Resources 选 **Include → All **；`no_workers_permission` 缺 `Workers Scripts: Edit`）。

### 2.2 当前数量与隧道健康

```bash
"$NODE" tools/cf-worker-exit.js --list
"$NODE" -e "fetch('http://:20880/health').then(r=>r.json()).then(j=>console.log('隧道出口数 =',j.exits.length,'| 末端口 =',j.exits[j.exits.length-1].port))"
```

### 2.3 端口冲突预检（决定能扩到多少个）

```bash
netstat -ano | grep -E ":202[0-9][0-9] " | awk '{print $2}' | sed 's/.*://' | sort -n | uniq | tr '\n' ' '
```

**实测结论**：`20242`、`20244` 被**其他项目的 cloudflared** 随机占用（PID 18700 `WorkBuddy\20260427141156\llamacoder\`、PID 20656 `WorkBuddy\2026-05-19-task-14\`）→ **纯靠现有公式安全上限 = 41 个 Worker**。

要更多：停掉那两个 cloudflared（属其他项目，需确认），或改 `tools/cf-tunnel.js` 的 `BASE_PORT` **并同步** `tools/multi-exit.js` 的 `CF_TUNNEL_BASE`（两处必须一致 + 双写 D 盘）。

---

## 3. 扩容 SOP（6 步，以 26 → 40 为例）

### Step 1 ｜ 决定目标 N，预留端口

目标 N=40 → 隧道端口 `20201~20240`（与 20242 不冲突 ✅）。
容量参考：`日均帖数 ÷ 10 帖/IP × 1.6 = 所需唯一 IP`（150 帖/天 → 24 IP）。

### Step 2 ｜ 部署 Worker（最慢，10~18 分钟）

```bash
"$NODE" tools/cf-worker-exit.js --deploy --count=40
```

须知 3 件事：

1. **顺序重部署 1..40**，已存在的 1–26 会被幂等更新（不是只部署 27–40）。本次实测 **4 分 58 秒**，**别中途 Ctrl+C**。
2. 单个失败不影响整体：`× ` 的条目保留旧记录，不会从配置里删掉。
3. 每次部署写入新的随机 `UUID` —— **无害**，隧道走 raw 模式不使用 UUID。

预期末尾：

```
  [40/40] mscms-exit-40: ✓ mscms-exit-40.aoshuang99.workers.dev

✓ 写入 D:/mscms-ws/config/cf-worker-exits.json（40 个 CF 边缘出口）
```

### Step 3 ｜ 重启隧道（**最容易漏的一步**）

```bash
# 找 PID
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*cf-tunnel*' } | Select-Object ProcessId"
# 杀掉（换 <PID>）
powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"
# 等 20~70 秒后复核（exit-guard 60 秒内自动拉起；本次实测 20 秒恢复）
"$NODE" -e "fetch('http://:20880/health').then(r=>r.json()).then(j=>console.log('隧道出口数 =',j.exits.length,'| 末端口 =',j.exits[j.exits.length-1].port))"
```

预期：`隧道出口数 = 40 | 末端口 = 20240`

> 90 秒后仍是旧数：`exit-guard` 没在跑。检查 `http://:20779/health`，不是 200 就得手工起 `"$NODE" tools/cf-tunnel.js`（须 detached 常驻）。

### Step 4 ｜ 重建 mihomo 网关

```bash
"$NODE" tools/multi-exit.js --restart --apply
```

做 4 件事：采集全部节点 → 重建 `D:/mscms-ws/tmp/mihomo-multi-exit.yaml` → 重启 mihomo → 探测并把**非 CF 节点**写入池。

> **注意**：从 2026-09-11 起，此命令**不再写 CF 条目**（CF 改用隧道端口 + IPv6，由下一步的专用工具维护）。日志会打印：
> `跳过 N 个 CF Worker 出口（由 cf-exit-verify.js --sync-pool 维护）`

### Step 5 ｜ CF 段入池（**新增的关键一步**）

```bash
"$NODE" tools/cf-exit-verify.js --sync-pool
```

它会：逐隧道端口探测 → 采 **IPv6 + IPv4** → 按 `cf-worker-<n>` 约定新增/更新池条目 → **双写 D 盘 + 工作区** → 顺带清理历史错误写法（`exit-cf-*`）。

预期末尾：

```
  隧道端口可达 : 40/40
  唯一 IPv6    : 37
  Tumblr 可达  : 40
  池文件: D:/MSCMS-Desktop/resources/proxy-pool.json
  池同步: 清理 0 条旧写法 / 新增 14 条 / 更新 26 条
  池现状: 总数 87，启用 post 41，其中 CF 40 条
  CF 唯一出口 IP = 37
```

### Step 6 ｜ 让发布/养号服务用上新出口（**不做这步 = 新出口白扩**）

两条路径，**优先用重载，能不动进程就不动**：

**① 养号 3005 —— 零重启，推荐**

```bash
"$NODE" -e "fetch('http://:3005/api/reload',{method:'POST'}).then(r=>r.json()).then(j=>console.log('proxyPoolSize =',j.proxyPoolSize))"
```

`POST /api/reload` 内部会 `proxyPool.load()` + `engine.proxyPool.load()`（源码注释明写「新增出口 IP 即时生效（无需重启）」）。
**本次实测：`proxyPoolSize` 27 → 41 ✅**

**② 主服务 3002 —— 必须重启**

`cloud-publisher._proxyCandidates()` 读到的列表缓存在 `this._proxyCache`，**一旦填充就只在整个进程生命周期内复用，没有任何重置点**（源码 430/445 行；注释里说的「60s 后重新读盘」并未实现）。`_poolForBudget` 同理。所以：

```bash
powershell -NoProfile -Command "netstat -ano | Select-String ':3002' | Select-Object -First 2"
# 杀掉进程树 → 由看门狗(3011)拉起；若无看门狗须手工启动（见 §7，注意 50 台云手机的副作用）
```

> 好消息：如果 3002 本来就没运行（本次即如此），它**下次启动会自然读到新池**，无需额外动作。
> 只读验证（不重启也能看）：`GET http://:3002/api/v14/exits/list` 每请求读文件；但发布路径不会用。

---

## 4. 代理池 CF 条目的正确写法（本项目约定）

```json
{
  "url": "http://:20201",
  "name": "cf-worker-1",
  "weight": 1,
  "enabled": true,
  "exitIp": "2a09:bac5:624d:2da5::48c:56",
  "tumblr": true,
  "src": "cf-worker",
  "usage": "post"
}
```

- `url` = **隧道端口**（`20201 + Worker序号 - 1`），稳定，与 mihomo 节点数无关。
- `exitIp` = **IPv6**（目标站实际看到的就是它，唯一度最高：37~38/40）。
- `usage: post` + `tumblr: true`（`load()` 会过滤掉 `usage==='scrape'`）。
- 想停用某条：网页端设 `off`，**不要删**（会破坏序号对应关系）。

**错误写法（本次踩过，工具已能自动清理）**：`url` 指向 mihomo 端口 `201xx` + `name: exit-cf-*` + `exitIp` 存 IPv4。它会随节点数变化整体错位，且与隧道端口写法重复。

---

## 5. 探测源黑名单（2026-09-11 实测）

| 源 | 经 CF 出口 | 说明 |
|---|---|---|
| `api.ipify.org` | ❌ TLS 断连 | **`multi-exit.js` 原本用它 → 40/40 全误判不可达** |
| `cloudflare.com/cdn-cgi/trace` | ❌ TLS 断连 | CF 自家域名触发回环检测 |
| `icanhazip.com` / `api.ip.sb` / `ipapi.co` / `api.myip.com` / `myip.ipip.net` | ❌ | 均在 CF 上或不可达 |
| **`ifconfig.me/ip`** | ✅ 返回 **IPv6** | 首选 |
| **`ip.me`** / **`ident.me`** | ✅ 返回 IPv6 | 备用 |
| **`checkip.amazonaws.com`** / **`ipinfo.io/ip`** | ✅ 返回 IPv4 | 需要 v4 时用 |

`multi-exit.js` 与 `cf-exit-verify.js` 都已按「非 CF 源 + 多级回退」改写。

---

## 6. 验收（三层，缺一不可）

**① 隧道逐端口实探 + 双栈 IP**（最权威）

```bash
"$NODE" tools/cf-exit-verify.js            # 只体检不入池；加 --sync-pool 才写池
```

**② 平台侧口径**

```bash
"$NODE" -e "fetch('http://:3002/api/v14/exits/list').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.summary||j).slice(0,300)))"
```

**③ 真实鉴权端到端**（最强证据，本次已跑通）：用真实账号 token 经**新增出口**调 Tumblr API，应返回该账号自己的 blog：

```
account      = tumblr_pbvypin1
ownBlogName  = mscmsnmxnpq4
port 20240 -> OK  3092ms  blogs=1 primary=mscmsnmxnpq4   ← 新增出口 ✅
port 20226 -> OK  2853ms  blogs=1 primary=mscmsnmxnpq4   ← 原出口对照 ✅
```

---

## 7. 服务重启与保活

| 服务 | 端口 | 启动方式 | 池加载 | 扩出口后怎么办 |
|---|---|---|---|---|
| 主服务 | 3002 | 看门狗 `main:3002`，cwd=`D:\MSCMS-Desktop\resources`，`bootGraceMs` 15 分钟（含 50 台云手机 STARTALL） | `cloud-publisher._proxyCache` 进程内永久缓存 | **重启**（无重载入口） |
| 养号 | 3005 | 看门狗 `nurture:3005`，cwd=工作区，env 含 `TUMBLR_PROXY=http://:10808` | `proxyPool.load()` | **`POST /api/reload`（零重启）** |
| 看门狗 | 3011 | `tools/mscms-watchdog.js`，每 60 秒巡检 | — | — |
| 出口守护 | 20779 | 看门狗托管，每 15 分钟 rescan | 每次 rescan 重读 | 自动 |

**看门狗不在时**：重启 3002 会连带启动 50 台云手机（约 12~13 分钟），属重副作用操作，**动手前先确认**。

> `exit-guard` 的 rescan 已在 2026-09-11 扩展为两步：先 `multi-exit --apply`（非 CF 段），再 `cf-exit-verify --sync-pool`（CF 段，刷新漂移的 IPv6）。此改动需 **exit-guard 重启一次**才生效；不重启也无害——它每 15 分钟新起的 `multi-exit` 子进程已读到补丁代码，不会再制造错误条目。

---

## 8. 缩容 / 回滚

- **只减用量（推荐）**：网页端把出口设 `off`，池立即减少但 Worker 保留。
- **真删 Worker**：`"$NODE" tools/cf-worker-exit.js --undeploy`（逐个删除并把配置置 `[]`），完成后 `multi-exit.js --restart --apply`。
- **只回滚池**：备份在 `D:/mscms-tmp/proxy-pool.D-drive.before.bak.json`（D 盘权威）与 `proxy-pool.26workers.bak.json`（26 Worker 时期）。

---

## 9. 故障排查表

| 症状 | 根因 | 处置 |
|---|---|---|
| `--diag` 报 `no_resources` | Token 创建时「账户资源」未勾 | 重建 Token，Account Resources 选 **Include → All ** |
| 部署报 403 code 10000 但 `verify=active` | 权限 + 资源未双满足 | 同上；模板 Edit Cloudflare Workers |
| Worker 数已 40，隧道仍 26 | **没重启 cf-tunnel** | Step 3 |
| 某端口不监听 | 端口被别的进程占（如 20242/20244 的 cloudflared） | 看 cf-tunnel 日志「端口 X 启动失败」；避开或改基址 |
| `multi-exit --apply` 报「可达 1/50、新增 0」 | 探测源 `api.ipify.org` 被 CF 拒 | 已修（改用非 CF 源）；CF 段改用 `cf-exit-verify --sync-pool` |
| 网页端看到新出口但发布不用 | ProxyPool 是启动时加载的实例 | 重启 3002 / 3005（Step 6） |
| 池里出现重复/错位条目 | 用了 mihomo 端口写 CF 条目 | 跑 `cf-exit-verify --sync-pool` 自动清理 |
| 唯一出口 IP 远小于 Worker 数 | 同一边缘节点复用 IP | 正常；若 < 20 才排查 |

---

## 10. 一页速查

```bash
cd "C:/Users/AS/WorkBuddy/2026-06-13-19-42-19"
NODE="C:/Users/AS//binaries/node/versions/22.22.2-2/node.exe"

"$NODE" tools/cf-worker-exit.js --diag                  # ① 凭证体检：必须「结论: ✅」
"$NODE" tools/cf-worker-exit.js --list                  # ② 看现有数量
netstat -ano | grep -E ":202[0-9][0-9] " | head         # ③ 端口冲突（20242/20244 被占）
"$NODE" tools/cf-worker-exit.js --deploy --count=40     # ④ 部署（本次 4m58s，别中断）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*cf-tunnel*' } | Select-Object ProcessId"
powershell -NoProfile -Command "Stop-Process -Id <PID> -Force"   # ⑤ 重启隧道（关键）
"$NODE" tools/multi-exit.js --restart --apply           # ⑥ mihomo 网关（不含 CF 条目）
"$NODE" tools/cf-exit-verify.js --sync-pool             # ⑦ CF 入池（隧道端口 + IPv6）
# ⑧ 重启 3002 / 3005 才真正生效
```

---

## 附：本次执行记录（2026-09-11）

| 项 | 结果 |
|---|---|
| 部署 | 40/40 成功，耗时 4 分 58 秒 |
| 隧道 | 20 秒自动恢复，`exits=40`，末端口 20240 |
| mihomo | 50 节点，监听 20101~20150 |
| CF 出口实测 | 40/40 可达，**唯一 IPv6 = 37**，Tumblr 40/40 |
| 代理池 | 73 → 87 条；`cf-worker-1..40` 全部启用；原有 26 条 exitIp 全刷新；**丢失 0 条** |
| 鉴权端到端 | 经新增出口 20240 调 Tumblr API → 返回本账号 blog `mscmsnmxnpq4` ✅ |
| 养号服务 | `POST /api/reload` → `proxyPoolSize` **27 → 41**，零重启生效 ✅ |
| 工具改动 | `multi-exit.js`（探测源 + 不再写 CF 条目）、`exit-guard.js`（rescan 加 CF 刷新）、新增 `cf-exit-verify.js`；三者已双写 D 盘，md5 一致 |
| 未完成 | 3002 主服务与 3011 看门狗**当前未运行**（执行前即如此）→ 3002 下次启动即自动读到新池，**无需额外动作** |
