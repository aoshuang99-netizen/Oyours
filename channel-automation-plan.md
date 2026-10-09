# MSCMS v14 — 7 条免费渠道「第三方插件/应用自动化对接」方案

> 范围：Tumblr / Bluesky / Mastodon / Telegram / Discord / DEV.to / Hashnode
> （Nostr 已用本地密钥真实发布，不在此列）
> 目标：不再逐条去开发者后台拿 key，而是让 MSCMS 产出**统一 Feed**，由**第三方自动化应用**去扇出分发。

---

## 1. 核心架构：一个真理源 + 自动分发

```
┌─────────────┐    RSS/Atom + Webhook     ┌──────────────────────────┐
│  MSCMS v14  │ ───────────────────────▶  │   第三方自动化层          │
│  posts/feed │                           │  (n8n / Zapier / dlvr.it) │
└─────────────┘                           └──────────────────────────┘
                                                  │ 一次授权，多平台扇出
        ┌──────────────┬──────────────┬──────────┼──────────┬──────────────┐
        ▼              ▼              ▼          ▼          ▼              ▼
     Telegram      Discord        Mastodon    Tumblr     Bluesky      DEV.to / Hashnode
   (bot/webhook)  (webhook)      (token)    (OAuth)    (app pwd)   (RSS 自动导入·零key)
```

**两条路线（按「省事程度」排序）**

- **A. RSS 自动导入（零额外凭证，最强推荐）**：DEV.to、Hashnode 原生支持从 RSS 拉取并自动发稿。MSCMS 只需暴露一个 RSS 地址，这两个平台自己来抓，**完全不需要 API key**。
- **B. 自动化中枢（一次授权，fan-out）**：用 n8n（自托管/免费）或 Zapier/Make 接 MSCMS 的 RSS，自动转发到 Telegram / Discord / Mastodon / Tumblr / Bluesky。凭证只在自动化应用里填一次，MSCMS 侧彻底解耦。

> 诚实说明：第三方自动化**减少的是 MSCMS 侧的维护**，并不凭空消灭平台凭证——Telegram/Discord/Mastodon/Tumblr/Bluesky 仍然各需一个凭证，只是你改在自动化应用里授权一次即可。真正「零凭证」的只有 A 路线的 DEV.to 与 Hashnode。

---

## 2. 渠道 × 第三方对接 对照矩阵

| 渠道 | 推荐第三方对接 | 仍需凭证 | 免费档 | 自动化类型 |
|------|---------------|---------|--------|-----------|
| **DEV.to** | 官方 RSS Importer（Settings→Extensions→Publishing from RSS） | **无** | 官方免费·无限 | RSS 自动导入 ✅零凭证 |
| **Hashnode** | 官方 RSS Importer（Publication→Settings→RSS Importer） | **无** | 官方免费·无限 | RSS 自动导入 ✅零凭证 |
| **Discord** | n8n Discord 节点 / Zapier / IFTTT | Webhook URL（频道设置里复制，免费、无审核） | 全免费 | Webhook 推送 |
| **Telegram** | n8n Telegram 节点 / ManyChat / RSS-to-TG bot | Bot token（@BotFather 免费）+ 频道 chat_id | 全免费 | Bot API |
| **Mastodon** | n8n Mastodon 节点 / dlvr.it / RSS-to-Mastodon | 实例访问令牌（任意实例免费注册） | 全免费 | 实例 API |
| **Bluesky** | n8n Bluesky 节点 / Publer / Buffer（免费限额） | handle + App （免费） | 免费·有限额 | AT Protocol |
| **Tumblr** | IFTTT「Publish to Tumblr」/ dlvr.it / Buffer | Tumblr 账号 OAuth（无需自建 App） | IFTTT 免费仅 2-3 applet；dlvr.it 免费 1 目的地 | OAuth 转发 |

**最省心组合**：DEV.to + Hashnode 走 A（RSS，零 key）；其余 5 条走 B（n8n 一个工作流全包）。

---

## 3. 落地步骤（分 3 阶段）

### Phase 0 — 给 MSCMS 加 Feed 出口（必做，所有自动化的前提）
新增一个轻量端点，把已发布的 Mixpost 帖子序列化成 RSS 2.0：

- `GET /api/v14/feed/rss` → XML（title/link/description/pubDate + 每个渠道的 `<category>` 标签）
- 数据源复用 `mixpost_post` + `mixpost_post_version`（已存在）
- 可选：`POST /api/v14/feed/webhook` 在帖子进入 `published` 时主动 push 给 n8n 的 Webhook 触发（比轮询 RSS 更实时）
- 建议加 `?channel=all` / `?limit=20` 参数

### Phase 1 — DEV.to + Hashnode RSS 自动导入（零凭证，立刻见效）
1. 部署 Phase 0 的 RSS 端点（如 `https://mscms.cc.cd/v14/feed/rss`）。
2. DEV.to：Settings → Extensions → Publishing from RSS → 粘贴 RSS 地址 → 开启自动导入。
3. Hashnode：Publication Dashboard → Settings → RSS Importer → 粘贴 RSS 地址 → 开启。
4. 此后 MSCMS 每发一篇，这两个平台自动同步，**无需任何 API key**。

### Phase 2 — n8n 自托管扇出（覆盖其余 5 条）
1. 自托管 n8n（Docker：`docker run -p 5678:5678 n8nio/n8n`，完全免费、数据不出本地）。
2. 导入附带的 `n8n-mscms-fanout.json` 工作流。
3. 在 n8n 里为 Telegram / Discord / Mastodon / Bluesky / Tumblr 各填一次凭证。
4. 触发方式：RSS Feed Read 节点轮询 MSCMS RSS（或用 Phase 0 的 Webhook 实时触发）。
5. 每个渠道一个节点，帖子标题+正文+链接自动发出。

### Phase 3（可选）— 保留 MSCMS 原生适配器作兜底
MSCMS 已有这 7 个 provider 适配器（`providers/*-provider.js`）。若你更想「MSCMS 直连」而非走 n8n，可在发布台填凭证，调度器 `social-publishing.js` 会自动 fan-out 并推进因果链 S4。两条路线可并存。

---

## 4. 免费档要点 & 坑

- **n8n 自托管**：完全免费、无任务限额、数据本地 → **最推荐**的中枢。
- **IFTTT 免费**：仅 2–3 个 applet，且每 applet 单目的地 → 不够 5 渠道。
- **dlvr.it 免费**：仅 1 个 destination → 只能接 1 个渠道。
- **Zapier 免费**：100 tasks/月，每平台单独连接 → 轻度可用。
- **DEV.to / Hashnode RSS 导入**：官方功能、免费、无限 → **优先吃**，零维护。
- **代理注意**：若 MSCMS 在带 `HTTP_PROXY` 的沙箱，n8n 若部署在同环境需同样走代理出网（参考 Nostr provider 的 ProxyAgent 做法）。

---

## 5. 我可立即帮你做的

- ✅ 加 `GET /api/v14/feed/rss`（+ 可选 webhook 推送）
- ✅ 交付 `n8n-mscms-fanout.json`（导入即用，覆盖 5 渠道）
- ✅ 或改为 MSCMS 原生直连（凭证填发布台，调度器自动扇出 + 推进 S4）

选定路线后告诉我，我直接落地。
