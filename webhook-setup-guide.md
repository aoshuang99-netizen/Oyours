# MSCMS v14 → 多渠道自动化：详细操作指引

> 目标：让 MSCMS v14 每真实发布一篇帖子，就自动扇出到你的各个社交渠道。
> 服务器已具备：① `GET /api/v14/feed/rss`（RSS 出口）、② 实时 Webhook 推送（`/api/v14/mixpost/webhook/config`）、③ 原生直连调度器。
> 域名：MSCMS 经 Cloudflare Tunnel 暴露在 `https://mscms.cc.cd`（或 `https://v14.cc.cd`），均指向本地 3002。

---

## 〇、三条路线怎么选

| 路线 | 适用 | 你需要做的 | 零凭证？ |
|------|------|-----------|---------|
| **A. Webhook → n8n 扇出** | 想一处配置、实时毫秒级扇出 5 渠道 | 自托管/云端 n8n + 导入工作流 + 填一次凭证 | 否（n8n 内各填一次） |
| **B. RSS 自动导入** | DEV.to / Hashnode 发布 | 仅粘贴 MSCMS 的 RSS 地址 | ✅ 完全零 key |
| **C. 原生直连** | 不想用 n8n，直接在 MSCMS 发 | 发布台逐张卡填免费凭证 | 否（各填一次） |

三条可并存，互不冲突。推荐 **A 为主、B 补 DEV.to/Hashnode、C 作兜底**。

---

## 一、路线 A：MSCMS Webhook → n8n 实时扇出（主推）

### A0. 准备好 n8n
二选一：
- **n8n.cloud**（最省事）：注册 https://n8n.io → 直接有云实例。
- **自托管（本机/服务器，免费）**：
  ```bash
  docker run -it --rm -p 5678:5678 n8nio/n8n
  # 或本机无 Docker 时： npx n8n   （会起在 http://localhost:5678）
  ```
  确认能打开 `https://<你的n8n域名>`（云）或 `http://localhost:5678`（本机）。

### A1. 导入工作流
1. 打开本仓库里的 `n8n-mscms-fanout.json`（已随本轮交付）。
2. n8n 左上角 ☰ → **Workflows** → **Import from File**（或 New Workflow → 右上 ⋯ → Import）。
3. 导入后看到 6 个节点：
   `MSCMS Publish Webhook` →（扇出）→ `Telegram` / `Discord` / `Mastodon` / `Tumblr` / `Bluesky`

### A2. 在 n8n 侧配置 5 渠道凭证（一次性）
工作流里 5 个扇出节点用 `{{ $env.X }}` 读变量。两种填法：
- **(a) 环境变量**：在 n8n 实例配置里设 `TELEGRAM_CHAT_ID`、`DISCORD_WEBHOOK_ID`、`DISCORD_WEBHOOK_TOKEN`、`MASTODON_INSTANCE`、`MASTODON_TOKEN`、`TUMBLR_BLOG`、``、`BLUESKY_JWT`、`BLUESKY_DID`。
- **(b) 直接用 n8n 凭证**（更直观）：把节点参数里的 `{{ $env.X }}` 换成 n8n 的 Credential（如 Telegram API 凭证、Discord Webhook 凭证）。

各渠道**免费获取方式**：
- **Telegram**：@BotFather → `/newbot` 拿 bot token → 在 n8n 建 *Telegram API* 凭证填 token；频道 chat_id 用 `getUpdates` 取（带 `-100` 前缀），填到 `TELEGRAM_CHAT_ID`。
- **Discord**：服务器 → 设置 → 集成 → Webhooks → 复制 URL，形如 `https://discord.com/api/webhooks/{id}/{token}` → 节点 `webhookId={id}`、`webhookToken={token}`（或改用 Discord Webhook 凭证类型）。
- **Mastodon**：任意实例（如 .social）注册 → 设置 → 开发 → 新建应用 → 拿到 access token → 填 `MASTODON_INSTANCE`（含 https://）、`MASTODON_TOKEN`。
- **Tumblr**：官方 API 是 OAuth1，裸 HTTP 不便。最省事是走 **IFTTT（IF This Then That）** 接 Tumblr（无需自建 App）；若坚持在 n8n 做，建议装 *Tumblr 社区节点* 或用 IFTTT 接收 Webhook 再发 Tumblr。工作流里的 Tumblr 节点是 Bearer token 示意，生产请改用 OAuth/社区节点。
- **Bluesky** ⚠️：工作流当前把 `BLUESKY_JWT`/`BLUESKY_DID` 当作静态 env 占位。**正确做法**：先到 Bluesky → 设置 → App s → 建密码（handle + app ）；再加一个 *Function/OAuth 节点* 调 `https://bsky.social/xrpc/com.atproto.server.createSession` 用 handle+app  换 `accessJwt`+`did`，把它们传给 Bluesky 节点（替换 `$env.BLUESKY_JWT`/`BLUESKY_DID`）。否则 JWT 过期会发不出去。

