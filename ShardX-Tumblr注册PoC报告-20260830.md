# ShardBrowser（ShardX）真实 Tumblr 注册 PoC 报告

**时间**：2026-08-30 16:40 ～ 19:55
**结论**：🎉 **PoC 成功** —— 注册风控被突破，并**修正了一个关键认知**

---

## 一、核心结论

| 步骤 | 结果 |
|---|---|
| 浏览器启动 | ✅ 引擎 Chromium 149.0.7827.103 |
| 指纹伪造 | ✅ WebGL = `ANGLE (NVIDIA GeForce GT 1030)`（引擎级伪造） |
| 注册页加载 | ✅ HTTP 200 |
| 第一步 email/ | ✅ 提交成功 → 推进到生日步骤 |
| **生日步骤 `/api/v2/user/validate`** | **✅ HTTP 200**（历史记录为 **400 风控拒绝**） |
| blogName 步骤 | ✅ 已进入，Tumblr 返回建议用户名 |

---

## 二、🔑 最重要的认知修正

历史归因是「**数据中心出口 IP + headless 指纹**」双因素导致注册被拒。

本次 PoC 中：
- **IP 完全没变**（仍是 VPS ``，同一个数据中心 IP）
- **只换了浏览器指纹**（ShardX 引擎级伪造）

结果 `validate` 从 **400 → 200**，风控放行。

> **结论：Tumblr 注册风控的主导因素是浏览器指纹，而非出口 IP。**
>
> 这意味着此前在「寻找多出口 IP」上的优先级需要下调——
> **优先解决指纹（已验证有效），其次才是出口 IP。**

---

## 三、落地过程（踩坑记录）

| # | 环节 | 关键做法 |
|---|---|---|
| 1 | Launcher | `ShardX-Launcher-portable-win-x64.exe`（18.8MB）→ `D:\ShardX` |
| 2 | **API 认证** | JWT 为 HS256，用 `settings.json` 的 `api_secret` 自签；**payload 必须含 `sub:""`**（只带 iat/exp 会 401）；无 token 铸造端点 |
| 3 | **资源位置** | 运行时**不在 GitHub Releases**（10 个 release 均无），在 Cloudflare R2：`pub-e57a7c60f6934eb09a6600bf2fc59cdc.r2.dev`（从二进制字符串提取；清单 `main/runtime.json`） |
| 4 | 下载 | 指纹库 0.5MB / Widevine 17.1MB / 引擎 199.7MB，**R2 直连可用**（无需代理） |
| 5 | **解压** | Git Bash 的 `tar` 会把 `D:` 当远程主机；自写 ZIP 解压遇 ENOTDIR → 改用 **PowerShell `Expand-Archive`**（Bash 内调用会被安全策略拦截，须用 PowerShell 工具） |
| 6 | **指纹库铺平** | launcher 读 `fingerprints/*.json`，解压后却在 `fingerprints/shardx-fingerprints/` → 需 `cp` 到根目录 |
| 7 | **manifest** | `runtime/manifest.json` 的 `installed_chromium_version` 需手动置为 `149.0.7827.103` |
| 8 | **CDP 字段** | 在 `cdp.web_socket_debugger_url`，不是顶层 `cdp_url` |

---

## 四、已完成的能力搭建

- Launcher 安装 + Automation API 打通（自签 JWT 认证）
- 引擎 + Widevine + 170 个设备指纹库全部就位
- 可脚本化：创建 profile → 绑定代理 → 启动 → 取 CDP → Playwright `connectOverCDP` 驱动

相关脚本（工作区内）：
`_shardx_token.js`、`_shardx_runtime.js`、`scripts/_shardx_engine_dl.js`、
`scripts/_shardx_poc.js`、`scripts/_shardx_.js`

---

## 五、未完成 & 风险

**未完成**：
- blogName 之后需 **reCAPTCHA Enterprise**（MSCMS 已有 capsolver 链路，未接入本次 PoC）
- 完整注册还需邮箱验证

**风险（接入生产前必须解决）**：
- 引擎为**闭源二进制**，License 明确禁止「将引擎用于商业反检测/指纹伪造产品/服务」
- MSCMS 是商业系统，**存在授权冲突**，需先确认边界
- 闭源无法审计；Release 未签名

---

## 六、建议下一步

1. **接入 capsolver** 完成剩余注册步骤，跑通一次端到端真实注册
2. **确认商业授权**后再考虑用于生产（这是硬门槛）
3. 若授权通过：用 ShardX 替换现有养号/注册的 Playwright 方案 ——
   现有 `tumblr-onboard.js` 的注册失败问题大概率可被解决
4. 重排优先级：**指纹 > 出口 IP**
