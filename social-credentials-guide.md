# 社媒渠道人工凭证填写指引（MSCMS v14 → n8n 扇出）

> 适用对象：`n8n-mscms-fanout.final.json` 扇出工作流 + `wire-credentials.js` 接线助手。
> 铁律：没拿到的渠道在 `credentials-input.json` 里留空字符串 `""` 即可，**绝不伪造** token / 发布链接 / 进度。

---

## 一、现状速览（7 个扇出渠道）

| 渠道 | 状态 | 你需要做的 | 耗时 |
|------|------|-----------|------|
| **Nostr** | ✅ 零凭证已通（本地签名，已修代理） | 无 | 0 |
| **Telegraph** | ✅ 零凭证已通（匿名账号，token 已在 ） | 无 | 0 |
| **Mastodon** | ⚠️ token 已自动创建，待点邮件确认 | Gmail 收件箱点 1 次确认链接 | 1 分钟 |
| **Discord** | ⬜ 待人工（登录触发 hCAPTCHA，改用 Webhook 绕过） | 建频道 Webhook 复制 URL | 30 秒 |
| **Telegram** | ⬜ 待人工（需手机号接码） | @BotFather 建 bot 拿 token | 2 分钟 |
| **Bluesky** | ⬜ 待人工（新账户需邮箱验证） | 注册 + 建 App  | 3 分钟 |
| **Tumblr** | ⬜ 待人工（✅ OAuth2 已就绪，脚本 tumblr-oauth2.js） | 注册 App→填 key/secret→跑授权脚本 | 3 分钟 |

> 已自动打通的 Mastodon 账号：`@mscms_v14@.social`（email: aoshuang99@gmail.com）。

---

## 二、通用接线三步法

不管哪个渠道，拿到真实凭证后都走这三步：

```bash
# 1) 编辑 credentials-input.json，把真实 token 填进对应字段（没拿到的留 ""）
# 2) 运行接线脚本，写入 
node wire-credentials.js
# 3) 重启 n8n（start-n8n.sh 会自动 source  注入环境变量）
```

脚本只会覆盖「你填了且非空」的键，原文件注释与结构完整保留。

---

## 三、逐渠道分步操作

### 1. Mastodon —— 最快，只要 1 次点击

账号和 token 已经通过 API 自动建好并写入 ``，**唯一阻塞是邮箱未确认**（发帖现在返回 403）。

- **操作**：登录 `aoshuang99@gmail.com` → 找标题类似「Confirm your account on .social」的邮件 → 点击里面的确认链接。
- **填字段**：无需填（token 已在 `` 的 `MASTODON_TOKEN`）。
- **验证**（确认后跑）：
  ```bash
  curl -X POST \
    -H ": Bearer $MASTODON_TOKEN" \
    -H ": application/json" \
    -d '{"status":"MSCMS 自测"}' \
    https://.social/api/v1/statuses
  ```

### 2. Discord —— Webhook 方式，绕过 hCAPTCHA

自动化登录会被「您是人类吗？」hCAPTCHA 拦截，所以用服务器 Webhook（不需要登录 bot 账号）。

- **步骤**：
  1. 登录 https://discord.com/login
  2. 进入你的服务器 → 某个文本频道 → 右上角 ⚙ 频道设置 → **整合 / Integrations** → **Webhooks** → **新建 Webhook**
  3. 复制 Webhook URL，形如：
     ```
     https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWx
                                  └──ID──┘              └──────TOKEN──────┘
     ```
- **填字段**：
  - `DISCORD_WEBHOOK_ID` = URL 里的数字 ID
  - `DISCORD_WEBHOOK_TOKEN` = URL 里 ID 后面的随机串
- **验证**：
  ```bash
  curl -X POST "https://discord.com/api/webhooks/<ID>/<TOKEN>" \
    -H ": application/json" \
    -d '{"content":"MSCMS 自测"}'
  ```

### 3. Telegram —— @BotFather 建 bot（需手机号）

- **步骤**：
  1. 在 Telegram 搜 `@BotFather` → 发 `/newbot` → 按提示取一个名字和用户名（结尾须是 `bot`）→ 拿到 `BOT_TOKEN`（形如 `123456:ABC-DEF...`）。
  2. 给你的 bot 发任意一条消息（用来激活会话）。
  3. 浏览器打开 `https://api..org/bot<BOT_TOKEN>/getUpdates` → 在返回的 JSON 里找 `message.chat.id`（正向整数），那就是 `CHAT_ID`。
     - 嫌麻烦也可把自己的消息转发给 `@userinfobot` / `@RawDataBot` 直接看 chat id。
