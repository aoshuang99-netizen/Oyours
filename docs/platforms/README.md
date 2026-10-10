# 平台发布规则库（P1.1 — Rule 4 合规预检源）

> 本目录是 **单一事实源（single source of truth）**，供 `content-gate.js` 在发布前做规则预检：
> 比对目标平台的「敏感词 / 频率 / 格式 / 代理要求」，不合则**拦截**，不进发布队列。
> 每条平台一个 `.md`，结构统一（见下方 schema）。新增平台只加一个文件，不改代码主路径。

## 状态总览（2026-10-09 实测）

| 平台 | 准入状态 | 出口要求 | 当前价值 |
|---|---|---|---|
| Mastodon | ✅ 已通（4/4 成功） | 任意可达 IP | 主力免费通道 |
| Bluesky | 🟡 待接入（App ） | 任意可达 IP | 扩量候选 |
| Telegraph | 🟡 待接入 | 任意可达 IP | SEO 桥接 / 落地页 |
| Tumblr | ⛔ 住宅 IP 墙（数据中心 IP 被重置） | **必须住宅住宅 IP** | 暂不可靠，绕路 |
| kkmatch SEO | 🟡 待接入（IndexNow/sitemap） | 任意可达 IP | 自有站收录 |

## 文件 schema（每个平台 .md 必备段落）

```
## 准入状态        # ✅ / 🟡 / ⛔ + 一句话现状
## 限流            # 单位时间上限、退避建议
## 反机器人        # 风控维度、所需出口类型
## 内容格式        # 长度、标签数、媒体、NSFW 标注
## 算法偏好        # 冷启动如何获得曝光
## 预检规则        # content-gate.js 读取的硬约束（JSON 片段）
## 发布器映射      # 对应 providers/*.js 与 free--publisher.js 路由键
```

## 与 content-gate.js 的集成契约

`content-gate.js` 启动时 `require` 本目录所有 `.md`，解析「预检规则」下的 JSON，
构建 `Map<, Rule>`。发布前调用 `gate.check(, post)`：

- 返回 `{ ok:true }` → 放行入队
- 返回 `{ ok:false, reason }` → 拦截并记 `incidents.jsonl`（level=warn）

**硬约束**：任何平台的「预检规则」不得为空；空规则视为该平台未就绪，默认拦截。
