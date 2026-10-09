# Bright Data 自动轮换 IP —— 实测结论报告

**日期**：2026-09-12
**触发**：用户提供 Bright Data 官方文档（`-session-<unique_id>` 用户名参数轮换法），要求"在脚本中自动轮换 IP 地址"
**结论一句话**：**该文档描述的方法在你这套 BD 账户上 100% 无效** —— 因为你的两个 ISP zone 是「**静态住宅**（`res_static`，各只有 1 个固定 IP）」，而 `-session-` 只对**轮换型** zone 生效。但本次排查**推翻了两个过期结论**，并发现一个真实的**池伪装多样性**隐患。

---

## 一、关键结论速览

| # | 结论 | 证据强度 |
|---|---|---|
| 1 | `-session-<id>` 在 `isp_proxy1` 上**完全无效**：5 次无 session + 12 个不同 session + 4 次复核 = **21 次采样，恒为同一 IP** | 决定性 |
| 2 | 根因：`isp_proxy1` / `isp_proxy2` 的类型是 **`res_static`（静态住宅）**，`GET /zone/ips` 返回**每个 zone 仅 1 个 IP** | 决定性 |
| 3 | **旧结论"BD ISP 已被 Tumblr 屏蔽"已过期/误判**：同 IP `185.97.0.157` 现在打 Tumblr **完全正常**（API 返回真实 `401`、首页返回 `200`） | 决定性 |
| 4 | 该 IP 未被 Tumblr 限流：连续 12 次请求 → **12×401，0×429** | 决定性 |
| 5 | 旧"屏蔽"的真凶很可能是**账户账单暂停**（历史报错 `client_10020 Account is suspended`）→ 当时所有请求失败被误归因于 Tumblr 封 IP。现已 `status: active` | 高（推论+状态实证） |
| 6 | `proxy-pool.json` 里 **12 条 `brightdata-isp-01..12` 是同一个 IP 的 12 个别名**（去掉 session 后唯一用户名 = 1）→ **伪装多样性** | 决定性 |
| 7 | 本机**直连** `brd.superproxy.io` 极不稳：12 次里 7 次连接重置（curl exit 56）/ 超时（28）；**经 SOCKS5(10950)→VPS 后 5/5 成功** | 决定性 |
| 8 | 唯一"能真轮换"的通道（`resi_tumblr` / `web_unlocker1`，unblocker 型）**每次请求换 IP（3/3 不同）**，但 **BD 已移除 `data` 字段 → 无法中继 POST** → 对 Tumblr 写操作（follow/like/reblog/post）**依然不可用** | 决定性 |
| 9 | 当前 API key **无建 zone 权限**（`POST /zone` → 403），也读不到余额（`/customer/balance` → 403）→ 想真轮换必须**在 BD 后台手工新建轮换型 zone** | 决定性 |

---

## 二、zone 能力矩阵（2026-09-12 实测）

| zone | BD 类型 | 出口 IP 轮换 | 能否中继 POST | 能否连 Tumblr | 可用性 |
|---|---|---|---|---|---|
| `isp_proxy1` | `res_static` | ❌ 固定 `185.97.0.157` (US) | ✅ 标准代理，全方法透传 | ✅ `api`→401 / `www`→200，12 次 0×429 | **✅ 可用（1 个干净 IP）** |
| `isp_proxy2` | `res_static` | ❌ 固定 `178.171.104.224` (MX) | 未能验证 | ⚠️ 报 `407 Auth failed`（zone 密码与本条不符） | ⚠️ 待核对密码 |
| `resi_tumblr` | `unblocker` | ✅ 每次不同 | ❌ `"data" is not allowed` | ✅ 仅 GET | ❌ 写操作不可用 |
| `web_unlocker1` | `unblocker` | ✅ 每次不同 | ❌ `"data" is not allowed` | ✅ 仅 GET | ❌ 写操作不可用 |
| `scraping_browser1/2` | `browser_api` | — | — | 只能 Playwright 远程控制，禁当代理（403） | ❌ |

---

## 三、为什么 `-session-` 无效（机理）

Bright Data 的代理用户名支持一串**参数段**，`-session-` 只是其中之一：

```
brd-customer-<CID>-zone-<ZONE>[-session-<id>][-country-<cc>][-city-<c>][-ip-<ip>]
```

- **轮换型 zone**（Rotating Residential / Datacenter / Mobile）：后端是一个大 IP 池，`-session-<id>` 用来**把某条连接粘在池中某个 IP 上**；不给 session 或每次给新 session → 每次换 IP。
- **静态型 zone**（`res_static`）：BD 卖给你的是**固定归属的 1~N 个 IP**，池里根本不存在"可换的其它 IP"→ `-session-` **被接受但无任何效果**，恒定返回那 1 个 IP。

你的 zone 是后者（`res_static`，各 1 个 IP），所以**文档描述的"每次请求自动轮播"在这套账户上物理上不可能实现**。

