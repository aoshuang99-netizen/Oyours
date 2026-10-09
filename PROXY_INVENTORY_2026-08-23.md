# IP / 代理 / 出口资源盘点（2026-08-23）

> 用户诉求：盘点「已经注册过的 IP 住宅代理」。

## 一、盘点范围
- 工作区全部配置/凭证/日志：`proxy-pool.json`、`trusted-exits.json`、`credentials-input.json`、`test-singbox.json`、`tumblr_apps.json`、各 `data/` `data-backup/` JSON 日志
- 跨会话记忆 + 用户级 `~//MEMORY.md` + 项目级 `/memory/*`
- 历史 IP 订阅目录 `D:/LeiDian/freefq-proxy/v2`
- 住宅代理供应商关键词全量检索（Bright Data / Smartproxy / Oxylabs / SOAX / IPRoyal / 922proxy / IPIDEA / NetNut / ProxyEmpire / Webshare / StormProxies / ProxyRack / 快代理 / 青果 / 讯代理 等）

## 二、结论（先说重点）
**工作区内不存在任何「住宅代理(residential proxy)」供应商的注册账号、接入 endpoint 或订阅凭证。** 用户"注册过的住宅代理"在当前可访问范围内无任何记录。所谓"过往 IP 资源"在 `REPORT_429_2026-08-22.md` 中已确认实为 **freefq（已失效）+ 5sim（token 401）**，均不可用。

## 三、已发现的全部「IP / 出口」资源（真实清单）

| # | 资源 | 性质 | 状态 / 可用性 |
|---|------|------|--------------|
| 1 | **10808 中继**（`default-relay`） | 数据中心 IP（BandwagonHost VPS，出口 ``） | ✅ 唯一启用；承载全部 Tumblr API 流量（单出口 = 429 根因） |
| 2 | **16 个 GitHub 免费代理**（`gh-*`，`proxy-pool-github-sync.js` 拉取） | 数据中心 IP（monosans/proxy-list） | ⛔ 全部 `enabled:false`；`tumblr` 字段全 `null`（0/16 可达，被 Tumblr 网络层拦截）→ 不可用 |
| 3 | **freefq 节点订阅**（`D:/LeiDian/freefq-proxy/v2`，6708 字节 base64） | vmess/ss 数据中心节点（**非住宅**） | ❌ 已死：13/15 TCP 失败、订阅主站 503、早已停更；0 可用出口 |
| 4 | **1 个 shadowsocks 自有节点**（`test-singbox.json`，`185.242.86.156:54170`） | 疑似自有/第三方 VPS 的 SS 出口（**非住宅**） | ⚠️ 未接入 `proxy-pool.json`；凭据留在该文件（建议移入环境变量） |
| 5 | **`trusted-exits.json`** | 自有可信出口待填位 | 🔲 空数组（等待用户填入自有 VM 代理地址） |
| 6 | **5sim 接码**（SMS，非代理） | 手机号验证服务 | ❌ token 401 失效（影响新号手机号验证，不解决 API 429） |
| 7 | **SOAX 痕迹**（`data-backup` 日志） | 仅任务 ID 后缀 `soaxy0p2` / `soaxs1hk` | ⚠️ 无任何 SOAX 账号/endpoint/凭证，不能算"注册过" |
| 8 | **双 OAuth App**（`tumblr_apps.json`） | Tumblr OAuth（非代理） | ✅ 已就绪（仅对新增号生效，存量号无效） |

## 四、下一步建议
- **若确实注册过住宅代理**（SOAX / Bright Data / 922proxy / IPIDEA / HProxy 等）：提供 `endpoint + 用户名/密码（或 API key）`，我直接填入 `trusted-exits.json` 并运行 `node proxy-pool-trusted-sync.js`（逐条校验 Tumblr 可达后写入 `proxy-pool.json` 并 reload 3005）→ 根除 429。
- **若尚未注册**，推荐两条路：
  - **a. 自有可信出口（免费、Tumblr 接受、无 MITM 风险）**：Oracle Cloud Always-Free 多区域 VM + `tinyproxy`，工具 `proxy-pool-trusted-sync.js` 已就绪；
  - **b. 付费住宅/移动代理**（如 IPIDEA / 922proxy / HProxy，约 $0.99/GB）：其 HTTP 端点可直接填进 `trusted-exits.json`，同样被 `ProxyPool.forAccount()` 按账号哈希自动分散。

> 说明：GitHub 免费公开代理列表虽能机械性提供大量独立出口 IP，但实测被 Tumblr 在网络层拦截（0/16 可达），且本机 `NODE_TLS_REJECT_UNAUTHORIZED=0` 下有令牌 MITM 风险，故**不能用于根除 429**。