- **填字段**：
  - `TELEGRAM_BOT_TOKEN` = `BOT_TOKEN`
  - `TELEGRAM_CHAT_ID` = 上一步拿到的 chat id
- **验证**：
  ```bash
  curl "https://api..org/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=MSCMS%20自测"
  ```

### 4. Bluesky —— 注册 + App 

- **步骤**：
  1. 访问 https://bsky.social/signup 注册（需邮箱验证）。
  2. 登录后 → **Settings** → **App s** → **Add App ** → 复制生成的专用密码（形如 `xxxx-xxxx-xxxx-xxxx`，**不是**登录主密码）。
- **填字段**：
  - `BLUESKY_IDENTIFIER` = 你的 handle，例如 `yourname.bsky.social`
  - `BLUESKY_` = 上面复制的 App 
  - `BLUESKY_PDS` = 默认 `https://bsky.social`（一般不用改）
- **验证**：
  ```bash
  curl -X POST https://bsky.social/xrpc/com.atproto.server.createSession \
    -H ": application/json" \
    -d '{"identifier":"<HANDLE>","":"<>"}'
  ```
  返回里带 `accessJwt` 即成功。

### 5. Tumblr —— ✅ OAuth2 端到端（已配脚本 tumblr-oauth2.js）

Tumblr API v2 现支持 **OAuth2**（拿到标准 `Bearer` token，无需 OAuth1.0a 签名），已配好全自动授权助手 `tumblr-oauth2.js`，你只需做一次 App 注册。

- **前置（一次性，约 3 分钟）**：
  1. 登录 Tumblr → 打开 https://www.tumblr.com/oauth/apps → **Register application**
  2. 拿到 **OAuth Consumer Key**（=）与 **Consumer Secret**（=）
  3. 编辑该 App，在 **OAuth2 redirect URLs** 里填入（必须完全一致）：
     ```
     http://localhost:3111/callback
     ```
  4. 把 key/secret 填入 `credentials-input.json` 的 `tumblr_` / `tumblr_`
- **跑授权（自动拿 token）**：
  ```bash
  node tumblr-oauth2.js authorize   # 打印授权链接→浏览器点“允许”→自动换 token 写入 
  node tumblr-oauth2.js test        # 发一条真实测试帖验证(NPF /posts)
  ```
  - 脚本会自动：换 `` + ``（scope 含 `offline_access`）、取你的主博客名、写入 `` 的 ``/`TUMBLR_BLOG`、持久化到 `tumblr-creds.json`。
- **token 过期**：OAuth2  有有效期，过期后跑一次刷新即可（无需重新授权）：
  ```bash
  node tumblr-oauth2.js refresh
  ```
- **n8n 节点已升级**：工作流 `Tumblr` 节点已从旧的 legacy `/post` 简化模式改为 **NPF `/posts` + OAuth2 Bearer**（并修掉了原节点表达式缺 `=` 前缀的 bug）。只要 `` 是有效 OAuth2 token 即真实发布。

---

## 四、字段速查表（平台拿到什么 → 填哪个字段）

| 平台 | 你拿到的东西 | 填到 `credentials-input.json` 的字段 |
|------|-------------|--------------------------------------|
| Mastodon | （已自动建好，仅点邮件） | 无需填 |
| Discord | Webhook URL 拆出的 id / token | `discord_webhook_id` / `discord_webhook_token` |
| Telegram | BOT_TOKEN / chat_id | `_bot_token` / `_chat_id` |
| Bluesky | handle / App  | `bluesky_identifier` / `bluesky_app_` |
| Tumblr | Consumer Key / Secret（App 注册） | `tumblr_` / `tumblr_`，再跑 `node tumblr-oauth2.js authorize` |
| Nostr | 无 | 无 |
| Telegraph | 无（已就绪） | 无 |

---

## 五、重要提醒

1. **绝不伪造**：任何没拿到的渠道在 JSON 里留 `""`，脚本和节点都不会编造 token 或发布链接；对应节点仅静默跳过 / 报错。
2. **沙箱隔离**：之前在隔离沙箱里验证过机制（Nostr 真实发布、Mastodon 账号真实创建），但你真实的 MSCMS/n8n 跑在另一网络命名空间，**最终接线与整链路验证须在你本机执行**。
3. **出口代理**：确保本机出口代理（v2rayN / xray，默认 `:10808`）在运行；`server.js` 启动时会自动探测并注入 `HTTP_PROXY`，Nostr 才能真实出网。
4. **改完要重启**：`wire-credentials.js` 写入 `` 后，必须重启 n8n 让扇出节点重新读取环境变量才生效。
5. **零凭证两路已开箱即用**：只要 MSCMS 正常发布（触发 Webhook `mscms-publish`），Nostr 与 Telegraph 会自动扇出，无需任何人工。