### A3. 激活并复制 Webhook URL
1. 右上角 **Activate** 激活工作流。
2. 触发节点 `MSCMS Publish Webhook` 的**生产 URL** 为：
   ```
   https://<你的n8n>/webhook/mscms-publish
   ```
   （未激活/测试时可用 `https://<你的n8n>/webhook-test/mscms-publish`）
3. **复制这个 URL**。

### A4. 告诉 MSCMS 这个 URL（配置出站 Webhook）
> 发布台暂无 Webhook 配置卡，用 API（二选一）：

**PowerShell：**
```powershell
Invoke-RestMethod -Uri "https://mscms.cc.cd/api/v14/mixpost/webhook/config" `
  -Method Post -ContentType 'application/json' `
  -Body '{"url":"https://<你的n8n>/webhook/mscms-publish"}'
```
**curl：**
```bash
curl -X POST https://mscms.cc.cd/api/v14/mixpost/webhook/config \
  -H ': application/json' \
  -d '{"url":"https://<你的n8n>/webhook/mscms-publish"}'
```
验证已配置：
```bash
curl https://mscms.cc.cd/api/v14/mixpost/webhook/config
# → {"ok":true,"configured":true,"url":"https://<你的n8n>/webhook/mscms-publish"}
```
发一条测试推送（确认 n8n 收到）：
```bash
curl -X POST https://mscms.cc.cd/api/v14/mixpost/webhook/test
# n8n 的 MSCMS Publish Webhook 节点应立即收到一条 event=post.published 的测试事件
```

### A5. 真实发布验证
1. MSCMS 发布台建帖 → 选 **Nostr**（你已配密钥）或任一已配渠道 → 发布。
2. MSCMS 真实发布成功 → 毫秒级 POST 到 n8n → n8n 扇出到 Telegram/Discord/Mastodon/Tumblr/Bluesky。
3. 去各渠道确认收到（内容 = 帖子标题 + `https://mscms.cc.cd/v14/post/{id}` 链接）。

---

## 二、路线 B：DEV.to / Hashnode 走 RSS 自动导入（零凭证）

完全不用 API key，只要粘贴 MSCMS 的 RSS 地址：
```
https://mscms.cc.cd/api/v14/feed/rss
```
- **DEV.to**：登录 → Settings → Extensions → RSS → **Add RSS Feed** → 填上面地址 → 保存。之后 MSCMS 每发一篇，DEV.to 自动同步（含标题/正文/链接）。
- **Hashnode**：Dashboard → Settings → Integrations → RSS → 填同一地址。
- 说明：RSS 每条 `<item>` 的 `<category>` 标注了渠道平台；DEV.to/Hashnode 导入的是 MSCMS 帖子的标题 + 正文 + 链接。

---

## 三、路线 C：MSCMS 原生直连（不用 n8n）

1. 发布台 → **Mixpost 发布台 → 提供方**，逐张卡填免费凭证：
   - 已就绪：Nostr（你已配）、Telegram / Discord / DEV.to / Hashnode
   - 诚实脚手架（填真实凭证即启用）：Bluesky / Mastodon / Tumblr
2. 填好后，内置 `MixpostService` 调度器每 15s 扫描待发布版本 → 真实发帖 → 自动推进因果链 **S4（post.published）**。
3. 这是 MSCMS 内置扇出，不依赖任何外部服务。

---

## 四、重要提醒

- **只在真实发布成功时推送**（禁假数据铁律）：发布失败 / 未配置渠道不会触发 Webhook。
- **出网方式**：MSCMS 出站 Webhook 对非 localhost 地址走 `HTTP_PROXY` 代理出网；若 n8n 与 MSCMS 同机，可用 `http://localhost:5678/webhook/mscms-publish` 直连（更快更稳）。
- **安全**：Webhook URL 即推送入口，任何人拿到都可向你的 n8n 推事件。建议在 n8n 的 Webhook 节点开启 **Authentication（Basic Auth / Header）**，或只对内网/隧道暴露。
- **清理**：不想用 Webhook 时 `DELETE https://mscms.cc.cd/api/v14/mixpost/webhook/config` 即可恢复 `configured:false`。

---

## 五、可继续让我做的（任选）

1. 在发布台加一张 **「Webhook 配置」卡**（填 URL + 测试按钮），你就不用敲 API 了。
2. 把 **Bluesky 认证前置节点**补进 n8n 工作流（handle+App  → 自动换 JWT+DID）。
3. 给 Webhook 推送加 **失败重试 / 签名校验**。
4. 把 **Tumblr 节点**换成 IFTTT 或社区节点，去掉示意性 Bearer token。