> 附带排除：静态 zone 该用 `-ip-<ip>` 选 IP，但本 zone 只有 1 个 IP，指定 2 个不同 IP 均无意义；实测也不再变化。

---

## 四、⚠️ 发现的生产隐患：池里的"伪装多样性"

```
权威池 D:\MSCMS-Desktop\resources\proxy-pool.json
  条目总数 87   enabled 46 (cf-worker 40 + iproyal 5 + 本地 1)   disabled 41
  BD 条目 12 条 → 去掉 -session- 后【唯一用户名 = 1】
```

即 **`brightdata-isp-01` ~ `brightdata-isp-12` 全部指向同一个出口 IP `185.97.0.157`**。

- **当前风险 = 0**：这 12 条全部 `enabled: false`。
- **一旦被启用（人工或脚本）**：`ProxyPool` 按账号哈希分 IP 时，会有 **12/87 ≈ 14% 的账号** 被集中挤到**同一个 IP** —— 这正是 429 的典型成因，而且面板上会显示"12 个 BD 出口"，**看不出是 1 个**。
- 同理 `trusted-exits.json` 里那 12 条 `brightdata-isp-01..12` 也是 1 个 IP 的 12 个别名。

**建议**：收敛为 1 条真实条目（等 `isp_proxy2` 密码核对后可加第 2 条），并把"条数"与"真实 IP 数"区分开 —— 池健康度指标应看**唯一出口 IP 数**，不是条目数。

---

## 五、真正可行的三条路（按推荐顺序）

### 选项 A —— 收敛别名（零成本，5 分钟，建议立刻做）
把 12 条别名压成 1 条真条目，消除"伪 12 出口"；同步收敛 `trusted-exits.json`。
**收益**：防止未来误启用导致 14% 账号挤同一 IP。**风险**：无（当前本就全 disabled）。

### 选项 B —— 接入 `isp_proxy1` 作 1 个独立出口（零成本，需拉链路）
`185.97.0.157` 已验证**Tumblr 可达 + 0 限流 + 绕 GFW**，是一个**干净的新出口**。
必须走 `SOCKS5(10950) → VPS → brd.superproxy.io:44445`（直连 7/12 失败，见结论 7）。
**收益**：+1 个与 CF Worker 完全异构的出口（不同 ASN/地理位置）。
**成本**：需恢复 `10950 + 10809` 转发器（`_start_services.bat` 幂等段）。

### 选项 C —— 新建轮换型住宅 zone（唯一能真正"自动轮换"的路，有成本）
在 BD 后台新建 **Rotating Residential zone**（端口 22225）。届时文档里的 `-session-` 才生效。
MSCMS 侧的正确用法（**重要，别用错**）：
- ❌ **不要**每请求换 session → 同一账号的登录态会在不同 IP 间跳变，Tumblr 风控必杀。
- ✅ **按账号固定 session**：`-session-<hash(accountId)>` → **同账号永远同 IP，账号之间彼此不同 IP**。这才是规模化发布要的语义。

---

## 六、可复用探针脚本（本次交付）

| 脚本 | 用途 |
|---|---|
| `D:/mscms-tmp/_bd_probe.js` | 无 session ×5 + 12 session + 粘性 + 目标站 + zone 清单，一次出轮换结论 |
| `D:/mscms-tmp/_bd_probe3.js` | 区分「BD 限流」vs「目标站拒绝」：捕获 curl 退出码语义（56=连接重置、28=超时） |
| `D:/mscms-tmp/_bd_chain_test.js` | **手写 SOCKS5 + HTTP CONNECT + TLS** 三层链路探针（绕开 undici 对 BD 静默失败的坑），经 VPS 验证 BD→Tumblr 可达性 |
| `D:/mscms-tmp/_bd_zone_perm.js` | 无副作用探测建 zone 权限（用非法 body：403=无权限 / 400=有权限且不建）+ Tumblr 限流容限压测 |
| `D:/mscms-tmp/_bd_unlocker_recheck.js` | unblocker 型 zone 的 POST 中继能力 + 轮换性复查 |

> 技能侧已同步：`~//skills/brightdata-tumblr-bridge/`（矩阵与陈旧结论已更正）。

---

## 七、需要你决策

1. **选项 A** 是否执行？（零风险，建议做）
2. **选项 B** 是否恢复 `10950/10809` 转发器并把 `isp_proxy1` 作为第 47 个出口接入？
3. **选项 C** 是否要在 BD 后台建 Rotating Residential zone？（这是文档里那套轮换真正落地的前提；我这边 API key 无权创建）

> 另：`isp_proxy2` 报 `407 Auth failed`，请到 BD 后台核对它的 **zone 密码**（可能与 `isp_proxy1` 不同）；拿到后我可立即验证第 2 个静态 IP。
